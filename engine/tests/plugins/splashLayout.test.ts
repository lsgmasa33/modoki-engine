/** Splash overlay geometry (#396).
 *
 *  The title and the "Made by Modoki Engine" badge are composited onto the generated splash
 *  images, and both platforms cover-fill — so an overlay placed against the IMAGE rather than
 *  against the visible region is cropped off on real hardware while looking perfect in every
 *  file you can open on a Mac. That failure is invisible to a screenshot of the master and
 *  costs a device round-trip to notice, which is why the derivation is pinned here.
 *
 *  The numbers in these tests are computed from the range in `splashLayout.mjs`, not copied off
 *  a run: `safeBox` is the intersection of every crop the orientation allows, so each expected
 *  value is re-derivable by hand from `visible width fraction = min(1, aDev / aOut)`. */

import { describe, it, expect } from 'vitest';
import {
  DEVICE_ASPECT_RANGE,
  orientationKey,
  safeBox,
  overlayRect,
  badgeRect,
  BADGE_WIDTH_PCT,
} from '../../scripts/splashLayout.mjs';

describe('safeBox — the region that survives every crop', () => {
  it('leaves only the central 45% of the iOS square, which is the whole reason this module exists', () => {
    // LaunchScreen.storyboard shows one 2732x2732 image with contentMode="scaleAspectFill".
    // On the narrowest portrait device (0.45) the visible width is 2732 * 0.45.
    const box = safeBox(2732, 2732, 'portrait');
    expect(box.widthFrac).toBeCloseTo(0.45, 6);
    expect(box.w).toBe(Math.round(2732 * 0.45));
    // Height is never cropped on a square shown portrait: the squarest portrait screen is the
    // 4:3 iPad at 0.75, and 1.0 / 0.75 > 1.
    expect(box.heightFrac).toBe(1);
    expect(box.h).toBe(2732);
    // Centred, because cover-fill centres.
    expect(box.x).toBe(Math.round((2732 - box.w) / 2));
    expect(box.y).toBe(0);
  });

  it('crops both axes of an Android portrait bucket, since it is neither square nor phone-shaped', () => {
    // port-xhdpi is 720x1280 → aOut = 0.5625.
    const box = safeBox(720, 1280, 'portrait');
    expect(box.widthFrac).toBeCloseTo(0.45 / 0.5625, 6); // 0.8
    expect(box.heightFrac).toBeCloseTo(0.5625 / 0.75, 6); // 0.75
    expect(box.w).toBe(576);
    expect(box.h).toBe(960);
  });

  it('gives an unlocked game a smaller box than a locked one — the same image really is shown both ways', () => {
    const locked = safeBox(2732, 2732, 'portrait');
    const unlocked = safeBox(2732, 2732, 'any');
    expect(unlocked.w).toBeLessThanOrEqual(locked.w);
    expect(unlocked.h).toBeLessThan(locked.h);
    // Square, unlocked: both axes clip to the extreme of the union range.
    expect(unlocked.widthFrac).toBeCloseTo(0.45, 6);
    expect(unlocked.heightFrac).toBeCloseTo(0.45, 6);
  });

  it('never claims more than the whole image, whatever the shape', () => {
    for (const [w, h] of [[320, 480], [1920, 1280], [1280, 720], [240, 320], [1000, 1000]]) {
      for (const o of ['portrait', 'landscape', 'any']) {
        const box = safeBox(w, h, o);
        expect(box.w).toBeLessThanOrEqual(w);
        expect(box.h).toBeLessThanOrEqual(h);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(w);
        expect(box.y + box.h).toBeLessThanOrEqual(h);
      }
    }
  });

  it('treats a landscape bucket in a portrait game as mostly invisible, which it is', () => {
    // land-xhdpi 1280x720 (aOut 1.778) can only ever be shown on a portrait screen by cropping
    // almost all of its width away. The formula says so rather than pretending otherwise.
    const box = safeBox(1280, 720, 'portrait');
    expect(box.widthFrac).toBeCloseTo(0.45 / (1280 / 720), 6);
    expect(box.widthFrac).toBeLessThan(0.3);
  });

  it('is symmetric between the orientations — landscape is the reciprocal range, not a special case', () => {
    expect(DEVICE_ASPECT_RANGE.landscape.min).toBeCloseTo(1 / DEVICE_ASPECT_RANGE.portrait.max, 9);
    expect(DEVICE_ASPECT_RANGE.landscape.max).toBeCloseTo(1 / DEVICE_ASPECT_RANGE.portrait.min, 9);
    const portrait = safeBox(1000, 2000, 'portrait');
    const landscape = safeBox(2000, 1000, 'landscape');
    expect(landscape.w).toBe(portrait.h);
    expect(landscape.h).toBe(portrait.w);
  });

  it('widens an unrecognised orientation to `any` rather than guessing one', () => {
    expect(orientationKey(undefined)).toBe('any');
    expect(orientationKey('')).toBe('any');
    expect(orientationKey('sensor')).toBe('any');
    expect(orientationKey('portrait')).toBe('portrait');
    expect(orientationKey('landscape')).toBe('landscape');
  });
});

describe('overlayRect — placing the title', () => {
  const safe = safeBox(2732, 2732, 'portrait'); // 1229 x 2732 at x=752, y=0

  it('sizes the overlay against the SAFE BOX, not the image — one authored number across buckets', () => {
    const r = overlayRect(safe, { widthPct: 50, offsetPct: 0, aspect: 4 });
    expect(r.w).toBe(Math.round(safe.w * 0.5));
    expect(r.h).toBe(Math.round(r.w / 4));
    expect(r.clamped).toBe(false);
  });

  it('centres horizontally inside the safe box, which is NOT the centre of a cropped image', () => {
    const r = overlayRect(safe, { widthPct: 50, aspect: 4 });
    expect(r.x + r.w / 2).toBeCloseTo(safe.x + safe.w / 2, 0);
  });

  it('reads offsetPct as a share of the safe height from its centre, negative being up', () => {
    const mid = overlayRect(safe, { widthPct: 40, offsetPct: 0, aspect: 4 });
    const up = overlayRect(safe, { widthPct: 40, offsetPct: -10, aspect: 4 });
    const down = overlayRect(safe, { widthPct: 40, offsetPct: 10, aspect: 4 });
    expect(up.y).toBeLessThan(mid.y);
    expect(down.y).toBeGreaterThan(mid.y);
    // ±1: the rects round independently, and a 10% offset here is 273.2px — both 273 and 274
    // are correct roundings of it. Asserting exact equality would pin an artifact, not the rule.
    expect(Math.abs((mid.y - up.y) - safe.h * 0.1)).toBeLessThanOrEqual(1);
    expect(Math.abs((down.y - mid.y) - safe.h * 0.1)).toBeLessThanOrEqual(1);
  });

  it('keeps a tall overlay inside the box by height, and SAYS it clamped', () => {
    // A very tall aspect at full safe width would overflow the box vertically.
    const r = overlayRect(safe, { widthPct: 100, offsetPct: 0, aspect: 0.1 });
    expect(r.h).toBeLessThanOrEqual(safe.h);
    expect(r.clamped).toBe(true);
  });

  it('clamps an offset that would push the overlay out of the visible region', () => {
    const r = overlayRect(safe, { widthPct: 40, offsetPct: -90, aspect: 4 });
    expect(r.y).toBeGreaterThanOrEqual(safe.y);
    expect(r.clamped).toBe(true);
    const low = overlayRect(safe, { widthPct: 40, offsetPct: 90, aspect: 4 });
    expect(low.y + low.h).toBeLessThanOrEqual(safe.y + safe.h);
    expect(low.clamped).toBe(true);
  });

  it('refuses a nonsense aspect instead of producing a zero-area rect', () => {
    expect(() => overlayRect(safe, { widthPct: 40, aspect: 0 })).toThrow(/aspect/);
    expect(() => overlayRect(safe, { widthPct: 40, aspect: NaN })).toThrow(/aspect/);
  });

  it('REFUSES a non-positive width rather than composing a 1x1 overlay', () => {
    // Found in review. `Math.max(1, …)` turned 0 into a 1x1 image that was duly composited,
    // invisible, and reported as UNCLAMPED — so the build was clean and the title was gone.
    for (const widthPct of [0, -20]) {
      expect(() => overlayRect(safe, { widthPct, aspect: 4 })).toThrow(/widthPct/);
    }
  });

  it('REFUSES a NaN width or offset — a hand-edited null in the config reaches here', () => {
    // `mergeProjectConfig` spreads the `app` block unvalidated, so `Number('null')` → NaN gets
    // this far. Untrapped it produced {w:NaN,h:NaN}, which sharp throws on much later.
    expect(() => overlayRect(safe, { widthPct: NaN, aspect: 4 })).toThrow(/widthPct/);
    expect(() => overlayRect(safe, { widthPct: 50, offsetPct: NaN, aspect: 4 })).toThrow(/offsetPct/);
  });
});

describe('badgeRect — the engine mark', () => {
  const safe = safeBox(2732, 2732, 'portrait');

  it('pins to the bottom of the safe box with a margin beneath it', () => {
    const r = badgeRect(safe, 4);
    expect(r.y + r.h).toBeLessThan(safe.y + safe.h);
    expect(r.w).toBe(Math.round((safe.w * BADGE_WIDTH_PCT) / 100));
    expect(r.clamped).toBe(false);
  });

  it('stays clear of a title placed by the usual "a bit above the middle" value', () => {
    const title = overlayRect(safe, { widthPct: 60, offsetPct: -8, aspect: 3 });
    const badge = badgeRect(safe, 4);
    expect(badge.y).toBeGreaterThan(title.y + title.h);
  });

  it('is small — it is a credit, not a second title', () => {
    const title = overlayRect(safe, { widthPct: 60, offsetPct: -8, aspect: 3 });
    expect(badgeRect(safe, 4).w).toBeLessThan(title.w);
  });

  it('stays inside the safe box on a bucket short enough to squeeze it', () => {
    const short = safeBox(1920, 1280, 'landscape');
    const r = badgeRect(short, 4);
    expect(r.x).toBeGreaterThanOrEqual(short.x);
    expect(r.y).toBeGreaterThanOrEqual(short.y);
    expect(r.x + r.w).toBeLessThanOrEqual(short.x + short.w);
    expect(r.y + r.h).toBeLessThanOrEqual(short.y + short.h);
  });

  it('refuses a nonsense aspect', () => {
    expect(() => badgeRect(safe, 0)).toThrow(/aspect/);
  });
});
