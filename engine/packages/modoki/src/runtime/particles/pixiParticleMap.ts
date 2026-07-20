/**
 * Pure mapping from the CPU simulator's struct-of-arrays outputs onto PixiJS particle
 * instances — deliberately renderer-free (NO `pixi.js` import) so it's headlessly
 * unit-testable and the byte-exact color packing lives in one traced place. The real
 * `pixiParticleObject.ts` calls this against actual `Particle`s; tests call it against
 * plain objects implementing {@link MutableParticle}.
 *
 * This is the 2D twin of `spriteBillboard.ts`'s instance-attribute upload: the 3D backend
 * uploads `offsets/scales/colors/opacities/rotations/frames` as TSL instance attributes,
 * the 2D backend copies the same arrays onto `Particle.x/y/scaleX/scaleY/rotation/color/texture`.
 */

import type { ParticleOutputs } from './cpuSimulator';

/** The subset of PixiJS `IParticle` this mapping writes. Kept local (not imported from
 *  pixi.js) so this module stays renderer-free and node-testable. */
export interface MutableParticle {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** 32-bit packed color, PixiJS layout `0xAABBGGRR` (see {@link packColor}). */
  color: number;
  /** Sprite-sheet frame sub-texture (opaque here — set only when `frames` is provided). */
  texture?: unknown;
}

export interface ParticleMapOptions {
  /** billboard width/height ratio (scaleX = size × aspect, scaleY = size). */
  aspect: number;
  /** constant offset from the particle position, in units of the per-particle size
   *  (matches the 3D billboard's anchor/offset semantics). 2D is screen-space (y-down). */
  offsetX: number;
  offsetY: number;
  /** optional sprite-sheet frame textures; when present, each particle's `texture` is set
   *  from its computed frame index (`outputs.frames`). */
  frames?: readonly unknown[];
}

/**
 * Pack per-channel 0..1 RGB + alpha into PixiJS's 32-bit particle `color`.
 *
 * PixiJS v8 stores `Particle.color` as **`0xAABBGGRR`** (little-endian ABGR, straight/
 * non-premultiplied alpha) — verified against `Particle._updateColor` in pixi.js 8.17.1
 * (`_tint = Color.shared.setValue(v).toBgrNumber()` → `0x00BBGGRR`, then `color = _tint |
 * (alpha*255 << 24)`). To reproduce the `tint` setter byte-for-byte we **round** the RGB
 * channels (PixiJS's `Color.toUint8RgbArray` uses `Math.round`) but **truncate** the alpha
 * channel (PixiJS's `_updateColor` uses `alpha*255 | 0`). Avoids the per-set `Color.shared`
 * allocation. Result is unsigned (`>>> 0`).
 */
export function packColor(r: number, g: number, b: number, a: number): number {
  const u8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)); // matches tint path
  const R = u8(r);
  const G = u8(g);
  const B = u8(b);
  const A = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0; // matches _updateColor (truncates)
  return ((A << 24) | (B << 16) | (G << 8) | R) >>> 0;
}

/**
 * Write the live prefix `[0, aliveCount)` of the sim outputs onto `pool`, then hide the
 * particles that just died (`[aliveCount, prevAlive)`) by zeroing their scale. The sim keeps
 * alive particles densely packed at the front (swap-remove on death), so the pool mirrors it
 * 1:1 and only the newly-dead tail needs clearing — O(alive + deaths), never O(maxParticles).
 *
 * Returns the new high-water count (`aliveCount`) so the caller can thread it as the next
 * frame's `prevAlive`.
 */
export function applyParticleOutputs<P extends MutableParticle>(
  pool: P[],
  outputs: ParticleOutputs,
  aliveCount: number,
  prevAlive: number,
  opts: ParticleMapOptions,
): number {
  const { offsets, scales, colors, opacities, rotations, frames } = outputs;
  const { aspect, offsetX, offsetY } = opts;
  const frameTex = opts.frames;
  const hasFrames = !!frameTex && frameTex.length > 0;
  for (let i = 0; i < aliveCount; i++) {
    const p = pool[i];
    const s = scales[i];
    // Identity map: sim space IS PixiJS screen space (both +Y-down, axis-neutral — no Y flip).
    // The sim's align-to-velocity rotation (atan2(vy,vx)) already faces on-screen travel.
    p.x = offsets[i * 3] + offsetX * s;
    p.y = offsets[i * 3 + 1] + offsetY * s;
    p.scaleX = s * aspect;
    p.scaleY = s;
    p.rotation = rotations[i];
    p.color = packColor(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2], opacities[i]);
    if (hasFrames) {
      const n = frameTex!.length;
      let fi = frames[i] | 0;
      fi = fi < 0 ? 0 : fi >= n ? n - 1 : fi;
      p.texture = frameTex![fi];
    }
  }
  // Hide only the particles that died since last frame (dense pool ⇒ the tail shrank).
  for (let i = aliveCount; i < prevAlive; i++) {
    pool[i].scaleX = 0;
    pool[i].scaleY = 0;
  }
  return aliveCount;
}
