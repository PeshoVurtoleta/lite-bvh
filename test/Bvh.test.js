/**
 * @zakkster/lite-bvh -- unit tests (Node built-in test runner).
 *
 *   npm test            # node --test test/*.test.js
 *
 * Ported from the pre-1.0.1 bespoke assert runner. Two things changed and
 * nothing else: the runner is now `node:test`, and the import points at the
 * implementation (`../Bvh.js`) rather than the type-declaration file
 * (`../Bvh.d.ts`), which has no method bodies and made every case throw
 * `insertLeaf is not a function`.
 *
 * The zero-allocation guarantee is exercised far more thoroughly by
 * `test/torture.mjs`; the lightweight heap-delta check at the bottom is kept
 * as a fast smoke test and only runs under `--expose-gc`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicBVH2D, VERSION } from '../Bvh.js';

function box(minX, minY, maxX, maxY) {
    const b = new Float32Array(4);
    b[0] = minX; b[1] = minY; b[2] = maxX; b[3] = maxY;
    return b;
}

function setBox(b, minX, minY, maxX, maxY) {
    b[0] = minX; b[1] = minY; b[2] = maxX; b[3] = maxY;
    return b;
}

/** Sorted, deduplicated user-data hits for stable assertions. */
function queryIds(tree, query, max = 1024) {
    const out = new Int32Array(max);
    const n = tree.query(query, out);
    return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
}

// =============================================================================
// PACKAGE METADATA
// =============================================================================

test('VERSION is exported and in three-place sync', () => {
    assert.equal(VERSION, '1.3.0');
});

// =============================================================================
// CONSTRUCTION
// =============================================================================

test('constructor allocates SoA buffers of correct sizes', () => {
    const tree = new DynamicBVH2D(100);
    assert.equal(tree.bboxes.length, 400);
    assert.equal(tree.parents.length, 100);
    assert.equal(tree.children.length, 200);
    assert.equal(tree.heights.length, 100);
    assert.equal(tree.userData.length, 100);
    assert.equal(tree.maxNodes, 100);
    assert.equal(tree.root, -1);
    assert.equal(tree.nodeCount, 0);
});

test('constructor builds a valid free-list chain', () => {
    const tree = new DynamicBVH2D(5);
    assert.equal(tree.freeHead, 0);
    assert.equal(tree.nextFree[0], 1);
    assert.equal(tree.nextFree[1], 2);
    assert.equal(tree.nextFree[2], 3);
    assert.equal(tree.nextFree[3], 4);
    assert.equal(tree.nextFree[4], -1);
});

// =============================================================================
// INSERT
// =============================================================================

test('first insert becomes the root, no internal node', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 42);
    assert.equal(tree.root, leaf);
    assert.equal(tree.nodeCount, 1);
    assert.equal(tree.userData[leaf], 42);
    // No children on a single-leaf tree.
    assert.equal(tree.children[leaf << 1], -1);
});

test('second insert creates an internal parent', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const b = tree.insertLeaf(box(20, 20, 30, 30), 2);
    assert.notEqual(tree.root, a, 'root must no longer be leaf a');
    assert.notEqual(tree.root, b, 'root must no longer be leaf b');
    assert.equal(tree.nodeCount, 3); // 2 leaves + 1 internal
    assert.equal(tree.heights[tree.root], 1);
});

test('insert returns distinct ids for distinct leaves', () => {
    const tree = new DynamicBVH2D(16);
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
        const id = tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i);
        assert.ok(!seen.has(id), 'leaf ids must be unique');
        seen.add(id);
    }
});

test('insert throws when capacity exhausted', () => {
    const tree = new DynamicBVH2D(3); // can fit at most ~2 leaves
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(2, 2, 3, 3), 1);
    assert.throws(
        () => tree.insertLeaf(box(4, 4, 5, 5), 2), // needs a 4th node (internal)
        /capacity/,
        'expected capacity throw',
    );
});

// =============================================================================
// QUERY
// =============================================================================

test('query() on empty tree returns 0', () => {
    const tree = new DynamicBVH2D(16);
    const out = new Int32Array(4);
    assert.equal(tree.query(box(0, 0, 100, 100), out), 0);
});

test('query() finds a single leaf', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 7);
    assert.equal(queryIds(tree, box(5, 5, 6, 6)).length, 1);
    assert.equal(queryIds(tree, box(5, 5, 6, 6))[0], 7);
});

test('query() misses a non-overlapping region', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    assert.equal(tree.query(box(100, 100, 200, 200), new Int32Array(4)), 0);
});

test('query() finds multiple overlapping leaves', () => {
    const tree = new DynamicBVH2D(64);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.insertLeaf(box(5, 5, 15, 15), 2);
    tree.insertLeaf(box(8, 8, 12, 12), 3);
    tree.insertLeaf(box(100, 100, 110, 110), 4);
    const hits = queryIds(tree, box(7, 7, 9, 9));
    assert.equal(hits.join(','), '1,2,3', 'expected to find leaves 1,2,3');
});

test('query() finds all leaves with an enclosing query', () => {
    const tree = new DynamicBVH2D(128);
    const ids = [];
    for (let i = 0; i < 20; i++) {
        const id = i * 10;
        ids.push(id);
        tree.insertLeaf(box(id, id, id + 1, id + 1), id);
    }
    const hits = queryIds(tree, box(-1, -1, 1000, 1000));
    assert.equal(hits.length, 20);
});

test('query() touching edges counts as a hit', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    const hits = queryIds(tree, box(10, 0, 20, 10));
    assert.equal(hits.length, 1, 'edge-touching should hit');
});

test('query() respects outBuffer capacity and stops early', () => {
    const tree = new DynamicBVH2D(128);
    for (let i = 0; i < 30; i++) {
        tree.insertLeaf(box(0, 0, 10, 10), i);
    }
    const small = new Int32Array(5);
    const n = tree.query(box(1, 1, 9, 9), small);
    assert.equal(n, 5, 'must stop when buffer fills');
});

// =============================================================================
// REMOVE
// =============================================================================

test('remove() of the only leaf empties the tree', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.removeLeaf(leaf);
    assert.equal(tree.root, -1);
    assert.equal(tree.nodeCount, 0);
});

test('remove() of one of two leaves promotes the sibling to root', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const b = tree.insertLeaf(box(20, 20, 30, 30), 2);
    tree.removeLeaf(a);
    assert.equal(tree.root, b, 'sibling becomes root');
    assert.equal(tree.nodeCount, 1);
    assert.equal(tree.parents[b], -1, 'root has no parent');
});

test('remove() makes a leaf unfindable', () => {
    const tree = new DynamicBVH2D(64);
    const ids = [];
    for (let i = 0; i < 10; i++) {
        ids.push(tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i));
    }
    tree.removeLeaf(ids[5]);
    const hits = queryIds(tree, box(-100, -100, 1000, 100));
    assert.ok(!hits.includes(5), `expected id 5 gone, got ${hits}`);
    assert.equal(hits.length, 9);
});

test('remove() returns nodes to the free-list (capacity reusable)', () => {
    const tree = new DynamicBVH2D(8);
    const ids = [];
    for (let i = 0; i < 3; i++) {
        ids.push(tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i));
    }
    for (const id of ids) tree.removeLeaf(id);
    assert.equal(tree.nodeCount, 0);
    // Now we should be able to insert just as many again.
    for (let i = 0; i < 3; i++) {
        tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i + 100);
    }
    assert.ok(tree.nodeCount > 0);
});

// =============================================================================
// UPDATE
// =============================================================================

test('updateLeaf() fast path: bounds still contained, returns same id', () => {
    const tree = new DynamicBVH2D(16);
    // Insert a fat box from -5..15 on both axes.
    const leaf = tree.insertLeaf(box(-5, -5, 15, 15), 1);
    // Move the tight bounds within those fat bounds.
    const same = tree.updateLeaf(leaf, box(0, 0, 10, 10), 5);
    assert.equal(same, leaf, 'fast path must return original id');
});

test('updateLeaf() slow path: bounds breached, returns new id', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    // Move way outside the fat bounds.
    const newId = tree.updateLeaf(leaf, box(1000, 1000, 1010, 1010), 5);
    // After remove + reinsert, the new id will reuse a free-list slot, so it
    // might equal the old id. The contract is just "use the return value".
    // Verify the leaf is queryable at the new position only.
    const hitsOld = queryIds(tree, box(0, 0, 10, 10));
    const hitsNew = queryIds(tree, box(1000, 1000, 1010, 1010));
    assert.ok(!hitsOld.includes(1), 'leaf must no longer be at old position');
    assert.ok(hitsNew.includes(1), 'leaf must be at new position');
    assert.ok(newId >= 0, 'new id must be non-negative');
});

test('updateLeaf() preserves user data across re-insert', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 777);
    const newId = tree.updateLeaf(leaf, box(500, 500, 510, 510), 2);
    assert.equal(tree.userData[newId], 777);
});

test('updateLeaf() with margin produces wider fat bounds', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const newId = tree.updateLeaf(leaf, box(100, 100, 110, 110), 7);
    const b = newId << 2;
    assert.equal(tree.bboxes[b],     93,  'minX = 100 - 7');
    assert.equal(tree.bboxes[b + 1], 93,  'minY = 100 - 7');
    assert.equal(tree.bboxes[b + 2], 117, 'maxX = 110 + 7');
    assert.equal(tree.bboxes[b + 3], 117, 'maxY = 110 + 7');
});

// =============================================================================
// STRESS: build a 500-leaf tree and verify exhaustive query consistency
// =============================================================================

test('stress: 500 leaves, all queryable, all removable', () => {
    const N = 500;
    const tree = new DynamicBVH2D(2 * N + 16);

    // Insert leaves in a deterministic-but-varied pattern.
    const ids = new Array(N);
    for (let i = 0; i < N; i++) {
        // Pseudo-scatter so the tree isn't trivially linear.
        const x = (i * 113) % 1000;
        const y = (i * 191) % 1000;
        ids[i] = tree.insertLeaf(box(x, y, x + 5, y + 5), i);
    }

    // Every leaf must be found by its own AABB.
    for (let i = 0; i < N; i++) {
        const x = (i * 113) % 1000;
        const y = (i * 191) % 1000;
        const hits = queryIds(tree, box(x, y, x + 5, y + 5));
        assert.ok(hits.includes(i), `leaf ${i} not found`);
    }

    // Big query finds all of them.
    const all = queryIds(tree, box(-1, -1, 10000, 10000));
    assert.equal(all.length, N);

    // Remove every other one.
    for (let i = 0; i < N; i += 2) {
        tree.removeLeaf(ids[i]);
    }
    const remaining = queryIds(tree, box(-1, -1, 10000, 10000));
    assert.equal(remaining.length, N / 2);
    for (const id of remaining) {
        assert.equal(id % 2, 1, `even-numbered leaf ${id} was supposed to be removed`);
    }
});

test('stress: insert + updateLeaf cycling preserves correctness', () => {
    const tree = new DynamicBVH2D(256);
    const N = 50;

    let ids = new Array(N);
    let positions = new Array(N);
    for (let i = 0; i < N; i++) {
        positions[i] = { x: i * 5, y: 0 };
        const { x, y } = positions[i];
        ids[i] = tree.insertLeaf(box(x - 2, y - 2, x + 2, y + 2), i);
    }

    // Move every entity 10 times.
    const tight = new Float32Array(4);
    for (let frame = 0; frame < 10; frame++) {
        for (let i = 0; i < N; i++) {
            positions[i].x += 100;
            const { x, y } = positions[i];
            setBox(tight, x - 1, y - 1, x + 1, y + 1);
            ids[i] = tree.updateLeaf(ids[i], tight, 3);
        }
    }

    // Each entity should now be queryable at its new position.
    for (let i = 0; i < N; i++) {
        const { x, y } = positions[i];
        const hits = queryIds(tree, box(x, y, x, y));
        assert.ok(hits.includes(i), `entity ${i} not at expected position after movement`);
    }
});

// =============================================================================
// TELEMETRY & ROTATIONS (B3)
// =============================================================================

test('height and leafCount track the tree', () => {
    const tree = new DynamicBVH2D(64);
    assert.equal(tree.height, -1, 'empty tree height is -1');
    assert.equal(tree.leafCount, 0, 'empty tree has no leaves');

    const a = tree.insertLeaf(box(0, 0, 1, 1), 0);
    assert.equal(tree.height, 0, 'a single leaf has height 0');
    assert.equal(tree.leafCount, 1);

    tree.insertLeaf(box(5, 5, 6, 6), 1);
    assert.equal(tree.leafCount, 2);
    assert.equal(tree.height, 1, 'two leaves under one internal node -> height 1');

    for (let i = 2; i < 20; i++) tree.insertLeaf(box(i * 3, 0, i * 3 + 1, 1), i);
    assert.equal(tree.leafCount, 20);
    // 20 leaves balance to ceil(log2(20)) = 5 -ish; assert the loose bound holds.
    assert.ok(tree.height <= 2 * Math.ceil(Math.log2(20)) + 2);

    tree.removeLeaf(a);
    assert.equal(tree.leafCount, 19);
    tree.validate();
});

test('rotations keep a monotone insert order shallow (B-07)', () => {
    const N = 5000;
    const tree = new DynamicBVH2D(4 * N + 8);
    const probe = new Float32Array(4);
    for (let i = 0; i < N; i++) tree.insertLeaf(setBox(probe, i, 0, i + 100, 10), i);
    // Without rotations this is a linked list (height N-1). With them: O(log n).
    assert.ok(tree.height <= 2 * Math.ceil(Math.log2(N)) + 2,
        `monotone height ${tree.height} not bounded`);
    assert.equal(tree.leafCount, N);
    assert.equal(tree.queryStack.length, 256, 'stack never grew');
    tree.validate();
});

// =============================================================================
// QUERY KINDS (B4): clear / getBounds / queryPoint / raycast
// =============================================================================

/** Sorted userData from queryPoint. */
function pointIds(tree, x, y, max = 1024) {
    const out = new Int32Array(max);
    const n = tree.queryPoint(x, y, out);
    return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
}

/** Sorted userData from raycast. */
function rayIds(tree, p0x, p0y, p1x, p1y, max = 1024) {
    const out = new Int32Array(max);
    const n = tree.raycast(p0x, p0y, p1x, p1y, out);
    return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
}

test('clear() empties the tree without reallocating buffers', () => {
    const tree = new DynamicBVH2D(64);
    const bboxes = tree.bboxes, children = tree.children, nextFree = tree.nextFree;
    for (let i = 0; i < 10; i++) tree.insertLeaf(box(i, 0, i + 1, 1), i);

    tree.clear();

    assert.equal(tree.root, -1);
    assert.equal(tree.nodeCount, 0);
    assert.equal(tree.height, -1);
    assert.equal(tree.leafCount, 0);
    assert.equal(tree.freeHead, 0);
    // Same backing buffers -- clear() must not reallocate.
    assert.equal(tree.bboxes, bboxes, 'bboxes reallocated');
    assert.equal(tree.children, children, 'children reallocated');
    assert.equal(tree.nextFree, nextFree, 'nextFree reallocated');
    assert.equal(tree.query(box(-1, -1, 1000, 1000), new Int32Array(64)), 0);
    tree.validate();
});

test('clear() then rebuild matches a fresh tree exactly', () => {
    const build = (t) => { for (let i = 0; i < 30; i++) t.insertLeaf(box(i, i, i + 3, i + 3), i); };
    const fresh = new DynamicBVH2D(128); build(fresh);
    const reused = new DynamicBVH2D(128); build(reused); reused.clear(); build(reused);

    const q = box(4, 4, 20, 20);
    assert.deepEqual(queryIds(reused, q), queryIds(fresh, q));
    assert.equal(reused.leafCount, fresh.leafCount);
});

test('clear() fails closed: a stale handle cannot mutate the fresh tree', () => {
    const tree = new DynamicBVH2D(64);
    const stale = tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.clear();
    // The pre-clear id must no longer look like a live leaf.
    assert.throws(() => tree.updateLeaf(stale, box(0, 0, 1, 1), 0.1), /invalid or non-leaf/);
    assert.throws(() => tree.removeLeaf(stale), /invalid or non-leaf/);
    assert.throws(() => tree.getBounds(stale, new Float32Array(4)), /invalid or non-leaf/);
});

test('getBounds() reads a leaf\'s stored fat bounds, f32-exact', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const moved = tree.updateLeaf(leaf, box(100, 100, 110, 110), 7);

    const out = new Float32Array(4);
    const ret = tree.getBounds(moved, out);
    assert.equal(ret, out, 'returns the same buffer');
    // Fat bounds = tight +/- margin, f32-exact (integers here, no rounding).
    assert.deepEqual(Array.from(out), [93, 93, 117, 117]);
});

test('getBounds() throws on an invalid, freed, or internal handle', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.insertLeaf(box(20, 20, 30, 30), 2);
    const out = new Float32Array(4);
    assert.throws(() => tree.getBounds(tree.root, out), /invalid or non-leaf/); // internal
    assert.throws(() => tree.getBounds(-1, out), /invalid or non-leaf/);
    assert.throws(() => tree.getBounds(1.5, out), /invalid or non-leaf/);
    tree.removeLeaf(a);
    assert.throws(() => tree.getBounds(a, out), /invalid or non-leaf/); // freed
});

test('queryPoint() equals query() of a degenerate box at the point', () => {
    const tree = new DynamicBVH2D(128);
    for (let i = 0; i < 20; i++) tree.insertLeaf(box(i * 5, 0, i * 5 + 8, 10), i);

    for (const [x, y] of [[0, 0], [12, 5], [47, 5], [-3, 5], [100, 100], [8, 10]]) {
        assert.deepEqual(
            pointIds(tree, x, y),
            queryIds(tree, box(x, y, x, y)),
            `queryPoint(${x},${y}) != query(degenerate box)`,
        );
    }
});

test('queryPoint() counts a point on the boundary as a hit', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    assert.deepEqual(pointIds(tree, 10, 5), [1], 'right edge counts');
    assert.deepEqual(pointIds(tree, 0, 0), [1], 'corner counts');
    assert.deepEqual(pointIds(tree, 10.0001, 5), [], 'just outside misses');
});

test('queryPoint() on empty tree and with NaN returns 0, no throw', () => {
    const tree = new DynamicBVH2D(16);
    assert.equal(tree.queryPoint(0, 0, new Int32Array(4)), 0);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    assert.equal(tree.queryPoint(NaN, 5, new Int32Array(4)), 0);
    assert.equal(tree.queryPoint(5, NaN, new Int32Array(4)), 0);
});

test('raycast() hand-pinned cases', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 42); // one box

    // Miss entirely (segment above the box).
    assert.deepEqual(rayIds(tree, -5, 20, 15, 20), []);
    // Horizontal crossing through the middle.
    assert.deepEqual(rayIds(tree, -5, 5, 15, 5), [42]);
    // Starts inside, points away.
    assert.deepEqual(rayIds(tree, 5, 5, 50, 50), [42]);
    // Exactly along the left edge (touching counts).
    assert.deepEqual(rayIds(tree, 0, -5, 0, 15), [42]);
    // Parallel to and just left of the left edge -> miss.
    assert.deepEqual(rayIds(tree, -0.001, -5, -0.001, 15), []);
    // Zero-length segment inside == a point hit.
    assert.deepEqual(rayIds(tree, 5, 5, 5, 5), [42]);
    // Zero-length segment outside == miss.
    assert.deepEqual(rayIds(tree, 50, 50, 50, 50), []);
    // Segment ends before reaching the box (t would need > 1).
    assert.deepEqual(rayIds(tree, -10, 5, -5, 5), []);
});

test('raycast() zero-length segment equals queryPoint everywhere', () => {
    const tree = new DynamicBVH2D(128);
    for (let i = 0; i < 20; i++) tree.insertLeaf(box(i * 5, 0, i * 5 + 8, 10), i);
    for (const [x, y] of [[0, 0], [12, 5], [47, 5], [-3, 5], [8, 10]]) {
        assert.deepEqual(rayIds(tree, x, y, x, y), pointIds(tree, x, y),
            `raycast zero-length != queryPoint at (${x},${y})`);
    }
});

test('raycast() on empty tree and with non-finite endpoints returns 0', () => {
    const tree = new DynamicBVH2D(16);
    assert.equal(tree.raycast(0, 0, 1, 1, new Int32Array(4)), 0);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    assert.equal(tree.raycast(NaN, 0, 5, 5, new Int32Array(4)), 0);
    assert.equal(tree.raycast(0, 0, Infinity, 5, new Int32Array(4)), 0);
});

test('queryPoint / raycast respect outBuffer capacity and stop early', () => {
    const tree = new DynamicBVH2D(128);
    for (let i = 0; i < 30; i++) tree.insertLeaf(box(0, 0, 10, 10), i); // all overlap
    const small = new Int32Array(5);
    assert.equal(tree.queryPoint(5, 5, small), 5, 'queryPoint stops when buffer fills');
    assert.equal(tree.raycast(-1, 5, 11, 5, small), 5, 'raycast stops when buffer fills');
    // Zero-length buffer records nothing.
    assert.equal(tree.queryPoint(5, 5, new Int32Array(0)), 0);
    assert.equal(tree.raycast(-1, 5, 11, 5, new Int32Array(0)), 0);
});

// =============================================================================
// ZERO-ALLOCATION SMOKE TEST (thorough gate lives in test/torture.mjs)
// =============================================================================

test('query / updateLeaf hot loop is zero-alloc (requires --expose-gc)', (t) => {
    if (typeof globalThis.gc !== 'function') {
        t.skip('run with --expose-gc to enable');
        return;
    }

    const tree = new DynamicBVH2D(1024);
    const N = 200;
    const ids = new Array(N);
    for (let i = 0; i < N; i++) {
        const x = (i * 113) % 1000;
        const y = (i * 191) % 1000;
        ids[i] = tree.insertLeaf(box(x - 2, y - 2, x + 2, y + 2), i);
    }

    const queryBox = new Float32Array(4);
    const out = new Int32Array(64);
    const tight = new Float32Array(4);

    // Warmup.
    for (let i = 0; i < 1000; i++) {
        setBox(queryBox, 0, 0, 50, 50);
        tree.query(queryBox, out);
    }

    globalThis.gc();
    const before = process.memoryUsage().heapUsed;

    // Hot loop: queries + small leaf updates that hit the fast path.
    const ITERATIONS = 100_000;
    for (let i = 0; i < ITERATIONS; i++) {
        setBox(queryBox, i % 1000, (i * 7) % 1000, (i % 1000) + 20, ((i * 7) % 1000) + 20);
        tree.query(queryBox, out);

        // Slight wobble that stays inside fat bounds -> fast path.
        const idx = i % N;
        const x = (idx * 113) % 1000;
        const y = (idx * 191) % 1000;
        setBox(tight, x - 1, y - 1, x + 1, y + 1);
        tree.updateLeaf(ids[idx], tight, 3);
    }

    globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    const delta = after - before;

    assert.ok(delta < 512 * 1024, `expected < 512 KB heap growth, got ${(delta / 1024).toFixed(1)} KB`);
});
