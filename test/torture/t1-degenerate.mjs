/**
 * T1 -- degenerate values (the simple nasty ones), QUERY side.
 *
 * The QUERY side pins the ACTUAL answer for degenerate query boxes against a
 * fixed scene (a read-only probe cannot corrupt the tree, so these are safe and
 * well-defined). The INSERT side (added in B2) crosses the same nasty values as
 * LEAF boxes and asserts the quarantine door rejects each one atomically -- a
 * poisoned leaf would otherwise propagate NaN through _refit to the root (B-03).
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { check, setBox } from './harness.mjs';

const INF = Infinity;
const F32_MAX = 3.4e38;
const SUBNORMAL = 1e-45;

export function run() {
    const tree = new DynamicBVH2D(64);
    tree.insertLeaf(Float32Array.of(0, 0, 1, 1), 0);
    tree.insertLeaf(Float32Array.of(10, 10, 11, 11), 1);
    tree.insertLeaf(Float32Array.of(-5, -5, -4, -4), 2);

    const q = new Float32Array(4);
    const out = new Int32Array(16);
    const hits = (minX, minY, maxX, maxY) => tree.query(setBox(q, minX, minY, maxX, maxY), out);

    // Zero-size query at a point inside leaf 0 -> exactly that leaf.
    check(hits(0.5, 0.5, 0.5, 0.5) === 1, () => 'T1: zero-size query inside leaf 0 must hit exactly 1');

    // Zero-size query on the shared edge (touching counts) of leaf 0.
    check(hits(1, 1, 1, 1) === 1, () => 'T1: point on leaf 0 corner must hit (touching counts)');

    // Full-extent finite query -> all three leaves.
    check(hits(-F32_MAX, -F32_MAX, F32_MAX, F32_MAX) === 3, () => 'T1: f32-max box must enclose all 3');

    // Empty sentinel query (min > max on both axes) -> no hits. qMaxX = -Inf,
    // so every finite box fails `bboxes[b] <= qMaxX`.
    check(hits(INF, INF, -INF, -INF) === 0, () => 'T1: empty sentinel query must return 0');

    // Far-away finite query -> no hits.
    check(hits(1e6, 1e6, 1e6 + 1, 1e6 + 1) === 0, () => 'T1: distant query must return 0');

    // Subnormal-sized query straddling the origin -> only leaf 0 (origin corner).
    check(hits(-SUBNORMAL, -SUBNORMAL, SUBNORMAL, SUBNORMAL) === 1,
        () => 'T1: subnormal box at origin must hit only leaf 0');

    // A query covering the negative-coordinate leaf only.
    check(hits(-6, -6, -3, -3) === 1, () => 'T1: negative-quadrant query must hit only leaf 2');

    // --- INSERT side: every degenerate LEAF box is quarantined (B2) ----------
    // The scene above stays untouched -- each rejected insert must be atomic.
    const before = tree.nodeCount;
    const p = new Float32Array(4);
    const poisons = [
        [NaN, 0, 1, 1], [0, NaN, 1, 1], [0, 0, NaN, 1], [0, 0, 1, NaN], // NaN per axis
        [INF, 0, 1, 1], [0, 0, -INF, 1],                                 // infinities
        [INF, INF, -INF, -INF],                                          // empty sentinel
        [5, 0, 1, 1], [0, 5, 1, 1],                                      // inverted per axis
    ];
    for (const box of poisons) {
        let threw = false;
        try { tree.insertLeaf(setBox(p, box[0], box[1], box[2], box[3]), 0); } catch { threw = true; }
        check(threw, () => `T1: insert of [${box}] must be quarantined`);
    }
    // The scene is byte-identical and every original leaf still queries.
    check(tree.nodeCount === before, () => 'T1: a rejected poison insert changed nodeCount');
    check(hits(-F32_MAX, -F32_MAX, F32_MAX, F32_MAX) === 3,
        () => 'T1: the tree lost leaves after poison attempts');
    tree.validate();
}
