import { trait } from 'koota';

/** Procedural per-glyph animation for a {@link Text3D}/{@link Text2D} entity. A
 *  modifier trait — attach it alongside a text trait and the renderers apply the
 *  effect per glyph each frame (while playing; frozen when stopped, like skeletal).
 *  The motion is computed procedurally from (glyph index, engine time, params) — see
 *  runtime/rendering/text/textAnimate.ts — so it works on dynamic/CJK strings of any
 *  length with no per-glyph authoring. */
export const TextAnimation = trait({
  /** none | typewriter | wave | bounce | jitter. */
  effect: 'none' as string,
  /** Time scale: waves/sec (wave/bounce), glyphs/sec (typewriter), shake rate (jitter). */
  speed: 1 as number,
  /** Motion size in em (scaled by the text's fontSize). Ignored by typewriter. */
  amplitude: 0.1 as number,
  /** Per-glyph phase across the string (wave wavelength / bounce + jitter stagger). */
  frequency: 1 as number,
  /** Loop the one-shot effects (typewriter); periodic effects always loop. */
  loop: true as boolean,
  /** Typewriter on UI (DOM) text: fade each glyph in (soft) vs pop it instantly
   *  (hard, more mechanical). No effect on other effects or on 2D/3D text (whose
   *  typewriter already pops whole glyphs). */
  fadeIn: true as boolean,
});
