# 0005 -- The shared FORMAT contract + packed bulk insert (X1, v2.0.0)

Status: accepted, 2026-07-30
Findings: none new -- this is the twin 2.0.0 that formalizes the cross-package
  format and adds the packed batch entry point.
Depends on: B4 (0004-query-kinds) and `@zakkster/lite-aabb@2.0.0` (its X1 half).

## Why a major

Every v1 single-box and query method is unchanged and still exported, so in pure
code terms this release is additive. It is nonetheless **2.0.0**, in lockstep with
`@zakkster/lite-aabb@2.0.0`, because X1 turns the informal "we both happen to
agree on `Float32Array(4)`" understanding into a **versioned, cross-package
contract** (FORMAT.md + `FORMAT_VERSION`). Formalizing a contract that a third
package can now depend on for conformance is the semantic breaking line, and the
two packages must carry the same major so a consumer reads one story. This is the
same call `@zakkster/lite-aabb` recorded in its decision 0005; the twin bumps
together or the contract is meaningless.

`VERSION` (semver, `2.0.0`) and `FORMAT_VERSION` (the contract integer, `1`) are
on **separate axes**. FORMAT_VERSION bumps only when the buffer layout itself
changes; a package can ship many semver majors without ever touching it.

## Decision 1: FORMAT.md is copied, not depended on

FORMAT.md is **byte-identical** in both repos (`diff` is empty) and shipped in
both `files[]`. `FORMAT_VERSION = 1` is declared **inline** in `Bvh.js`, not
imported from `@zakkster/lite-aabb` -- this package keeps its **zero runtime
dependencies** (the law), exactly as B2 copied the `_isValidBox` quarantine
predicate inline rather than importing `isValid`. The two constants are held in
agreement by a **conformance test**, not a dependency edge:

- `test/Bvh.test.js` imports both packages (aabb is a devDep) and asserts
  `FORMAT_VERSION === aabb.FORMAT_VERSION`.
- Torture T8 asserts the same equality and then runs the full packed round-trip.

If the two ever skew, both the unit suite and the torture gate go red. That is the
enforcement; the dependency edge is deliberately absent.

## Decision 2: `insertLeaves` -- packed bulk insert

`insertLeaves(packed, dataArray, count)` walks a packed `4*count` buffer (box `i`
at slots `4i..4i+3`, the FORMAT.md layout) and inserts each box. It is the
broadphase-feeding entry point: the loop a caller used to hand-roll around
`insertLeaf`, but without the per-box `Float32Array` view that loop implies.

### Batch-atomic (fail closed)

Every box, every `data`, the buffer-alias rule, and total capacity are validated
in **one pass before any mutation**. A single bad element aborts the whole call
with the tree **byte-unchanged** -- never a partial batch. The alternative,
per-box-atomic (insert until the first bad element, leaving a prefix committed),
was rejected: "fail closed on every unverified state" means a batch that cannot
complete should change nothing, matching how `insertLeaf` is atomic at the single
level. Cost: an O(count) pre-scan, zero allocation. T9 control 9 proves the
guarantee is real and non-vacuous (a mid-batch NaN leaves `nodeCount` untouched;
the same all-valid batch does grow it).

Capacity is checked once, up front, as `nodeCount + 2*count <= maxNodes`
(`count` leaves add at most `2*count` nodes; the first into an empty tree adds
one, so this is conservative by <=1). O(1) -- no free-list walk.

### Zero allocation: shared core + one reused scratch

`insertLeaf`'s post-validation body was extracted into
`_insertPreValidated(box4, data)`, so the SAH descent + refit live in exactly one
place. `insertLeaf` still passes its own `leafAABB` straight through -- so its
observable behaviour (including the plain-`Array`/`Float64Array` coercion of B-11)
is **unchanged**, measured within noise (single-insert throughput moved 6.1 ->
6.1 M box/s across the refactor). `insertLeaves` copies each packed box into a
**reused `_batchScratch` Float32Array(4)** (allocated once in the constructor) and
hands that to the core -- so the bulk path allocates **nothing per box**.

The alternative -- threading a `(buffer, offset)` pair through `_perimeterNode`,
`_mergedPerimeter`, and `_mergeNodesToAABB` to read the packed buffer in place
with no copy at all -- was rejected: it would invade three hot single-insert
helpers to save 8 array ops per box on a setup-time bulk op. The 8-op scratch copy
is invisible next to the SAH descent it feeds. T6 gates the bulk path at
`maxArrayBuffersGrowth: 0`; `bytesPerOp` is 0 there.

## Round-trip conformance (the point of the twin)

Producer/consumer, run from THIS repo and mirrored in aabb's: build a packed
buffer with `aabb2.fattenAll`, feed it straight to `insertLeaves` (no per-box
view), then assert `query` / `queryPoint` / `raycast` agree with a brute-force
scan over the same fattened geometry. Covered by a unit test and torture T8
(N=300). This is the executable proof that a buffer built by one package is read
correctly by the other.

## Hot path

`insertLeaves` and `_insertPreValidated` are on the insert path, not on
`updateLeaf`'s fast path or in any query. The single-insert path is byte-identical
in behaviour after the extraction. No query kind changed.

## Measured

`measureOps({ stabilize: 'deep' })`, best of 5, Node v26. One "op" = clear + a
256-box batch. The binding contract is the T6 alloc gate, not throughput.

| probe | throughput | bytesPerOp |
| --- | --- | --- |
| `insertLeaves(256)` (per batch) | ~0.025 M/s (~6.4 M box/s) | ~0 (T6 gate: 0) |
| 256x `insertLeaf` (per batch) | ~0.024 M/s (~6.1 M box/s) | ~0 |

Bulk is marginally faster than the single-call loop (one JS call and validation
pass instead of 256) and, more importantly, is proven allocation-free box-for-box
by the T6 gate.

## Consequences

- New public surface: `insertLeaves(packed, dataArray, count)` and the
  `FORMAT_VERSION` export. FORMAT.md ships in the tarball.
- New internal: `_insertPreValidated` (shared insert core) and `_batchScratch`.
- The full v1 unit suite is green unchanged; every v1 method behaves identically.
- No format LAYOUT change: `FORMAT_VERSION` stays `1`. No runtime dependency on
  `@zakkster/lite-aabb`. No new query kinds. `closestPoint` remains deferred
  (decision 0004).
- This closes the lite-bvh line: B0 (harness) -> B1 (integrity) -> B2 (quarantine)
  -> B3 (rotations) -> B4 (query kinds) -> X1 (format contract + batch).
