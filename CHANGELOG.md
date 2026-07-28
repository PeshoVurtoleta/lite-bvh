# Changelog

All notable changes to `@zakkster/lite-bvh` are documented here.
The format follows Keep a Changelog; this package adheres to SemVer.

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

[1.0.1]: https://github.com/PeshoVurtoleta/lite-bvh/releases/tag/v1.0.1
