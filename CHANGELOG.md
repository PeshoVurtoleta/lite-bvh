# Changelog

All notable changes to `@zakkster/lite-bvh` are documented here.
The format follows Keep a Changelog; this package adheres to SemVer.

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

[1.0.2]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.0.1
