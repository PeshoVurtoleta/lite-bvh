/**
 * @zakkster/lite-bvh -- torture harness.
 *
 * Shared scratch pool, zero-alloc assertions, a seeded PRNG, the free-list
 * conservation helpers, and the lite-gc-profiler gate wrapper. Every tier
 * imports from here so the discipline is enforced in one place:
 *
 *   - All scratch (boxes, buffers, trees) is allocated ONCE, by the tier,
 *     outside every loop. This module hands out helpers, never per-call
 *     allocations on a hot path.
 *   - `check()` builds its message string only on failure -- a template
 *     literal per iteration is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed
 *     and op index so the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into the T6 hot loop. */
export const BREAK = process.env.BVH_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/** Length of the free-list chain walked from freeHead. O(maxNodes) -- test only. */
export function freeListLength(tree) {
    let n = 0;
    let h = tree.freeHead;
    // Bounded by maxNodes so a corrupted cyclic chain cannot loop forever.
    for (let guard = 0; h !== -1 && guard <= tree.maxNodes; guard++) {
        n++;
        h = tree.nextFree[h];
    }
    return n;
}

/** The one invariant: allocated + free === capacity. */
export function conservation(tree) {
    return tree.nodeCount + freeListLength(tree) === tree.maxNodes;
}

/** Nodes reachable from the root by walking children. O(n) -- test only. */
export function reachableCount(tree) {
    if (tree.root === -1) return 0;
    let count = 0;
    const stack = [tree.root];
    while (stack.length) {
        const node = stack.pop();
        count++;
        const l = tree.children[node << 1];
        const r = tree.children[(node << 1) + 1];
        if (l !== -1) stack.push(l);
        if (r !== -1) stack.push(r);
    }
    return count;
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule
 * is resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns
 * the checkNoGc report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/** Set a Float32Array(4) box in place -- no allocation. */
export function setBox(b, minX, minY, maxX, maxY) {
    b[0] = minX; b[1] = minY; b[2] = maxX; b[3] = maxY;
    return b;
}
