# 0001 -- Handle validation and atomic insert (B1, v1.0.2)

Status: accepted, 2026-07-28
Findings: B-01, B-02, B-04, B-05, B-06, B-09

## Problem

Six ways to corrupt a tree with a plain-looking call, all silent, one root
cause: **no operation validated that the id it was handed was a live leaf, and
insert was not atomic.**

- `removeLeaf(freedId)` twice -> free-list corruption; on the current build the
  second call walks a stale parent chain and **never terminates**.
- `removeLeaf(internalNodeId)` -> `root` set to -1, the tree silently destroyed.
- `updateLeaf(freedId, ...)` -> returns an id, resurrecting a deleted entity.
- `insertLeaf` at capacity -> the leaf is allocated, then the parent allocation
  throws, leaking the leaf and corrupting `nodeCount`.
- `query(q, new Int32Array(0))` -> returns 1 while writing nothing.
- `new DynamicBVH2D(bad)` -> raw `RangeError` or silent garbage.

## Decision

### Liveness: a tri-state `children` left-slot marker

`children[id<<1]` already distinguishes a leaf (`-1`) from an internal node
(`>= 0`). We add a third state for freed slots and make the whole thing the
liveness oracle:

| state | `children[id<<1]` | set by |
| --- | --- | --- |
| live leaf | `-1` | `_allocateNode` |
| internal | `>= 0` | `insertLeaf` |
| freed | `-2` (`FREED`) | `_freeNode`, and the constructor's initial fill |

Liveness is then O(1) with no traversal:

```
(id >>> 0) === id && id < maxNodes && children[id << 1] === -1
```

`(id >>> 0) === id` rejects negatives, non-integers (e.g. `1.5`) and ids `>= 2^32`
in a single test before the range and marker checks. This is **cheaper and more
complete than the reachability check** the brief floated: reachability would not
catch a freed leaf (its `children` slot is still `-1` unless we mark it), which
is exactly the B-06 case.

### Enforcement: always on (Option A), not behind a flag

`removeLeaf` and `updateLeaf` validate on **every** call, in production. The
alternative -- validation behind a `{checked:true}` constructor flag defaulting
off -- was rejected: fail-closed is the house law, and these are S1 bugs that
bite real callers. A guard that is off in production protects nobody.

The guard sits inline at the top of both mutators (not a method call, to keep
the `updateLeaf` fast path tight). `validate()` and tests share the same logic
via `_isLiveLeaf`.

### Atomic insert

`insertLeaf` reserves capacity **before the first mutation**: a non-empty tree
needs two free nodes (leaf + new parent), an empty tree needs one. On shortfall
it throws at the boundary, leaving the tree byte-unchanged and still valid --
which is what the README already promised.

### validate()

An O(n), debug/test-only full structural check (free-list conservation and
acyclicity, reciprocal parent/child links, correct heights, bbox containment,
node markers, reachable == nodeCount). Never called on a hot path. It is the
centrepiece the torture suite asserts after every adversarial sequence.

### Constructor

`maxNodes` must be an integer in `[1, 2^26]`; otherwise a library `Error`. (A
two-leaf tree needs at least 3 nodes: two leaves plus one internal parent.)

## Hot-path cost

The only change on the `updateLeaf` fast path is the guard: two integer
comparisons and one `children` load, no traversal and no allocation.

Measured with `measureOps({ ops: 2_000_000, warmup: 100_000, stabilize: 'deep' })`,
`updateLeaf` fast path (tight bounds inside fat bounds), Node v26, same machine:

| build | ops/sec (best of runs) | bytesPerOp |
| --- | --- | --- |
| v1.0.1 baseline | ~181M -- 206M | 0 |
| v1.0.2 (guard) | ~123M -- 180M | ~0 (<= 0.004) |

Run-to-run variance is large (+/- ~40%) on this shared machine, so the two added
comparisons are within measurement noise; both builds sustain well over 100M
`updateLeaf`/sec, far past any real workload. **The load-bearing property --
zero allocation -- is preserved:** `bytesPerOp` is ~0, and torture tier T6 gates
`maxMajor:0` **and** `maxArrayBuffersGrowth:0` (with `stabilize:'deep'`) plus a
direct `queryStack.length` / `bboxes.buffer.byteLength` equality. That gate,
not the noisy throughput figure, is the contract.

## Consequences

- `removeLeaf`/`updateLeaf` now **throw** on a bad handle instead of silently
  corrupting. This is a behaviour change, but only for calls that were already
  bugs; documented in the CHANGELOG and README.
- B2 (poison quarantine) builds on `_isLiveLeaf` and `validate()`: a NaN box is a
  valid `Float32Array(4)` that passes handle validation, so quarantining it is a
  separate door -- see the deferred cases marked in torture tier T4.
