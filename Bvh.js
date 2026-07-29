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
 * contained inside the fat bounds. No tree-rotation rebalancing yet (see
 * the TODO in `_refit`); for the workloads this is designed for (Twitch
 * extension overlays, particle systems, sprite broadphase) the SAH descent
 * already produces well-balanced trees in practice.
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
    /** Stack reused across all `query()` calls. Auto-grows on overflow. */
    queryStack = new Int32Array(256);

    /** Internal scratch AABB for re-insertion fattening. Never exposed. */
    _scratchAABB;

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
        this.bboxes[bIdx]     = leafAABB[0];
        this.bboxes[bIdx + 1] = leafAABB[1];
        this.bboxes[bIdx + 2] = leafAABB[2];
        this.bboxes[bIdx + 3] = leafAABB[3];
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
            const combinedArea = this._mergedPerimeter(searchNode, leafAABB);
            const cost = 2.0 * combinedArea;
            const inheritanceCost = 2.0 * (combinedArea - nodeArea);

            // Descent cost for left child.
            let costLeft;
            if (this.children[left << 1] === -1) {
                costLeft = this._mergedPerimeter(left, leafAABB) + inheritanceCost;
            } else {
                const oldArea = this._perimeterNode(left);
                const newArea = this._mergedPerimeter(left, leafAABB);
                costLeft = (newArea - oldArea) + inheritanceCost;
            }

            // Descent cost for right child.
            let costRight;
            if (this.children[right << 1] === -1) {
                costRight = this._mergedPerimeter(right, leafAABB) + inheritanceCost;
            } else {
                const oldArea = this._perimeterNode(right);
                const newArea = this._mergedPerimeter(right, leafAABB);
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

        this._mergeNodesToAABB(newParent, sibling, leafAABB);
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
                    // Safety: auto-grow the stack on pathologically deep trees.
                    if (stackPtr + 2 > stack.length) {
                        const newStack = new Int32Array(stack.length * 2);
                        newStack.set(stack);
                        this.queryStack = newStack;
                        stack = newStack;
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

            this._refit(grandParent);
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

    _refit(nodeId) {
        let index = this.parents[nodeId];
        while (index !== -1) {
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

            // TODO: Box2D-style left/right tree rotations would go here.
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
export const VERSION = '1.1.0';
