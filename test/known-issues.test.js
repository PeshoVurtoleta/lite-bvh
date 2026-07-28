/**
 * @zakkster/lite-bvh -- known-issue reproductions (B0 disclosure).
 *
 * Every test here is marked `{ todo: true }`. Each ASSERTS THE DESIRED,
 * CORRECT behaviour, so on the current (1.0.1) build it fails -- and node:test
 * reports a failing `todo` as an expected-failure that does NOT fail the run
 * (`npm test` still exits 0). When B1 (1.0.2) fixes the bug, drop the
 * `{ todo: true }` marker and the test becomes a hard passing regression.
 *
 * These are the five S1 ways to silently corrupt a tree with a plain-looking
 * call. Reproductions are runnable EXCEPT B-04, whose executable form does not
 * terminate on this build (documented inline) -- so it asserts the fix vehicle
 * instead of triggering the hang.
 *
 * See CHANGELOG.md "Known issues" and section 2 of the roadmap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicBVH2D } from '../Bvh.js';

function box(minX, minY, maxX, maxY) {
    return Float32Array.of(minX, minY, maxX, maxY);
}

/** Count nodes actually reachable from the root by walking children. */
function reachableCount(tree) {
    if (tree.root === -1) return 0;
    let count = 0;
    const stack = [tree.root];
    while (stack.length) {
        const n = stack.pop();
        count++;
        const l = tree.children[n << 1];
        const r = tree.children[(n << 1) + 1];
        if (l !== -1) stack.push(l);
        if (r !== -1) stack.push(r);
    }
    return count;
}

// -----------------------------------------------------------------------------
// B-01 -- capacity-exhaustion insert leaks a node and corrupts nodeCount.
// insertLeaf allocates the leaf, THEN allocates the parent; the parent
// allocation throws with the leaf already consumed, unlinked, and never
// returned to the free list. README claims the tree is "left in a valid state".
// -----------------------------------------------------------------------------
test('B-01: a capacity throw must not leak a node', { todo: true }, () => {
    const tree = new DynamicBVH2D(4);
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(2, 2, 3, 3), 1); // -> 2 leaves + 1 internal = 3 nodes
    assert.throws(() => tree.insertLeaf(box(4, 4, 5, 5), 2), /capacity/);
    // Desired: no node is stranded. Every counted node is reachable from root.
    // Today: nodeCount === 4 but only 3 nodes are reachable -- slot 3 leaked.
    assert.equal(reachableCount(tree), tree.nodeCount,
        'nodeCount counts a leaf that is neither reachable nor on the free list');
});

// -----------------------------------------------------------------------------
// B-02 -- query(q, new Int32Array(0)) returns 1 while writing nothing.
// The buffer-full check runs AFTER the write, so a zero-length buffer reports
// one phantom hit.
// -----------------------------------------------------------------------------
test('B-02: query with a zero-length buffer returns 0', { todo: true }, () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 7);
    assert.equal(tree.query(box(1, 1, 9, 9), new Int32Array(0)), 0,
        'a zero-length out buffer can hold no hits');
});

// -----------------------------------------------------------------------------
// B-04 -- double removeLeaf(id) corrupts the free-list. The documented symptom
// is nodeCount -> -1; on this build the second call walks a stale parent chain
// and NEVER TERMINATES. It therefore cannot be executed inside the runner
// (it would hang `npm test`). We assert the fix vehicle instead: B1 adds a
// handle-validation path (validate()/live-leaf check) so removeLeaf(freed)
// fails closed rather than looping.
//
// Executable reproduction (for B1, once the guard lands):
//     const a = tree.insertLeaf(box(0,0,1,1), 0);
//     tree.insertLeaf(box(9,9,10,10), 1);
//     tree.removeLeaf(a);
//     assert.throws(() => tree.removeLeaf(a));   // must throw, must not hang
// -----------------------------------------------------------------------------
test('B-04: an already-freed handle must be rejectable (no hang on double remove)',
    { todo: true }, () => {
        const tree = new DynamicBVH2D(16);
        assert.equal(typeof tree.validate, 'function',
            'B1 adds validate()/handle validation so removeLeaf(freed) fails closed');
    });

// -----------------------------------------------------------------------------
// B-05 -- removeLeaf(internalNodeId) silently destroys the tree. Passing the
// internal root of a two-leaf tree sets root -> -1 and orphans both live
// leaves; queries then return 0.
// -----------------------------------------------------------------------------
test('B-05: removeLeaf on an internal node must not destroy the tree', { todo: true }, () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(9, 9, 10, 10), 1);
    const internalRoot = tree.root; // internal node above the two leaves
    // Desired: reject the bad handle and leave the tree intact.
    assert.throws(() => tree.removeLeaf(internalRoot),
        'removeLeaf must reject a non-leaf id instead of unrooting the tree');
    const out = new Int32Array(8);
    assert.equal(tree.query(box(-1, -1, 100, 100), out), 2,
        'both live leaves must still be queryable');
});

// -----------------------------------------------------------------------------
// B-06 -- updateLeaf(freedId, ...) succeeds and resurrects a deleted entity.
// After removing leaf A, updateLeaf(A, ...) returns a node id (fast path) and
// the caller believes A is live again.
// -----------------------------------------------------------------------------
test('B-06: updateLeaf on a freed handle must not resurrect it', { todo: true }, () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(9, 9, 10, 10), 1);
    tree.removeLeaf(a);
    // Identical to A's stale bounds -> hits the fast path (no slow-path hang).
    // Desired: reject the freed handle. Today: returns an id, no throw.
    assert.throws(() => tree.updateLeaf(a, box(0, 0, 1, 1), 1),
        'updateLeaf must reject a freed handle instead of returning it');
});
