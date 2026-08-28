/** Where an overlay may be placed on a splash image so that it SURVIVES the crop (#396).
 *
 *  Pure geometry, no I/O — this is the half of splash compositing that can be wrong in a way
 *  nothing on screen would explain, so it is separated from the sharp pipeline and tested on
 *  its own.
 *
 *  ## The problem this exists to solve
 *
 *  A splash master is one image; the screens it lands on are not one shape. Both platforms
 *  cover-fill (aspect-preserving scale-to-fill, centred, overflow cropped), so a splash is
 *  ALWAYS shown with some of it off-screen — and which part depends on the device:
 *
 *    - **iOS** crops at RUNTIME, not at generation. `LaunchScreen.storyboard` shows a single
 *      square 2732x2732 image with `contentMode="scaleAspectFill"`. On a 19.5:9 phone that
 *      leaves only the CENTRAL ~46% OF THE WIDTH visible — the other 54% is off both edges.
 *      An overlay placed by eye on the square master is simply gone on every modern iPhone.
 *    - **Android** crops at generation (`@capacitor/assets` resizes with sharp's default
 *      `fit: 'cover'`) and then the SplashScreen plugin scales that bucket to the real screen.
 *      ⚠️ **That last step only preserves aspect if `androidScaleType` is `CENTER_CROP`** — the
 *      plugin's own default is `FIT_XY`, which stretches and would make this whole derivation a
 *      fiction on Android (a 960x1600 bucket on a 1080x2340 screen renders ~30% taller relative
 *      to its width than authored). `addNativeTarget.ts` sets CENTER_CROP for that reason; a
 *      project whose `capacitor.config.json` predates it must set it by hand.
 *
 *  So an overlay cannot be positioned against the image it is drawn on. It has to be
 *  positioned against the region of that image which is visible on EVERY device the game can
 *  run on — the intersection of all the crops. That region is what {@link safeBox} returns.
 *
 *  ## The derivation
 *
 *  An output image of aspect `aOut = W/H`, cover-filled onto a device of aspect `aDev`:
 *
 *    - the scale is `max(devW/W, devH/H)`, so exactly one axis overflows;
 *    - the visible FRACTION of the output's width  is `min(1, aDev / aOut)`;
 *    - the visible FRACTION of the output's height is `min(1, aOut / aDev)`.
 *
 *  Taking the worst case over the whole device range gives the intersection: width is worst at
 *  the NARROWEST device (smallest `aDev`), height at the WIDEST (largest `aDev`). Both are
 *  centred, because cover-fill centres.
 *
 *  Worked, for the two cases that matter:
 *
 *    | output            | aOut  | orientation | safe width | safe height |
 *    |-------------------|-------|-------------|------------|-------------|
 *    | iOS 2732x2732     | 1.0   | portrait    | 45%        | 100%        |
 *    | android port-xhdpi 720x1280 | 0.563 | portrait | 80%    | 75%         |
 *
 *  ⚠️ The iOS row is the one that bites: on the square master, nearly half the width is
 *  unusable. Court's splash art is composed around that column deliberately.
 */

/** The device aspect ratios (width/height) a splash must survive.
 *
 *  `portrait.min` is 0.45 — TALLER than any shipping phone (the tallest measured is the
 *  iPhone 16 Pro Max at 1320/2868 = 0.4603), so a future taller device does not silently
 *  invalidate every splash already authored. `portrait.max` is 0.75, the 4:3 iPad, which is
 *  the SQUAREST portrait screen and therefore the one that crops the most height.
 *
 *  Landscape is the reciprocal range, and `any` (an unlocked game) is the union — which is
 *  why an unlocked game gets a much smaller safe box than a locked one. That is not
 *  conservatism, it is the actual intersection: the same image really is shown both ways. */
export const DEVICE_ASPECT_RANGE = {
  portrait: { min: 0.45, max: 0.75 },
  landscape: { min: 1 / 0.75, max: 1 / 0.45 },
  any: { min: 0.45, max: 1 / 0.45 },
};

/** Normalise a `capacitor.orientation` value to a key of {@link DEVICE_ASPECT_RANGE}.
 *  Anything unrecognised widens to `any` rather than guessing — an overlay that is smaller
 *  than it needed to be is a cosmetic loss; one placed outside the visible region is invisible. */
export function orientationKey(orientation) {
  if (orientation === 'portrait') return 'portrait';
  if (orientation === 'landscape') return 'landscape';
  return 'any';
}

/** The centred region of a `width` x `height` output image that is visible on EVERY device in
 *  the orientation's aspect range. Integer pixels, so it can be handed straight to sharp.
 *
 *  Returns `{x, y, w, h}` plus the raw `widthFrac`/`heightFrac` the callers' diagnostics quote. */
export function safeBox(width, height, orientation = 'any') {
  const range = DEVICE_ASPECT_RANGE[orientationKey(orientation)];
  const aOut = width / height;
  const widthFrac = Math.min(1, range.min / aOut);
  const heightFrac = Math.min(1, aOut / range.max);
  const w = Math.max(1, Math.round(width * widthFrac));
  const h = Math.max(1, Math.round(height * heightFrac));
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    w,
    h,
    widthFrac,
    heightFrac,
  };
}

/** Place one overlay inside `safe`.
 *
 *  - `widthPct` — the overlay's width as a percentage of the SAFE BOX's width, not the image's.
 *    That is what makes one authored number hold across buckets of different shapes.
 *  - `offsetPct` — vertical offset from the safe box's CENTRE, as a percentage of the safe
 *    box's height. Negative is up. Centre-anchored rather than top-anchored so that the
 *    natural authoring value ("a bit above the middle") is a small number.
 *  - `aspect` — the overlay artwork's own width/height, so height follows from width.
 *
 *  The result is clamped into the safe box, and `clamped` says whether that happened — a
 *  caller reports it rather than silently shipping an overlay that was asked to be bigger than
 *  the region it must fit inside. */
export function overlayRect(safe, { widthPct, offsetPct = 0, aspect }) {
  if (!(aspect > 0)) throw new Error(`overlayRect: aspect must be > 0, got ${aspect}`);
  // ⚠️ A non-positive or non-finite width is a CONFIG error, not a size. Without this it fell
  // through `Math.max(1, …)` to a 1x1 overlay — composited, invisible, and reported as unclamped,
  // so the build looked clean and the title was simply gone. `NaN` reaches here from a hand-edited
  // `null` in project.config.json (`Number(null)` is 0, `Number('null')` is NaN) since the `app`
  // block is spread unvalidated.
  if (!(widthPct > 0)) throw new Error(`overlayRect: widthPct must be > 0, got ${widthPct}`);
  if (!Number.isFinite(offsetPct)) throw new Error(`overlayRect: offsetPct must be finite, got ${offsetPct}`);
  let w = Math.max(1, Math.round((safe.w * widthPct) / 100));
  let h = Math.max(1, Math.round(w / aspect));
  let clamped = false;
  if (w > safe.w) { w = safe.w; h = Math.max(1, Math.round(w / aspect)); clamped = true; }
  if (h > safe.h) { h = safe.h; w = Math.max(1, Math.round(h * aspect)); clamped = true; }

  const x = Math.round(safe.x + (safe.w - w) / 2);
  const centreY = safe.y + safe.h / 2 + (safe.h * offsetPct) / 100;
  let y = Math.round(centreY - h / 2);
  const minY = safe.y;
  const maxY = safe.y + safe.h - h;
  if (y < minY) { y = minY; clamped = true; }
  if (y > maxY) { y = maxY; clamped = true; }
  return { x, y, w, h, clamped };
}

/** Place the "Made by Modoki Engine" badge: centred, pinned to the BOTTOM of the safe box with
 *  a margin of {@link BADGE_MARGIN_PCT} of the safe height beneath it.
 *
 *  Bottom-pinned rather than offset-authored because it is engine branding with no per-project
 *  knob (`app.splashBadge` is a boolean) — so its position must be derived, and the bottom of
 *  the guaranteed-visible region is the one place it cannot collide with a title placed by the
 *  usual "a bit above the middle" values. */
export const BADGE_WIDTH_PCT = 34;
export const BADGE_MARGIN_PCT = 6;

export function badgeRect(safe, aspect) {
  if (!(aspect > 0)) throw new Error(`badgeRect: aspect must be > 0, got ${aspect}`);
  let w = Math.max(1, Math.round((safe.w * BADGE_WIDTH_PCT) / 100));
  let h = Math.max(1, Math.round(w / aspect));
  let clamped = false;
  if (h > safe.h) { h = safe.h; w = Math.max(1, Math.round(h * aspect)); clamped = true; }
  const margin = Math.round((safe.h * BADGE_MARGIN_PCT) / 100);
  let y = safe.y + safe.h - margin - h;
  if (y < safe.y) { y = safe.y; clamped = true; }
  return { x: Math.round(safe.x + (safe.w - w) / 2), y, w, h, clamped };
}
