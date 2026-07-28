/**
 * T0 -- metamorphic laws. Properties that must hold for ANY scene, checked
 * over a seeded scattered corpus. These are bvh-level invariants (the aabb
 * algebra laws live in lite-aabb's own T0).
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { makePrng, SEED, check, setBox } from './harness.mjs';

const N = 400;           // leaves in the corpus
const COORD = 2000;      // coordinate range

export function run() {
    const prng = makePrng(SEED);
    const tree = new DynamicBVH2D(4 * N);

    // Build a scattered scene once. Record each leaf's box so laws can replay it.
    const boxes = new Float32Array(4 * N);
    const ids = new Int32Array(N);
    const probe = new Float32Array(4);
    const out = new Int32Array(4 * N);

    for (let i = 0; i < N; i++) {
        const x = (prng() % COORD);
        const y = (prng() % COORD);
        const w = 1 + (prng() % 8);
        const h = 1 + (prng() % 8);
        const b = i << 2;
        boxes[b] = x; boxes[b + 1] = y; boxes[b + 2] = x + w; boxes[b + 3] = y + h;
        ids[i] = tree.insertLeaf(setBox(probe, x, y, x + w, y + h), i);
    }

    // Law 1 -- self-find: every leaf is found by a query of its own box, and
    // reports its own user data.
    for (let i = 0; i < N; i++) {
        const b = i << 2;
        setBox(probe, boxes[b], boxes[b + 1], boxes[b + 2], boxes[b + 3]);
        const n = tree.query(probe, out);
        let found = false;
        for (let k = 0; k < n; k++) if (out[k] === i) { found = true; break; }
        check(found, () => `T0.self-find: leaf ${i} not found by its own box (seed=${SEED})`);
    }

    // Law 2 -- enclosing query returns EVERY live leaf, exactly once.
    setBox(probe, -1, -1, COORD + 32, COORD + 32);
    const total = tree.query(probe, out);
    check(total === N, () => `T0.enclosing: expected ${N} hits, got ${total} (seed=${SEED})`);
    const seen = new Uint8Array(N);
    for (let k = 0; k < total; k++) {
        const id = out[k];
        check(id >= 0 && id < N && seen[id] === 0,
            () => `T0.enclosing: duplicate or out-of-range hit ${id} (seed=${SEED})`);
        seen[id] = 1;
    }

    // Law 3 -- monotonicity: a query box contained in a larger one never
    // returns more hits than the larger one.
    for (let t = 0; t < 64; t++) {
        const x = prng() % COORD, y = prng() % COORD;
        setBox(probe, x, y, x + 20, y + 20);
        const inner = tree.query(probe, out);
        setBox(probe, x - 40, y - 40, x + 60, y + 60);
        const outer = tree.query(probe, out);
        check(outer >= inner,
            () => `T0.monotone: inner ${inner} > outer ${outer} at (${x},${y}) (seed=${SEED})`);
    }

    // Law 4 -- insert/remove inverse: removing then re-inserting a leaf returns
    // the enclosing-query count to its original value.
    setBox(probe, -1, -1, COORD + 32, COORD + 32);
    const before = tree.query(probe, out);
    const victim = ids[N >> 1];
    tree.removeLeaf(victim);
    const afterRemove = tree.query(probe, out);
    check(afterRemove === before - 1,
        () => `T0.inverse: remove changed count by ${before - afterRemove}, expected 1 (seed=${SEED})`);
    const vb = (N >> 1) << 2;
    tree.insertLeaf(setBox(probe, boxes[vb], boxes[vb + 1], boxes[vb + 2], boxes[vb + 3]), N >> 1);
    setBox(probe, -1, -1, COORD + 32, COORD + 32);
    const afterReinsert = tree.query(probe, out);
    check(afterReinsert === before,
        () => `T0.inverse: reinsert count ${afterReinsert} != original ${before} (seed=${SEED})`);
}
