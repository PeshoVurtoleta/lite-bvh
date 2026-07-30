/**
 * @zakkster/lite-bvh
 * Zero-GC Dynamic Bounding Volume Hierarchy (2D)
 *
 * Flat-array Structure-of-Arrays (SoA) layout. Leaf-AABB format is
 * `Float32Array(4)` — `[minX, minY, maxX, maxY]` — compatible with
 * `@zakkster/lite-aabb`.
 */

/**
 * On the SoA buffers below, `readonly` means **"do not reassign the binding"**
 * -- the tree owns and reuses these arrays for the life of the instance. It does
 * NOT mean the contents are immutable: every `insertLeaf`/`removeLeaf`/
 * `updateLeaf`/`query` writes through them in place. Treat them as read-only
 * views for introspection; never swap them out.
 */
export class DynamicBVH2D {
    /** Hard cap on total nodes (leaves + internal). */
    readonly maxNodes: number;

    /** Float32Array(maxNodes * 4) — `[minX, minY, maxX, maxY]` per node. */
    readonly bboxes: Float32Array;
    /** Int32Array(maxNodes) — parent node id, or -1 for the root. */
    readonly parents: Int32Array;
    /** Int32Array(maxNodes * 2) — `[leftChild, rightChild]`, both -1 for leaves. */
    readonly children: Int32Array;
    /** Int32Array(maxNodes) — subtree height; 0 for leaves. */
    readonly heights: Int32Array;
    /** Int32Array(maxNodes) — user data per leaf (non-negative int32; -1 marks an internal node). */
    readonly userData: Int32Array;

    /** Int32Array(maxNodes) -- free-list chain: `nextFree[id]` is the next free node id, or -1. */
    readonly nextFree: Int32Array;
    /** Head of the free-list chain, or -1 when the tree is full. */
    readonly freeHead: number;

    /** Currently allocated node count (leaves + internal). Read-only stat. */
    readonly nodeCount: number;
    /** Root node id, or -1 if the tree is empty. */
    readonly root: number;

    /**
     * Root height in edges: -1 for an empty tree, 0 for a single leaf, else the
     * longest root-to-leaf path. O(1). With rotations it tracks
     * ~ceil(log2(leafCount)); watch it to confirm rebalancing holds under load.
     */
    readonly height: number;
    /**
     * Number of live leaves. O(1): every internal node has exactly two children,
     * so a non-empty tree has `nodeCount === 2 * leafCount - 1`.
     */
    readonly leafCount: number;

    /**
     * Int32Array traversal stack reused across all `query()` calls. **Fixed size;
     * never grows.** The DFS uses at most `height + 1` slots and rotations bound
     * height to O(log n), so the 256 slots are never exhausted by a well-formed
     * tree; `query` throws (fail-closed) rather than allocate a bigger one.
     */
    readonly queryStack: Int32Array;
    /** Float32Array(4) internal scratch box for `updateLeaf` re-insert fattening. Never exposed as a result. */
    readonly _scratchAABB: Float32Array;

    /**
     * @param maxNodes Hard cap on total nodes. For N leaves you create at most
     *   2N-1 nodes, so size accordingly. Typical: `4 × expectedEntities`.
     */
    constructor(maxNodes: number);

    /**
     * Inserts a leaf using the Surface Area Heuristic. O(log n) average.
     *
     * @param leafAABB Length-4 box (typically pre-fattened by the caller). Pass a
     *   `Float32Array`; a plain `Array`/`Float64Array` is accepted and coerced by
     *   value (see `updateLeaf` for the f32 fast-path caveat).
     * @param data User integer returned by `query()`. **Must be a non-negative
     *   int32** (`[0, 2^31-1]`); `-1` is the internal-node sentinel.
     * @returns The new node id. **Store this** to call `updateLeaf`/`removeLeaf`.
     * @throws When capacity is exhausted; when `leafAABB` is non-finite or
     *   inverted (`minX > maxX` or `minY > maxY`); when `data` is not a
     *   non-negative int32; or when `leafAABB` aliases the tree's `bboxes` buffer.
     *   Every throw is atomic -- the tree is left byte-unchanged and still valid.
     */
    insertLeaf(leafAABB: Float32Array, data: number): number;

    /**
     * Bulk insert of `count` boxes packed contiguously in one `Float32Array`
     * (`4*count` floats, box `i` at slots `4i..4i+3` -- the FORMAT.md packed
     * layout). Reads the buffer by index, so it allocates nothing per box.
     *
     * **Batch-atomic**: every box, every `data`, the buffer-alias rule and total
     * capacity are validated BEFORE any mutation. A single bad element throws and
     * leaves the tree byte-unchanged -- never a partial batch. The per-box test is
     * exactly `insertLeaf`'s door.
     *
     * @param packed `4*count` floats; box `i` at `[4i, 4i+3]`.
     * @param dataArray `count` userData ints (each a non-negative int32).
     * @param count Number of boxes to insert.
     * @returns `count` (all boxes inserted, or the call threw).
     * @throws Before any mutation on a bad `count`; a `packed`/`dataArray` too
     *   short; a `packed` aliasing the tree's own `bboxes`; a non-finite or
     *   inverted box; a bad `data`; or insufficient capacity.
     */
    insertLeaves(packed: Float32Array, dataArray: ArrayLike<number>, count: number): number;

    /**
     * Empties the tree to its just-constructed state WITHOUT reallocating any
     * buffer -- for scene reloads and reset-in-place loops. **O(maxNodes)**, not
     * a hot-path call. Fails closed: every liveness marker is reset, so a leaf
     * handle held across a `clear()` throws from `updateLeaf`/`removeLeaf`/
     * `getBounds` instead of mutating a slot the caller no longer owns.
     */
    clear(): void;

    /**
     * Reads a leaf's stored FAT bounds into `out4` and returns it -- the
     * supported alternative to indexing the raw `bboxes` view. O(1). The values
     * are the fattened box from the last insert/re-insert (f32-exact), not the
     * caller's original tight box.
     *
     * @param leaf Live-leaf node id.
     * @param out4 Length-4 destination, written `[minX, minY, maxX, maxY]`.
     * @returns `out4`.
     * @throws On an invalid, freed, or non-leaf (internal) handle.
     */
    getBounds(leaf: number, out4: Float32Array): Float32Array;

    /**
     * Removes a leaf, heals the gap by promoting its sibling, and returns the
     * nodes to the free-list. O(log n). Throws on an invalid, freed, or non-leaf
     * (internal) handle.
     */
    removeLeaf(leaf: number): void;

    /**
     * Fast path (O(1)): if `newAABB` still fits inside the leaf's fat bounds,
     * nothing changes — the same id is returned.
     * Slow path (O(log n)): removes, fattens by `margin`, re-inserts; returns
     * a new id. **Always reassign your stored handle from the return value.**
     *
     * Pass a `Float32Array`: the fast path compares `newAABB` directly against
     * f32-rounded stored bounds, so a `Float64Array` value within one f32 ulp of
     * the fat boundary can take the fast path yet lie just outside the stored box
     * (a silent query miss). Non-`Float32Array` inputs are coerced on the slow
     * path only.
     *
     * @throws On an invalid/freed handle; or, on the slow path, when the fattened
     *   box would be non-finite or inverted (e.g. a non-finite `margin`, or a
     *   negative `margin` larger than half the box width). A slow-path throw is
     *   atomic -- the leaf is NOT removed.
     */
    updateLeaf(leaf: number, newAABB: Float32Array, margin: number): number;

    /**
     * Iterative AABB query. Zero allocations: matches are written into the
     * caller's `outBuffer`. Stops early when the buffer fills. Read-only -- it
     * takes no quarantine door; a non-finite or empty-sentinel query box returns
     * 0 hits rather than throwing.
     *
     * @returns Hit count. Read the prefix as `outBuffer.subarray(0, hitCount)`.
     * @throws Only on a traversal-stack overflow, which is impossible for a
     *   well-formed tree (rotations bound height to O(log n)); a throw here
     *   signals corruption. It is fail-closed -- `query` never silently grows
     *   the stack inside the loop.
     */
    query(queryAABB: Float32Array, outBuffer: Int32Array): number;

    /**
     * Point-pick query -- every leaf whose fat bounds contain `(x, y)`. Equals
     * `query([x, y, x, y], outBuffer)` by construction; skips building an AABB
     * for mouse/touch hit-tests. Iterative, zero-allocation, writes `userData`
     * into `outBuffer`, stops early when it fills, same touching-edge convention
     * as `query`. REUSES the query stack (inherits the no-grow policy). Non-finite
     * coordinates return 0, not a throw.
     *
     * @returns Hit count. Read `outBuffer.subarray(0, count)`.
     * @throws Only on a traversal-stack overflow -- impossible for a well-formed
     *   tree; fail-closed, never an allocation.
     */
    queryPoint(x: number, y: number, outBuffer: Int32Array): number;

    /**
     * Segment query -- every leaf whose fat bounds the segment `(p0x,p0y)`->
     * `(p1x,p1y)` touches or crosses (a slab test clamped to `t in [0, 1]`, not
     * an infinite ray). Iterative, zero-allocation, writes `userData` into
     * `outBuffer`, stops early when it fills, REUSES the query stack.
     *
     * **No callback form by design**: a per-hit callback would re-enter user code
     * mid-traversal while the shared stack is held, so a nested query would
     * corrupt it. Hits go into the caller buffer instead. A zero-length segment
     * degenerates to `queryPoint(p0x, p0y)`; a non-finite endpoint returns 0.
     *
     * @returns Hit count. Read `outBuffer.subarray(0, count)`.
     * @throws Only on a traversal-stack overflow -- impossible for a well-formed
     *   tree; fail-closed, never an allocation.
     */
    raycast(p0x: number, p0y: number, p1x: number, p1y: number, outBuffer: Int32Array): number;

    /**
     * Full structural self-check. **O(n); debug and test only -- never on a hot
     * path.** Throws an `Error` naming the first offending node; returns `true`
     * when the tree is internally consistent (free-list conservation, reciprocal
     * links, correct heights, bbox containment, node markers, reachable count,
     * and every stored bbox finite and non-inverted).
     */
    validate(): true;

    /** True iff `id` is a currently-allocated leaf. O(1). Internal/test guard. */
    _isLiveLeaf(id: number): boolean;

    /**
     * The quarantine predicate: all four bounds finite AND `minX <= maxX` and
     * `minY <= maxY`. O(1). Matches `@zakkster/lite-aabb`'s `isValid`.
     * Internal/test guard.
     */
    _isValidBox(a: ArrayLike<number>): boolean;

    /**
     * One Box2D-style rotation to rebalance the subtree at `iA`; returns the
     * (possibly new) subtree root. Called by the refit walk. Internal -- exposed
     * only so a control can disable rotations (assign the identity) and prove the
     * height gate can fail.
     */
    _balance(iA: number): number;
}

/** Package version. In three-place sync with `package.json` and `CHANGELOG.md`. */
export const VERSION: string;

/**
 * Version of the shared FORMAT contract (see FORMAT.md), NOT the package version.
 * `@zakkster/lite-aabb` exports the identical constant; the two are compared for
 * equality to detect a format skew. On a separate axis from `VERSION` -- it bumps
 * only when the buffer layout itself changes. Copied inline (no runtime dep on
 * lite-aabb); agreement is enforced by the conformance test.
 */
export const FORMAT_VERSION: number;
