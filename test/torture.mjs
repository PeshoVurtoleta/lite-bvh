/**
 * @zakkster/lite-bvh -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Ten tiers share one shape (see the roadmap section 3). B0 stands up the
 * harness and wires the tiers this package needs now:
 *
 *     T0  metamorphic laws          t3  adversarial insert orders (1 seed case)
 *     T1  degenerate query values   t4  handle / buffer abuse (safe cases)
 *     T6  the zero-alloc gate       t7  soak + free-list conservation
 *     T9  controls (must be able to fail)
 *
 * T2 (aliasing), T5 (differential fuzz) and T8 (cross-package conformance) are
 * reserved for later sessions and intentionally not registered here.
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * Controls: `BVH_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` injects
 * retained allocations into the T6 hot loop and must exit non-zero. A gate that
 * cannot fail is decorative.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. Bvh.js has zero
 * runtime dependencies.
 *
 * @license MIT
 */

import { SEED, BREAK } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-handles.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T3 adversarial', t3],
    ['T4 handles', t4],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T9 controls', t9],
];

function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            run();
        } catch (err) {
            // Tiers normally fail via die() (which exits). A thrown error is an
            // unexpected fault -- surface it with the replay seed and stop.
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write('torture: FAIL -- BVH_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
