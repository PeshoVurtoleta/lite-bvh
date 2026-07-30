# The AABB FORMAT contract

`FORMAT_VERSION = 1`

This is the shared, versioned buffer contract between `@zakkster/lite-aabb` and
`@zakkster/lite-bvh`. Both packages export `FORMAT_VERSION` and both assert this
document's invariants. A consumer that builds boxes with one package and feeds
them to the other relies on every rule below. When the layout itself changes,
`FORMAT_VERSION` increments and both packages bump together.

`FORMAT_VERSION` is an integer compared for **equality**, on a separate axis from
each package's semver `VERSION`. Two packages agree on the format iff their
`FORMAT_VERSION` values are equal.

## Single box

A box is a `Float32Array` of length **4**:

| Index | 0      | 1      | 2      | 3      |
| ----- | ------ | ------ | ------ | ------ |
| Field | `minX` | `minY` | `maxX` | `maxY` |

- Element type is **`Float32Array`** (~7 significant decimal digits). Not
  `Array`, not `Float64Array` -- indexed typed-array reads are the performance
  contract, and an f64 box compared against f32-rounded stored bounds can differ
  by under one ULP.
- There is no class wrapper. Every operation is a module-level function on this
  flat layout.
- A valid box has `minX <= maxX` and `minY <= maxY`. Check with `isValid`.

## Touching-edge convention (the A-02 triad)

The boundary is treated three ways, deliberately:

- `intersects` -- touching edges **count** as overlapping (`>=`/`<=`).
- `contains` -- touching edges **count** as contained.
- `overlapArea` -- a touching (zero-width) intersection has area **`0`**.

A touching pair genuinely shares zero area, so `overlapArea` differing from the
predicates is correct, not a bug. `containsPoint` follows the inclusive rule
(edges and corners count); `distanceSq` is `0` for overlapping AND touching
boxes.

## Degenerate values

NaN **propagates** through every numeric op and is never laundered into a clean
number; the boolean predicates **fail closed** to `false`. Every box is one of:
**VALID** (`isValid`), **EMPTY** (the canonical sentinel `[Inf, Inf, -Inf,
-Inf]`, recognized by `isEmpty`, built by `setEmpty`, the identity of
`merge`/`extend`), or **GARBAGE**. The geometry ops are total and branchless:
they do not validate. Check `isValid` at trust boundaries.

## Precision (the margin floor)

Float32 has a coordinate-dependent step (ULP). Once a `fatten` margin drops below
that step it rounds away and the box silently does not widen. `fatten` is
branchless and never bumps; `marginFloor(a)` reports the smallest margin that
provably widens the box at its coordinates, and the caller clamps:
`fatten(out, a, Math.max(margin, marginFloor(a)))`.

## Aliasing (single box)

Every single-box writer snapshots its array inputs into locals before the first
write, so `out` may safely alias any input under **any** view relationship: the
same view, a shifted/partially-overlapping `subarray` of one buffer, or a
distinct buffer.

## Packed `4*N` buffers

A packed buffer holds N boxes contiguously in one `Float32Array` of `4*N` floats.
Box `i` occupies slots `4i .. 4i+3` (stride 4). The batch ops
(`fattenAll`, `mergeAll`, `intersectsAny`) read and write this shape.

- **Bounds are the caller's contract.** `inPacked.length >= 4*count` and, where
  applicable, `outPacked.length >= 4*count`. The ops do not validate length: an
  out-of-range read yields `undefined -> NaN`, which propagates (it never
  produces a silently-wrong finite answer). `count` bounds every loop; a `count`
  of 0, negative, or NaN processes zero boxes.
- **`count === 0`** is defined: `mergeAll` yields the empty sentinel,
  `intersectsAny` yields `-1`, `fattenAll` writes nothing.

### Packed aliasing rules

The single-box "alias anything" rule does **not** extend uniformly to packed ops,
because an element-wise write to box `i` can clobber box `i+1`'s input:

| Op               | Aliasing                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `mergeAll`       | `out4` may alias **anywhere** in `inPacked` (all reads precede the one write). |
| `intersectsAny`  | Read-only; `b` may be a view into `inPacked`.                            |
| `fattenAll`      | `outPacked === inPacked` (in place) **safe**; disjoint `outPacked` **safe**; a shifted/partially-overlapping view of `inPacked` **unsupported**. |

For a shifted `fattenAll` destination, use a disjoint output buffer.
