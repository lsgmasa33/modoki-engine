/** maskRamp — an ANALYTIC feathered-edge generator for `Mask2D` (#449).
 *
 *  A mask with `feather === 0` uses a `Graphics` (hard stencil) — see `maskGroups.ts`. A mask with
 *  `feather > 0` needs a SOFT edge, and in Pixi a soft edge means an alpha mask, which means a
 *  texture. The obvious source for that texture is a Canvas2D `ctx.filter = 'blur(...)'` pass, and
 *  this module exists specifically to AVOID that: canvas blur radius/quality is browser- and
 *  GPU-dependent, so the same authored feather would render a visibly different ramp on Chromium
 *  vs Safari vs a device WebView, and the result cannot be unit-tested (it never leaves the DOM).
 *  Rendering a repo with a determinism guard and a "verify by data, not pixels" culture, the ramp
 *  is generated here instead — from a closed-form signed distance function, pure numeric code, no
 *  DOM and no Pixi — so the same inputs produce the exact same bytes on every platform and a test
 *  can assert on them directly.
 *
 *  ⚠️ This module must import NOTHING. No DOM, no Pixi, no engine imports — it is pure math so it
 *  stays trivially unit-testable and trivially safe to call from a worker or a headless test. */

/** Signed distance from `(px, py)` to a rounded box CENTRED AT THE ORIGIN with half-extents
 *  `(hx, hy)` and corner radius `r`. Negative inside, 0 on the edge, positive outside. Standard
 *  rounded-box SDF formulation (see Inigo Quilez's `sdRoundBox`): shrink the box by `r` on each
 *  side, measure the distance to that shrunk box, then subtract `r` back out — which is exactly
 *  what rounds the corners instead of the box itself growing or shifting.
 *
 *  `r` is clamped into `[0, min(hx, hy)]` FIRST: an authored `cornerRadius` bigger than the box
 *  (a fully round pill/circle is a legitimate design, so this is reachable, not just malformed
 *  data) must degrade to the largest radius the box can hold — a stadium when `hx !== hy`, a
 *  circle when `hx === hy` — never subtract a radius larger than the box has room for, which
 *  would push the inner extent negative and the two `q*` terms out of the regime the formula
 *  assumes. `hx` or `hy` of 0 falls out of the same clamp (radius clamps to 0 too) rather than
 *  needing a separate guard — no branch here can produce NaN. */
export function roundedBoxSdf(px: number, py: number, hx: number, hy: number, r: number): number {
  const rr = Math.max(0, Math.min(r, Math.min(hx, hy)));
  const qx = Math.abs(px) - (hx - rr);
  const qy = Math.abs(py) - (hy - rr);
  const maxQx = Math.max(qx, 0);
  const maxQy = Math.max(qy, 0);
  const outsideLen = Math.sqrt(maxQx * maxQx + maxQy * maxQy);
  const insideCorrection = Math.min(Math.max(qx, qy), 0);
  return outsideLen + insideCorrection - rr;
}

/** Coverage in 0..1 for a point: 1 well inside, 0 well outside, a linear ramp across `feather`.
 *
 *  `feather <= 0` is a hard step (`sdf <= 0 ? 1 : 0`) — this is what makes `feather` a single knob
 *  that also subsumes the hard-mask case, so callers don't need a separate "is this hard or soft"
 *  branch above this function.
 *
 *  Otherwise coverage is `clamp01(-sdf / feather)`: 0 exactly ON the authored edge, reaching 1 at
 *  `feather` px INSIDE it, so the whole ramp lives inside the rect.
 *
 *  ⚠️ This was briefly the straddled form `clamp01(0.5 - sdf / feather)`, which put 0.5 on the edge
 *  and ran half the ramp OUTSIDE it. Two things killed that, both worth keeping written down
 *  because the straddle is the more obvious-looking choice:
 *
 *  1. **`buildMaskRamp` cannot rasterise it.** The buffer spans exactly `[-hx,hx] x [-hy,hy]`, so
 *     the outer half of the ramp has no texels to live in and is cut off at the texture edge.
 *     Measured live on wordweave's crossword clip at `feather: 90`: alpha ran 255 -> 133 and then
 *     hard-stopped — a 52%-opacity SEAM exactly where the fade was meant to finish. At small
 *     feathers it hides (about 3 texels at `feather: 12`), which is what made it a trap rather
 *     than an obvious bug: every unit test and the typecheck were green.
 *  2. **It is wrong for a CLIP.** A straddled mask paints content up to half a feather OUTSIDE the
 *     authored rect. For a vignette that is a fine look; for a panel clip it means the thing you
 *     asked to be contained is not contained.
 *
 *  The cost is what the straddle was avoiding: the fully-opaque region is inset by `feather`, so a
 *  large feather visibly eats into the content. That is the honest trade — the authored rect is a
 *  HARD limit nothing crosses, and `feather` says how far inside it the fade begins. */
export function roundedBoxCoverage(
  px: number, py: number, hx: number, hy: number, r: number, feather: number,
): number {
  const d = roundedBoxSdf(px, py, hx, hy, r);
  if (feather <= 0) return d <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -d / feather));
}

export interface MaskRamp {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major, length `width * height * 4`. RGB is 0xFF everywhere;
   *  only the ALPHA channel carries the ramp (Pixi's AlphaMask samples alpha). */
  data: Uint8ClampedArray;
}

/** Rasterise the feathered rounded box into an RGBA buffer sized `resW x resH`, representing a
 *  mask whose half-extents are `hx, hy` in DESIGN px. The buffer is a low-resolution ramp that the
 *  caller stretches to the mask's real size — bilinear filtering makes that visually exact for a
 *  smooth gradient (a ramp has no high-frequency content to lose), so `resW/resH` are capped for
 *  COST, not fidelity: a 256×256 texture is plenty for a gradient that only ever varies smoothly
 *  across it, and generating it at the mask's full pixel size would scale with device resolution
 *  for no visible benefit.
 *
 *  Resolution is chosen to preserve the mask's aspect ratio (so a wide, short mask doesn't get
 *  stretched into a square texture and distort its corner radius), clamped to `[2, maxRes]` on
 *  each axis — 2 is the floor because a 1-pixel-wide axis has no ramp to sample across.
 *
 *  Each pixel is sampled at its CENTRE, mapped back into the design-space square
 *  `[-hx, hx] x [-hy, hy]` — i.e. pixel `i` of `resW` samples `x = -hx + (i + 0.5) / resW * 2*hx`.
 *  ⚠️ Sampling at pixel CORNERS instead is the single most likely bug here: it silently shifts the
 *  whole ramp by half a texel and breaks the axis symmetry the tests check for.
 *
 *  Degenerate `hx <= 0` or `hy <= 0` (no area to mask) return a minimal 2×2 buffer that is fully
 *  TRANSPARENT (alpha 0 everywhere) rather than throwing — an empty mask should hide everything
 *  behind it, and a caller stretching this over any real mask size gets uniform zero coverage. */
export function buildMaskRamp(
  hx: number, hy: number, r: number, feather: number,
  maxRes = 256,
): MaskRamp {
  if (hx <= 0 || hy <= 0) {
    const data = new Uint8ClampedArray(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 0;
    }
    return { width: 2, height: 2, data };
  }

  const aspect = hx / hy;
  let resW: number;
  let resH: number;
  if (aspect >= 1) {
    resW = maxRes;
    resH = Math.max(2, Math.round(maxRes / aspect));
  } else {
    resH = maxRes;
    resW = Math.max(2, Math.round(maxRes * aspect));
  }

  const data = new Uint8ClampedArray(resW * resH * 4);
  for (let row = 0; row < resH; row++) {
    const py = -hy + ((row + 0.5) / resH) * (2 * hy);
    for (let col = 0; col < resW; col++) {
      const px = -hx + ((col + 0.5) / resW) * (2 * hx);
      const coverage = roundedBoxCoverage(px, py, hx, hy, r, feather);
      const idx = (row * resW + col) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(coverage * 255);
    }
  }

  return { width: resW, height: resH, data };
}
