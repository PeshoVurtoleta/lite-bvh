/**
 * T1 -- degenerate values (the simple nasty ones), QUERY side.
 *
 * These pin the ACTUAL answer for degenerate query boxes against a fixed scene.
 * Non-finite / inverted LEAF boxes (which poison the tree, B-03) are a separate
 * decision that belongs to B2's quarantine tier, not here -- B0 does not change
 * behaviour, so it only pins what is already safe.
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
}
