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
        this.maxNodes = maxNodes;

        this.bboxes   = new Float32Array(maxNodes * 4);
        this.parents  = new Int32Array(maxNodes).fill(-1);
        this.children = new Int32Array(maxNodes * 2).fill(-1);
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
        this.nextFree[nodeId] = this.freeHead;
        this.freeHead = nodeId;
        this.nodeCount--;
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
                    outBuffer[hitCount++] = this.userData[nodeId];
                    if (hitCount >= maxHits) break;
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
     * @param {number} leaf Current node id.
     * @param {Float32Array} newAABB The exact, tight bounds of the moved object.
     * @param {number} margin Fattening to apply on the slow path. Larger margin =
     *   fewer re-inserts, larger query results. Common values: 0.1–4 world units.
     * @returns {number} The active node id (possibly === `leaf`, possibly different).
     */
    updateLeaf(leaf, newAABB, margin) {
        const b = leaf << 2;

        // Fast path: tight bounds still inside fat bounds.
        if (this.bboxes[b]     <= newAABB[0] &&
            this.bboxes[b + 1] <= newAABB[1] &&
            this.bboxes[b + 2] >= newAABB[2] &&
            this.bboxes[b + 3] >= newAABB[3]) {
            return leaf;
        }

        // Slow path: extract user data, remove, fatten in scratch, re-insert.
        const data = this.userData[leaf];
        this.removeLeaf(leaf);

        this._scratchAABB[0] = newAABB[0] - margin;
        this._scratchAABB[1] = newAABB[1] - margin;
        this._scratchAABB[2] = newAABB[2] + margin;
        this._scratchAABB[3] = newAABB[3] + margin;

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
}
