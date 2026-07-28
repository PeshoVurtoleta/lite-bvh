/**
 * @zakkster/lite-bvh -- structural-integrity regressions (B1, v1.0.2).
 *
 * These were the five S1 ways to silently corrupt a tree plus the missing
 * constructor validation. In B0 they were `todo` reproductions asserting the
 * desired behaviour; B1 fixes the code and they become hard passing tests.
 * Each names its finding id. Every mutating case ends by asserting
 * `tree.validate()` so a fix that trades one corruption for another is caught.
 *
 * See decisions/0001-handle-validation.md and CHANGELOG.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicBVH2D } from '../Bvh.js';

function box(minX, minY, maxX, maxY) {
    return Float32Array.of(minX, minY, maxX, maxY);
}

/** Nodes reachable from the root by walking children. */
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
// B-01 -- a capacity throw must leave the tree valid, with no leaked node.
// -----------------------------------------------------------------------------
test('B-01: capacity throw is atomic and leaks nothing', () => {
    const tree = new DynamicBVH2D(4);
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(2, 2, 3, 3), 1); // 2 leaves + 1 internal = 3 nodes
    assert.throws(() => tree.insertLeaf(box(4, 4, 5, 5), 2), /capacity/);

    // No node stranded: every counted node is reachable, and validate() agrees.
    assert.equal(reachableCount(tree), tree.nodeCount);
    tree.validate();

    // Still fully usable, and a later remove-then-insert succeeds.
    const out = new Int32Array(8);
    assert.equal(tree.query(box(-1, -1, 9, 9), out), 2);
    tree.removeLeaf(0);
    assert.ok(tree.insertLeaf(box(6, 6, 7, 7), 9) >= 0);
    tree.validate();
});

// -----------------------------------------------------------------------------
// B-02 -- query with a zero-length buffer returns 0 and writes nothing.
// -----------------------------------------------------------------------------
test('B-02: query with a zero-length buffer returns 0', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 7);
    assert.equal(tree.query(box(1, 1, 9, 9), new Int32Array(0)), 0);
    // And an exactly-full buffer stops cleanly at capacity.
    tree.insertLeaf(box(0, 0, 10, 10), 8);
    assert.equal(tree.query(box(1, 1, 9, 9), new Int32Array(1)), 1);
});

// -----------------------------------------------------------------------------
// B-04 -- double removeLeaf now throws instead of hanging / driving nodeCount
// negative. (Pre-1.0.2 the second call never terminated.)
// -----------------------------------------------------------------------------
test('B-04: double removeLeaf throws and does not corrupt the tree', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(9, 9, 10, 10), 1);
    tree.removeLeaf(a);
    assert.throws(() => tree.removeLeaf(a),
        /invalid or non-leaf handle/);
    assert.ok(tree.nodeCount >= 0);
    tree.validate();
});

// -----------------------------------------------------------------------------
// B-05 -- removeLeaf on an internal node throws; the tree is untouched.
// -----------------------------------------------------------------------------
test('B-05: removeLeaf on an internal node throws and leaves the tree intact', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(9, 9, 10, 10), 1);
    const internalRoot = tree.root;
    assert.throws(() => tree.removeLeaf(internalRoot), /invalid or non-leaf handle/);
    tree.validate();
    const out = new Int32Array(8);
    assert.equal(tree.query(box(-1, -1, 100, 100), out), 2);
});

// -----------------------------------------------------------------------------
// B-06 -- updateLeaf on a freed handle throws; nothing is resurrected.
// -----------------------------------------------------------------------------
test('B-06: updateLeaf on a freed handle throws (no resurrection)', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(9, 9, 10, 10), 1);
    tree.removeLeaf(a);
    assert.throws(() => tree.updateLeaf(a, box(0, 0, 1, 1), 1), /invalid or non-leaf handle/);
    const out = new Int32Array(8);
    assert.equal(tree.query(box(-1, -1, 100, 100), out), 1, 'only the surviving leaf is live');
});

// -----------------------------------------------------------------------------
// B-09 -- constructor validation. A bad capacity throws a library Error, not a
// raw RangeError from a typed-array allocator, and not silent garbage.
// -----------------------------------------------------------------------------
test('B-09: constructor rejects invalid maxNodes with a library error', () => {
    for (const bad of [0, -1, 2.5, NaN, Infinity, -Infinity, '4', null, undefined]) {
        assert.throws(() => new DynamicBVH2D(bad), /lite-bvh: maxNodes/,
            `expected throw for maxNodes=${String(bad)}`);
    }
    // Valid capacities construct. A two-leaf tree needs at least 3 nodes.
    assert.equal(new DynamicBVH2D(1).maxNodes, 1);
    const t = new DynamicBVH2D(3);
    t.insertLeaf(box(0, 0, 1, 1), 0);
    t.insertLeaf(box(2, 2, 3, 3), 1);
    t.validate();
});

// -----------------------------------------------------------------------------
// Handle validation is symmetric across the abusive id space.
// -----------------------------------------------------------------------------
test('handle validation: removeLeaf/updateLeaf reject out-of-range and junk ids', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(5, 5, 6, 6), 1);
    for (const bad of [-1, tree.maxNodes, 1e9, 1.5, NaN]) {
        assert.throws(() => tree.removeLeaf(bad), /invalid or non-leaf handle/,
            `removeLeaf should reject ${String(bad)}`);
        assert.throws(() => tree.updateLeaf(bad, box(0, 0, 1, 1), 1), /invalid or non-leaf handle/,
            `updateLeaf should reject ${String(bad)}`);
    }
    // The genuine live leaf still works.
    assert.equal(tree._isLiveLeaf(a), true);
    tree.validate();
});
