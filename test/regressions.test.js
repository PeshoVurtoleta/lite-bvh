/**
 * @zakkster/lite-bvh -- finding regressions (B1/B2/B3/B4).
 *
 * One passing test per fixed finding, each named by its id, each ending in
 * `tree.validate()` so a fix that trades one corruption for another is caught:
 *   - B1 (v1.0.2): structural integrity -- B-01/02/04/05/06/09.
 *   - B2 (v1.1.0): poison quarantine -- B-03/10/11/12, A-05.
 *   - B3 (v1.2.0): rotations + query-stack -- B-07 (height bound) and B-08 (query
 *     no longer allocates), plus the stale-refit-on-remove fix rotations exposed.
 *   - B4 (v1.3.0): new query kinds -- B-13. clear/getBounds/queryPoint/raycast
 *     ship, and queryPoint/raycast inherit B-08's no-grow query stack.
 *
 * See decisions/0001..0004 and CHANGELOG.md.
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

// -----------------------------------------------------------------------------
// B-07 -- an adversarial (monotone) insert order must NOT degrade the tree.
// Before rotations this produced height N-1 (19,999 for 20,000 leaves), turning
// the BVH into a linked list. Rotations keep it O(log n).
// -----------------------------------------------------------------------------
test('B-07: monotone insert stays height-bounded (rotations)', () => {
    const probe = new Float32Array(4);
    for (const N of [1000, 20000]) {
        const tree = new DynamicBVH2D(4 * N + 8);
        for (let i = 0; i < N; i++) {
            probe[0] = i; probe[1] = 0; probe[2] = i + 100; probe[3] = 10;
            tree.insertLeaf(probe, i);
        }
        const bound = 2 * Math.ceil(Math.log2(N)) + 2;
        assert.ok(tree.height <= bound,
            `N=${N}: height ${tree.height} exceeds bound ${bound} (was ${N - 1} pre-rotation)`);
        assert.equal(tree.leafCount, N);
        // Every leaf is still findable -- rotations change shape, not answers.
        const out = new Int32Array(N);
        const q = Float32Array.of(-1e9, -1e9, 1e9, 1e9);
        assert.equal(tree.query(q, out), N);
        tree.validate();
    }
});

// -----------------------------------------------------------------------------
// B-08 -- a query on the (formerly) degenerate tree must not grow queryStack.
// Before rotations, a full-extent query on the height-19,999 tree grew the stack
// 256 -> 32,768 by allocating INSIDE the loop, breaking the zero-GC law by data.
// -----------------------------------------------------------------------------
test('B-08: query on an adversarial tree does not grow the stack', () => {
    const N = 20000;
    const tree = new DynamicBVH2D(4 * N + 8);
    const probe = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        probe[0] = i; probe[1] = 0; probe[2] = i + 100; probe[3] = 10;
        tree.insertLeaf(probe, i);
    }
    const stackBefore = tree.queryStack.length;
    assert.equal(stackBefore, 256, 'stack should start at its fixed 256 slots');
    const out = new Int32Array(N);
    // Full-extent query: visits every node, the worst case for stack depth.
    assert.equal(tree.query(Float32Array.of(-1e9, -1e9, 1e9, 1e9), out), N);
    assert.equal(tree.queryStack.length, stackBefore,
        `queryStack grew ${stackBefore} -> ${tree.queryStack.length} (B-08 regressed)`);
    tree.validate();
});

// -----------------------------------------------------------------------------
// Remove-refit -- a remove must recompute the grandparent it heals into. B3's
// rotations exposed that removeLeaf refit from one level too high, leaving a
// stale internal height/bbox. validate() mid-drain would flag it; here we drain
// and check after every removal.
// -----------------------------------------------------------------------------
test('remove refits the healed grandparent (no stale height mid-drain)', () => {
    const N = 600;
    const tree = new DynamicBVH2D(4 * N + 8);
    const ids = [];
    const probe = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        const x = (i * 37) % 4096, y = (i * 71) % 4096;
        probe[0] = x; probe[1] = y; probe[2] = x + 3; probe[3] = y + 3;
        ids.push(tree.insertLeaf(probe, i));
    }
    tree.validate();
    // Deterministic shuffle so the drain hits interior removals, then validate
    // after each one -- a stale grandparent height throws inside validate().
    for (let i = ids.length - 1; i > 0; i--) {
        const j = ((i * 2654435761) >>> 0) % (i + 1);
        const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }
    for (let k = 0; k < ids.length; k++) {
        tree.removeLeaf(ids[k]);
        tree.validate();
    }
    assert.equal(tree.nodeCount, 0);
    assert.equal(tree.root, -1);
});

// -----------------------------------------------------------------------------
// B-13 -- the promised query kinds ship, and the two hot ones (queryPoint,
// raycast) inherit B-08's fixed no-grow stack: probing the adversarial tree
// must not grow queryStack, exactly as query() must not.
// -----------------------------------------------------------------------------
test('B-13: queryPoint / raycast on an adversarial tree do not grow the stack', () => {
    const N = 20000;
    const tree = new DynamicBVH2D(4 * N + 8);
    const probe = new Float32Array(4);
    for (let i = 0; i < N; i++) {
        probe[0] = i; probe[1] = 0; probe[2] = i + 100; probe[3] = 10;
        tree.insertLeaf(probe, i);
    }
    const stackBefore = tree.queryStack.length;
    assert.equal(stackBefore, 256);
    const out = new Int32Array(N);

    // A point inside the overlapping slab band, and a segment spanning the whole
    // extent -- each visits deep into the (now balanced) tree.
    tree.queryPoint(N >> 1, 5, out);
    assert.equal(tree.queryStack.length, stackBefore, 'queryPoint grew the stack');
    tree.raycast(-1e9, 5, 1e9, 5, out);
    assert.equal(tree.queryStack.length, stackBefore, 'raycast grew the stack');
    tree.validate();
});

// -----------------------------------------------------------------------------
// B-13 -- clear() reuses the buffers, fails closed on stale handles, and leaves
// a reusable tree whose rebuild is identical to a fresh one.
// -----------------------------------------------------------------------------
test('B-13: clear() reuses buffers, fails closed, and rebuilds identically', () => {
    const N = 400;
    const build = (t) => {
        const ids = [];
        for (let i = 0; i < N; i++) {
            const x = (i * 37) % 4096, y = (i * 71) % 4096;
            ids.push(t.insertLeaf(box(x, y, x + 3, y + 3), i));
        }
        return ids;
    };
    const full = box(-1e9, -1e9, 1e9, 1e9);
    const hits = (t) => {
        const out = new Int32Array(N);
        const n = t.query(full, out);
        return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
    };

    const fresh = new DynamicBVH2D(4 * N + 8); build(fresh);

    const reused = new DynamicBVH2D(4 * N + 8);
    const bboxes = reused.bboxes, children = reused.children;
    const staleIds = build(reused);
    reused.clear();
    reused.validate();
    assert.equal(reused.bboxes, bboxes, 'clear reallocated bboxes');
    assert.equal(reused.children, children, 'clear reallocated children');
    // Fail closed: every pre-clear handle is dead.
    for (const id of staleIds) {
        assert.throws(() => reused.removeLeaf(id), /invalid or non-leaf handle/);
    }
    build(reused);
    assert.deepEqual(hits(reused), hits(fresh), 'rebuild after clear diverged from fresh');
    reused.validate();
});
