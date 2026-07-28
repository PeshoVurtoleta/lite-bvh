/**
 * @zakkster/lite-bvh — unit tests
 *
 * Plain Node. Run with:
 *   node --expose-gc Bvh.test.js
 *
 * `--expose-gc` is only used for the zero-allocation guarantee at the bottom.
 */

import { DynamicBVH2D } from '../Bvh.d.ts';

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
        failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n    ${e.message}`);
    }
}

function assert(cond, msg = 'assertion failed') {
    if (!cond) throw new Error(msg);
}

function assertEq(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'expected equal'}: got ${a}, expected ${b}`);
}

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
// CONSTRUCTION
// =============================================================================

test('constructor allocates SoA buffers of correct sizes', () => {
    const tree = new DynamicBVH2D(100);
    assertEq(tree.bboxes.length, 400);
    assertEq(tree.parents.length, 100);
    assertEq(tree.children.length, 200);
    assertEq(tree.heights.length, 100);
    assertEq(tree.userData.length, 100);
    assertEq(tree.maxNodes, 100);
    assertEq(tree.root, -1);
    assertEq(tree.nodeCount, 0);
});

test('constructor builds a valid free-list chain', () => {
    const tree = new DynamicBVH2D(5);
    assertEq(tree.freeHead, 0);
    assertEq(tree.nextFree[0], 1);
    assertEq(tree.nextFree[1], 2);
    assertEq(tree.nextFree[2], 3);
    assertEq(tree.nextFree[3], 4);
    assertEq(tree.nextFree[4], -1);
});

// =============================================================================
// INSERT
// =============================================================================

test('first insert becomes the root, no internal node', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 42);
    assertEq(tree.root, leaf);
    assertEq(tree.nodeCount, 1);
    assertEq(tree.userData[leaf], 42);
    // No children on a single-leaf tree.
    assertEq(tree.children[leaf << 1], -1);
});

test('second insert creates an internal parent', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const b = tree.insertLeaf(box(20, 20, 30, 30), 2);
    assert(tree.root !== a, 'root must no longer be leaf a');
    assert(tree.root !== b, 'root must no longer be leaf b');
    assertEq(tree.nodeCount, 3); // 2 leaves + 1 internal
    assertEq(tree.heights[tree.root], 1);
});

test('insert returns distinct ids for distinct leaves', () => {
    const tree = new DynamicBVH2D(16);
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
        const id = tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i);
        assert(!seen.has(id), 'leaf ids must be unique');
        seen.add(id);
    }
});

test('insert throws when capacity exhausted', () => {
    const tree = new DynamicBVH2D(3); // can fit at most ~2 leaves
    tree.insertLeaf(box(0, 0, 1, 1), 0);
    tree.insertLeaf(box(2, 2, 3, 3), 1);
    let threw = false;
    try {
        tree.insertLeaf(box(4, 4, 5, 5), 2); // needs a 4th node (internal)
    } catch (e) {
        threw = true;
        assert(e.message.includes('capacity'), `wrong error: ${e.message}`);
    }
    assert(threw, 'expected capacity throw');
});

// =============================================================================
// QUERY
// =============================================================================

test('query() on empty tree returns 0', () => {
    const tree = new DynamicBVH2D(16);
    const out = new Int32Array(4);
    assertEq(tree.query(box(0, 0, 100, 100), out), 0);
});

test('query() finds a single leaf', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 7);
    assert(queryIds(tree, box(5, 5, 6, 6)).length === 1);
    assertEq(queryIds(tree, box(5, 5, 6, 6))[0], 7);
});

test('query() misses a non-overlapping region', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    assertEq(tree.query(box(100, 100, 200, 200), new Int32Array(4)), 0);
});

test('query() finds multiple overlapping leaves', () => {
    const tree = new DynamicBVH2D(64);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.insertLeaf(box(5, 5, 15, 15), 2);
    tree.insertLeaf(box(8, 8, 12, 12), 3);
    tree.insertLeaf(box(100, 100, 110, 110), 4);
    const hits = queryIds(tree, box(7, 7, 9, 9));
    assertEq(hits.join(','), '1,2,3', 'expected to find leaves 1,2,3');
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
    assertEq(hits.length, 20);
});

test('query() touching edges counts as a hit', () => {
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(box(0, 0, 10, 10), 1);
    const hits = queryIds(tree, box(10, 0, 20, 10));
    assertEq(hits.length, 1, 'edge-touching should hit');
});

test('query() respects outBuffer capacity and stops early', () => {
    const tree = new DynamicBVH2D(128);
    for (let i = 0; i < 30; i++) {
        tree.insertLeaf(box(0, 0, 10, 10), i);
    }
    const small = new Int32Array(5);
    const n = tree.query(box(1, 1, 9, 9), small);
    assertEq(n, 5, 'must stop when buffer fills');
});

// =============================================================================
// REMOVE
// =============================================================================

test('remove() of the only leaf empties the tree', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    tree.removeLeaf(leaf);
    assertEq(tree.root, -1);
    assertEq(tree.nodeCount, 0);
});

test('remove() of one of two leaves promotes the sibling to root', () => {
    const tree = new DynamicBVH2D(16);
    const a = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const b = tree.insertLeaf(box(20, 20, 30, 30), 2);
    tree.removeLeaf(a);
    assertEq(tree.root, b, 'sibling becomes root');
    assertEq(tree.nodeCount, 1);
    assertEq(tree.parents[b], -1, 'root has no parent');
});

test('remove() makes a leaf unfindable', () => {
    const tree = new DynamicBVH2D(64);
    const ids = [];
    for (let i = 0; i < 10; i++) {
        ids.push(tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i));
    }
    tree.removeLeaf(ids[5]);
    const hits = queryIds(tree, box(-100, -100, 1000, 100));
    assert(!hits.includes(5), `expected id 5 gone, got ${hits}`);
    assertEq(hits.length, 9);
});

test('remove() returns nodes to the free-list (capacity reusable)', () => {
    const tree = new DynamicBVH2D(8);
    const ids = [];
    for (let i = 0; i < 3; i++) {
        ids.push(tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i));
    }
    const countBefore = tree.nodeCount;
    for (const id of ids) tree.removeLeaf(id);
    assertEq(tree.nodeCount, 0);
    // Now we should be able to insert just as many again.
    for (let i = 0; i < 3; i++) {
        tree.insertLeaf(box(i * 10, 0, i * 10 + 5, 5), i + 100);
    }
    assert(tree.nodeCount > 0);
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
    assertEq(same, leaf, 'fast path must return original id');
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
    assert(!hitsOld.includes(1), 'leaf must no longer be at old position');
    assert(hitsNew.includes(1), 'leaf must be at new position');
    assert(newId >= 0, 'new id must be non-negative');
});

test('updateLeaf() preserves user data across re-insert', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 777);
    const newId = tree.updateLeaf(leaf, box(500, 500, 510, 510), 2);
    assertEq(tree.userData[newId], 777);
});

test('updateLeaf() with margin produces wider fat bounds', () => {
    const tree = new DynamicBVH2D(16);
    const leaf = tree.insertLeaf(box(0, 0, 10, 10), 1);
    const newId = tree.updateLeaf(leaf, box(100, 100, 110, 110), 7);
    const b = newId << 2;
    assertEq(tree.bboxes[b],     93,  'minX = 100 - 7');
    assertEq(tree.bboxes[b + 1], 93,  'minY = 100 - 7');
    assertEq(tree.bboxes[b + 2], 117, 'maxX = 110 + 7');
    assertEq(tree.bboxes[b + 3], 117, 'maxY = 110 + 7');
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
        assert(hits.includes(i), `leaf ${i} not found`);
    }

    // Big query finds all of them.
    const all = queryIds(tree, box(-1, -1, 10000, 10000));
    assertEq(all.length, N);

    // Remove every other one.
    for (let i = 0; i < N; i += 2) {
        tree.removeLeaf(ids[i]);
    }
    const remaining = queryIds(tree, box(-1, -1, 10000, 10000));
    assertEq(remaining.length, N / 2);
    for (const id of remaining) {
        assertEq(id % 2, 1, `even-numbered leaf ${id} was supposed to be removed`);
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
        assert(hits.includes(i), `entity ${i} not at expected position after movement`);
    }
});

// =============================================================================
// ZERO-ALLOCATION GUARANTEE
// =============================================================================

test('query / updateLeaf hot loop is zero-alloc (requires --expose-gc)', () => {
    if (typeof globalThis.gc !== 'function') {
        console.log('    \x1b[33m⚠ skipped: run with --expose-gc to enable\x1b[0m');
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

    console.log(`    heap delta over ${ITERATIONS.toLocaleString()} iterations: ${(delta / 1024).toFixed(1)} KB`);
    assert(delta < 512 * 1024, `expected < 512 KB heap growth, got ${(delta / 1024).toFixed(1)} KB`);
});

// =============================================================================
// REPORT
// =============================================================================

console.log('');
console.log('━'.repeat(60));
if (failed === 0) {
    console.log(`\x1b[32m${passed} passed, 0 failed\x1b[0m`);
    process.exit(0);
} else {
    console.log(`\x1b[31m${passed} passed, ${failed} failed\x1b[0m`);
    process.exit(1);
}
