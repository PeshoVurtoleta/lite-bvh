/**
 * T5 -- differential fuzz against a brute-force oracle.
 *
 * Rotations (B3) change the tree's SHAPE but must never change its ANSWERS.
 * The executable proof: run a long stream of mixed insert / remove / update /
 * query ops against the tree AND against a plain O(N) array-scan oracle, and
 * after every query assert the two produce the identical set of hits.
 *
 * Because the oracle is rotation-agnostic, "tree == oracle before and after
 * rebalancing" is exactly the guarantee the B3 brief asks for: the hit sets are
 * identical to a pre-rotation implementation across the whole corpus.
 *
 * The oracle mirrors each leaf's ACTUAL stored bbox (read back from the tree
 * after every insert/update), not the caller's tight box. That matters because
 * `updateLeaf`'s slow path stores FAT bounds: the tree legitimately reports a
 * leaf whose fat box overlaps the query even when its tight box would not.
 * Reading the stored box back makes both sides scan identical geometry, so a
 * mismatch is a genuine structural bug (a mislinked parent, a stale/pruned
 * bbox), never an artifact of fattening.
 *
 * On any divergence the tier prints the seed and the op index so the exact run
 * replays with `TORTURE_SEED=... npm run torture`. T5 is a CORRECTNESS tier, not
 * the alloc gate (that is T6); it may allocate its bookkeeping freely, and it
 * calls validate() periodically so a structural break is caught even in a window
 * with no query over the affected leaf.
 */

import { DynamicBVH2D } from '../../Bvh.js';
import { makePrng, SEED, check, setBox } from './harness.mjs';

const CAP = 400;          // max live leaves
const OPS = 120000;       // mixed ops
const WORLD = 2048;       // coordinate span
const VALIDATE_EVERY = 2000;

/** Two AABBs overlap iff they touch or cross on both axes (matches query()). */
function overlaps(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
    return ax0 <= bx1 && ax1 >= bx0 && ay0 <= by1 && ay1 >= by0;
}

export function run() {
    const prng = makePrng(SEED);
    const rnd = (n) => prng() % n;

    const tree = new DynamicBVH2D(4 * CAP + 8);

    // Oracle: parallel arrays of live leaves. A row is removed by swap-popping to
    // keep the scan tight. `os0..os1` mirror the leaf's STORED bbox (read back
    // from the tree), so the oracle and the tree scan identical geometry.
    const os0 = new Float32Array(CAP), ot0 = new Float32Array(CAP);
    const os1 = new Float32Array(CAP), ot1 = new Float32Array(CAP);
    const odata = new Int32Array(CAP);
    const oslot = new Int32Array(CAP);   // tree handle per oracle row
    let live = 0;

    /** Copy the tree's stored bbox for node `id` into oracle row `r`. */
    const mirror = (r, id) => {
        const b = id << 2;
        os0[r] = tree.bboxes[b];     ot0[r] = tree.bboxes[b + 1];
        os1[r] = tree.bboxes[b + 2]; ot1[r] = tree.bboxes[b + 3];
    };

    const box = new Float32Array(4);
    const tight = new Float32Array(4);
    const out = new Int32Array(CAP);
    const seen = new Int32Array(OPS + 16); // membership by userData, stamped per query
    let nextData = 0;
    let stamp = 1;

    for (let op = 0; op < OPS; op++) {
        const roll = rnd(100);

        if (live < 4 || (roll < 40 && live < CAP)) {
            // INSERT
            const x = rnd(WORLD), y = rnd(WORLD);
            const w = 1 + rnd(20), h = 1 + rnd(20);
            const data = nextData++;
            const id = tree.insertLeaf(setBox(box, x, y, x + w, y + h), data);
            odata[live] = data; oslot[live] = id;
            mirror(live, id);
            live++;
        } else if (roll < 60) {
            // REMOVE a random live leaf (swap-pop the oracle row).
            const r = rnd(live);
            tree.removeLeaf(oslot[r]);
            live--;
            os0[r] = os0[live]; ot0[r] = ot0[live]; os1[r] = os1[live]; ot1[r] = ot1[live];
            odata[r] = odata[live]; oslot[r] = oslot[live];
        } else if (roll < 80) {
            // UPDATE a random live leaf (may take fast or slow path).
            const r = rnd(live);
            const x = rnd(WORLD), y = rnd(WORLD);
            const w = 1 + rnd(20), h = 1 + rnd(20);
            const id = tree.updateLeaf(oslot[r], setBox(tight, x, y, x + w, y + h), 4);
            oslot[r] = id;
            mirror(r, id); // re-read: fast path keeps old fat box, slow path stores new fat box
        } else {
            // QUERY: compare hit SETS (order-independent) against the oracle.
            const qx = rnd(WORLD), qy = rnd(WORLD);
            const qx1 = qx + rnd(200), qy1 = qy + rnd(200);
            const n = tree.query(setBox(box, qx, qy, qx1, qy1), out);

            const s = stamp++;
            for (let i = 0; i < n; i++) seen[out[i]] = s;

            let oracleHits = 0;
            for (let i = 0; i < live; i++) {
                if (overlaps(os0[i], ot0[i], os1[i], ot1[i], qx, qy, qx1, qy1)) {
                    oracleHits++;
                    check(seen[odata[i]] === s,
                        () => `T5: op ${op} seed ${SEED}: leaf data ${odata[i]} overlaps query ` +
                              `[${qx},${qy},${qx1},${qy1}] but the tree missed it (live=${live})`);
                }
            }
            check(oracleHits === n,
                () => `T5: op ${op} seed ${SEED}: tree returned ${n} hits, oracle found ${oracleHits} ` +
                      `(a phantom or duplicate hit)`);
        }

        if (op % VALIDATE_EVERY === 0) {
            tree.validate();
            check(tree.leafCount === live,
                () => `T5: op ${op}: leafCount ${tree.leafCount} != live ${live}`);
        }
    }

    tree.validate();
}
