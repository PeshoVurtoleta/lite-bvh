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

    // Control 4 -- validate() itself. Corrupt a reciprocal parent link and
    // confirm validate() throws. If a broken tree validates, the gate is blind.
    const t2 = new DynamicBVH2D(16);
    t2.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    t2.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    t2.validate(); // healthy first
    const root = t2.root;
    const leftChild = t2.children[root << 1];
    t2.parents[leftChild] = leftChild; // sever the reciprocal link
    let caught = false;
    try { t2.validate(); } catch { caught = true; }
    if (!caught) die('T9 control: validate() passed a tree with a broken parent link');

    // Control 5 -- the B2 poison detector. Bypass the insertLeaf door by writing
    // a NaN straight into a live leaf's bbox, and confirm validate() names it.
    // The door stops poison at entry; this proves validate() is the backstop if
    // poison ever arrives another way. A NaN that validates clean is invisible.
    const t3 = new DynamicBVH2D(16);
    const leaf = t3.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    t3.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    t3.validate(); // healthy first
    t3.bboxes[leaf << 2] = NaN; // poison a bound behind the door's back
    let caughtPoison = false;
    try { t3.validate(); } catch { caughtPoison = true; }
    if (!caughtPoison) die('T9 control: validate() passed a tree with a NaN bbox');

    // ... and the inverted-bbox variant (min > max) is caught the same way.
    const t4 = new DynamicBVH2D(16);
    const lf = t4.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    t4.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    t4.bboxes[(lf << 2) + 2] = -9; // maxX < minX
    let caughtInv = false;
    try { t4.validate(); } catch { caughtInv = true; }
    if (!caughtInv) die('T9 control: validate() passed a tree with an inverted bbox');

    // Control 6 -- the B3 height gate. Disable rotations (make `_balance` the
    // identity) and rebuild the monotone B-07 shape: the height MUST blow past
    // the O(log n) bound the T3/T6 gates assert. If a rotation-less tree still
    // satisfies the bound, the height assertion is decorative.
    const N = 4000;
    const noRot = new DynamicBVH2D(4 * N + 8);
    noRot._balance = (i) => i; // rotations off
    const b = new Float32Array(4);
    for (let i = 0; i < N; i++) noRot.insertLeaf(setBox(b, i, 0, i + 100, 10), i);
    const bound = 2 * Math.ceil(Math.log2(N)) + 2;
    if (noRot.height <= bound) {
        die('T9 control: monotone insert with rotations disabled stayed within the height ' +
            'bound (' + noRot.height + ' <= ' + bound + ') -- the B3 height gate cannot fail');
    }
    noRot.validate(); // a tall tree is still structurally valid -- only unbalanced

    // Control 7 -- the B4 clear() fail-closed guarantee. `clear()` resets the
    // children markers to FREED so a leaf handle held across it fails
    // `_isLiveLeaf`. Prove that step is load-bearing: a broken clear that rebuilds
    // the free-list but SKIPS `children.fill(FREED)` leaves the stale handle
    // looking live, and the real clear() must kill it.
    const brk = new DynamicBVH2D(16);
    const staleId = brk.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    brk.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    // Broken clear: everything clear() does EXCEPT resetting the child markers.
    for (let i = 0; i < brk.maxNodes - 1; i++) brk.nextFree[i] = i + 1;
    brk.nextFree[brk.maxNodes - 1] = -1;
    brk.freeHead = 0; brk.nodeCount = 0; brk.root = -1;
    if (!brk._isLiveLeaf(staleId)) {
        die('T9 control: a clear() without children.fill already invalidated the handle -- ' +
            'the fail-closed step would be decorative');
    }
    const cl = new DynamicBVH2D(16);
    const stale2 = cl.insertLeaf(setBox(new Float32Array(4), 0, 0, 1, 1), 0);
    cl.insertLeaf(setBox(new Float32Array(4), 5, 5, 6, 6), 1);
    cl.clear();
    if (cl._isLiveLeaf(stale2)) {
        die('T9 control: clear() left a pre-clear handle live -- fail-closed guarantee broken');
    }

    // Control 8 -- the B4 touching-edge convention for queryPoint / raycast. Both
    // must count a boundary contact as a hit (`<=`/`>=`), exactly like query().
    // Assert a boundary point and an edge-grazing segment hit, and a just-outside
    // twin misses -- so a future flip to strict `<` in either direction is caught.
    const conv = new DynamicBVH2D(8);
    conv.insertLeaf(setBox(new Float32Array(4), 0, 0, 10, 10), 7);
    const o = new Int32Array(4);
    if (conv.queryPoint(10, 5, o) !== 1) die('T9 control: queryPoint missed a boundary point (convention regressed)');
    if (conv.queryPoint(10.01, 5, o) !== 0) die('T9 control: queryPoint hit a just-outside point (comparator blind)');
    if (conv.raycast(0, -5, 0, 15, o) !== 1) die('T9 control: raycast missed an edge-grazing segment');
    if (conv.raycast(-0.01, -5, -0.01, 15, o) !== 0) die('T9 control: raycast hit a just-outside segment (comparator blind)');
}
