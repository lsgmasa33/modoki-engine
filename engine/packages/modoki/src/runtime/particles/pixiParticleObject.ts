/**
 * The PixiJS v8 render primitive for 2D particles — a {@link ParticleContainer} of pooled
 * {@link Particle}s, the 2D twin of `spriteBillboard.ts`. The CPU simulator writes per-particle
 * data into `outputs` (shared struct-of-arrays), and `commit(aliveCount)` copies the live prefix
 * onto the pooled particles via the renderer-free {@link applyParticleOutputs} mapping.
 *
 * Pool model: `maxParticles` `Particle`s are created once and added to the container; dead
 * particles are hidden (scale 0) rather than removed, so `particleChildren` never changes length
 * (no per-frame reallocation). With position/rotation/color/vertex marked dynamic, PixiJS
 * re-uploads them each frame — no `container.update()` needed except on structural rebuild.
 *
 * Scope (Phase 1): billboard sprites, blend modes, render-order (zIndex), sprite-sheet flipbook.
 * Trails and sub-emitters are intentionally NOT rendered here (deferred follow-up).
 */

import { ParticleContainer, Particle, Texture, Rectangle } from 'pixi.js';
import type { RenderConfig, BlendMode } from './types';
import type { ParticleOutputs } from './cpuSimulator';
import { applyParticleOutputs, type ParticleMapOptions } from './pixiParticleMap';

export interface PixiParticleObject {
  /** The renderable to add to a Canvas2D's Pixi container. */
  container: ParticleContainer;
  /** Instance buffers for the simulator to write into. */
  outputs: ParticleOutputs;
  /** Sync `aliveCount` particles from `outputs` to the pool this frame. */
  commit(aliveCount: number): void;
  dispose(): void;
}

export interface PixiParticleOptions {
  /** Base sprite texture (already loaded). Null → the default soft-circle (or EMPTY headless). */
  texture?: Texture | null;
  tilesX?: number;
  tilesY?: number;
}

/** Map our authoring BlendMode onto a PixiJS blend mode string. */
function pixiBlend(blend: BlendMode): 'normal' | 'add' | 'multiply' | 'screen' {
  switch (blend) {
    case 'additive': return 'add';
    case 'multiply': return 'multiply';
    case 'screen': return 'screen';
    default: return 'normal';
  }
}

/** Lazily-built, memoized soft round particle texture (radial alpha falloff) — the 2D analogue
 *  of the 3D backend's `radialAlpha()`. Needs a canvas, so headless (no `document`) falls back to
 *  `Texture.EMPTY`; the mapping still runs, there's just nothing to see (Phase 1 is data-only). */
let defaultParticleTex: Texture | null = null;
function getDefaultParticleTexture(): Texture {
  if (defaultParticleTex) return defaultParticleTex;
  if (typeof document === 'undefined') return Texture.EMPTY;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Texture.EMPTY;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  defaultParticleTex = Texture.from(canvas);
  return defaultParticleTex;
}

/** Build the sprite-sheet frame sub-textures (row-major, frame 0 = top-left) that share the base
 *  texture's source — satisfies PixiJS's "one source per ParticleContainer" constraint. */
function buildFrames(base: Texture, tilesX: number, tilesY: number): Texture[] {
  const W = base.source.width;
  const H = base.source.height;
  const cw = Math.floor(W / tilesX);
  const ch = Math.floor(H / tilesY);
  const frames: Texture[] = [];
  for (let row = 0; row < tilesY; row++) {
    for (let col = 0; col < tilesX; col++) {
      frames.push(new Texture({ source: base.source, frame: new Rectangle(col * cw, row * ch, cw, ch) }));
    }
  }
  return frames;
}

export function createPixiParticles(
  maxParticles: number,
  render: RenderConfig,
  opts: PixiParticleOptions = {},
): PixiParticleObject {
  const tilesX = Math.max(1, Math.floor(opts.tilesX ?? 1));
  const tilesY = Math.max(1, Math.floor(opts.tilesY ?? 1));
  const hasFlipbook = !!opts.texture && (tilesX > 1 || tilesY > 1);
  const frames = hasFlipbook ? buildFrames(opts.texture!, tilesX, tilesY) : null;
  // The texture every particle starts with: frame 0 for a sheet, the whole texture for a single
  // sprite, or the default soft circle when no texture was supplied.
  const baseTex = frames ? frames[0] : (opts.texture ?? getDefaultParticleTexture());

  const container = new ParticleContainer({
    dynamicProperties: {
      position: true,
      rotation: true,
      color: true,
      vertex: true, // scale (and anchor) change over life
      uvs: hasFlipbook, // only a flipbook swaps frames per particle
    },
  });
  container.blendMode = pixiBlend(render.blend);
  if (render.renderOrder != null) container.zIndex = render.renderOrder;

  const anchorY = render.anchor === 'bottom' ? 1 : 0.5;
  const pool: Particle[] = [];
  for (let i = 0; i < maxParticles; i++) {
    const p = new Particle({ texture: baseTex, anchorX: 0.5, anchorY });
    p.scaleX = 0; // start hidden until the sim brings it alive
    p.scaleY = 0;
    pool.push(p);
    container.addParticle(p);
  }

  const outputs: ParticleOutputs = {
    offsets: new Float32Array(maxParticles * 3),
    scales: new Float32Array(maxParticles),
    colors: new Float32Array(maxParticles * 3),
    opacities: new Float32Array(maxParticles),
    rotations: new Float32Array(maxParticles),
    frames: new Float32Array(maxParticles),
  };

  const mapOpts: ParticleMapOptions = {
    aspect: render.aspect && render.aspect > 0 ? render.aspect : 1,
    offsetX: render.offset?.[0] ?? 0,
    offsetY: render.offset?.[1] ?? 0,
    frames: frames ?? undefined,
    // No Y flip: the sim is axis-neutral and already runs in PixiJS screen space (+Y down). A 2D
    // effect authors gravity [0,+G,0] to fall and a cone/polyline axis [0,-1,0] to spray upward.
  };

  let prevAlive = 0;

  return {
    container,
    outputs,
    commit(aliveCount: number) {
      prevAlive = applyParticleOutputs(pool, outputs, aliveCount, prevAlive, mapOpts);
    },
    dispose() {
      container.destroy();
      // Per-frame sub-textures wrap the shared source; destroy the wrappers (keep the source,
      // which is owned by the Assets cache) so we don't leak Texture objects.
      if (frames) for (const f of frames) f.destroy(false);
    },
  };
}
