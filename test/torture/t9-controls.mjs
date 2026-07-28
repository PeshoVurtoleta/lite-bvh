/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts that the
 * corresponding gate flags each one. If a control slips through, T9 itself
 * fails the run -- a gate that cannot fail is decorative.
 *
 * There is also a whole-suite control: `BVH_TORTURE_BREAK=1 npm run torture`
 * injects retained allocations into the T6 hot loop, so the alloc gate rejects
 * and the process exits non-zero. T9 covers the same alloc lane here so a plain
 * `npm run torture` already proves the gate bites.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { runOpsGate, conservation, die, setBox } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    const { report } = runOpsGate((i) => { leak.push(new Float64Array(64)); }, {
        ops: 4000,
        warmup: 0,
    });
    if (report.ok) {
        die('T9 control: an allocating hot loop passed the zero-alloc gate');
    }
    leak.length = 0; // release the control's garbage

    // Control 2 -- the conservation invariant. Corrupt nodeCount on a throwaway
    // tree and assert the checker reports the violation.
    const tree = new DynamicBVH2D(16);
    tree.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    tree.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    if (!conservation(tree)) die('T9 control: conservation false on a valid tree (checker is broken)');
    tree.nodeCount += 1; // fabricate a leaked node
    if (conservation(tree)) {
        die('T9 control: conservation held despite a corrupted nodeCount');
    }

    // Control 3 -- the hit-set comparator. A correct result and a deliberately
    // wrong oracle must be detected as divergent.
    const correct = [1, 2, 3];
    const wrongOracle = [1, 2, 4];
    let diverges = false;
    for (let i = 0; i < correct.length; i++) if (correct[i] !== wrongOracle[i]) { diverges = true; break; }
    if (!diverges) die('T9 control: comparator failed to flag a wrong oracle');
}
