/** Procedural per-glyph text animation — the pure layer between {@link layoutText}
 *  and the geometry builder. Given the laid-out quads + an effect + an elapsed time,
 *  it returns a NEW quad array with each glyph offset/scaled (or collapsed, for a
 *  typewriter reveal) as a function of `(glyphIndex, elapsed, params)`.
 *
 *  Design invariants that make it cheap + renderer-friendly:
 *   - **Length-invariant.** Every effect returns exactly `quads.length` quads in the
 *     same order (a hidden glyph is COLLAPSED to a zero-area rect, not dropped). So a
 *     renderer can rebuild geometry POSITIONS in place each frame and reuse the atlas
 *     material/shader — no per-frame recompile, no vertex-count churn across pages.
 *   - **Pure + deterministic.** No DOM/renderer/time-source; offsets are a function of
 *     the passed `elapsed` (seconds) and index. Jitter uses an integer hash, never
 *     `Math.random`/wall-clock — headless-testable and determinism-guard-clean.
 *
 *  Offsets are authored in **em** (`amplitude`) and scaled by `fontSize` here, so a
 *  wave looks the same at any text size. Quads stay in layout px, Y-down (the builder
 *  flips Y for the 3D world), so a positive `dy` moves a glyph DOWN the text block.
 *
 *  Phase 1 = translation + reveal (typewriter/wave/bounce/jitter); per-glyph rotation
 *  and colour (rainbow/fade) are Phase 2 (they need a richer quad + a shader change).
 */

import type { TextQuad } from './layoutText';

export type TextEffect = 'none' | 'typewriter' | 'wave' | 'bounce' | 'jitter' | 'fade' | 'rainbow';

/** Effects that TINT/fade per glyph (set quad.color) rather than move it. The
 *  renderers use this to update the colour vertex buffer only when needed. */
export function isColorEffect(effect: TextEffect): boolean {
  return effect === 'fade' || effect === 'rainbow';
}

export interface TextAnimParams {
  effect: TextEffect;
  /** Time scale: waves/sec (wave/bounce), glyphs/sec (typewriter), shakes ×10/sec (jitter). */
  speed: number;
  /** Motion size in em (scaled by fontSize). Ignored by typewriter. */
  amplitude: number;
  /** Per-glyph phase across the string (wave wavelength / bounce + jitter offset). */
  frequency: number;
  /** Loop the one-shot effects (typewriter); periodic effects ignore it. */
  loop: boolean;
}

const TAU = Math.PI * 2;

/** True if this effect actually moves/hides anything (so a renderer can skip the
 *  per-frame animation path entirely for static text). */
export function isTextAnimating(a: TextAnimParams | null | undefined): boolean {
  return !!a && a.effect !== 'none';
}

/** Deterministic [0,1) hash of two small integers (jitter noise — no Math.random). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Collapse a quad to a zero-area rect at its top-left (renders nothing, keeps count). */
function hidden(q: TextQuad): TextQuad {
  return { ...q, x1: q.x0, y1: q.y0 };
}

/** Offset a quad by (dx,dy) px. */
function shift(q: TextQuad, dx: number, dy: number): TextQuad {
  return { ...q, x0: q.x0 + dx, x1: q.x1 + dx, y0: q.y0 + dy, y1: q.y1 + dy };
}

/** HSV (all 0..1) → RGB (0..1). Pure; for the rainbow effect's per-glyph hue. */
function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** Apply `params` to `quads` at time `elapsed` (seconds). Returns a NEW array of the
 *  SAME length/order (hidden glyphs collapsed). `fontSize` scales em amplitudes to px. */
export function applyTextAnimation(
  quads: TextQuad[],
  params: TextAnimParams,
  elapsed: number,
  fontSize: number,
): TextQuad[] {
  const { effect } = params;
  if (effect === 'none' || quads.length === 0) return quads.map((q) => ({ ...q }));

  const amp = params.amplitude * fontSize;
  const speed = params.speed;
  const freq = params.frequency;
  const n = quads.length;

  switch (effect) {
    case 'typewriter': {
      // Reveal `speed` glyphs/sec; loop restarts after the string + a ~1s hold. A
      // non-positive rate has no reveal to animate → show the full static string
      // (matching wave/bounce's "frozen but visible" at speed 0), never all-hidden.
      const revealedRaw = elapsed * speed;
      const revealed = speed <= 0 ? n
        : params.loop ? revealedRaw % (n + Math.max(1, speed)) : revealedRaw;
      return quads.map((q, i) => (i < revealed ? { ...q } : hidden(q)));
    }
    case 'wave': {
      // Sinusoidal vertical bob; phase marches along the string by `freq`.
      return quads.map((q, i) => shift(q, 0, amp * Math.sin(elapsed * speed * TAU + i * freq)));
    }
    case 'bounce': {
      // Rectified sine (always upward hops), staggered per glyph by `freq`.
      return quads.map((q, i) =>
        shift(q, 0, -amp * Math.abs(Math.sin(elapsed * speed * Math.PI - i * freq))));
    }
    case 'jitter': {
      // Small per-glyph shake that re-rolls ~10·speed times/sec.
      const step = Math.floor(elapsed * speed * 10);
      return quads.map((q, i) =>
        shift(q, amp * (hash(i, step) * 2 - 1), amp * (hash(i, step + 9973) * 2 - 1)));
    }
    case 'fade': {
      // Per-glyph fade-in: glyph i starts at t=i·freq and ramps over 1 unit. `loop`
      // restarts after the whole string faded in + a ~1-unit hold.
      const prog = elapsed * speed;
      const p = params.loop ? prog % (n * Math.max(0, freq) + 2) : prog;
      return quads.map((q, i) => {
        const a = Math.max(0, Math.min(1, p - i * freq));
        return { ...q, color: [1, 1, 1, a] as const };
      });
    }
    case 'rainbow': {
      // Per-glyph hue cycle at full saturation; `freq` phases the hue along the string
      // so the whole word reads as a moving spectrum. (amplitude is unused here.)
      return quads.map((q, i) => {
        const hue = (elapsed * speed + i * freq) % 1;
        const [r, g, b] = hsv2rgb(hue < 0 ? hue + 1 : hue, 1, 1);
        return { ...q, color: [r, g, b, 1] as const };
      });
    }
    default:
      return quads.map((q) => ({ ...q }));
  }
}
