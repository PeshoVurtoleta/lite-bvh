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
    /** Int32Array(maxNodes) — user data per leaf (e.g. ECS entity id). */
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
     * Int32Array traversal stack reused across all `query()` calls. Grows on
     * pathologically deep trees (see the zero-alloc caveat in the README).
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
     * @param leafAABB Length-4 box (typically pre-fattened by the caller).
     * @param data User-defined integer (e.g. ECS entity id) returned by `query()`
     *   for matching leaves.
     * @returns The new node id. **Store this** to call `updateLeaf`/`removeLeaf`.
     * @throws When `nodeCount` would exceed `maxNodes`.
     */
    insertLeaf(leafAABB: Float32Array, data: number): number;

    /**
     * Removes a leaf, heals the gap by promoting its sibling, and returns the
     * nodes to the free-list. O(log n).
     */
    removeLeaf(leaf: number): void;

    /**
     * Fast path (O(1)): if `newAABB` still fits inside the leaf's fat bounds,
     * nothing changes — the same id is returned.
     * Slow path (O(log n)): removes, fattens by `margin`, re-inserts; returns
     * a new id. **Always reassign your stored handle from the return value.**
     */
    updateLeaf(leaf: number, newAABB: Float32Array, margin: number): number;

    /**
     * Iterative AABB query. Zero allocations: matches are written into the
     * caller's `outBuffer`. Stops early when the buffer fills.
     *
     * @returns Hit count. Read the prefix as `outBuffer.subarray(0, hitCount)`.
     */
    query(queryAABB: Float32Array, outBuffer: Int32Array): number;

    /**
     * Full structural self-check. **O(n); debug and test only -- never on a hot
     * path.** Throws an `Error` naming the first offending node; returns `true`
     * when the tree is internally consistent (free-list conservation, reciprocal
     * links, correct heights, bbox containment, node markers, reachable count).
     */
    validate(): true;

    /** True iff `id` is a currently-allocated leaf. O(1). Internal/test guard. */
    _isLiveLeaf(id: number): boolean;
}

/** Package version. In three-place sync with `package.json` and `CHANGELOG.md`. */
export const VERSION: string;
