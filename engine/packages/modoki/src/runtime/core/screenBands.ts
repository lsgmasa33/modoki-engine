/**
 * The vertical BAND STACK solver — how a game divides its design box into horizontal strips.
 *
 * A band is an authored claim on vertical space: `minHeight` is a floor it never goes below, and
 * `flex` is its share of whatever height is left once every floor is paid. `flex: 0` is therefore
 * rigid. The point of expressing it this way, rather than as a chain of subtractions, is that it
 * makes **which band absorbs a per-device reserve** an authored decision instead of an accident of
 * arithmetic — for both shipping games that reserve is the ad banner, and it swings 18-178 design
 * px across the device set.
 *
 * ⚠️ **`reserve` is subtracted BEFORE any band is paid, because it is not a band.** It is not
 * authored at all — it is a per-device MEASUREMENT — so it cannot take part in the flex split.
 *
 * ⚠️ **Every band's `minHeight` must already be RESOLVED by the caller.** A game whose floor is a
 * measured quantity (Court's `top` band is its measured caption bottom) substitutes the number
 * before calling. Keeping that out of here is what lets this stay pure arithmetic with no `World`,
 * and therefore testable as arithmetic.
 *
 * ⚠️ **L0: this module imports NOTHING.** It is the shape `entityOrder.ts` is — see
 * docs/architecture-layers.md. Do not reach for a trait or a world here; the reader that does both
 * lives in `runtime/ui/readScreenBands.ts`.
 *
 * Generic over the role string so each game keeps its OWN role union end to end: Court's `byRole`
 * stays keyed by Court's four roles, and a typo is a type error in the game rather than a lookup
 * that silently returns undefined.
 *
 * Extracted from two independent copies (wordweave #773, court #791) that were arithmetically
 * identical — same clamps, same floors-then-flex split, same first-wins-on-duplicate `byRole` —
 * under #800.
 */

/** One authored band. */
export interface Band<R extends string = string> {
  readonly role: R;
  /** Top-to-bottom position in the stack. Ties are unspecified — keep them distinct. */
  readonly order: number;
  /** Design-px floor. For a rigid band (`flex: 0`) this IS its height. */
  readonly minHeight: number;
  /** Share of the leftover height after every band's `minHeight` is paid. 0 = rigid. */
  readonly flex: number;
}

/** One band resolved to its design-space vertical extent. */
export interface SolvedBand<R extends string = string> {
  readonly role: R;
  readonly y: number;
  readonly h: number;
}

export interface SolvedBands<R extends string = string> {
  /** Every band with its solved extent, in stacking order. */
  readonly bands: SolvedBand<R>[];
  /** Lookup by role. A role no band declared is ABSENT rather than a zero-height rect — a caller
   *  that needs one has to say so, instead of laying out against a silent zero. */
  readonly byRole: Partial<Record<R, SolvedBand<R>>>;
}

/**
 * Resolve a band stack into design-space vertical extents.
 *
 * ⚠️ Both clamps are deliberate. A `reserve` plus floors exceeding the design height drives the
 * leftover to 0 rather than negative: bands keep their floors and the flexed bands collapse. A
 * negative authored `minHeight` or `flex` is clamped to 0 rather than being allowed to steal height
 * from its neighbours.
 */
export function solveBands<R extends string>(
  bands: readonly Band<R>[],
  opts: { designH: number; reserve: number },
): SolvedBands<R> {
  const ordered = [...bands].sort((a, b) => a.order - b.order);
  const floorOf = (b: Band<R>): number => Math.max(0, b.minHeight);
  const weightOf = (b: Band<R>): number => Math.max(0, b.flex);

  const floors = ordered.reduce((sum, b) => sum + floorOf(b), 0);
  const available = Math.max(0, opts.designH - opts.reserve);
  const leftover = Math.max(0, available - floors);
  const flexTotal = ordered.reduce((sum, b) => sum + weightOf(b), 0);

  const out: SolvedBand<R>[] = [];
  const byRole: Partial<Record<R, SolvedBand<R>>> = {};
  let y = 0;
  for (const b of ordered) {
    const h = floorOf(b) + (flexTotal > 0 ? (leftover * weightOf(b)) / flexTotal : 0);
    const solved: SolvedBand<R> = { role: b.role, y, h };
    out.push(solved);
    // First wins on a duplicate role. The READER drops duplicates before they reach here, so this
    // is the direct-caller path — but a duplicate that got this far would still take a share of
    // `flexTotal`, which is why the reader refuses to pass one on.
    if (byRole[b.role] === undefined) byRole[b.role] = solved;
    y += h;
  }
  return { bands: out, byRole };
}
