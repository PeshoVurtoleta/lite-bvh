/**
 * T3 -- adversarial insert / remove sequences (bvh).
 *
 * Every sequence ends with `validate()` (reciprocal links, heights, bbox
 * containment, free-list conservation) AND a correctness check, so a shape that
 * corrupts the tree is caught even when a plain query still happens to return
 * the right count.
 *
 * B1 remit: insert orders, remove orders, capacity boundary, teleport churn,
 * finite margins. Height BOUNDS are NOT asserted here -- rotations are B3, so a
 * tall monotone tree is expected and only its CORRECTNESS is gated. Since B2,
 * the margin sweep also asserts that a non-finite margin is rejected atomically;
 * non-finite / inverted LEAF boxes (poison entry) are T8's cross-package tier.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { makePrng, SEED, check, conservation, reachableCount, setBox } from './harness.mjs';

/** Enclosing query hit count over a fresh out buffer. */
function countAll(tree, cap) {
    const out = new Int32Array(cap);
    const q = setBox(new Float32Array(4), -1e9, -1e9, 1e9, 1e9);
    return tree.query(q, out);
}

/** validate() + reachable/nodeCount agreement + enclosing count. */
function assertHealthy(tree, expectedLive, label) {
    tree.validate();
    check(reachableCount(tree) === tree.nodeCount,
        () => `T3.${label}: reachable ${reachableCount(tree)} != nodeCount ${tree.nodeCount}`);
    const got = countAll(tree, tree.maxNodes);
    check(got === expectedLive, () => `T3.${label}: enclosing query ${got} != ${expectedLive}`);
}

/** Insert `n` leaves whose boxes come from `boxOf(i)`; return the id array. */
function build(n, boxOf) {
    const tree = new DynamicBVH2D(4 * n + 8);
    const ids = new Int32Array(n);
    const probe = new Float32Array(4);
    for (let i = 0; i < n; i++) {
        const b = boxOf(i);
        ids[i] = tree.insertLeaf(setBox(probe, b[0], b[1], b[2], b[3]), i);
    }
    return { tree, ids };
}

const B = (a, b, c, d) => [a, b, c, d];

export function run() {
    const prng = makePrng(SEED);

    // --- insert orders -------------------------------------------------------

    // Monotone wide slabs (the B-07 degenerate shape) at two scales.
    for (const N of [1000, 20000]) {
        const { tree } = build(N, (i) => B(i, 0, i + 100, 10));
        assertHealthy(tree, N, 'monotone' + N);
    }

    // All-identical boxes.
    {
        const N = 2000;
        const { tree } = build(N, () => B(0, 0, 10, 10));
        assertHealthy(tree, N, 'identical');
    }

    // All zero-size boxes at one point.
    {
        const N = 1000;
        const { tree } = build(N, () => B(5, 5, 5, 5));
        assertHealthy(tree, N, 'zero-size-point');
    }

    // All boxes at the origin (zero-size at 0,0).
    {
        const N = 1000;
        const { tree } = build(N, () => B(0, 0, 0, 0));
        assertHealthy(tree, N, 'origin');
    }

    // Spiral order.
    {
        const N = 1500;
        const { tree } = build(N, (i) => {
            const a = i * 0.3;
            const rr = i * 0.5;
            const x = Math.cos(a) * rr;
            const y = Math.sin(a) * rr;
            return B(x, y, x + 3, y + 3);
        });
        assertHealthy(tree, N, 'spiral');
    }

    // Reverse-sorted order.
    {
        const N = 1500;
        const { tree } = build(N, (i) => { const x = (N - i) * 2; return B(x, 0, x + 5, 5); });
        assertHealthy(tree, N, 'reverse');
    }

    // --- remove orders -------------------------------------------------------

    const removeOrder = (name, orderFn) => {
        const N = 800;
        const { tree, ids } = build(N, (i) => { const x = (i * 37) % 4096, y = (i * 71) % 4096; return B(x, y, x + 3, y + 3); });
        assertHealthy(tree, N, name + '-built');
        const order = orderFn(N);
        for (let k = 0; k < order.length; k++) tree.removeLeaf(ids[order[k]]);
        check(tree.nodeCount === 0, () => `T3.${name}: nodeCount ${tree.nodeCount} != 0 after full drain`);
        check(tree.root === -1, () => `T3.${name}: root != -1 after full drain`);
        check(conservation(tree), () => `T3.${name}: conservation violated after drain`);
        tree.validate();
    };

    removeOrder('remove-forward', (n) => Array.from({ length: n }, (_, i) => i));
    removeOrder('remove-reverse', (n) => Array.from({ length: n }, (_, i) => n - 1 - i));
    removeOrder('remove-random', (n) => {
        const a = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) { const j = prng() % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
        return a;
    });

    // --- insert/remove alternating exactly at the free-list boundary ---------
    {
        // maxNodes = 4 fits a two-leaf tree (3 nodes) with one spare. Alternate
        // insert-to-full / remove so the allocator churns the boundary slot.
        const tree = new DynamicBVH2D(4);
        const probe = new Float32Array(4);
        let live = tree.insertLeaf(setBox(probe, 0, 0, 1, 1), 0);
        for (let k = 0; k < 500; k++) {
            const b = tree.insertLeaf(setBox(probe, k, k, k + 1, k + 1), 1);
            // Now full (3 nodes + 1 spare used by internal). Next insert must throw.
            check(conservation(tree), () => `T3.boundary: conservation broke at k=${k}`);
            tree.validate();
            tree.removeLeaf(b);
            check(conservation(tree), () => `T3.boundary: conservation broke after remove at k=${k}`);
        }
        tree.removeLeaf(live);
        check(tree.nodeCount === 0, () => 'T3.boundary: tree not empty at end');
    }

    // --- teleport churn: every entity breaches its fat bounds every frame ----
    {
        const N = 300;
        const { tree, ids } = build(N, (i) => { const x = i * 4; return B(x, 0, x + 2, 2); });
        const tight = new Float32Array(4);
        for (let frame = 1; frame <= 20; frame++) {
            for (let i = 0; i < N; i++) {
                const x = i * 4 + frame * 1000; // far outside the old fat bounds -> slow path
                ids[i] = tree.updateLeaf(ids[i], setBox(tight, x, 0, x + 2, 2), 3);
            }
        }
        assertHealthy(tree, N, 'teleport');
    }

    // --- margins: finite churns; non-finite is quarantined atomically (B2) ---
    // 0 and -1 always produce a valid fattened box (a negative margin can shrink
    // to a zero-size box -- still valid: min == max). So they churn cleanly.
    for (const margin of [0, -1]) {
        const N = 200;
        const { tree, ids } = build(N, (i) => { const x = i * 5; return B(x, 0, x + 2, 2); });
        const tight = new Float32Array(4);
        for (let i = 0; i < N; i++) {
            const x = i * 5 + 5000;
            ids[i] = tree.updateLeaf(ids[i], setBox(tight, x, 0, x + 2, 2), margin);
        }
        tree.validate();
        check(reachableCount(tree) === tree.nodeCount,
            () => `T3.margin=${margin}: reachable != nodeCount`);
    }
    // Infinity / -Infinity / NaN margins de-finite or invert the fattened box, so
    // the B2 door throws -- and it must throw ATOMICALLY, before removeLeaf, so
    // the leaf stays live and the tree byte-valid.
    for (const margin of [Infinity, -Infinity, NaN]) {
        const { tree, ids } = build(4, (i) => { const x = i * 5; return B(x, 0, x + 2, 2); });
        const tight = setBox(new Float32Array(4), 9000, 0, 9002, 2); // breaches -> slow path
        const before = tree.nodeCount;
        let threw = false;
        try { tree.updateLeaf(ids[0], tight, margin); } catch { threw = true; }
        check(threw, () => `T3.margin=${margin}: non-finite margin must throw`);
        check(tree._isLiveLeaf(ids[0]), () => `T3.margin=${margin}: leaf lost on a rejected update`);
        check(tree.nodeCount === before, () => `T3.margin=${margin}: nodeCount moved on a rejected update`);
        tree.validate();
    }

    // --- capacity boundary: maxNodes-1, maxNodes, one past (B-01) ------------
    {
        // Capacity 7 -> can hold 4 leaves (4 leaves + 3 internal = 7 nodes).
        const tree = new DynamicBVH2D(7);
        const probe = new Float32Array(4);
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push(tree.insertLeaf(setBox(probe, i * 10, 0, i * 10 + 2, 2), i));
        check(tree.nodeCount === 7, () => `T3.capacity: expected full at 7, got ${tree.nodeCount}`);
        tree.validate();
        // One past -> throw, atomically. Tree must be byte-valid afterwards.
        let threw = false;
        try { tree.insertLeaf(setBox(probe, 999, 0, 1000, 2), 99); } catch { threw = true; }
        check(threw, () => 'T3.capacity: insert past maxNodes did not throw');
        assertHealthy(tree, 4, 'capacity-after-throw');
        // Continue using the tree after the throw: remove then insert succeeds.
        tree.removeLeaf(ids[0]);
        tree.insertLeaf(setBox(probe, 500, 0, 502, 2), 500);
        assertHealthy(tree, 4, 'capacity-reuse');
    }
}
