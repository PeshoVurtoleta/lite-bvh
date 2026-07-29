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
// B-03 -- one NaN leaf must NOT kill the tree. The door rejects it atomically;
// a run with a poison attempt is bit-for-bit identical to a run without one.
// (Pre-1.1.0 the NaN propagated through _refit to the root and every subsequent
// query returned 0, permanently and silently.)
// -----------------------------------------------------------------------------
test('B-03: a rejected poison insert leaves the tree identical to a clean run', () => {
    const N = 2000;
    const full = box(-1e9, -1e9, 1e9, 1e9);

    const buildClean = () => {
        const t = new DynamicBVH2D(4 * N + 8);
        for (let i = 0; i < N; i++) t.insertLeaf(box(i, 0, i + 2, 2), i);
        return t;
    };
    const hitSet = (t) => {
        const out = new Int32Array(N);
        const n = t.query(full, out);
        return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
    };

    const clean = buildClean();

    const poisoned = new DynamicBVH2D(4 * N + 8);
    for (let i = 0; i < N; i++) {
        poisoned.insertLeaf(box(i, 0, i + 2, 2), i);
        if (i === N >> 1) { // one poison attempt right in the middle
            assert.throws(() => poisoned.insertLeaf(box(NaN, 0, 1, 1), 999999),
                /non-finite or inverted/);
        }
    }

    assert.deepEqual(hitSet(poisoned), hitSet(clean), 'poison attempt perturbed the tree');
    assert.equal(poisoned.nodeCount, clean.nodeCount);
    poisoned.validate();
});

// -----------------------------------------------------------------------------
// B-10 -- userData is a non-negative int32. -1 is the internal sentinel; the
// out-of-range/non-integer values that silently wrapped or truncated now throw.
// -----------------------------------------------------------------------------
test('B-10: userData must be a non-negative int32', () => {
    const tree = new DynamicBVH2D(64);
    for (const bad of [-1, -5, 3.7, 2 ** 31, 2 ** 32, NaN, Infinity]) {
        assert.throws(() => tree.insertLeaf(box(0, 0, 1, 1), bad),
            /non-negative int32/, `userData ${String(bad)} should be rejected`);
    }
    // The legal extremes round-trip exactly through query -- no wrap, no truncation.
    const big = 0x7fffffff; // INT32_MAX
    const id = tree.insertLeaf(box(0, 0, 1, 1), big);
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    assert.ok(tree._isLiveLeaf(id));
    const out = new Int32Array(8);
    const n = tree.query(box(-1, -1, 2, 2), out);
    const seen = Array.from(out.subarray(0, n)).sort((a, b) => a - b);
    assert.deepEqual(seen, [0, big]);
});

// -----------------------------------------------------------------------------
// B-11 -- a plain Array / Float64Array box is accepted and coerced to f32 on
// store (values, not container type, are validated). A non-finite one still
// throws by value. This is the documented "coerce, do not reject" policy.
// -----------------------------------------------------------------------------
test('B-11: non-Float32Array boxes are accepted and coerced by value', () => {
    const tree = new DynamicBVH2D(64);
    const idArr = tree.insertLeaf([0, 0, 4, 4], 0);            // plain Array
    const idF64 = tree.insertLeaf(Float64Array.of(10, 10, 14, 14), 1); // Float64Array
    assert.ok(tree._isLiveLeaf(idArr) && tree._isLiveLeaf(idF64));

    // Stored as f32: read the bbox back and confirm the exact f32 value.
    const base = idArr << 2;
    assert.equal(tree.bboxes[base], Math.fround(0));
    assert.equal(tree.bboxes[base + 2], Math.fround(4));

    const out = new Int32Array(8);
    assert.equal(tree.query([1, 1, 12, 12], out), 2, 'coerced boxes did not index');

    // A non-finite plain Array is still rejected by value.
    assert.throws(() => tree.insertLeaf([NaN, 0, 1, 1], 2), /non-finite or inverted/);
    assert.throws(() => tree.insertLeaf([0, 0, 1], 2), /non-finite or inverted/); // short buffer
});

// -----------------------------------------------------------------------------
// B-12 -- a view into the tree's own bboxes buffer must not be passed to
// insertLeaf (the SAH descent reads it while _mergeNodesToAABB writes it).
// -----------------------------------------------------------------------------
test('B-12: insertLeaf rejects a box that aliases the tree bboxes buffer', () => {
    const tree = new DynamicBVH2D(64);
    const id = tree.insertLeaf(box(0, 0, 2, 2), 0);
    const aliased = tree.bboxes.subarray(id << 2, (id << 2) + 4);
    assert.throws(() => tree.insertLeaf(aliased, 1), /alias the tree bboxes buffer/);
    // A distinct Float32Array with the same values is fine.
    assert.ok(tree.insertLeaf(Float32Array.of(0, 0, 2, 2), 1) >= 0);
    tree.validate();
});

// -----------------------------------------------------------------------------
// A-05 at the door -- a negative margin that inverts the fattened box throws
// on the updateLeaf slow path, ATOMICALLY: the leaf stays live.
// -----------------------------------------------------------------------------
test('A-05: an inverting negative margin is rejected atomically on updateLeaf', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 2, 2), 0);
    tree.insertLeaf(box(50, 50, 52, 52), 1);
    // Move far enough to breach the fat bounds (force the slow path), margin -3
    // inverts [100,100,102,102] -> [103,103,99,99].
    assert.throws(() => tree.updateLeaf(a, box(100, 100, 102, 102), -3),
        /non-finite or inverted fattened box/);
    assert.ok(tree._isLiveLeaf(a), 'leaf was removed despite an atomic reject');
    tree.validate();
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
