# 0002 -- Poison quarantine at the door (B2, v1.1.0)

Status: accepted, 2026-07-29
Findings: B-03, B-10, B-11, B-12 (and A-05 at the door)
Depends on: B1 (0001-handle-validation), lite-aabb A2 (degenerate-value law, 1.1.0)

## Problem

A single degenerate leaf silently kills the tree. One NaN bound propagates
through `_refit` (which merges with `Math.min`/`Math.max`) to the root; from
then on every query's bbox test is `false` and returns 0 hits, permanently,
with no signal (B-03). An inverted box (min > max) makes the SAH perimeter
negative and the descent nonsense. Neither is a handle bug -- a NaN box is a
perfectly valid `Float32Array(4)` that passes B1's handle validation. It is an
*input* bug, and once the value is in the tree it is too late. **The fix is a
door, not a repair.**

Two more inputs corrupt silently: `userData` outside the non-negative int32
range (`2**31` wraps, `3.7` truncates, `-1` collides with the internal sentinel;
B-10), and a `leafAABB` that aliases the tree's own `bboxes` buffer, which the
SAH descent reads while `_mergeNodesToAABB` writes it (B-12).

## Decision

### The predicate: `_isValidBox`, copied from lite-aabb by contract

A box may enter only if all four bounds are finite AND `minX <= maxX` and
`minY <= maxY`:

```
Number.isFinite(a[0]) && Number.isFinite(a[1]) &&
Number.isFinite(a[2]) && Number.isFinite(a[3]) &&
a[0] <= a[2] && a[1] <= a[3]
```

This is **exactly** `@zakkster/lite-aabb`'s `isValid` as of 1.1.0 (A2). It is
copied inline, not imported: **lite-bvh takes no runtime dependency on
lite-aabb.** The FORMAT is a two-package contract and so is the definition of a
broken box; the packages agree by a shared definition, not a dependency edge.
lite-aabb is a TEST-ONLY devDep, used by torture tier T8 to prove the agreement.

Reading `a[3]` on a 3-element buffer yields `undefined`, which is not finite, so
the predicate also closes the short-buffer poison case (T4) for free.

### Where the door goes -- and where it deliberately does not

| Site | Door? | Why |
| --- | --- | --- |
| `insertLeaf` | **yes**, before the first mutation | The only write path for a leaf box. Atomic: a rejected insert leaves the tree byte-unchanged (B-01 already made capacity atomic; this extends it to poison). |
| `updateLeaf` SLOW path | **yes**, on the fattened scratch, BEFORE `removeLeaf` | If the door lived only in `insertLeaf`, a poison update would remove-then-throw, orphaning the entity. Validating the scratch first makes it atomic, and catches a non-finite `margin` and A-05's inverting negative margin. |
| `updateLeaf` FAST path | **no -- zero new instructions** | The fast path never writes `newAABB`; it reads already-validated stored bounds and returns. Poison there cannot corrupt the tree, so there is nothing to check. This is the load-bearing claim of the package and it stays untouched. |
| `query` | **no** | A read-only probe. It never writes the tree, so it cannot be poisoned. A non-finite or empty-sentinel query box has well-defined, pinned behaviour (0 hits -- every comparison is `false`); validating it would also reject the *canonical empty-sentinel query* `[Inf,Inf,-Inf,-Inf]`, which legitimately means "match nothing" and must return 0 (torture T1). So the fail-closed law is satisfied by "cannot enter shared state", not by a per-query guard. |

The `query` decision is the one place the plan's first instinct (throw on an
invalid query box) was wrong: it is both a needless read-path cost AND
semantically incorrect for the empty sentinel. Recorded here so it is not
re-litigated.

### userData: non-negative int32

`(data | 0) === data && data >= 0`. `(data | 0) === data` rejects non-integers
and anything outside int32 (including `2**31`, which would wrap negative once
stored in the `Int32Array`); `data >= 0` reserves the entire negative half,
including the `-1` internal-node sentinel. Legal range: `[0, 2^31 - 1]`, which
is exactly the id space ECS and rendering systems produce. `-1` becomes a
reserved value the caller must not store.

The shorthand `(data >>> 0) === data` was rejected: it admits `[2^31, 2^32-1]`,
which then wraps negative in the `Int32Array` -- the very B-10 symptom.

### bboxes aliasing: forbid

`leafAABB.buffer === this.bboxes.buffer` -> throw. A plain `Array` has
`.buffer === undefined`, which never equals the tree's real `ArrayBuffer`, so
legitimate non-typed inputs pass; only a typed-array view sharing the tree's
backing store is rejected (B-12).

### validate() is the backstop

The pre-B2 containment check was NaN-blind (`NaN > NaN` is `false`), so a
poisoned node validated clean. `validate()` now checks `_isValidBox` on every
reachable node's stored bbox and names the offender. The door stops poison at
entry; `validate()` catches it if it ever arrives another way (a control in T9
writes a NaN straight into `bboxes` and asserts `validate()` throws).

## B-11: coerce and document, do not enforce

A plain `Array` or `Float64Array` box is accepted and coerced to f32 on store --
its VALUES are validated (`_isValidBox` reads by index), its TYPE is not.
Enforcing `Float32Array` would require an `instanceof`/`ArrayBuffer.isView`
check, and the only place type matters is the `updateLeaf` FAST path, where a
`Float64Array` value within one f32 ulp of the fat boundary can pass the
containment test yet sit just outside the stored f32 box (a silent query miss).
Putting that check on the fast path is exactly the cost the package refuses to
pay. So the policy is: pass a `Float32Array`; the caveat is documented in the
`d.ts`, the README and the `updateLeaf` JSDoc; the fast path stays type-agnostic
and allocation-free.

## Hot-path cost

The `updateLeaf` fast path and the `query` inner loop take **zero** new
instructions -- provable by diff. The door lives on `insertLeaf` (O(log n), not
a fast path) and the `updateLeaf` slow path (already O(log n): a remove plus a
re-insert).

Measured with `measureOps({ ops, warmup, stabilize: 'deep' })`, best of 5 runs,
Node v26, same machine (the run-to-run variance is ~2x on this shared box, so
these are ranges, and the binding contract is the alloc gate, not the throughput
figure -- as in 0001):

| probe | v1.0.2 best | v1.1.0 best | bytesPerOp |
| --- | --- | --- | --- |
| `query` (tiny tree, worst case for any top-of-call guard) | ~97M/s | ~100M/s | 0 |
| `updateLeaf` fast path | ~293M/s | ~288M/s | 0 |
| `insert`+`remove` churn (carries the new door) | ~4.1M/s | ~3.9M/s | 0 |

`query` and `updateLeaf` fast path are unchanged within noise (as expected --
neither gained code). `insert+remove` carries the three insert-door checks and
sits ~5% lower on the best-of-5, which is at the edge of this machine's noise and
is the correct place for the cost to land. **The load-bearing property is
preserved:** `bytesPerOp` is 0 everywhere and torture tier T6 gates
`maxArrayBuffersGrowth: 0` (`stabilize: 'deep'`) plus a direct
`queryStack.length` / `bboxes.buffer.byteLength` equality. That gate is the
contract.

## Consequences

- `insertLeaf`/`updateLeaf` throw on poison, bad `userData`, or bboxes aliasing.
  Behaviour change, but only for calls that were already silent bugs.
- `-1` is now a reserved `userData` value.
- lite-bvh gains a TEST-ONLY devDep on `@zakkster/lite-aabb`; the shipped
  package still has zero runtime dependencies (`decisions/` and `test/` are
  excluded from the tarball).
- B3 (rotations + query-stack policy) is unblocked; it does not touch the door.
