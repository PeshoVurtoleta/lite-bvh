/**
 * T4 -- handle and buffer abuse (bvh).
 *
 * B0 seeds the cases that are ALREADY well-defined and safe today, pinning
 * them so a refactor cannot regress them. The abusive cases whose current
 * behaviour is a bug (zero-length buffer -> B-02, double remove -> B-04,
 * remove-internal -> B-05, update-freed -> B-06) live in
 * `test/known-issues.test.js` as todo reproductions and are NOT gated here;
 * B1 decides their policy and moves them into this tier.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { check, conservation, setBox } from './harness.mjs';

export function run() {
    const tree = new DynamicBVH2D(64);
    const ids = [];
    for (let i = 0; i < 8; i++) {
        ids.push(tree.insertLeaf(Float32Array.of(0, 0, 10, 10), i)); // all overlapping
    }

    const probe = setBox(new Float32Array(4), 1, 1, 9, 9);

    // Oversized buffer: returns the exact hit count, not the buffer length.
    const big = new Int32Array(64);
    check(tree.query(probe, big) === 8, () => 'T4: oversized buffer must return exact hit count 8');

    // Exact-size buffer: returns all hits.
    const exact = new Int32Array(8);
    check(tree.query(probe, exact) === 8, () => 'T4: exact-size buffer must return all 8');

    // Undersized buffer: documented early-stop at capacity.
    const small = new Int32Array(3);
    check(tree.query(probe, small) === 3, () => 'T4: undersized buffer must stop early at 3');

    // Single-slot buffer: exactly one hit (early stop after first write).
    const one = new Int32Array(1);
    check(tree.query(probe, one) === 1, () => 'T4: single-slot buffer must return 1');

    // Remove in insertion order returns every node to the free list; the tree
    // empties cleanly and conservation holds throughout.
    for (const id of ids) tree.removeLeaf(id);
    check(tree.nodeCount === 0, () => `T4: nodeCount ${tree.nodeCount} != 0 after removing all`);
    check(tree.root === -1, () => 'T4: root != -1 after removing all');
    check(conservation(tree), () => 'T4: free-list conservation violated after full drain');
}
