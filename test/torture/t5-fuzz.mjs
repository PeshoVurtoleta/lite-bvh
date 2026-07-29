/**
 * T5 -- differential fuzz against a brute-force oracle.
 *
 * Rotations (B3) change the tree's SHAPE but must never change its ANSWERS.
 * The executable proof: run a long stream of mixed insert / remove / update /
 * query ops against the tree AND against a plain O(N) array-scan oracle, and
 * after every query assert the two produce the identical set of hits.
 *
 * B4 widens the query op to all three kinds -- box `query`, `queryPoint`, and
 * `raycast` -- each compared against its own brute-force scan (`overlaps`,
 * `pointIn`, `segHitsBox`). queryPoint must equal a degenerate box query and
 * raycast must equal the segment-vs-AABB oracle; a shared bug can't hide because
 * the oracles are written independently of the tree's traversal.
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

/** Point inside a box, boundary counted (matches queryPoint()). */
function pointIn(x, y, bx0, by0, bx1, by1) {
    return bx0 <= x && bx1 >= x && by0 <= y && by1 >= y;
}

/**
 * Segment (p0->p1) touches or crosses a box over t in [0,1]. A line-for-line
 * brute-force twin of the tree's slab test in `raycast`, including the explicit
 * zero-direction branch -- so a divergence is a real bug, not a convention gap.
 */
function segHitsBox(p0x, p0y, p1x, p1y, bx0, by0, bx1, by1) {
    const dx = p1x - p0x, dy = p1y - p0y;
    let tmin = 0, tmax = 1;
    if (dx !== 0) {
        const inv = 1 / dx;
        let t1 = (bx0 - p0x) * inv, t2 = (bx1 - p0x) * inv;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return false;
    } else if (p0x < bx0 || p0x > bx1) {
        return false;
    }
    if (dy !== 0) {
        const inv = 1 / dy;
        let t1 = (by0 - p0y) * inv, t2 = (by1 - p0y) * inv;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return false;
    } else if (p0y < by0 || p0y > by1) {
        return false;
    }
    return true;
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
            // QUERY: compare hit SETS (order-independent) against the oracle. One
            // roll picks among the three query kinds so all of box / point /
            // segment are fuzzed against their own brute-force scan. B4 adds the
            // point and segment kinds; each must match the oracle exactly.
            const kind = rnd(3);
            const s = stamp++;
            let n = 0;
            let describe;

            if (kind === 0) {
                // Box query.
                const qx = rnd(WORLD), qy = rnd(WORLD);
                const qx1 = qx + rnd(200), qy1 = qy + rnd(200);
                n = tree.query(setBox(box, qx, qy, qx1, qy1), out);
                for (let i = 0; i < n; i++) seen[out[i]] = s;
                describe = `box [${qx},${qy},${qx1},${qy1}]`;
                let oracleHits = 0;
                for (let i = 0; i < live; i++) {
                    if (overlaps(os0[i], ot0[i], os1[i], ot1[i], qx, qy, qx1, qy1)) {
                        oracleHits++;
                        check(seen[odata[i]] === s, () =>
                            `T5: op ${op} seed ${SEED}: leaf ${odata[i]} overlaps ${describe} ` +
                            `but the tree missed it (live=${live})`);
                    }
                }
                check(oracleHits === n, () =>
                    `T5: op ${op} seed ${SEED}: ${describe} tree ${n} hits, oracle ${oracleHits}`);
            } else if (kind === 1) {
                // Point query.
                const px = rnd(WORLD), py = rnd(WORLD);
                n = tree.queryPoint(px, py, out);
                for (let i = 0; i < n; i++) seen[out[i]] = s;
                describe = `point (${px},${py})`;
                let oracleHits = 0;
                for (let i = 0; i < live; i++) {
                    if (pointIn(px, py, os0[i], ot0[i], os1[i], ot1[i])) {
                        oracleHits++;
                        check(seen[odata[i]] === s, () =>
                            `T5: op ${op} seed ${SEED}: leaf ${odata[i]} contains ${describe} ` +
                            `but queryPoint missed it (live=${live})`);
                    }
                }
                check(oracleHits === n, () =>
                    `T5: op ${op} seed ${SEED}: ${describe} tree ${n} hits, oracle ${oracleHits}`);
            } else {
                // Segment query (raycast). Endpoints anywhere in the world, so
                // segments start inside boxes, graze edges, and miss entirely.
                const ax = rnd(WORLD), ay = rnd(WORLD);
                const bx = rnd(WORLD), by = rnd(WORLD);
                n = tree.raycast(ax, ay, bx, by, out);
                for (let i = 0; i < n; i++) seen[out[i]] = s;
                describe = `seg (${ax},${ay})->(${bx},${by})`;
                let oracleHits = 0;
                for (let i = 0; i < live; i++) {
                    if (segHitsBox(ax, ay, bx, by, os0[i], ot0[i], os1[i], ot1[i])) {
                        oracleHits++;
                        check(seen[odata[i]] === s, () =>
                            `T5: op ${op} seed ${SEED}: leaf ${odata[i]} on ${describe} ` +
                            `but raycast missed it (live=${live})`);
                    }
                }
                check(oracleHits === n, () =>
                    `T5: op ${op} seed ${SEED}: ${describe} tree ${n} hits, oracle ${oracleHits}`);
            }
        }

        if (op % VALIDATE_EVERY === 0) {
            tree.validate();
            check(tree.leafCount === live,
                () => `T5: op ${op}: leafCount ${tree.leafCount} != live ${live}`);
        }
    }

    tree.validate();
}
