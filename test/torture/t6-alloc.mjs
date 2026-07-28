/**
 * T6 -- the zero-alloc gate.
 *
 * A mixed query + fast-path-update hot loop, measured with lite-gc-profiler and
 * gated at maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0. The last rule is
 * the one that matters: the tree's buffers are ArrayBuffer backing stores, which
 * live OUTSIDE the V8 heap and are invisible to a heapUsed gate (measured 152x
 * blind spot). It requires `stabilize:'deep'`, which `runOpsGate` supplies.
 *
 * A heap gate cannot substitute for a direct structural assertion either, so we
 * also pin `queryStack.length` and `bboxes.buffer.byteLength` across the window:
 * nothing may grow.
 *
 * The tree here is SCATTERED (well-balanced), so query stays within the initial
 * 256-slot stack. The adversarial B-07/B-08 tree that forces the stack to grow
 * is B3's fix, not B0's gate.
 *
 * BVH_TORTURE_BREAK=1 injects a retained allocation into the hot body: the gate
 * must then reject the window. That is the T9 control, exercisable from here.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { runOpsGate, BREAK, check, die, setBox } from './harness.mjs';

const N = 512;
const OPS = 60000;
const WARMUP = 2000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export function run() {
    const tree = new DynamicBVH2D(4 * N);
    const ids = new Int32Array(N);
    const px = new Float32Array(N);
    const py = new Float32Array(N);

    // Scatter leaves so the SAH tree is well balanced.
    for (let i = 0; i < N; i++) {
        const x = (i * 131) % 4096;
        const y = (i * 257) % 4096;
        px[i] = x; py[i] = y;
        ids[i] = tree.insertLeaf(setBox(new Float32Array(4), x - 4, y - 4, x + 4, y + 4), i);
    }

    // Everything the hot body touches is pre-allocated here, once.
    const q = new Float32Array(4);
    const out = new Int32Array(64);
    const tight = new Float32Array(4);

    const hot = (i) => {
        const idx = i & (N - 1); // N is a power of two
        const x = px[idx], y = py[idx];
        setBox(q, x - 32, y - 32, x + 32, y + 32);
        tree.query(q, out);
        // Tight bounds stay inside the fat bounds -> updateLeaf fast path (O(1),
        // no remove/reinsert, no allocation).
        setBox(tight, x - 1, y - 1, x + 1, y + 1);
        tree.updateLeaf(ids[idx], tight, 4);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    const stackLenBefore = tree.queryStack.length;
    const bboxBytesBefore = tree.bboxes.buffer.byteLength;

    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // Structural assertions no heap gate can make: the query stack and the SoA
    // backing store must be byte-identical in size after the window.
    check(tree.queryStack.length === stackLenBefore,
        () => `T6: queryStack grew ${stackLenBefore} -> ${tree.queryStack.length}`);
    check(tree.bboxes.buffer.byteLength === bboxBytesBefore,
        () => `T6: bboxes backing store grew ${bboxBytesBefore} -> ${tree.bboxes.buffer.byteLength}`);

    if (!report.ok) {
        const g = summary.gc;
        die('T6 alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            (BREAK ? ' (BVH_TORTURE_BREAK control -- expected)' : ''));
    }

    // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
    // control silently passed, which is itself a failure.
    if (BREAK) die('T6: BVH_TORTURE_BREAK injected allocations but the gate passed');
}
