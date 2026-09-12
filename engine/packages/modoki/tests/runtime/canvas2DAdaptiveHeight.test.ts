/** canvas2DAdaptiveHeight — the opt-in `Canvas2D.maxReferenceHeight` (#1087), the vertical twin of
 *  `maxReferenceWidth` (#773/#774): on a host TALLER than the design aspect the design box grows
 *  from `referenceHeight` toward the host aspect, turning the letterbox strip into addressable
 *  design space instead of dead pixels.
 *
 *  ⚠️ **The first describe below is the one that matters.** #774 made the WIDTH adaptive and the
 *  consequences surfaced months later as an owner bug report (#806): widening the box lowered
 *  `scale`, host-space chrome (`vmin`, safe-area insets) did not move with it, and the two stopped
 *  holding the ratio the docs recorded. #815 closed that with a ruling and the closed form
 *  `ratio = vmin / (1080 * scale)`.
 *
 *  This axis is safe for a reason that is ASSERTABLE rather than argued: under `contain`, growing
 *  the height does not change `scale` at all. Setting `effectiveRefH = refW / hostAspect` makes
 *  `actualH / effectiveRefH === actualW / refW`, so the `contain` min is taken between two equal
 *  terms; past the cap the width term wins and it is unchanged again. So the ratio above is
 *  untouched on every shipping phone, and host-space chrome cannot drift.
 *
 *  Each case names the mutation it catches. */

import { describe, it, expect } from 'vitest';

import { computeCanvasScale } from '../../src/runtime/rendering/canvas2DScaler';

const REF_W = 1080, REF_H = 1920;
/** Hosts TALLER than 9:16 — i.e. where this feature does anything at all. */
const TALL_HOSTS: Array<[number, number, string]> = [
  [402, 874, 'iPhone 16 Pro (19.5:9)'],
  [411, 890, 'Pixel-class (9:19.5)'],
  [360, 780, 'Galaxy S22 — the narrowest shipping phone'],
  [1080, 2340, 'a 19.5:9 handset at native px'],
];

describe('under `contain` the SCALE does not move — the property that makes this axis safe', () => {
  for (const [actualW, actualH, label] of TALL_HOSTS) {
    it(`${label}: scale with the cap set equals scale with it off`, () => {
      // ⚠️ **What this does and does NOT catch — measured, not assumed.** Two mutations were tried
      // against it and PASSED, and saying so is the point of the note:
      //
      //   - Deriving `effectiveRefW` from `effectiveRefH` (the "mutually recursive" shape) passes,
      //     because in one direction it is a fixed point: `effectiveRefH = refW / aspect`, so
      //     `effectiveRefH * aspect === refW` and the width lands back on its authored value.
      //     Genuinely circular code cannot be written straight-line at all.
      //   - Making `contain` take the min against the RAW `refH` passes too, and that one is a true
      //     equivalence rather than a gap: under `contain` the HEIGHT term never strictly binds.
      //     Uncapped it equals the width term exactly; capped it is larger, so the width term wins.
      //     **That is the mechanism behind "scale does not move" — not an accident of the fixture.**
      //
      // What this case does catch is anything that moves the WIDTH term on a tall host, which is the
      // thing that would actually reproduce #806 here. The lower clamp on `effectiveRefW` is caught
      // by 'a tall host adapts only the height' below; `effectiveRefH`'s own clamps are caught by
      // the cap cases; and the modes where `effectiveRefH` IS load-bearing — cover, fill, fitH and
      // `offsetY` — are pinned separately at the bottom of this file.
      const off = computeCanvasScale(REF_W, REF_H, actualW, actualH, 'contain');
      const on = computeCanvasScale(REF_W, REF_H, actualW, actualH, 'contain', 0, 4000);
      expect(on.scale).toBeCloseTo(off.scale, 10);
      expect(on.scaleX).toBeCloseTo(off.scaleX, 10);
      expect(on.scaleY).toBeCloseTo(off.scaleY, 10);
      // ...and the width axis is untouched, which is the other half of "one axis adapts".
      expect(on.refW).toBe(REF_W);
    });

    it(`${label}: the box really did grow, so the test above is not vacuous`, () => {
      // Without this, "scale is unchanged" would also pass if the feature did nothing at all.
      const on = computeCanvasScale(REF_W, REF_H, actualW, actualH, 'contain', 0, 4000);
      expect(on.refH).toBeGreaterThan(REF_H);
      expect(on.refH).toBeCloseTo(REF_W / (actualW / actualH), 6);
      // The letterbox strip is gone: content now fills the host vertically.
      expect(on.offsetY).toBeCloseTo(0, 6);
    });
  }
});

describe('the cap bounds the growth', () => {
  it('never grows past maxRefH, and letterboxes again beyond it', () => {
    // MUTATION: drop the upper clamp. An extremely tall window would stretch the design box without
    // bound and the crossword would float in a column nothing fills.
    const capped = computeCanvasScale(REF_W, REF_H, 300, 1600, 'contain', 0, 2200);
    expect(capped.refH).toBe(2200);
    // Past the cap the width term wins the `contain` min, so scale is still the width-bound one.
    expect(capped.scale).toBeCloseTo(300 / REF_W, 10);
    expect(capped.offsetY).toBeGreaterThan(0);
  });

  it('never SHRINKS the box below referenceHeight', () => {
    // MUTATION: drop the lower clamp. On a WIDE host `refW / hostAspect < refH`, so the box would
    // shrink — silently cropping authored content that sits near the bottom of the design box.
    const wide = computeCanvasScale(REF_W, REF_H, 1376, 1032, 'contain', 0, 4000);
    expect(wide.refH).toBe(REF_H);
  });
});

describe('at most ONE axis adapts', () => {
  it('a tall host adapts only the height, even with both caps set', () => {
    const cs = computeCanvasScale(REF_W, REF_H, 402, 874, 'contain', 1440, 4000);
    expect(cs.refW).toBe(REF_W);
    expect(cs.refH).toBeGreaterThan(REF_H);
  });

  it('a wide host adapts only the width, even with both caps set', () => {
    // MUTATION: gate the two on something other than their own lower clamp (an explicit aspect
    // comparison that disagrees with the clamp) and one of these two goes red.
    const cs = computeCanvasScale(REF_W, REF_H, 1376, 1032, 'contain', 1440, 4000);
    expect(cs.refH).toBe(REF_H);
    expect(cs.refW).toBeGreaterThan(REF_W);
  });

  it('the design aspect exactly adapts neither', () => {
    const cs = computeCanvasScale(REF_W, REF_H, 1080, 1920, 'contain', 1440, 4000);
    expect(cs.refW).toBe(REF_W);
    expect(cs.refH).toBe(REF_H);
  });
});

describe('maxRefH omitted/0/<=refH is a no-op (regression — every existing project)', () => {
  const hosts: Array<[number, number, string]> = [
    ...TALL_HOSTS,
    [1080, 1920, 'design aspect'],
    [1376, 1032, 'landscape'],
    [633.48, 907.58, 'tablet (#774)'],
  ];
  for (const [actualW, actualH, label] of hosts) {
    for (const mode of ['fitW', 'fitH', 'contain', 'cover', 'fill', 'none'] as const) {
      it(`${mode} on ${label} — omitted matches explicit 0 and explicit refH`, () => {
        // MUTATION: make the feature unconditional (drop the `maxRefH > refH` guard). Every project
        // that never opted in would silently relayout.
        const base = computeCanvasScale(REF_W, REF_H, actualW, actualH, mode, 0);
        for (const cs of [
          computeCanvasScale(REF_W, REF_H, actualW, actualH, mode, 0, 0),
          computeCanvasScale(REF_W, REF_H, actualW, actualH, mode, 0, REF_H),
          computeCanvasScale(REF_W, REF_H, actualW, actualH, mode, 0, REF_H - 100),
        ]) {
          expect(cs.refH).toBe(REF_H);
          expect(cs.scale).toBe(base.scale);
          expect(cs.scaleX).toBe(base.scaleX);
          expect(cs.scaleY).toBe(base.scaleY);
          expect(cs.offsetX).toBe(base.offsetX);
          expect(cs.offsetY).toBe(base.offsetY);
        }
      });
    }
  }
});

describe('`fitH` is the one mode whose scale DOES move, by definition', () => {
  it('keys off the effective height, not the authored one', () => {
    // Documented on the trait: `fitH` matches the height exactly, so a taller box means a smaller
    // scale. Called out because the `contain` property above must not be read as "this never
    // changes scale anywhere". MUTATION: leave `fitH` reading the raw `refH` — it would then
    // disagree with `offsetY`, which uses the effective one, and the content would sit off-centre.
    const off = computeCanvasScale(REF_W, REF_H, 402, 874, 'fitH');
    const on = computeCanvasScale(REF_W, REF_H, 402, 874, 'fitH', 0, 4000);
    expect(on.scale).toBeLessThan(off.scale);
    expect(on.scale).toBeCloseTo(874 / on.refH, 10);
    expect(on.offsetY).toBeCloseTo(0, 6);
  });
});

describe('the modes where `effectiveRefH` is genuinely load-bearing', () => {
  // ⚠️ These exist because mutating `contain`'s min to use the raw `refH` left all 56 other cases
  // green: under `contain` the height term never binds, so that expression cannot be pinned there.
  // `cover`, `fill` and the centring offset are where the effective height actually decides the
  // answer, and without these the field could be read wrongly in three places and nothing would say.
  const TALL: [number, number] = [402, 874];

  it('cover scales to the EFFECTIVE height, so a taller box crops less', () => {
    // MUTATION: use the raw `refH` in the `cover` max. `cover` takes the LARGER term, so the height
    // one does bind here — the content would be scaled to cover a box that is no longer on screen.
    const off = computeCanvasScale(REF_W, REF_H, ...TALL, 'cover');
    const on = computeCanvasScale(REF_W, REF_H, ...TALL, 'cover', 0, 4000);
    expect(on.scale).toBeLessThan(off.scale);
    expect(on.scale).toBeCloseTo(TALL[1] / on.refH, 10);
  });

  it('fill stretches Y to the EFFECTIVE height', () => {
    // MUTATION: use the raw `refH` for `scaleY`. `fill` is the non-uniform mode, so this is the
    // one place the two axes are read independently and a stale height is directly visible.
    const on = computeCanvasScale(REF_W, REF_H, ...TALL, 'fill', 0, 4000);
    expect(on.scaleY).toBeCloseTo(TALL[1] / on.refH, 10);
    expect(on.scaleY).not.toBeCloseTo(TALL[1] / REF_H, 6);
  });

  it('offsetY centres the EFFECTIVE box, not the authored one', () => {
    // MUTATION: compute `offsetY` from the raw `refH`. Under `contain` the scale is (correctly)
    // unchanged, so a stale height here would leave the content offset by half the reclaim — the
    // content would sit low by ~16pt on a 16 Pro with nothing else looking wrong.
    const on = computeCanvasScale(REF_W, REF_H, ...TALL, 'contain', 0, 4000);
    expect(on.offsetY).toBeCloseTo(0, 6);
    const stale = (TALL[1] - REF_H * on.scaleY) / 2;
    expect(stale, 'the stale value really would differ, so this is not vacuous').toBeGreaterThan(1);
  });

  it('the returned box reports the EFFECTIVE height', () => {
    // MUTATION: return the raw `refH`. `CanvasScale.refH` is what consumers must read for the box's
    // own size (see the trait doc); returning the authored value describes a box that is not there.
    const on = computeCanvasScale(REF_W, REF_H, ...TALL, 'contain', 0, 4000);
    expect(on.refH).not.toBe(REF_H);
    expect(on.refH * on.scaleY).toBeCloseTo(TALL[1], 6);
  });
});
