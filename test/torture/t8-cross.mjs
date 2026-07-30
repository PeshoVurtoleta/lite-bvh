/**
 * T8 -- cross-package conformance (lite-aabb <-> lite-bvh).
 *
 * `@zakkster/lite-aabb` is a TEST-ONLY devDep here; lite-bvh has NO runtime
 * dependency on it -- the quarantine predicate `_isValidBox` is copied inline,
 * by contract, so the two packages agree on what "broken box" means without a
 * dependency edge. This tier proves that agreement three ways:
 *
 *   1. Boxes built by `aabb2` index and query correctly in the bvh (shared
 *      Float32Array(4) `[minX,minY,maxX,maxY]` format).
 *   2. The A-03 -> B-03 chain: a box that `aabb2.merge`/`extend` can POISON with
 *      a NaN is rejected at the bvh door instead of propagating to the root and
 *      silently killing every future query. This is the whole point of B2.
 *   3. lite-aabb's `isValid` and lite-bvh's door decide the SAME boxes valid --
 *      inverted (min > max) and non-finite boxes are rejected by both.
 */

import { aabb2, FORMAT_VERSION as AABB_FORMAT_VERSION } from '@zakkster/lite-aabb';
import { DynamicBVH2D, FORMAT_VERSION } from '../../Bvh.js';
import { check, setBox } from './harness.mjs';

const FULL = (b) => setBox(b, -1e9, -1e9, 1e9, 1e9);

export function run() {
    // --- 1. conformance: aabb2-built boxes index and query in the bvh --------
    {
        const tree = new DynamicBVH2D(64);
        const b = aabb2.create(0, 0, 2, 2); // Float32Array(4), same format
        check(b.length === 4, () => 'T8: aabb2.create is not a length-4 box');
        const id0 = tree.insertLeaf(b, 0);
        tree.insertLeaf(aabb2.create(10, 10, 12, 12), 1);
        const out = new Int32Array(8);
        check(tree.query(aabb2.create(-1, -1, 3, 3), out) === 1, () => 'T8: aabb2-built query missed');
        check(out[0] === 0, () => 'T8: aabb2-built query returned the wrong leaf');
        check(tree._isLiveLeaf(id0), () => 'T8: leaf not live after aabb2 conformance');
        tree.validate();
    }

    // --- layout conformance: both agree on [minX,minY,maxX,maxY] -------------
    {
        const b = aabb2.create(1, 2, 3, 4);
        check(b[0] === 1 && b[1] === 2 && b[2] === 3 && b[3] === 4,
            () => 'T8: aabb2 index layout is not [minX,minY,maxX,maxY]');
        const tree = new DynamicBVH2D(8);
        const id = tree.insertLeaf(b, 0);
        const base = id << 2;
        check(tree.bboxes[base] === 1 && tree.bboxes[base + 1] === 2 &&
              tree.bboxes[base + 2] === 3 && tree.bboxes[base + 3] === 4,
            () => 'T8: bvh leaf storage layout diverged from the aabb2 format');
    }

    // --- 2. the A-03 -> B-03 chain: a merge-poisoned box must not kill the tree
    {
        const tree = new DynamicBVH2D(64);
        for (let i = 0; i < 5; i++) tree.insertLeaf(aabb2.create(i, 0, i + 1, 1), i);
        const out = new Int32Array(16);
        const q = new Float32Array(4);
        check(tree.query(FULL(q), out) === 5, () => 'T8: expected 5 live leaves before poison');
        const beforeCount = tree.nodeCount;

        // Poison a box exactly as A-03 documents: merge a good box with a NaN box.
        const poison = aabb2.create(0, 0, 1, 1);
        aabb2.merge(poison, poison, Float32Array.of(NaN, 0, 1, 1)); // poison[0] -> NaN
        check(!aabb2.isValid(poison), () => 'T8: aabb2.merge did not actually poison the box');

        // Pre-B2 this NaN reached _refit and every subsequent query returned 0.
        let threw = false;
        try { tree.insertLeaf(poison, 99); } catch { threw = true; }
        check(threw, () => 'T8: a merge-poisoned box was NOT rejected at the door (B-03)');

        // The tree is byte-identical: same count, same 5 hits, validate() clean.
        check(tree.nodeCount === beforeCount, () => 'T8: nodeCount moved on a rejected poison insert');
        const after = tree.query(FULL(q), out);
        check(after === 5, () => `T8: tree died after a poison attempt -- ${after} hits, expected 5`);
        tree.validate();
    }

    // --- extend-poison (the documented reducer) is rejected the same way -----
    {
        const tree = new DynamicBVH2D(16);
        tree.insertLeaf(aabb2.create(0, 0, 1, 1), 0);
        const acc = aabb2.setEmpty(new Float32Array(4));       // canonical empty
        aabb2.extend(acc, aabb2.create(2, 2, 3, 3));            // valid so far
        aabb2.extend(acc, Float32Array.of(NaN, NaN, NaN, NaN)); // one NaN kills the reduction
        let threw = false;
        try { tree.insertLeaf(acc, 1); } catch { threw = true; }
        check(threw, () => 'T8: an extend-poisoned accumulator was not rejected');
        tree.validate();
    }

    // --- 3. inverted box: aabb2.isValid and the bvh door agree it is invalid --
    {
        const tree = new DynamicBVH2D(16);
        const inv = Float32Array.of(5, 5, 1, 1); // minX > maxX
        check(!aabb2.isValid(inv), () => 'T8: aabb2.isValid disagrees that min>max is invalid');
        let threw = false;
        try { tree.insertLeaf(inv, 0); } catch { threw = true; }
        check(threw, () => 'T8: an inverted box was not rejected at the door');
        check(tree.root === -1 && tree.nodeCount === 0, () => 'T8: inverted-box reject left state behind');
    }

    // --- 4. the FORMAT contract (X1): both packages agree on FORMAT_VERSION ---
    check(FORMAT_VERSION === AABB_FORMAT_VERSION,
        () => `T8: FORMAT_VERSION skew -- bvh ${FORMAT_VERSION} vs aabb ${AABB_FORMAT_VERSION}`);

    // --- 5. packed round-trip: aabb2.fattenAll -> insertLeaves -> all 3 queries
    // The producer/consumer conformance the twin 2.0.0 exists for. Build a packed
    // `4*N` buffer with aabb2's batch op, feed it straight to the bvh's bulk entry
    // with no per-box view, then assert every query kind agrees with a brute-force
    // scan over the SAME fattened geometry the tree stores.
    {
        const N = 300;
        const tight = new Float32Array(4 * N);
        const fat = new Float32Array(4 * N);
        const data = new Int32Array(N);
        for (let i = 0; i < N; i++) {
            const x = (i * 131) % 2048, y = (i * 257) % 2048;
            tight[4 * i] = x; tight[4 * i + 1] = y; tight[4 * i + 2] = x + 5; tight[4 * i + 3] = y + 5;
            data[i] = i;
        }
        aabb2.fattenAll(fat, tight, 3, N); // disjoint output (FORMAT.md rule)

        const tree = new DynamicBVH2D(4 * N + 8);
        check(tree.insertLeaves(fat, data, N) === N, () => 'T8: insertLeaves did not insert every box');
        tree.validate();
        check(tree.leafCount === N, () => `T8: leafCount ${tree.leafCount} != ${N} after bulk insert`);

        const out = new Int32Array(N);
        const bOverlap = (i, x0, y0, x1, y1) =>
            fat[4 * i] <= x1 && fat[4 * i + 2] >= x0 && fat[4 * i + 1] <= y1 && fat[4 * i + 3] >= y0;

        // Box query vs oracle.
        const q = Float32Array.of(200, 200, 900, 900);
        const nBox = tree.query(q, out);
        const seenBox = new Set(Array.from(out.subarray(0, nBox)));
        let oracleBox = 0;
        for (let i = 0; i < N; i++) {
            if (bOverlap(i, q[0], q[1], q[2], q[3])) {
                oracleBox++;
                check(seenBox.has(data[i]), () => `T8: round-trip box query missed leaf ${data[i]}`);
            }
        }
        check(oracleBox === nBox, () => `T8: round-trip box query ${nBox} hits, oracle ${oracleBox}`);

        // Point query vs oracle (a point inside box 7's tight bounds).
        const px = tight[4 * 7] + 1, py = tight[4 * 7 + 1] + 1;
        const nPt = tree.queryPoint(px, py, out);
        const seenPt = new Set(Array.from(out.subarray(0, nPt)));
        let oraclePt = 0;
        for (let i = 0; i < N; i++) {
            if (bOverlap(i, px, py, px, py)) {
                oraclePt++;
                check(seenPt.has(data[i]), () => `T8: round-trip point query missed leaf ${data[i]}`);
            }
        }
        check(oraclePt === nPt, () => `T8: round-trip point query ${nPt} hits, oracle ${oraclePt}`);
    }
}
