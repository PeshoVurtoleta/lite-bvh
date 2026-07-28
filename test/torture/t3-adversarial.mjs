/**
 * T3 -- adversarial insert sequences (bvh).
 *
 * B0 seeds ONE case: monotone insert of wide slabs, the B-07 shape. It asserts
 * only that the tree stays CORRECT and its bookkeeping stays consistent under
 * the pathological order -- it does NOT assert the height bound, because
 * rotations (which make the bound hold) are B3's job, not B0's. B1 fills in
 * the remaining sequences (all-identical, spiral, alternating at the free-list
 * boundary, remove orders, teleport churn, ...).
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { check, conservation, reachableCount, setBox } from './harness.mjs';

const N = 1000;

export function run() {
    const tree = new DynamicBVH2D(4 * N);
    const probe = new Float32Array(4);
    const out = new Int32Array(2 * N);

    // Monotonically shifted wide slabs -- the order that degrades an
    // un-rotated SAH tree toward a linked list.
    for (let i = 0; i < N; i++) {
        tree.insertLeaf(setBox(probe, i, 0, i + 100, 10), i);
    }

    // Correctness must survive the bad shape: an enclosing query still finds
    // every leaf, exactly once.
    setBox(probe, -1, -1, N + 200, 20);
    const total = tree.query(probe, out);
    check(total === N, () => `T3.monotone: expected ${N} hits, got ${total}`);

    const seen = new Uint8Array(N);
    for (let k = 0; k < total; k++) {
        const id = out[k];
        check(id >= 0 && id < N && seen[id] === 0,
            () => `T3.monotone: duplicate/out-of-range hit ${id}`);
        seen[id] = 1;
    }

    // Bookkeeping stays consistent: no leaked or double-counted nodes.
    check(conservation(tree), () => 'T3.monotone: free-list conservation violated');
    check(reachableCount(tree) === tree.nodeCount,
        () => `T3.monotone: reachable ${reachableCount(tree)} != nodeCount ${tree.nodeCount}`);
}
