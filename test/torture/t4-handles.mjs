/**
 * T4 -- handle and buffer abuse (bvh).
 *
 * Each case has a DECIDED policy -- throw, or a documented count -- never
 * "silently returns garbage". B1 owns the handle-validation and buffer-length
 * policies below.
 *
 * Deferred to B2 (the input-quarantine session), NOT gated here:
 *   - insertLeaf with a 3- or 8-element buffer (a short buffer poisons the tree
 *     with NaN -- that is B-03's quarantine door, not a handle question);
 *   - query / insertLeaf with a Float64Array or plain Array box (B-11);
 *   - insertLeaf with a view into the tree's own bboxes (B-12);
 *   - non-integer / out-of-range userData (B-10).
 * They are listed here as a marker so B2 knows exactly what this tier still owes.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { check, conservation, setBox } from './harness.mjs';

function expectThrow(fn, label) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(threw, () => `T4: ${label} should throw`);
}

export function run() {
    // --- handle validation: every bad id is rejected by BOTH mutators --------
    {
        const tree = new DynamicBVH2D(16);
        const a = tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 0);
        const bId = tree.insertLeaf(Float32Array.of(5, 5, 6, 6), 1);
        const internal = tree.root; // internal node id

        const badIds = [-1, tree.maxNodes, 1e9, 1.5, NaN, internal];
        for (const bad of badIds) {
            expectThrow(() => tree.removeLeaf(bad), `removeLeaf(${String(bad)})`);
            expectThrow(() => tree.updateLeaf(bad, Float32Array.of(0, 0, 1, 1), 1), `updateLeaf(${String(bad)})`);
        }

        // Double remove -> throw (pre-1.0.2 this hung).
        tree.removeLeaf(a);
        expectThrow(() => tree.removeLeaf(a), 'double removeLeaf');
        // Update a freed id -> throw (no resurrection).
        expectThrow(() => tree.updateLeaf(a, Float32Array.of(0, 0, 1, 1), 1), 'updateLeaf(freed)');
        // Update a never-allocated (but in-range) id -> throw.
        expectThrow(() => tree.updateLeaf(9, Float32Array.of(0, 0, 1, 1), 1), 'updateLeaf(never-allocated)');

        // The surviving leaf is untouched throughout.
        check(tree._isLiveLeaf(bId), () => 'T4: surviving leaf lost its liveness');
        tree.validate();
    }

    // --- query buffer lengths: 0, 1, exact-1, exact, oversized ---------------
    {
        const tree = new DynamicBVH2D(64);
        for (let i = 0; i < 8; i++) tree.insertLeaf(Float32Array.of(0, 0, 10, 10), i); // 8 overlapping
        const q = setBox(new Float32Array(4), 1, 1, 9, 9);

        check(tree.query(q, new Int32Array(0)) === 0, () => 'T4: len-0 buffer must return 0');
        check(tree.query(q, new Int32Array(1)) === 1, () => 'T4: len-1 buffer must return 1');
        check(tree.query(q, new Int32Array(7)) === 7, () => 'T4: len-(exact-1) buffer must return 7');
        check(tree.query(q, new Int32Array(8)) === 8, () => 'T4: exact buffer must return 8');
        check(tree.query(q, new Int32Array(64)) === 8, () => 'T4: oversized buffer must return 8');
    }

    // --- query an empty tree -------------------------------------------------
    {
        const tree = new DynamicBVH2D(16);
        check(tree.query(setBox(new Float32Array(4), -1, -1, 1, 1), new Int32Array(4)) === 0,
            () => 'T4: query on an empty tree must return 0');
        // ... and after building then fully draining it.
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push(tree.insertLeaf(Float32Array.of(i, 0, i + 1, 1), i));
        for (const id of ids) tree.removeLeaf(id);
        check(tree.query(setBox(new Float32Array(4), -1, -1, 100, 100), new Int32Array(4)) === 0,
            () => 'T4: query on a drained tree must return 0');
        check(conservation(tree), () => 'T4: conservation violated after drain');
        tree.validate();
    }
}
