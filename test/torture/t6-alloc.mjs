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
 * Two trees are gated. The first is SCATTERED (well-balanced). The second is the
 * ADVERSARIAL monotone B-07 shape: before B3 it degraded to height 19,999 and a
 * full-extent query grew `queryStack` 256 -> 32,768 by allocating INSIDE the
 * loop (B-08), breaking the zero-GC law by data alone. With rotations the height
 * is O(log n) and the stack never grows, so the same gate now passes on it --
 * that is the executable B-08 fix.
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
        // B4: the other two query kinds share `queryStack`, so gate them here too
        // -- a per-hit allocation in either would show up as arrayBuffers growth.
        tree.queryPoint(x, y, out);
        tree.raycast(x - 48, y, x + 48, y, out);
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
    // control silently passed, which is itself a failure. (BREAK trips in the
    // scattered gate above and exits before the adversarial gate below.)
    if (BREAK) die('T6: BVH_TORTURE_BREAK injected allocations but the gate passed');

    // --- B-08: query on the adversarial monotone tree must not allocate ------
    // The pre-rotation shape (height 19,999) grew the query stack 256 -> 32,768
    // by allocating inside the loop. With rotations the height is O(log n), the
    // fixed 256-slot stack never overflows, and this gate passes.
    {
        const M = 20000;
        const adv = new DynamicBVH2D(4 * M + 8);
        const b = new Float32Array(4);
        for (let i = 0; i < M; i++) adv.insertLeaf(setBox(b, i, 0, i + 100, 10), i);

        const bound = 2 * Math.ceil(Math.log2(M)) + 2;
        check(adv.height <= bound,
            () => `T6: adversarial height ${adv.height} exceeds bound ${bound} -- rotations off?`);

        // A wide sliding window that descends most of the tree every call.
        const q = new Float32Array(4);
        const out = new Int32Array(M);
        const advHot = (i) => {
            const c = (i * 997) % M;
            setBox(q, c - 4000, -1, c + 4000, 11);
            adv.query(q, out);
            // queryPoint / raycast on the deep adversarial tree: the shared stack
            // must not grow for these either (B-08 + B-13).
            adv.queryPoint(c, 5, out);
            adv.raycast(c - 4000, 5, c + 4000, 5, out);
        };

        const advStackBefore = adv.queryStack.length;
        const advBboxBefore = adv.bboxes.buffer.byteLength;
        const { report: advReport, summary: advSummary } =
            runOpsGate(advHot, { ops: 8000, warmup: 500 });

        check(adv.queryStack.length === advStackBefore,
            () => `T6: adversarial queryStack grew ${advStackBefore} -> ${adv.queryStack.length} (B-08 regressed)`);
        check(adv.bboxes.buffer.byteLength === advBboxBefore,
            () => `T6: adversarial bboxes backing store grew ${advBboxBefore} -> ${adv.bboxes.buffer.byteLength}`);
        if (!advReport.ok) {
            const g = advSummary.gc;
            die('T6 adversarial alloc gate rejected -- verdict=' + advReport.verdict +
                ' source=' + advSummary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
        }
    }

    // --- X1: bulk insert must not allocate per box ---------------------------
    // `insertLeaves` walks a packed 4*N buffer by index and copies each box into a
    // reused scratch -- no per-box `subarray`. The hot body clears and refills the
    // tree from a pre-built packed buffer every iteration; a per-box view (or any
    // batch bookkeeping) would show as arrayBuffers growth under the deep gate.
    {
        const B = 256;
        const packed = new Float32Array(4 * B);
        const bdata = new Int32Array(B);
        for (let i = 0; i < B; i++) {
            const x = (i * 131) % 4096, y = (i * 257) % 4096;
            packed[4 * i] = x - 4; packed[4 * i + 1] = y - 4;
            packed[4 * i + 2] = x + 4; packed[4 * i + 3] = y + 4;
            bdata[i] = i;
        }
        const bulk = new DynamicBVH2D(4 * B + 8);

        const bulkHot = () => {
            bulk.clear();
            bulk.insertLeaves(packed, bdata, B);
        };

        const bulkStackBefore = bulk.queryStack.length;
        const bulkBboxBefore = bulk.bboxes.buffer.byteLength;
        const { report: bulkReport, summary: bulkSummary } =
            runOpsGate(bulkHot, { ops: 3000, warmup: 200 });

        check(bulk.queryStack.length === bulkStackBefore,
            () => `T6: bulk queryStack grew ${bulkStackBefore} -> ${bulk.queryStack.length}`);
        check(bulk.bboxes.buffer.byteLength === bulkBboxBefore,
            () => `T6: bulk bboxes backing store grew ${bulkBboxBefore} -> ${bulk.bboxes.buffer.byteLength}`);
        if (!bulkReport.ok) {
            const g = bulkSummary.gc;
            die('T6 bulk-insert alloc gate rejected -- verdict=' + bulkReport.verdict +
                ' source=' + bulkSummary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
        }
    }
}
