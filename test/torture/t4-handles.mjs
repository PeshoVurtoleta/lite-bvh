/**
 * T4 -- handle and buffer abuse (bvh).
 *
 * Each case has a DECIDED policy -- throw, or a documented count -- never
 * "silently returns garbage". B1 owns the handle-validation and buffer-length
 * policies; B2 adds the input-quarantine block at the bottom (B-10/B-11/B-12
 * and the short-buffer case), which was deferred here as a marker until the
 * lite-aabb degenerate-value law (A2) defined "broken box".
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

    // --- B2 input quarantine: boxes, userData, aliasing ----------------------
    {
        const tree = new DynamicBVH2D(32);

        // Short buffer (3 elements): a[3] is undefined -> not finite -> throw.
        // Pre-B2 this stored a NaN maxY and poisoned the tree (B-03's door).
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1), 0), 'insertLeaf(3-element)');

        // Oversized buffer (8 elements): the first 4 are read, the rest ignored.
        const wide = Float32Array.of(0, 0, 2, 2, 9, 9, 9, 9);
        const idWide = tree.insertLeaf(wide, 0);
        check(tree._isLiveLeaf(idWide), () => 'T4: 8-element insert should succeed on the first 4');

        // Non-Float32Array boxes (B-11): finite + ordered -> ACCEPTED, coerced.
        const idArr = tree.insertLeaf([3, 3, 4, 4], 1);            // plain Array
        const idF64 = tree.insertLeaf(Float64Array.of(5, 5, 6, 6), 2); // Float64Array
        check(tree._isLiveLeaf(idArr) && tree._isLiveLeaf(idF64),
            () => 'T4: plain-Array / Float64Array boxes should be accepted and coerced');
        const out = new Int32Array(8);
        check(tree.query([2.5, 2.5, 6.5, 6.5], out) === 2, () => 'T4: coerced boxes did not index');
        // ... but a non-finite plain Array is still rejected by value.
        expectThrow(() => tree.insertLeaf([NaN, 0, 1, 1], 3), 'insertLeaf([NaN,...])');
        expectThrow(() => tree.insertLeaf([0, 0, Infinity, 1], 3), 'insertLeaf([Infinity,...])');

        // Inverted box (min > max), any container type -> throw (A-05 at the door).
        expectThrow(() => tree.insertLeaf(Float32Array.of(5, 0, 1, 1), 3), 'insertLeaf(inverted)');

        // userData (B-10): only a non-negative int32. -1 is the internal sentinel.
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1, 1), -1), 'userData -1');
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1, 1), -5), 'userData -5');
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 3.7), 'userData 3.7');
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 2 ** 31), 'userData 2**31 (wraps)');
        expectThrow(() => tree.insertLeaf(Float32Array.of(0, 0, 1, 1), NaN), 'userData NaN');
        // Boundary: 0 and INT32_MAX are the extremes of the legal range.
        check(tree._isLiveLeaf(tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 0)), () => 'T4: userData 0 rejected');
        check(tree._isLiveLeaf(tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 0x7fffffff)),
            () => 'T4: userData INT32_MAX rejected');

        // Aliasing the tree's own bboxes (B-12) -> throw. A subarray shares buffer.
        const aliased = tree.bboxes.subarray(idWide << 2, (idWide << 2) + 4);
        expectThrow(() => tree.insertLeaf(aliased, 4), 'insertLeaf(bboxes alias)');

        tree.validate();
    }
}
