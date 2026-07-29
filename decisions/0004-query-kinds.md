# 0004 -- New query kinds: clear / getBounds / queryPoint / raycast (B4, v1.3.0)

Status: accepted, 2026-07-29
Finding: B-13 (missing introspection / query API)
Depends on: B3 (0003-rotations-and-query-stack)

## Problem

The README's roadmap has promised four additions since 1.0.0. B1-B3 made the
structure sound (atomic ops, a quarantine door, O(log n) height, a non-allocating
query stack), so the features are now cheap to add on top -- three of them. The
fourth (`closestPoint`) is not, and this record says why it is deferred rather
than half-shipped.

## Decision 1: `queryPoint` and `raycast` reuse the query stack, no callback

Both new probes are iterative DFS over the same tree, so they REUSE `queryStack`
and inherit B3's policy verbatim: the stack is fixed at 256 slots, never grows,
and an overflow throws fail-closed (unreachable for a well-formed tree, because
rotations bound height to O(log n)). They are therefore part of the T6
`maxArrayBuffersGrowth: 0` gate, alongside `query`.

`queryPoint(x, y, out)` tests point-in-box (`bboxes[b] <= x && bboxes[b+2] >= x`,
same on y). By construction it equals `query([x, y, x, y], out)` -- containing a
point is overlapping a zero-size box at that point -- which is the exact fuzz
assertion in T5 and a named unit test. Same touching-edge convention (`<=`/`>=`),
same early-stop, same read-only stance (non-finite coords return 0, never throw).

### `raycast` writes to a caller buffer -- no callback form (rejected)

The README's roadmap sketched `raycast(p0, p1, callback)`. **Rejected.** A per-hit
callback re-enters user code in the middle of a traversal that holds the shared
`queryStack`. If that callback issues any nested query/queryPoint/raycast, it
overwrites the stack mid-walk and corrupts the outer traversal -- turning
"reentrant-safe" from true-by-accident into silently-false. Every other probe
here writes hits into a caller-owned `Int32Array` and stops early when it fills;
`raycast` does the same, so reentrancy stays honest and the zero-alloc contract
holds (no closure, no per-hit object). A caller who wants per-hit work iterates
the returned prefix afterwards.

### Slab test: explicit zero-direction branch, not the branchless `1/d` trick

`raycast` clips the segment against each node's slabs over `t in [0, 1]` (a
segment, not an infinite ray). The common branchless form precomputes `1/d` and
lets `+/-Infinity` carry the degenerate axes -- but when the segment starts
exactly on a slab boundary it computes `0 * Infinity === NaN` (or `0/0`), and a
NaN silently defeats the `tmin`/`tmax` clamp (`NaN < x` and `NaN > x` are both
false), so a grazing segment would wrongly match. We take the explicit per-axis
branch instead: if `d === 0` on an axis, the segment is parallel to that slab and
hits only if the origin lies within `[min, max]`; otherwise clip normally.
Branches are free here (no allocation); NaN-correctness is not negotiable. A
zero-length segment (`p0 === p1`) takes the parallel branch on both axes and so
degenerates exactly to `queryPoint(p0)` -- asserted in T5 and a unit test.

One consequence the point test does not share: the slab arithmetic does not
self-reject a NaN endpoint the way `query`'s comparisons do (a NaN `t` leaves
`tmin=0/tmax=1` unclamped, which would match every leaf). So `raycast` guards
finiteness ONCE up front and returns 0 for a non-finite endpoint -- matching
`query`'s read-only convention, off the per-hit path, costing the traversal
nothing.

## Decision 2: `clear()` fails closed via `children.fill(FREED)`

`clear()` returns the tree to its just-constructed state without reallocating any
buffer (for scene reloads, and so the T7 soak can reset in place instead of
building a new tree each cycle). It rebuilds the free-list chain, sets
`root = -1`, `nodeCount = 0`, `freeHead = 0`.

The load-bearing line is `children.fill(FREED)`. `children[id<<1]` is the
tri-state liveness marker (`-1` live leaf, `>=0` internal, `-2` FREED); a leaf
handle held across a `clear()` would still read `-1` and pass `_isLiveLeaf`,
letting a stale id mutate a slot the caller no longer owns. Resetting every
marker to FREED makes `updateLeaf`/`removeLeaf`/`getBounds` on a pre-clear handle
throw -- fail closed, consistent with the B1 handle policy. The other SoA fields
(bboxes/heights/userData/parents) are reset per node by `_allocateNode` on reuse,
so they need no wipe. `clear()` is therefore O(maxNodes) and says so in its doc
comment; it is not a hot-path call. T9 control 7 disables the fill and asserts the
stale handle survives, proving the step is not decorative.

## Decision 3: `closestPoint` deferred (not shipped)

The README marks `closestPoint` Hard. It is: nearest-leaf search needs a
best-first traversal ordered by distance, i.e. a priority queue -- a SECOND data
structure with its own independent zero-allocation proof (a pre-allocated binary
heap over node ids, its own overflow policy, its own torture coverage). Bolting a
heap on to hit one method would either allocate per query (breaking the headline
contract) or ship an unproven heap into the one package whose identity is "no
allocation after construction." Deferred with this reason on the record rather
than half-shipped. If it lands later it is its own session with its own decision
record, not a footnote here.

## Hot path

`queryPoint` and `raycast` are NEW methods; they do not touch `query`,
`updateLeaf`'s fast path, or the SAH insert. Those functions are byte-identical
to 1.2.0 (provable by diff), so their measured behaviour is unchanged. `clear`
and `getBounds` are not hot (`clear` is O(maxNodes); `getBounds` is O(1) but a
setup/introspection call, not a per-frame probe).

## Measured

`measureOps({ stabilize: 'deep' })`, best of 5, Node v26, 512-leaf scattered tree.
Run-to-run variance is ~2x on this shared box, so throughput is indicative; the
binding contract is `bytesPerOp` / `maxArrayBuffersGrowth: 0`, as in 0001-0003.

| probe | M/s | bytesPerOp |
| --- | --- | --- |
| `query` (box, baseline) | ~10.5 | 0 (0.007 = profiler noise) |
| `queryPoint` | ~10.3 | 0 |
| `raycast` | ~8.9 | 0 |
| `updateLeaf` fast path | ~24.8 | 0 |
| `getBounds` | ~25.4 | 0 |

`queryPoint` tracks `query` (it does strictly less work -- a point, not a box --
but descends the same tree). `raycast` is a little cheaper per node avoided and a
little dearer per node kept (the slab clip is more arithmetic than an overlap
test); on a scattered tree it lands just below `query`. Every steady-state probe
is 0 bytes/op; that gate is the contract. On the adversarial monotone tree, T6
gates `queryPoint` and `raycast` too and the shared stack holds at 256.

## Consequences

- Four new public methods: `clear()`, `getBounds(leaf, out4)`,
  `queryPoint(x, y, out)`, `raycast(p0x, p0y, p1x, p1y, out)`.
- `queryPoint`/`raycast` can throw only on the same impossible stack overflow as
  `query`; `getBounds` throws on a bad handle like the other handle-takers.
- T5 now fuzzes all three query kinds against independent brute-force oracles;
  T6 gates all three for allocation; T7 soaks `clear()`; T9 adds controls for the
  `clear()` fail-closed step and the point/segment touching-edge convention.
- `closestPoint` remains unimplemented, deferred here with its reason.
- No format change, no SAH change, no callback APIs. X1 (the twin 2.0.0 format
  contract) is the next and final session in the bvh line.
