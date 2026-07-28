/**
 * T7 -- soak and conservation.
 *
 * `leak_cycles` build-up / tear-down cycles. After EACH cycle the tree must
 * return to empty and the free-list conservation invariant must hold. A second,
 * independent witness (lite-leak) tracks a per-cycle resource and must return to
 * size 0 -- so a free-list leak and a JS-object leak cannot hide behind each
 * other. Heap is sampled ACROSS cycles, not within one.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, conservation, setBox } from './harness.mjs';

const CYCLES = 4096;
const N = 32;          // leaves built and torn down each cycle
const NOOP = function () {};

export function run() {
    const tree = new DynamicBVH2D(4 * N);
    const ids = new Int32Array(N);
    const probe = new Float32Array(4);
    const out = new Int32Array(2 * N);
    const tracker = createLeakTracker({ name: 'bvh-soak' });

    // Sample heap only at cycle boundaries, after settling, so intra-cycle
    // churn is never misread as growth.
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        // Build up.
        for (let i = 0; i < N; i++) {
            const x = (i * 37 + c) % 1024;
            const y = (i * 71 + c) % 1024;
            ids[i] = tree.insertLeaf(setBox(probe, x, y, x + 3, y + 3), i);
        }
        // A tracked external resource modelling a per-cycle allocation.
        const h = tracker.track({ cycle: c }, NOOP, c);

        // Everything is findable while live.
        setBox(probe, -1, -1, 2048, 2048);
        const live = tree.query(probe, out);
        check(live === N, () => `T7: cycle ${c} expected ${N} live, got ${live}`);

        // Tear down.
        for (let i = 0; i < N; i++) tree.removeLeaf(ids[i]);
        tracker.untrack(h);

        check(tree.nodeCount === 0, () => `T7: cycle ${c} nodeCount ${tree.nodeCount} != 0`);
        check(tree.root === -1, () => `T7: cycle ${c} root ${tree.root} != -1`);
        check(conservation(tree), () => `T7: cycle ${c} free-list conservation violated`);
    }

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512, () => `T7: heap grew ${grewKB.toFixed(1)} KB over ${CYCLES} cycles`);
}
