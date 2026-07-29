# 0003 -- Tree rotations + query-stack policy (B3, v1.2.0)

Status: accepted, 2026-07-29
Findings: B-07 (adversarial height), B-08 (query allocates), + a remove-refit bug
Depends on: B2 (0002-poison-quarantine)

## Problem

Two findings, one root cause: the `// TODO: Box2D-style rotations` in `_refit`.

`insertLeaf` picks a sibling by the Surface Area Heuristic and refits the parent
chain, but never rebalances. For a friendly (scattered) insert order the SAH
alone produces a well-shaped tree, so this was invisible. For an adversarial
order it is fatal: 20,000 wide slabs inserted in monotone-increasing order
produce a tree of **height 19,999** -- a linked list wearing a BVH costume
(B-07). Two consequences:

- Every further insert's refit walk is O(height) = O(N), so building that tree
  is O(N^2): ~2.5 s for 20k, and it does not finish in two minutes for 100k.
- A single `query()` on it grows `queryStack` from 256 to 32,768 by allocating
  `new Int32Array` **inside the traversal loop** (B-08). That breaks the package's
  headline "no allocations after construction" with data alone -- and does it
  invisibly to a heap-growth gate, because the stack is an ArrayBuffer backing
  store outside the V8 heap (the profiler documents a measured 152x blind spot).

Sorted spawn order is not exotic, so both are reachable by accident.

## Decision 1: rotations -- a faithful Box2D `Balance` port

`_refit` now rebalances with Box2D-style single rotations (`_balance`, a
line-for-line port of Erin Catto's `b2DynamicTree::Balance`). At each ancestor
on the refit walk, if the two subtrees differ in height by more than one, the
taller grandchild is rotated up; the moved nodes' parent links, bboxes and
heights are fixed, and the walk continues from the subtree's new root. Balance
is called BEFORE the node's own bbox/height recompute (Box2D order), so it always
reads current child heights.

Both rotation branches (rotate-C-up / rotate-B-up) are written out in full rather
than folded into a shared helper: this is the insert/remove path, not the fast
path, and staying bit-faithful to the reference is worth more than brevity.

This holds `height <= 2*ceil(log2(leafCount)) + 2` under every adversarial order
in the torture suite (monotone, reverse, spiral, identical, at N up to 100k),
asserted after each build and mid-drain. Measured height at N=20,000 monotone:
**19,999 -> 15**.

### A remove-refit bug rotations exposed

`removeLeaf` promotes the sibling into the grandparent, then called
`_refit(grandParent)` -- but `_refit(x)` starts at `parents[x]`, so it began one
level too high and left the grandparent's own height and bbox **stale**. The
stale bbox is always a superset (queries stayed correct, just over-descended);
the stale height was latent -- until rotations became the first consumer of
internal heights, where a wrong height feeds a wrong rotation decision. Fixed by
refitting from the promoted `sibling` (whose parent is the grandparent), so the
grandparent is recomputed. B1's remove tests missed it because they validated
only the empty tree at the end of a drain; T3 and a new regression now validate
after every removal.

## Decision 2: query-stack policy -- fixed size + fail-closed throw (option B)

The roadmap offered: (A) size the stack from `maxNodes`; (B) bound the depth and
make overflow a fail-closed throw; (C) keep growing but count it. **Chosen: B, in
its simplest safe form.**

The iterative DFS (pop one, push both children) uses at most `height + 1` stack
slots. With rotations, height is O(log n); even at the 2^26 `maxNodes` ceiling a
balanced tree's height is ~50, and the fixed 256-slot stack only fills at height
255 -- a balanced tree of ~2^250 nodes. So 256 is safe headroom across the entire
supported range, at zero memory-scaling cost.

- **Why not A** (size from `maxNodes`): the only way to guarantee no throw even
  with rotations OFF is to size for the degenerate worst case, `O(maxNodes)`
  slots -- 256 MB at the 2^26 cap, to defend against a case rotations already
  make unreachable. Rejected on memory.
- **Why not C** (grow + count): keeping a growth path means the zero-alloc
  promise has an asterisk. The whole point of B-08 is that there must be no
  allocation in the query loop.

The former silent reallocation is now a **fail-closed throw**: overflow means the
tree is more degenerate than rotations permit, i.e. corruption, so it fails loud
rather than papering over it with a hot-loop allocation. The bounds check stays
in the loop -- removing it would make an overflow a silent typed-array no-op,
losing nodes and returning wrong hit counts, which is worse than a throw.

## Telemetry

`height` (root height in edges; -1 empty, 0 a single leaf) and `leafCount`
(O(1): a non-empty tree has `nodeCount === 2*leafCount - 1`) are read-only
getters, so degradation is observable without an O(n) `validate()`.

## Hot path

Rotations run in `_refit`, which is on the insert/remove path -- NOT on
`updateLeaf`'s fast path and NOT in `query`. The fast path and the query inner
loop take **zero** new instructions (provable by diff). `query`'s only change is
that the overflow branch throws instead of reallocating; that branch is off the
normal path (it never trips for a well-formed tree).

## Measured

`measureOps({ stabilize: 'deep' })`, best of 5, Node v26, same machine. Run-to-run
variance is ~2x on this shared box, so throughput figures are ranges and the
binding contract is the alloc gate (bytesPerOp / `maxArrayBuffersGrowth: 0`), not
the ops/sec -- as in 0001 and 0002.

| probe | v1.1.0 | v1.2.0 | bytesPerOp |
| --- | --- | --- | --- |
| `updateLeaf` fast path | ~84 M/s | ~87 M/s | 0 |
| `query` (scattered, 512 leaves) | ~4.2 M/s | ~16 M/s | 0 |
| `insert`+`remove` churn (small balanced tree) | ~6.0 M/s | ~7.4 M/s | ~0 |
| **monotone build, N=20,000** | **~2550 ms** | **~8.4 ms** | -- |
| **monotone build, N=100,000** | **did not finish (>2 min)** | **~41 ms** | -- |
| **adversarial full-extent `query`: stack** | **256 -> 32,768 (allocates)** | **256 (stable)** | 0 |

The fast path is unchanged within noise, as expected -- it gained no code. The
scattered query improves because the balanced tree is shallower. The headline is
the adversarial column: rotations turn an O(N^2) build into O(N log N)
(~300x at N=20k) and eliminate the query-loop allocation entirely, so the T6
gate's `maxArrayBuffersGrowth: 0` now passes on the adversarial tree that used to
fail it. `bytesPerOp` is 0 on every steady-state probe; that gate is the contract.

There is no insert regression to report on a balanced workload: the small-tree
churn moved 6.0 -> 7.4 M/s, within this machine's noise. Rotations add a bounded
number of index writes per ancestor, which is dominated by the refit already
happening there; on adversarial input they are a ~300x net win.

## Consequences

- `query()` can now throw (stack overflow) -- unreachable for a well-formed tree,
  a fail-closed corruption signal otherwise.
- `height` and `leafCount` are new public read-only accessors.
- Query hit sets are byte-identical to the pre-rotation implementation across the
  T5 fuzz corpus: rotations change shape, never answers.
- B4 (new query kinds / raycast) is unblocked; it does not touch rotations.
