/** Sprite-frame index math shared by the particle sprite-sheet renderer
 *  (`particles/types.ts`'s `spriteFrameIndex`) and fps-driven 2D flipbook playback
 *  (`animation/spriteAnimationSystem.ts`) — moved to `core/` (P7 C2) since both are L2
 *  subsystems and neither should reach into the other for shared discrete-frame math. */

/**
 * Sprite-sheet playback over a particle's normalized lifetime (0..1):
 * - `once` — single forward pass, frame 0 → last, then holds the last frame (default).
 * - `loop` — cycle forward repeatedly (`RenderConfig.spriteCycles` times over the life).
 * - `pingpong` — forward then backward (flip-flop), repeating for `spriteCycles` cycles.
 */
export type SpriteMode = 'once' | 'loop' | 'pingpong';

/**
 * Maps a monotonic integer frame counter (`step`) to a concrete frame index for the
 * given play mode. The discrete core shared by `particles/types.ts`'s `spriteFrameIndex`
 * (which derives `step` from a normalized phase × cycles) and fps-driven flipbook playback
 * (`spriteAnimationSystem`, where `step = floor(time·fps)`).
 *
 * - `once`: clamps to the last frame.
 * - `loop`: wraps (`step mod tiles`).
 * - `pingpong`: triangle wave over `2·tiles−2` virtual frames per cycle (forward then back),
 *   `(tiles−1) − |vf − (tiles−1)|`.
 *
 * `offset` (0..tiles−1) shifts the start frame.
 */
export function spriteIndexFromStep(
  step: number, tiles: number, mode: SpriteMode = 'once', offset = 0,
): number {
  if (tiles <= 1) return 0;
  let frame: number;
  if (mode === 'loop') {
    frame = ((step % tiles) + tiles) % tiles;
  } else if (mode === 'pingpong') {
    const period = 2 * tiles - 2; // forward 0..N-1 then back N-2..1
    const vf = ((step % period) + period) % period;
    frame = (tiles - 1) - Math.abs(vf - (tiles - 1));
  } else {
    frame = Math.min(tiles - 1, Math.max(0, step)); // once
  }
  return offset ? (frame + offset) % tiles : frame;
}
