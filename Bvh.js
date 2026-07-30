/**
 * @zakkster/lite-bvh — Zero-GC Dynamic Bounding Volume Hierarchy (2D)
 *
 * Flat-array Structure-of-Arrays (SoA) layout. One contiguous block per
 * tree field; nodes are referenced by index, not by object reference.
 * Internal free-list provides O(1) node allocation / deallocation with no
 * GC pressure during gameplay.
 *
 * Algorithm: Box2D-style dynamic AABB tree (Erin Catto). Insert uses the
 * Surface Area Heuristic; remove heals the gap by promoting the sibling;
 * update has a fast path that does nothing when the tight bounds are still
 * contained inside the fat bounds. The refit walk rebalances with Box2D-style
 * single rotations (`_balance`), so an adversarial insert order (e.g. a
 * monotone sweep) can no longer degrade the tree into a linked list -- height
 * stays O(log n), which is what keeps `query` shallow and allocation-free.
 *
 * Leaf-AABB format: `Float32Array(4)` -> `[minX, minY, maxX, maxY]`,
 * compatible with `@zakkster/lite-aabb`.
 *
 * @license MIT
 * @author Zahary Shinikchiev
 */

/**
 * `children[id<<1]` doubles as a tri-state liveness marker, which is what makes
 * O(1) handle validation possible without a traversal:
 *   -1  -> a live LEAF (both child slots -1, set by _allocateNode)
 *  >=0  -> an INTERNAL node (a real left child)
 *   -2  -> a FREED slot (set by _freeNode; also the initial fill)
 * So `children[id<<1] === -1` is true for exactly the live leaves.
 */
const FREED = -2;

/**
 * Upper bound on `maxNodes`. Node fields are addressed by `id << 2` (bboxes),
 * so ids must stay well inside the positive int32 range; 2^26 nodes is already
 * ~1 GB of bboxes and far below that limit. Anything larger is a caller error.
 */
const MAX_NODES = 1 << 26;

export class DynamicBVH2D {
    /** Maximum number of nodes (leaves + internal). Set at construction. */
    maxNodes;

    // ---- SoA tree data ----
    /** Float32Array(maxNodes * 4) — `[minX, minY, maxX, maxY]` per node. */
    bboxes;
    /** Int32Array(maxNodes) — parent node id, or -1 for the root. */
    parents;
    /** Int32Array(maxNodes * 2) — `[leftChild, rightChild]`, both -1 for leaves. */
    children;
    /** Int32Array(maxNodes) — subtree height; 0 for leaves. */
    heights;
    /** Int32Array(maxNodes) — user data per leaf (e.g. ECS entity id). -1 for internal nodes. */
    userData;

    // ---- Free-list allocator ----
    /** Int32Array(maxNodes) — chain of free node ids. */
    nextFree;
    /** Head of the free-list chain (-1 = full). */
    freeHead = 0;
    /** Currently allocated node count (leaves + internal). */
    nodeCount = 0;

    /** Root node id, or -1 if the tree is empty. */
    root = -1;

    // ---- Traversal scratch ----
    /**
     * Stack reused across all `query()` calls. Fixed size, NEVER grows: the
     * iterative DFS uses at most `height + 1` slots, and with rotations keeping
     * height at O(log n) the 256 slots here are only exhausted by a tree of
     * height 255 -- a balanced tree of ~2^250 nodes, far beyond the 2^26 node
     * cap. Overflow therefore means the tree is more degenerate than rotations
     * permit, i.e. corruption; `query` throws (fail-closed) rather than silently
     * allocating a bigger stack inside the hot loop (the old B-08 behaviour).
     */
    queryStack = new Int32Array(256);

    /** Internal scratch AABB for re-insertion fattening. Never exposed. */
    _scratchAABB;

    /** Internal scratch box for `insertLeaves` to copy each packed box into,
     *  so the bulk path allocates no per-box view. Never exposed. */
    _batchScratch;

    /**
     * @param {number} maxNodes Hard cap on total nodes (leaves + internal). Internal
     *   nodes are needed too — for N leaves you'll create at most 2N-1 total nodes,
     *   so size accordingly. Typical: `maxNodes = 4 * expectedEntities`.
     */
    constructor(maxNodes) {
        // B-09: fail closed on a bad capacity with a library error, not a raw
        // RangeError from a typed-array allocator three lines down. Note a
        // two-leaf tree needs at least 3 nodes (2 leaves + 1 internal parent).
        if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_NODES) {
            throw new Error(
                'lite-bvh: maxNodes must be an integer in [1, ' + MAX_NODES + '], got ' + maxNodes);
        }
        this.maxNodes = maxNodes;

        this.bboxes   = new Float32Array(maxNodes * 4);
        this.parents  = new Int32Array(maxNodes).fill(-1);
        // Every node starts FREED (-2). _allocateNode flips a slot's left child
        // to -1 (live leaf); insertLeaf gives internal nodes real children.
        this.children = new Int32Array(maxNodes * 2).fill(FREED);
        this.heights  = new Int32Array(maxNodes);
        this.userData = new Int32Array(maxNodes).fill(-1);

        this.nextFree = new Int32Array(maxNodes);

        // Initialize free-list chain: 0 -> 1 -> 2 -> ... -> (maxNodes-1) -> -1
        for (let i = 0; i < maxNodes - 1; i++) {
            this.nextFree[i] = i + 1;
        }
        this.nextFree[maxNodes - 1] = -1;

        // Pre-allocated scratch for `updateLeaf` re-inserts (zero-GC).
        this._scratchAABB = new Float32Array(4);
        // Pre-allocated scratch for `insertLeaves` per-box copy (zero-GC).
        this._batchScratch = new Float32Array(4);
    }

    /**
     * Root height in edges: -1 for an empty tree, 0 for a single leaf, else the
     * longest root-to-leaf path. O(1) telemetry -- with rotations it tracks
     * ~ceil(log2(leafCount)); watch it to see rebalancing hold under load. */
    get height() {
        return this.root === -1 ? -1 : this.heights[this.root];
    }

    /**
     * Number of live leaves. O(1): every internal node has exactly two children,
     * so a non-empty tree has `nodeCount === 2 * leafCount - 1`. */
    get leafCount() {
        return this.root === -1 ? 0 : (this.nodeCount + 1) >> 1;
    }

    /**
     * Empties the tree back to its just-constructed state WITHOUT reallocating
     * any buffer -- for scene reloads and the torture soak tier (which would
     * otherwise allocate a fresh tree per cycle). **O(maxNodes)**, so it is not
     * a hot-path call.
     *
     * The load-bearing line is `children.fill(FREED)`: it fails closed. Every
     * slot's liveness marker is reset to FREED so any leaf handle held across a
     * `clear()` now fails `_isLiveLeaf` -- `updateLeaf`/`removeLeaf`/`getBounds`
     * on a stale id throw instead of mutating a slot the caller no longer owns.
     * Skipping it would leave the old leaves' `children[id<<1] === -1` markers
     * intact, so a pre-clear handle would masquerade as live and corrupt the
     * fresh tree. The other SoA fields (bboxes/heights/userData/parents) are
     * reset per node by `_allocateNode` on reuse, so they need no wipe here.
     */
    clear() {
        this.children.fill(FREED);
        for (let i = 0; i < this.maxNodes - 1; i++) {
            this.nextFree[i] = i + 1;
        }
        this.nextFree[this.maxNodes - 1] = -1;
        this.freeHead = 0;
        this.nodeCount = 0;
        this.root = -1;
    }

    /**
     * Reads a leaf's stored FAT bounds into a caller-owned length-4 buffer and
     * returns it -- the supported alternative to indexing the raw `bboxes` view.
     * O(1). The values are exactly what is stored (f32), i.e. the fattened box
     * from the last insert/re-insert, not the caller's original tight box.
     *
     * @param {number} leaf Live-leaf node id from `insertLeaf`/`updateLeaf`.
     * @param {Float32Array} out4 Length-4 destination, written `[minX,minY,maxX,maxY]`.
     * @returns {Float32Array} `out4`.
     * @throws On an invalid, freed, or non-leaf (internal) handle -- fail closed,
     *   like the other handle-taking methods.
     */
    getBounds(leaf, out4) {
        if ((leaf >>> 0) !== leaf || leaf >= this.maxNodes || this.children[leaf << 1] !== -1) {
            throw new Error('lite-bvh: getBounds on an invalid or non-leaf handle: ' + leaf);
        }
        const b = leaf << 2;
        out4[0] = this.bboxes[b];
        out4[1] = this.bboxes[b + 1];
        out4[2] = this.bboxes[b + 2];
        out4[3] = this.bboxes[b + 3];
        return out4;
    }

    /** Internal O(1) allocation from the free-list. */
    _allocateNode() {
        if (this.freeHead === -1) {
            throw new Error('lite-bvh: Max node capacity reached');
        }
        const nodeId = this.freeHead;
        this.freeHead = this.nextFree[nodeId];

        this.parents[nodeId] = -1;
        const cIdx = nodeId << 1;
        this.children[cIdx] = -1;
        this.children[cIdx + 1] = -1;
        this.heights[nodeId] = 0;
        this.userData[nodeId] = -1;

        this.nodeCount++;
        return nodeId;
    }

    /** Internal O(1) deallocation back to the free-list. */
    _freeNode(nodeId) {
        // Mark the slot FREED so a stale handle to it fails validation instead
        // of masquerading as a live leaf (B-04/B-06). _allocateNode resets it.
        this.children[nodeId << 1] = FREED;
        this.nextFree[nodeId] = this.freeHead;
        this.freeHead = nodeId;
        this.nodeCount--;
    }

    /**
     * True iff `id` is a currently-allocated leaf. O(1); the guard behind every
     * handle. `(id >>> 0) === id` rejects negatives, non-integers (e.g. 1.5) and
     * ids >= 2^32 in one test before the range and leaf-marker checks.
     */
    _isLiveLeaf(id) {
        return (id >>> 0) === id && id < this.maxNodes && this.children[id << 1] === -1;
    }

    /**
     * The quarantine predicate (B-03/A-05). A box may enter the tree only if all
     * four bounds are finite AND `minX <= maxX && minY <= maxY`. This is exactly
     * `@zakkster/lite-aabb`'s `isValid` (1.1.0) -- copied inline, by contract, so
     * the two packages agree on what "broken box" means with no runtime dep.
     *
     * Reading `a[3]` on a short buffer yields `undefined`, which is not finite,
     * so a 3-element input is rejected here too (T4). A plain `Array` or
     * `Float64Array` whose four values are finite and ordered is accepted and
     * coerced to f32 on store; see the `updateLeaf` note on the f32 fast-path
     * caveat for non-`Float32Array` inputs (B-11).
     */
    _isValidBox(a) {
        return Number.isFinite(a[0]) && Number.isFinite(a[1]) &&
               Number.isFinite(a[2]) && Number.isFinite(a[3]) &&
               a[0] <= a[2] && a[1] <= a[3];
    }

    /**
     * Inserts an AABB as a leaf, using the Surface Area Heuristic to pick a
     * sibling. O(log n) average. Throws when capacity is exhausted.
     *
     * @param {Float32Array} leafAABB Length-4 box. Typically pre-fattened by
     *   the caller (or `updateLeaf` will pre-fatten on re-insert).
     * @param {number} data User-defined integer (e.g. ECS entity id) returned
     *   by `query()` for matching leaves.
     * @returns {number} The new node id. **Store this** to call `updateLeaf`
     *   or `removeLeaf` later.
     */
    insertLeaf(leafAABB, data) {
        // B-03/A-05: the quarantine door. Reject a non-finite or inverted box
        // BEFORE any mutation, so poison can never reach `_refit` and propagate
        // NaN up to the root (after which every query returns 0, forever). A NaN
        // box is a valid Float32Array(4) that passes handle validation, so this
        // is a separate door from the B1 handle checks.
        if (!this._isValidBox(leafAABB)) {
            throw new Error('lite-bvh: insertLeaf rejected a non-finite or inverted box');
        }
        // B-10: userData must be a non-negative int32. `-1` is the internal-node
        // sentinel; `(data | 0) === data` rejects non-integers (3.7) and values
        // outside int32 (2**31, which would wrap negative in the Int32Array);
        // `data >= 0` reserves the whole negative half, sentinel included.
        if ((data | 0) !== data || data < 0) {
            throw new Error('lite-bvh: insertLeaf userData must be a non-negative int32, got ' + data);
        }
        // B-12: a view into the tree's own bboxes buffer aliases memory the SAH
        // descent reads while `_mergeNodesToAABB` writes it -- undefined. Forbid
        // it. A plain Array (`.buffer === undefined`) never equals bboxes.buffer.
        if (leafAABB.buffer === this.bboxes.buffer) {
            throw new Error('lite-bvh: insertLeaf leafAABB must not alias the tree bboxes buffer');
        }

        return this._insertPreValidated(leafAABB, data);
    }

    /**
     * Bulk insert of `count` boxes packed contiguously in one `Float32Array`
     * (`4*count` floats, box `i` at slots `4i..4i+3` -- the FORMAT.md packed
     * layout). The broadphase-feeding path: it reads the buffer BY INDEX, so it
     * allocates NOTHING per box (a `subarray` per box would defeat the point and
     * fail the T6 gate).
     *
     * **Batch-atomic** (fail closed): every box, every `data`, the buffer-alias
     * rule and total capacity are checked in a single pass BEFORE any mutation.
     * If any element is bad the call throws and the tree is left byte-unchanged --
     * never a partial batch. The per-box test is exactly `insertLeaf`'s door
     * (finite/non-inverted box; non-negative int32 `data`; no `bboxes` aliasing).
     *
     * @param {Float32Array} packed `4*count` floats; box `i` at `[4i, 4i+3]`.
     * @param {ArrayLike<number>} dataArray `count` userData ints, one per box.
     * @param {number} count Number of boxes to insert.
     * @returns {number} `count` (all boxes inserted, or the call threw).
     * @throws Before any mutation on: a non-integer/negative `count`; a `packed`
     *   or `dataArray` too short; a `packed` aliasing the tree's own `bboxes`; a
     *   non-finite or inverted box; a bad `data`; or insufficient capacity.
     */
    insertLeaves(packed, dataArray, count) {
        if ((count | 0) !== count || count < 0) {
            throw new Error('lite-bvh: insertLeaves count must be a non-negative int32, got ' + count);
        }
        if (count === 0) return 0;
        if (packed.length < (count << 2)) {
            throw new Error('lite-bvh: insertLeaves packed buffer holds fewer than 4*count floats');
        }
        if (dataArray.length < count) {
            throw new Error('lite-bvh: insertLeaves dataArray holds fewer than count entries');
        }
        // B-12 at the batch level: the packed buffer must not be a view into the
        // tree's own bboxes (the SAH descent reads it while _refit writes it).
        if (packed.buffer === this.bboxes.buffer) {
            throw new Error('lite-bvh: insertLeaves packed must not alias the tree bboxes buffer');
        }
        // Whole-batch capacity, up front: `count` leaves add at most `2*count`
        // nodes (each leaf may create an internal parent; the first into an empty
        // tree adds only one). Conservative by <=1 -- fail closed, no free-list walk.
        if (this.nodeCount + (count << 1) > this.maxNodes) {
            throw new Error('lite-bvh: insertLeaves needs up to ' + (count << 1) +
                ' free nodes; capacity ' + this.maxNodes + ' would be exceeded');
        }
        // Per-element quarantine, still BEFORE any mutation (batch-atomic): a
        // single bad box or data value aborts with the tree untouched. Inlined
        // `_isValidBox` on the packed slots so no per-box view is created.
        for (let k = 0, j = 0; k < count; k++, j += 4) {
            if (!(Number.isFinite(packed[j]) && Number.isFinite(packed[j + 1]) &&
                  Number.isFinite(packed[j + 2]) && Number.isFinite(packed[j + 3]) &&
                  packed[j] <= packed[j + 2] && packed[j + 1] <= packed[j + 3])) {
                throw new Error('lite-bvh: insertLeaves rejected a non-finite or inverted box at index ' + k);
            }
            const d = dataArray[k];
            if ((d | 0) !== d || d < 0) {
                throw new Error('lite-bvh: insertLeaves userData must be a non-negative int32 at index ' +
                    k + ', got ' + d);
            }
        }
        // All validated: insert. Copy each box into the reused scratch (zero
        // per-box allocation) and hand it to the shared, already-validated core.
        const s = this._batchScratch;
        for (let k = 0, j = 0; k < count; k++, j += 4) {
            s[0] = packed[j]; s[1] = packed[j + 1]; s[2] = packed[j + 2]; s[3] = packed[j + 3];
            this._insertPreValidated(s, dataArray[k]);
        }
        return count;
    }

    /**
     * Inserts a box that has ALREADY cleared the quarantine door and the
     * userData / alias checks. Shared by `insertLeaf` (single) and `insertLeaves`
     * (bulk) so the SAH descent + refit live in one place. `box4` is read by
     * index `[0..3]` -- the caller's `Float32Array` on the single path, the reused
     * `_batchScratch` on the bulk path. Still does its own atomic capacity check
     * (a redundant no-op when the bulk caller pre-reserved).
     *
     * @param {ArrayLike<number>} box4
     * @param {number} data
     * @returns {number} the new leaf id
     */
    _insertPreValidated(box4, data) {
        // B-01: reserve capacity atomically, BEFORE the first mutation. A
        // non-empty tree needs two free nodes (the leaf plus a new internal
        // parent); an empty tree needs one. Checking up front means a capacity
        // failure throws at the boundary and leaves the tree byte-unchanged and
        // still valid -- as the README promises -- instead of consuming the leaf
        // and then throwing on the parent, orphaning a node forever.
        if (this.root === -1) {
            if (this.freeHead === -1) {
                throw new Error('lite-bvh: Max node capacity reached');
            }
        } else if (this.freeHead === -1 || this.nextFree[this.freeHead] === -1) {
            throw new Error('lite-bvh: Max node capacity reached');
        }

        const leaf = this._allocateNode();

        const bIdx = leaf << 2;
        this.bboxes[bIdx]     = box4[0];
        this.bboxes[bIdx + 1] = box4[1];
        this.bboxes[bIdx + 2] = box4[2];
        this.bboxes[bIdx + 3] = box4[3];
        this.userData[leaf] = data;

        if (this.root === -1) {
            this.root = leaf;
            return leaf;
        }

        // 1. Find the best sibling for the new leaf via SAH descent.
        let searchNode = this.root;

        while (this.children[searchNode << 1] !== -1) {
            const left  = this.children[searchNode << 1];
            const right = this.children[(searchNode << 1) + 1];

            const nodeArea = this._perimeterNode(searchNode);
            const combinedArea = this._mergedPerimeter(searchNode, box4);
            const cost = 2.0 * combinedArea;
            const inheritanceCost = 2.0 * (combinedArea - nodeArea);

            // Descent cost for left child.
            let costLeft;
            if (this.children[left << 1] === -1) {
                costLeft = this._mergedPerimeter(left, box4) + inheritanceCost;
            } else {
                const oldArea = this._perimeterNode(left);
                const newArea = this._mergedPerimeter(left, box4);
                costLeft = (newArea - oldArea) + inheritanceCost;
            }

            // Descent cost for right child.
            let costRight;
            if (this.children[right << 1] === -1) {
                costRight = this._mergedPerimeter(right, box4) + inheritanceCost;
            } else {
                const oldArea = this._perimeterNode(right);
                const newArea = this._mergedPerimeter(right, box4);
                costRight = (newArea - oldArea) + inheritanceCost;
            }

            // If neither descent is cheaper than making `searchNode` the sibling, stop.
            if (cost < costLeft && cost < costRight) break;
            searchNode = costLeft < costRight ? left : right;
        }

        const sibling = searchNode;

        // 2. Create a new parent above the sibling.
        const oldParent = this.parents[sibling];
        const newParent = this._allocateNode();

        this.parents[newParent] = oldParent;
        this.userData[newParent] = -1; // internal nodes carry no user data

        this._mergeNodesToAABB(newParent, sibling, box4);
        this.heights[newParent] = this.heights[sibling] + 1;

        if (oldParent !== -1) {
            const opC = oldParent << 1;
            if (this.children[opC] === sibling) {
                this.children[opC] = newParent;
            } else {
                this.children[opC + 1] = newParent;
            }
        } else {
            this.root = newParent;
        }

        const npC = newParent << 1;
        this.children[npC] = sibling;
        this.children[npC + 1] = leaf;
        this.parents[sibling] = newParent;
        this.parents[leaf] = newParent;

        // 3. Walk back up refitting AABBs and heights.
        this._refit(leaf);

        return leaf;
    }

    /**
     * Iterative range query — finds every leaf whose AABB intersects `queryAABB`.
     * Zero allocations: matches are written into the caller-provided `outBuffer`.
     *
     * `query` is a read-only probe: it never writes the tree, so it needs no
     * quarantine door and its hot inner loop takes no validation. A degenerate
     * query box has well-defined, pinned behaviour rather than a silent trap --
     * a NaN-bearing box and the canonical empty sentinel `[Inf,Inf,-Inf,-Inf]`
     * both return 0 hits (every bbox comparison is `false`). See torture T1.
     *
     * @param {Float32Array} queryAABB Length-4 box to test against.
     * @param {Int32Array} outBuffer User-provided buffer; will receive the
     *   matching leaves' `userData` values. **The query stops early** when
     *   the buffer fills (`hitCount === outBuffer.length`), so size it to
     *   match your worst-case batch (e.g. visible entities per frame).
     * @returns {number} Hit count. Use `outBuffer.subarray(0, hitCount)` to
     *   read the filled prefix.
     * @throws Only if the traversal stack overflows -- impossible for a
     *   well-formed tree (rotations bound height to O(log n), the stack holds
     *   `height + 1`), so a throw here signals corruption. Fail-closed: it never
     *   silently grows the stack inside the hot loop (the old B-08 behaviour).
     */
    query(queryAABB, outBuffer) {
        if (this.root === -1) return 0;

        let stackPtr = 0;
        let hitCount = 0;
        let stack = this.queryStack;
        const maxHits = outBuffer.length;

        stack[stackPtr++] = this.root;

        const qMinX = queryAABB[0], qMinY = queryAABB[1];
        const qMaxX = queryAABB[2], qMaxY = queryAABB[3];

        while (stackPtr > 0) {
            const nodeId = stack[--stackPtr];
            const bIdx = nodeId << 2;

            if (this.bboxes[bIdx] <= qMaxX && this.bboxes[bIdx + 2] >= qMinX &&
                this.bboxes[bIdx + 1] <= qMaxY && this.bboxes[bIdx + 3] >= qMinY) {

                const cIdx = nodeId << 1;
                const left = this.children[cIdx];

                if (left === -1) {
                    // B-02: check BEFORE the write so a full -- or zero-length --
                    // buffer never records a phantom hit and never reports one.
                    if (hitCount >= maxHits) break;
                    outBuffer[hitCount++] = this.userData[nodeId];
                } else {
                    // Fail-closed (B-08): the stack holds at most `height + 1`
                    // ids, and rotations bound height to O(log n), so this guard
                    // never trips for a well-formed tree. If it does, the tree is
                    // corrupt/degenerate beyond what rotations allow -- throw
                    // loudly rather than silently allocating a bigger stack in the
                    // hot loop (the old behaviour, which broke the zero-GC law by
                    // data alone). The check stays: dropping it would make an
                    // overflow a silent typed-array no-op -> lost nodes -> wrong
                    // hit counts, which is worse than a throw.
                    if (stackPtr + 2 > stack.length) {
                        throw new Error('lite-bvh: query stack overflow at depth ' +
                            stackPtr + ' (stack ' + stack.length + ') -- tree is degenerate; ' +
                            'call validate()');
                    }

                    stack[stackPtr++] = left;
                    stack[stackPtr++] = this.children[cIdx + 1];
                }
            }
        }

        return hitCount;
    }

    /**
     * Point-pick query -- every leaf whose fat bounds contain `(x, y)`. The
     * picking shortcut: no AABB to build for a mouse/touch hit-test. Identical
     * in every other respect to `query` -- iterative, zero-allocation, writes
     * `userData` into `outBuffer`, stops early when it fills, same touching-edge
     * convention (a point on a boundary counts, `<=`/`>=`), same fail-closed
     * stack (it REUSES `queryStack`, so it inherits B3's no-grow policy and is
     * part of the T6 alloc gate).
     *
     * By construction this equals `query([x, y, x, y], outBuffer)`: containing a
     * point is overlapping a zero-size box at that point. Non-finite `x`/`y`
     * make every comparison false and return 0 -- no throw, matching `query`.
     *
     * @param {number} x
     * @param {number} y
     * @param {Int32Array} outBuffer Receives matching leaves' `userData`.
     * @returns {number} Hit count; read `outBuffer.subarray(0, count)`.
     * @throws Only on a traversal-stack overflow -- impossible for a well-formed
     *   tree (see `query`); a fail-closed corruption signal, never an allocation.
     */
    queryPoint(x, y, outBuffer) {
        if (this.root === -1) return 0;

        let stackPtr = 0;
        let hitCount = 0;
        const stack = this.queryStack;
        const maxHits = outBuffer.length;

        stack[stackPtr++] = this.root;

        while (stackPtr > 0) {
            const nodeId = stack[--stackPtr];
            const bIdx = nodeId << 2;

            if (this.bboxes[bIdx] <= x && this.bboxes[bIdx + 2] >= x &&
                this.bboxes[bIdx + 1] <= y && this.bboxes[bIdx + 3] >= y) {

                const cIdx = nodeId << 1;
                const left = this.children[cIdx];

                if (left === -1) {
                    if (hitCount >= maxHits) break;
                    outBuffer[hitCount++] = this.userData[nodeId];
                } else {
                    if (stackPtr + 2 > stack.length) {
                        throw new Error('lite-bvh: queryPoint stack overflow at depth ' +
                            stackPtr + ' (stack ' + stack.length + ') -- tree is degenerate; ' +
                            'call validate()');
                    }
                    stack[stackPtr++] = left;
                    stack[stackPtr++] = this.children[cIdx + 1];
                }
            }
        }

        return hitCount;
    }

    /**
     * Segment query -- every leaf whose fat bounds the segment `(p0x,p0y)`->
     * `(p1x,p1y)` touches or crosses. A slab test clamped to the segment
     * (`t` in `[0, 1]`), not an infinite ray. Iterative, zero-allocation, writes
     * `userData` into `outBuffer`, stops early when it fills, REUSES `queryStack`
     * (so it too is under the no-grow policy and the T6 gate).
     *
     * Descending only into node boxes the segment hits is complete: a parent box
     * contains both children, so any segment reaching a leaf reaches every
     * ancestor box first.
     *
     * **No callback form (by design).** A per-hit callback re-enters user code
     * mid-traversal while `queryStack` is held; a nested query from that callback
     * would corrupt the shared stack, turning reentrant-safety from true into
     * silently-false. Hits go into a caller buffer like every other query here.
     * See decisions/0004-query-kinds.md.
     *
     * A zero-length segment (`p0 === p1`) degenerates to `queryPoint(p0x, p0y)`.
     * Non-finite endpoints return 0 hits, not a throw (read-only probe).
     *
     * @param {number} p0x
     * @param {number} p0y
     * @param {number} p1x
     * @param {number} p1y
     * @param {Int32Array} outBuffer Receives matching leaves' `userData`.
     * @returns {number} Hit count; read `outBuffer.subarray(0, count)`.
     * @throws Only on a traversal-stack overflow -- impossible for a well-formed
     *   tree (see `query`); a fail-closed corruption signal, never an allocation.
     */
    raycast(p0x, p0y, p1x, p1y, outBuffer) {
        if (this.root === -1) return 0;

        // Read-only probe (matches `query`): a non-finite endpoint returns 0, not
        // a throw. Guarded ONCE up front, not per node -- the slab arithmetic does
        // not self-reject NaN the way `query`'s comparisons do (a NaN `t` leaves
        // tmin=0/tmax=1 unclamped and would spuriously match every leaf), so the
        // door has to be explicit. Off the per-hit path, so it costs the traversal
        // nothing.
        if (!(Number.isFinite(p0x) && Number.isFinite(p0y) &&
              Number.isFinite(p1x) && Number.isFinite(p1y))) {
            return 0;
        }

        const dx = p1x - p0x;
        const dy = p1y - p0y;

        // Explicit per-axis zero-direction handling rather than the branchless
        // `1/d` slab trick: when the segment starts exactly on a slab boundary
        // the reciprocal form computes `0/0 === NaN`, and a NaN silently defeats
        // the tmin/tmax clamp (every `NaN <`/`NaN >` is false). Branches are free
        // here (no allocation); NaN correctness is not. See decision 0004.
        const invDx = dx !== 0 ? 1 / dx : 0;
        const invDy = dy !== 0 ? 1 / dy : 0;

        let stackPtr = 0;
        let hitCount = 0;
        const stack = this.queryStack;
        const maxHits = outBuffer.length;

        stack[stackPtr++] = this.root;

        while (stackPtr > 0) {
            const nodeId = stack[--stackPtr];
            const b = nodeId << 2;

            // Slab clip against this node's box over t in [0, 1].
            let tmin = 0;
            let tmax = 1;
            let hit = true;

            // X slabs.
            if (dx !== 0) {
                let t1 = (this.bboxes[b]     - p0x) * invDx;
                let t2 = (this.bboxes[b + 2] - p0x) * invDx;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) hit = false;
            } else if (p0x < this.bboxes[b] || p0x > this.bboxes[b + 2]) {
                hit = false;
            }

            // Y slabs.
            if (hit) {
                if (dy !== 0) {
                    let t1 = (this.bboxes[b + 1] - p0y) * invDy;
                    let t2 = (this.bboxes[b + 3] - p0y) * invDy;
                    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                    if (t1 > tmin) tmin = t1;
                    if (t2 < tmax) tmax = t2;
                    if (tmin > tmax) hit = false;
                } else if (p0y < this.bboxes[b + 1] || p0y > this.bboxes[b + 3]) {
                    hit = false;
                }
            }

            if (hit) {
                const cIdx = nodeId << 1;
                const left = this.children[cIdx];

                if (left === -1) {
                    if (hitCount >= maxHits) break;
                    outBuffer[hitCount++] = this.userData[nodeId];
                } else {
                    if (stackPtr + 2 > stack.length) {
                        throw new Error('lite-bvh: raycast stack overflow at depth ' +
                            stackPtr + ' (stack ' + stack.length + ') -- tree is degenerate; ' +
                            'call validate()');
                    }
                    stack[stackPtr++] = left;
                    stack[stackPtr++] = this.children[cIdx + 1];
                }
            }
        }

        return hitCount;
    }

    /**
     * Removes a leaf, heals the gap by promoting its sibling, and returns
     * the node ids (leaf + parent) to the free-list. O(log n).
     *
     * @param {number} leaf Node id returned from a previous `insertLeaf`.
     */
    removeLeaf(leaf) {
        // B-04/B-05: reject anything that is not a live leaf -- non-integer,
        // negative, out of range, an internal node, or an already-freed slot --
        // before touching the tree. Inlined `_isLiveLeaf`: `(leaf >>> 0) !== leaf`
        // folds every non-uint32 into the reject path, so `children[leaf << 1]`
        // is only read for an in-range integer id.
        if ((leaf >>> 0) !== leaf || leaf >= this.maxNodes || this.children[leaf << 1] !== -1) {
            throw new Error('lite-bvh: removeLeaf on an invalid or non-leaf handle: ' + leaf);
        }

        if (leaf === this.root) {
            this.root = -1;
            this._freeNode(leaf);
            return;
        }

        const parent = this.parents[leaf];
        const grandParent = this.parents[parent];

        // Find the sibling.
        const pIdx = parent << 1;
        const sibling = this.children[pIdx] === leaf
            ? this.children[pIdx + 1]
            : this.children[pIdx];

        if (grandParent !== -1) {
            // Promote sibling: grandParent now points directly at it.
            const gpIdx = grandParent << 1;
            if (this.children[gpIdx] === parent) {
                this.children[gpIdx] = sibling;
            } else {
                this.children[gpIdx + 1] = sibling;
            }
            this.parents[sibling] = grandParent;
            this._freeNode(parent);

            // Refit from `sibling`, whose parent is now grandParent, so the walk
            // recomputes grandParent ITSELF and up. `_refit(grandParent)` would
            // start one level too high and leave grandParent's height and bbox
            // stale after the promotion -- harmless for a bbox (it stays a
            // superset, so queries only over-descend) but a stale height feeds
            // `_balance` a wrong rotation decision, so it must be correct here.
            this._refit(sibling);
        } else {
            // Parent was the root; sibling becomes the new root.
            this.root = sibling;
            this.parents[sibling] = -1;
            this._freeNode(parent);
        }

        this._freeNode(leaf);
    }

    /**
     * Updates a moving leaf. Fast path (O(1)): if the new tight bounds still
     * fit inside the existing fat bounds, nothing changes — the original
     * `leaf` id is returned. Slow path (O(log n)): the leaf is removed,
     * its bounds are fattened by `margin`, and it's re-inserted; a new node
     * id is returned. **Always reassign your stored handle from the return
     * value** — the leaf id may change.
     *
     * Pass a `Float32Array`. The fast path compares `newAABB` directly against
     * the f32-rounded stored bounds; a `Float64Array` value sitting within one
     * f32 ulp of the fat boundary can take the fast path yet lie just outside
     * the stored box, a silent query miss (B-11). Non-`Float32Array` inputs are
     * accepted and coerced on the SLOW path, never rejected -- the fast path
     * stays type-agnostic and allocation-free.
     *
     * @param {number} leaf Current node id.
     * @param {Float32Array} newAABB The exact, tight bounds of the moved object.
     * @param {number} margin Fattening to apply on the slow path. Larger margin =
     *   fewer re-inserts, larger query results. Common values: 0.1–4 world units.
     * @returns {number} The active node id (possibly === `leaf`, possibly different).
     */
    updateLeaf(leaf, newAABB, margin) {
        // B-06: reject an invalid, freed, or non-leaf handle up front so a stale
        // id cannot resurrect a removed entity. This is the ONLY validation on
        // the fast path: an integer/range test and one child-slot load (the
        // tri-state leaf sentinel). No traversal, no allocation -- measured within
        // noise of the pre-1.0.2 baseline (see decisions/0001-handle-validation.md).
        if ((leaf >>> 0) !== leaf || leaf >= this.maxNodes || this.children[leaf << 1] !== -1) {
            throw new Error('lite-bvh: updateLeaf on an invalid or non-leaf handle: ' + leaf);
        }

        const b = leaf << 2;

        // Fast path: tight bounds still inside fat bounds.
        if (this.bboxes[b]     <= newAABB[0] &&
            this.bboxes[b + 1] <= newAABB[1] &&
            this.bboxes[b + 2] >= newAABB[2] &&
            this.bboxes[b + 3] >= newAABB[3]) {
            return leaf;
        }

        // Slow path: fatten into scratch and validate the fattened box BEFORE
        // removing the leaf, so a poison update is atomic -- it throws with the
        // leaf still exactly where it was, not removed-then-orphaned. This also
        // catches a non-finite `margin` and A-05's negative-margin inversion (a
        // valid tight box + a margin more negative than half its width inverts).
        this._scratchAABB[0] = newAABB[0] - margin;
        this._scratchAABB[1] = newAABB[1] - margin;
        this._scratchAABB[2] = newAABB[2] + margin;
        this._scratchAABB[3] = newAABB[3] + margin;
        if (!this._isValidBox(this._scratchAABB)) {
            throw new Error('lite-bvh: updateLeaf rejected a non-finite or inverted fattened box');
        }

        const data = this.userData[leaf];
        this.removeLeaf(leaf);
        return this.insertLeaf(this._scratchAABB, data);
    }

    // ---- Internal helpers ----

    _perimeterNode(nodeId) {
        const b = nodeId << 2;
        return 2 * ((this.bboxes[b + 2] - this.bboxes[b]) +
                    (this.bboxes[b + 3] - this.bboxes[b + 1]));
    }

    _mergedPerimeter(nodeId, aabb) {
        const b = nodeId << 2;
        const minX = Math.min(this.bboxes[b],     aabb[0]);
        const minY = Math.min(this.bboxes[b + 1], aabb[1]);
        const maxX = Math.max(this.bboxes[b + 2], aabb[2]);
        const maxY = Math.max(this.bboxes[b + 3], aabb[3]);
        return 2 * ((maxX - minX) + (maxY - minY));
    }

    _mergeNodesToAABB(destId, sourceId, aabb) {
        const d = destId << 2;
        const s = sourceId << 2;
        this.bboxes[d]     = Math.min(this.bboxes[s],     aabb[0]);
        this.bboxes[d + 1] = Math.min(this.bboxes[s + 1], aabb[1]);
        this.bboxes[d + 2] = Math.max(this.bboxes[s + 2], aabb[2]);
        this.bboxes[d + 3] = Math.max(this.bboxes[s + 3], aabb[3]);
    }

    /** Merge the bboxes of nodes `aId` and `bId` into node `destId`. */
    _combine(destId, aId, bId) {
        const d = destId << 2, a = aId << 2, b = bId << 2;
        this.bboxes[d]     = Math.min(this.bboxes[a],     this.bboxes[b]);
        this.bboxes[d + 1] = Math.min(this.bboxes[a + 1], this.bboxes[b + 1]);
        this.bboxes[d + 2] = Math.max(this.bboxes[a + 2], this.bboxes[b + 2]);
        this.bboxes[d + 3] = Math.max(this.bboxes[a + 3], this.bboxes[b + 3]);
    }

    /**
     * One Box2D-style rotation to rebalance the subtree rooted at `iA` (B-07).
     * A faithful port of Erin Catto's `b2DynamicTree::Balance`: if A's two
     * subtrees differ in height by more than one, the taller grandchild is
     * rotated up above A. Returns the (possibly new) subtree root -- `iA`
     * itself when no rotation was needed -- after fixing every moved node's
     * parent link, bbox and height. Called once per ancestor by `_refit`, which
     * keeps the whole tree's height O(log n) regardless of insert order.
     *
     * The two branches (rotate C up / rotate B up) are written out in full
     * rather than folded into a shared helper: this is the insert/remove path,
     * not the fast path, and staying line-for-line with the reference is worth
     * more here than brevity.
     */
    _balance(iA) {
        const cA = iA << 1;
        // A leaf (child1 === -1) or a height-1 node cannot be unbalanced.
        if (this.children[cA] === -1 || this.heights[iA] < 2) return iA;

        const iB = this.children[cA];
        const iC = this.children[cA + 1];
        const balance = this.heights[iC] - this.heights[iB];

        // --- Rotate C up (right child taller) ---
        if (balance > 1) {
            const cC = iC << 1;
            const iF = this.children[cC];
            const iG = this.children[cC + 1];

            // Swap A and C: C takes A's place, A becomes C's left child.
            this.children[cC] = iA;
            this.parents[iC] = this.parents[iA];
            this.parents[iA] = iC;

            // A's old parent (now C's parent) must point at C.
            const pC = this.parents[iC];
            if (pC !== -1) {
                const cP = pC << 1;
                if (this.children[cP] === iA) this.children[cP] = iC;
                else this.children[cP + 1] = iC;
            } else {
                this.root = iC;
            }

            // Promote C's taller grandchild; the other stays under A.
            if (this.heights[iF] > this.heights[iG]) {
                this.children[cC + 1] = iF;
                this.children[cA + 1] = iG;
                this.parents[iG] = iA;
                this._combine(iA, iB, iG);
                this._combine(iC, iA, iF);
                this.heights[iA] = 1 + Math.max(this.heights[iB], this.heights[iG]);
                this.heights[iC] = 1 + Math.max(this.heights[iA], this.heights[iF]);
            } else {
                this.children[cC + 1] = iG;
                this.children[cA + 1] = iF;
                this.parents[iF] = iA;
                this._combine(iA, iB, iF);
                this._combine(iC, iA, iG);
                this.heights[iA] = 1 + Math.max(this.heights[iB], this.heights[iF]);
                this.heights[iC] = 1 + Math.max(this.heights[iA], this.heights[iG]);
            }
            return iC;
        }

        // --- Rotate B up (left child taller) ---
        if (balance < -1) {
            const cB = iB << 1;
            const iD = this.children[cB];
            const iE = this.children[cB + 1];

            // Swap A and B: B takes A's place, A becomes B's right child.
            this.children[cB + 1] = iA;
            this.parents[iB] = this.parents[iA];
            this.parents[iA] = iB;

            const pB = this.parents[iB];
            if (pB !== -1) {
                const cP = pB << 1;
                if (this.children[cP] === iA) this.children[cP] = iB;
                else this.children[cP + 1] = iB;
            } else {
                this.root = iB;
            }

            // Promote B's taller grandchild; the other stays under A.
            if (this.heights[iD] > this.heights[iE]) {
                this.children[cB] = iD;
                this.children[cA] = iE;
                this.parents[iE] = iA;
                this._combine(iA, iC, iE);
                this._combine(iB, iA, iD);
                this.heights[iA] = 1 + Math.max(this.heights[iC], this.heights[iE]);
                this.heights[iB] = 1 + Math.max(this.heights[iA], this.heights[iD]);
            } else {
                this.children[cB] = iE;
                this.children[cA] = iD;
                this.parents[iD] = iA;
                this._combine(iA, iC, iD);
                this._combine(iB, iA, iE);
                this.heights[iA] = 1 + Math.max(this.heights[iC], this.heights[iD]);
                this.heights[iB] = 1 + Math.max(this.heights[iA], this.heights[iE]);
            }
            return iB;
        }

        return iA;
    }

    _refit(nodeId) {
        let index = this.parents[nodeId];
        while (index !== -1) {
            // Rebalance first (Box2D order): `_balance` reads the children's
            // heights -- which are current at this point -- and recomputes the
            // rotated nodes. `index` may change to the subtree's new root.
            index = this._balance(index);

            const cIdx  = index << 1;
            const left  = this.children[cIdx];
            const right = this.children[cIdx + 1];

            const iB = index << 2;
            const lB = left  << 2;
            const rB = right << 2;

            this.bboxes[iB]     = Math.min(this.bboxes[lB],     this.bboxes[rB]);
            this.bboxes[iB + 1] = Math.min(this.bboxes[lB + 1], this.bboxes[rB + 1]);
            this.bboxes[iB + 2] = Math.max(this.bboxes[lB + 2], this.bboxes[rB + 2]);
            this.bboxes[iB + 3] = Math.max(this.bboxes[lB + 3], this.bboxes[rB + 3]);

            this.heights[index] = 1 + Math.max(this.heights[left], this.heights[right]);

            index = this.parents[index];
        }
    }

    /**
     * Full structural self-check. **O(n); debug and test only -- never call it
     * on a hot path.** Throws an `Error` naming the first offending node;
     * returns `true` when the tree is internally consistent. Verifies:
     *   - free-list conservation: `nodeCount + freeListLength === maxNodes`;
     *   - the free-list is acyclic and in range;
     *   - every parent/child link is reciprocal;
     *   - `heights[n] === 1 + max(child heights)`;
     *   - each internal node's bbox contains both children's bboxes;
     *   - leaves have no children; internal nodes carry `userData === -1`;
     *   - the number of reachable nodes equals `nodeCount`.
     *
     * @returns {true}
     */
    validate() {
        const max = this.maxNodes;

        // 1. Free-list: acyclic, in range, and conserving.
        let free = 0;
        for (let h = this.freeHead, guard = 0; h !== -1; h = this.nextFree[h], guard++) {
            if (guard > max) throw new Error('lite-bvh: validate: free-list is cyclic');
            if ((h >>> 0) >= max) throw new Error('lite-bvh: validate: free id out of range: ' + h);
            free++;
        }
        if (this.nodeCount + free !== max) {
            throw new Error('lite-bvh: validate: conservation violated: nodeCount ' +
                this.nodeCount + ' + free ' + free + ' != maxNodes ' + max);
        }

        // 2. Empty tree.
        if (this.root === -1) {
            if (this.nodeCount !== 0) {
                throw new Error('lite-bvh: validate: empty tree has nodeCount ' + this.nodeCount);
            }
            return true;
        }
        if ((this.root >>> 0) >= max) throw new Error('lite-bvh: validate: root out of range: ' + this.root);
        if (this.parents[this.root] !== -1) throw new Error('lite-bvh: validate: root ' + this.root + ' has a parent');

        // 3. DFS from the root: links, heights, bbox containment, node markers.
        let reachable = 0;
        const stack = [this.root];
        while (stack.length) {
            const n = stack.pop();
            reachable++;
            if (reachable > max) throw new Error('lite-bvh: validate: tree has a cycle');

            // B-03 poison detector: every stored bbox must be finite and ordered.
            // The containment test below is NaN-blind (`NaN > NaN` is false), so a
            // poisoned node would slip past it -- this catch names the offender.
            const vb = n << 2;
            if (!(Number.isFinite(this.bboxes[vb]) && Number.isFinite(this.bboxes[vb + 1]) &&
                  Number.isFinite(this.bboxes[vb + 2]) && Number.isFinite(this.bboxes[vb + 3]) &&
                  this.bboxes[vb] <= this.bboxes[vb + 2] && this.bboxes[vb + 1] <= this.bboxes[vb + 3])) {
                throw new Error('lite-bvh: validate: node ' + n + ' has a non-finite or inverted bbox');
            }

            const cIdx = n << 1;
            const l = this.children[cIdx];
            const r = this.children[cIdx + 1];

            if (l === -1) {
                // Leaf.
                if (r !== -1) throw new Error('lite-bvh: validate: half-leaf node ' + n);
                if (this.heights[n] !== 0) {
                    throw new Error('lite-bvh: validate: leaf ' + n + ' has height ' + this.heights[n]);
                }
                continue;
            }

            // Internal node.
            if ((l >>> 0) >= max || (r >>> 0) >= max) {
                throw new Error('lite-bvh: validate: node ' + n + ' has an out-of-range child');
            }
            if (this.parents[l] !== n || this.parents[r] !== n) {
                throw new Error('lite-bvh: validate: non-reciprocal parent link at node ' + n);
            }
            if (this.userData[n] !== -1) {
                throw new Error('lite-bvh: validate: internal node ' + n + ' carries userData ' + this.userData[n]);
            }
            const expectH = 1 + Math.max(this.heights[l], this.heights[r]);
            if (this.heights[n] !== expectH) {
                throw new Error('lite-bvh: validate: node ' + n + ' height ' + this.heights[n] + ' != ' + expectH);
            }
            const nb = n << 2, lb = l << 2, rb = r << 2;
            if (this.bboxes[nb]     > Math.min(this.bboxes[lb],     this.bboxes[rb]) ||
                this.bboxes[nb + 1] > Math.min(this.bboxes[lb + 1], this.bboxes[rb + 1]) ||
                this.bboxes[nb + 2] < Math.max(this.bboxes[lb + 2], this.bboxes[rb + 2]) ||
                this.bboxes[nb + 3] < Math.max(this.bboxes[lb + 3], this.bboxes[rb + 3])) {
                throw new Error('lite-bvh: validate: node ' + n + ' bbox does not contain its children');
            }

            stack.push(l, r);
        }

        if (reachable !== this.nodeCount) {
            throw new Error('lite-bvh: validate: reachable ' + reachable + ' != nodeCount ' + this.nodeCount);
        }
        return true;
    }
}

/**
 * Package version. Kept in three-place sync: this constant, `package.json`
 * `version`, and the top entry of `CHANGELOG.md`. A release that touches one
 * without the other two is a broken release.
 */
export const VERSION = '2.0.0';

/**
 * The version of the shared FORMAT contract (see FORMAT.md), NOT the package
 * version. `@zakkster/lite-aabb` exports the identical constant; the two packages
 * compare it for equality to detect a format skew. It is an integer compared for
 * equality, on a separate axis from `VERSION` -- do not sync it to semver. Copied
 * inline (not imported) so this package keeps zero runtime dependencies; the two
 * are held in agreement by the conformance test, not by a dependency edge.
 * Bumps only when the buffer layout itself changes (decisions/0005). (v2.0.0+)
 */
export const FORMAT_VERSION = 1;
