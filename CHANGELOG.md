# Changelog

All notable changes to `@zakkster/lite-bvh` are documented here.
The format follows Keep a Changelog; this package adheres to SemVer.

## [2.0.0] - 2026-07-30

The twin major with `@zakkster/lite-aabb@2.0.0`: the shared buffer format becomes
a versioned, cross-package contract, and a packed bulk-insert entry point lands.
Every v1 method is unchanged and still exported -- the major marks the formalized
FORMAT contract, not a code break. See `decisions/0005-format-contract.md` and
`FORMAT.md`.

### Added
- **`FORMAT.md` + `FORMAT_VERSION` (= 1)** -- the shared, versioned buffer
  contract, byte-identical in both packages. `FORMAT_VERSION` is an integer
  compared for equality, on a **separate axis** from the semver `VERSION`; it is
  copied inline (no runtime dependency on `@zakkster/lite-aabb`), and the two
  packages' agreement is enforced by a conformance test, not a dependency edge.
- **`insertLeaves(packed, dataArray, count)`** -- bulk insert of `count` boxes
  from one packed `Float32Array` (`4*count` floats, box `i` at `[4i, 4i+3]`). The
  broadphase-feeding path: reads the buffer by index, so it allocates **nothing
  per box** (no `subarray`). **Batch-atomic** -- every box, every `data`, the
  alias rule and total capacity are validated before any mutation, so a single
  bad element throws and leaves the tree byte-unchanged (never a partial batch).
- Cross-package round-trip conformance: build a packed buffer with
  `aabb2.fattenAll`, feed it straight to `insertLeaves`, and confirm
  `query`/`queryPoint`/`raycast` agree with a brute-force scan over the same
  geometry (unit test + torture T8). T5 fuzz gains a bulk-vs-single differential;
  T6 gates `insertLeaves` at `maxArrayBuffersGrowth: 0`; T9 adds a batch-atomic
  control.

### Changed
- **BREAKING (contract):** `FORMAT_VERSION` is now the versioned handshake between
  the two packages. A consumer that mixes `@zakkster/lite-bvh@2` with an older
  `@zakkster/lite-aabb` should assert the two `FORMAT_VERSION` values are equal.
  The `Float32Array(4)` `[minX, minY, maxX, maxY]` **layout is unchanged**
  (`FORMAT_VERSION` stays 1); no data buffer needs migrating.
- `insertLeaf`'s post-validation body was factored into an internal
  `_insertPreValidated` shared with `insertLeaves`. `insertLeaf`'s observable
  behaviour (including B-11 coercion) is **unchanged**, measured within noise.

### Notes
- Zero runtime dependencies unchanged; `@zakkster/lite-aabb` is a devDependency
  only, bumped to `^2.0.0` for the round-trip conformance test.
- No new query kinds; `closestPoint` remains deferred (decision 0004).

## [1.3.0] - 2026-07-29

New query kinds, on the now-sound structure (B-13). Point-pick and segment
queries join the box query; `clear()` and `getBounds()` round out introspection.
`closestPoint` is deferred, with its reason on the record. See
`decisions/0004-query-kinds.md`.

### Added
- **`queryPoint(x, y, out)`** -- every leaf whose fat bounds contain the point.
  Equals `query([x, y, x, y], out)` by construction (a point is a zero-size box);
  skips building an AABB for mouse/touch hit-tests.
- **`raycast(p0x, p0y, p1x, p1y, out)`** -- every leaf a segment touches or
  crosses (a slab test clamped to `t in [0, 1]`). **No callback form**: a per-hit
  callback would re-enter user code mid-traversal while the shared query stack is
  held, so a nested query would corrupt it; hits go into the caller buffer like
  every other query here. A zero-length segment degenerates to `queryPoint`.
- **`clear()`** -- reset to empty without reallocating any buffer, for scene
  reloads and reset-in-place loops. O(maxNodes). Fails closed: a leaf handle held
  across a `clear()` throws instead of mutating a slot the caller no longer owns.
- **`getBounds(leaf, out4)`** -- read a leaf's stored fat bounds (f32-exact) into
  a caller buffer, the supported alternative to indexing the raw `bboxes` view.
- Torture coverage: T5 now fuzzes all three query kinds against independent
  brute-force oracles; T6 gates `queryPoint`/`raycast` for allocation on both the
  scattered and adversarial trees; T7 soaks `clear()`; T9 adds controls for the
  `clear()` fail-closed step and the point/segment touching-edge convention.

### Notes
- `queryPoint` and `raycast` REUSE the query stack, so they inherit B3's no-grow /
  fail-closed policy and are part of the `maxArrayBuffersGrowth: 0` gate.
- The `query`/`updateLeaf` fast paths and the SAH insert are UNCHANGED (the new
  methods add no instructions to them). Every new probe measures 0 bytes/op.
- **`closestPoint` is deferred**, not shipped: nearest-leaf needs a priority queue
  -- a second data structure with its own zero-allocation proof -- and bolting one
  on to hit one method would allocate per query or ship an unproven heap. Recorded
  in decision 0004 rather than half-shipped.

## [1.2.0] - 2026-07-29

Tree rotations. An adversarial insert order can no longer degrade the tree into
a linked list, and `query()` no longer allocates on such a tree. Both findings
had one root cause -- the missing `// TODO: Box2D-style rotations` in `_refit` --
and both are now closed. See `decisions/0003-rotations-and-query-stack.md`.

### Fixed
- **B-07** an adversarial (e.g. monotone) insert order no longer degrades the
  tree. Before, 20,000 wide slabs inserted in sorted order produced a tree of
  height 19,999 -- a linked list wearing a BVH costume -- and each further insert
  cost an O(N) refit walk (building that tree took ~2.5 s). `_refit` now applies
  Box2D-style single rotations, holding height to O(log n): the same build is
  ~8 ms and height 15. `height` stays `<= 2*ceil(log2(leafCount)) + 2` under
  every adversarial order in the torture suite.
- **B-08** `query()` on that degenerate tree grew `queryStack` from 256 to
  32,768 by allocating INSIDE the traversal loop -- breaking the zero-GC
  guarantee with data alone, invisibly to a heap-growth gate (the buffers are
  ArrayBuffer backing stores). With rotations the height is O(log n), the stack
  needs at most `height + 1` slots, and the fixed 256-slot stack never grows.
- **remove refit** discovered while implementing rotations: `removeLeaf` refit
  the parent chain from one level too high, leaving the healed grandparent's
  height and bbox stale (a superset bbox -- queries stayed correct but
  over-descended; the stale height was latent). It now refits from the promoted
  sibling, so the grandparent itself is recomputed. This was invisible pre-B3
  because rotations are the first consumer of internal heights; a stale height
  now feeds a wrong rotation decision, so it had to be correct.

### Added
- Box2D-style `_balance` (a faithful port of `b2DynamicTree::Balance`) in the
  refit walk, plus a `_combine(dest, a, b)` node-bbox merge helper.
- `height` (root height in edges; -1 empty, 0 a single leaf) and `leafCount`
  (O(1): a non-empty tree has `nodeCount === 2*leafCount - 1`) as read-only
  telemetry, so degradation is observable without `validate()`.
- Torture tier **T5 (differential fuzz)**: 120k mixed insert/remove/update/query
  ops against a brute-force O(N) oracle, comparing sorted hit sets -- the
  executable proof that rotations change the tree's shape, never its answers. T3
  now asserts the height bound after every adversarial build and mid-drain;
  T6 gains the B-08 gate (the adversarial tree's query is measured
  `maxArrayBuffersGrowth: 0` with `queryStack.length` pinned); T9 gains a
  rotations-disabled control that must trip the height gate.

### Changed
- `query()` no longer grows its stack. The former silent reallocation is now a
  fail-closed throw: for a well-formed tree the 256-slot stack is never
  exhausted (a balanced tree would need ~2^250 nodes), so a throw signals
  corruption rather than papering over it with an allocation in the hot loop.
  The bounds check stays -- dropping it would make an overflow a silent
  typed-array no-op and lose nodes.
- The `updateLeaf` fast path and the `query` inner loop are otherwise UNCHANGED
  (zero new instructions). Rotations live in `_refit`, on the insert/remove path
  only -- never on the fast path, never in a query.

## [1.1.0] - 2026-07-29

Poison quarantine. A degenerate box can no longer enter the tree and silently
kill it. The entry door rejects what `@zakkster/lite-aabb`'s degenerate-value
law (1.1.0) defines as invalid, and `validate()` is the backstop if poison ever
arrives another way. See `decisions/0002-poison-quarantine.md`.

### Fixed
- **B-03** one NaN leaf no longer kills the whole tree. A non-finite bound
  propagated through `_refit` to the root, after which every query returned 0
  hits, permanently and silently. `insertLeaf` now rejects a non-finite or
  inverted box at the door, before any mutation -- atomically, so the tree is
  byte-unchanged on a rejected insert.
- **B-10** `userData` must be a non-negative int32. `-1` (the internal-node
  sentinel), `2**31` (which wrapped negative in the `Int32Array`), `3.7` (which
  truncated to `3`), and `NaN` were all accepted silently; each now throws.
- **A-05 at the door** a negative `margin` larger than half the box width
  inverts the fattened box; `updateLeaf`'s slow path now validates the fattened
  box BEFORE removing the leaf, so an inverting margin throws atomically (the
  leaf stays live) instead of storing an inverted box.

### Added
- The quarantine predicate `_isValidBox` -- all four bounds finite AND
  `minX <= maxX && minY <= maxY`. Copied inline from `@zakkster/lite-aabb`'s
  `isValid` (1.1.0), BY CONTRACT: lite-bvh takes no runtime dependency on
  lite-aabb; the two packages agree on "broken box" by a shared definition, not
  a dependency edge.
- `validate()` now detects a non-finite or inverted bbox on any reachable node
  and names the offender. The old containment check was NaN-blind
  (`NaN > NaN` is `false`), so a poisoned node slipped past it.
- Torture tier **T8 (cross-package)**: builds boxes with `@zakkster/lite-aabb`
  (a new TEST-ONLY devDep), feeds a `merge`/`extend`-poisoned box into a live
  tree, and asserts the door holds and the tree survives byte-identical. T4
  gains the input-quarantine block (short/oversized buffers, non-`Float32Array`
  boxes, bad `userData`, bboxes aliasing); T1 crosses every degenerate value as
  a leaf; T9 gains a control proving `validate()`'s poison detector can fail.

### Changed
- `insertLeaf` and `updateLeaf` now THROW on a non-finite/inverted box, a
  non-negative-int32 `userData` violation, or (insert) a box aliasing the tree's
  own `bboxes` buffer. This only affects calls that were already silent bugs.
- The `updateLeaf` fast path is UNCHANGED (zero new instructions): it never
  writes `newAABB`, so poison there cannot corrupt the tree. Validation lives at
  `insertLeaf` and on the `updateLeaf` slow path only. `query` gains no door --
  a read-only probe cannot poison the tree, and a non-finite or empty-sentinel
  query box has well-defined, pinned behaviour (0 hits).

### Policy (documented, not enforced)
- **B-11** a plain `Array` or `Float64Array` box is accepted and coerced to f32
  on store; only its values are validated, not its type. Pass a `Float32Array`:
  the `updateLeaf` fast path compares against f32-rounded stored bounds, so a
  `Float64Array` value within one f32 ulp of the fat boundary can take the fast
  path yet lie just outside the stored box (a silent query miss). Enforcing the
  type would cost the fast path, which is the one thing this package protects.

### Known issues (unfixed; later sessions)
- **B-07 / B-08** tree rotations and the query-stack growth on degenerate trees
  are the B3 session.

## [1.0.2] - 2026-07-28

Structural integrity. The six S1 ways to silently corrupt a tree with a
plain-looking call are fixed, and the tree can now check itself. See
`decisions/0001-handle-validation.md`.

### Fixed
- **B-01** `insertLeaf` is now atomic: capacity is reserved before the first
  mutation, so a capacity failure throws at the boundary and leaves the tree
  byte-unchanged and still valid, instead of consuming the leaf and orphaning
  it when the parent allocation throws.
- **B-02** `query(q, out)` checks the buffer BEFORE writing, so a full -- or
  zero-length -- buffer never records or reports a phantom hit.
- **B-04** double `removeLeaf(id)` now throws instead of corrupting the
  free-list (previously it drove `nodeCount` negative and, on this build,
  hung in a stale parent-chain walk).
- **B-05** `removeLeaf(internalNodeId)` throws and leaves the tree intact,
  instead of setting `root` to -1 and orphaning every live leaf.
- **B-06** `updateLeaf(freedId, ...)` throws instead of resurrecting a
  removed entity.
- **B-09** the constructor validates `maxNodes` (integer in `[1, 2^26]`) and
  throws a library `Error`, not a raw allocator `RangeError` or silent garbage.

### Added
- Always-on O(1) handle validation on `removeLeaf` and `updateLeaf` via a
  tri-state `children` marker (live leaf `-1` / internal `>= 0` / freed `-2`).
  A bad handle -- non-integer, negative, out of range, internal, or freed --
  throws. Fail-closed, in production, by default.
- `validate()`: an O(n) debug/test-only structural self-check (free-list
  conservation and acyclicity, reciprocal links, heights, bbox containment,
  node markers, reachable count). Never on a hot path.
- `_isLiveLeaf(id)` O(1) predicate (internal/test guard).
- Torture tiers T3 (adversarial insert/remove orders, capacity boundary,
  teleport churn, finite margins) and T4 (handle/buffer abuse) filled;
  `validate()` asserted after every T3 sequence. A new T9 control proves
  `validate()` itself can fail.

### Changed
- `removeLeaf` and `updateLeaf` now THROW on an invalid handle. This only
  affects calls that were already bugs, but it is observable: catch it, or
  stop passing stale/freed ids.

### Known issues (unfixed; later sessions)
- **B-03 / B-10 / B-11 / B-12** input quarantine -- a NaN or inverted box, junk
  `userData`, non-`Float32Array` inputs, and aliasing the tree's own `bboxes`
  into `insertLeaf` -- are the B2 session (poison quarantine). A NaN box is a
  valid `Float32Array(4)` that passes handle validation, so it needs a separate
  door; the deferred cases are marked in torture tier T4.
- **B-07 / B-08** tree rotations and the query-stack growth on degenerate trees
  are the B3 session.

## [1.0.1] - 2026-07-28

Tooling and disclosure release. **No behavior change** to `Bvh.js` logic:
this session makes the existing structural bugs visible and reproducible,
it does not fix them (that is 1.0.2).

### Added
- `VERSION` export from `Bvh.js`. Three-place version sync from here on:
  the constant, `package.json` `version`, and this file's top entry.
- Node built-in test runner. `test/Bvh.test.js` ported from the bespoke
  `node --expose-gc Bvh.test.js` assert runner to `node --test`.
  Run: `npm test`.
- `test/torture.mjs` zero-GC / structural-integrity gate (tiers T0 laws,
  T1 degenerate, T3 adversarial, T4 handles, T6 alloc, T7 soak, T9 controls).
  Run: `npm run torture` -> prints exactly `ok`, exit 0. The T6 lane gates
  `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` and a direct
  `queryStack.length` / `bboxes.buffer.byteLength` assertion, because
  ArrayBuffer backing stores live outside the V8 heap and are invisible to a
  heap-growth gate (lite-gc-profiler documents a measured 152x blind spot).
- Free-list conservation invariant `nodeCount + _freeListLength() === maxNodes`,
  checkable via the internal `_freeListLength()` test helper.
- Deliberately-breakable control: `BVH_TORTURE_BREAK=1 node --expose-gc
  test/torture.mjs` injects an allocation into the T6 hot loop and must exit
  non-zero. A gate that cannot fail is decorative.
- devDependencies: `@zakkster/lite-gc-profiler`, `@zakkster/lite-leak`.

### Fixed
- `Bvh.d.ts` drift (B-14): declared `queryStack`, `nextFree`, `freeHead`,
  `_scratchAABB`, and `VERSION`. `readonly` on the SoA buffers now documents
  its real meaning -- "do not reassign the binding", not "contents are
  immutable" (they are mutated in place by every operation).
- Unit-test import pointed at `../Bvh.d.ts` (type declarations, no method
  bodies), so the entire suite threw `insertLeaf is not a function`. It now
  imports the implementation, `../Bvh.js`.

### Known issues (unfixed; scheduled for 1.0.2 / B1)
Registered as `todo` reproductions in `test/known-issues.test.js`. Each is a
silent way to corrupt a tree with a plain-looking call:
- **B-01** capacity-exhaustion insert leaks a node and corrupts `nodeCount`
  (allocates the leaf, then throws allocating the parent).
- **B-02** `query(q, new Int32Array(0))` returns 1 while writing nothing
  (the buffer-full check runs after the write).
- **B-04** double `removeLeaf(id)` drives `nodeCount` to -1 and corrupts the
  free-list chain.
- **B-05** `removeLeaf(internalNodeId)` silently destroys the tree.
- **B-06** `updateLeaf(freedId, ...)` resurrects a removed entity.

[1.2.0]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.2.0
[1.1.0]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.1.0
[1.0.2]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.0.1
