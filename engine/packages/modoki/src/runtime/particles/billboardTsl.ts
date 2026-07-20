/**
 * Shared TSL fragment helpers for the billboard particle render path, used by BOTH the CPU
 * backend (spriteBillboard.ts, per-instance vertex attributes) and the GPU compute backend
 * (gpuComputeBackend.buildMesh, storage reads). Each helper returns a FRESH node expression
 * per call — no shared mutable node instances — so the two backends build independent
 * materials. Defining the radial falloff, sprite-sheet UV remap and soft-particle depth fade
 * here keeps them identical; they previously diverged (the GPU copy carried a "matches
 * spriteBillboard" comment, a standing drift hazard).
 */

import { abs, float, floor, linearDepth, oneMinus, smoothstep, uv, vec2, viewportLinearDepth } from 'three/tsl';
import type { SpriteMode } from './types';

// Explicit node types so a consumer's `opacityExpr.mul(radialAlpha())` resolves the
// scalar `.mul` overload (a bare `any` return makes overload resolution pick vec3).
type FloatNode = ReturnType<typeof float>;
type Vec2Node = ReturnType<typeof vec2>;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type TslNode = any;

/**
 * Soft-particle fade width, in the active camera's normalized linear depth [0,1]. A fragment
 * fades to fully transparent as it comes within this depth band of the opaque scene behind
 * it (≈ a couple of world units at typical near/far). Generous so the effect reads clearly.
 */
export const SOFT_FADE_DEPTH = 0.008;

/** Round soft-circle alpha from the quad UV: ~1 at the centre, 0 past the edge. */
export function radialAlpha(): FloatNode {
  return smoothstep(float(0.5), float(0.38), uv().sub(vec2(0.5, 0.5)).length());
}

/**
 * Remap the quad UV into sprite-sheet cell `frame` (frame 0 = top-left) for a `tx`×`ty` grid.
 * `frame` is a TSL node (CPU: per-instance `aFrame` attribute; GPU: derived from lifetime).
 */
export function spriteSheetUv(frame: TslNode, tx: number, ty: number): Vec2Node {
  const col = frame.mod(tx);
  const row = floor(frame.div(tx));
  const vRow = float(ty - 1).sub(row);
  return uv().add(vec2(col, vRow)).div(vec2(tx, ty));
}

/**
 * Flip the V axis of a sample UV for bottom-origin textures (KTX2/Basis carry `flipY=false`),
 * so the top-origin quad/sprite-sheet UV logic above maps right-side up. No-op when `flipV` is
 * false. Pass `tex.flipY === false` — needed because particle textures resolve to KTX2 variants
 * (forced bottom-origin) yet the billboard quad UVs assume a top-origin (flipY=true) source.
 */
export function orientSampleUv(node: Vec2Node, flipV: boolean): Vec2Node {
  return flipV ? vec2(node.x, oneMinus(node.y)) : node;
}

/**
 * Sprite-sheet frame index as a TSL node — the GPU mirror of `spriteFrameIndex` (types.ts).
 * `t` is normalized lifetime (0..1); modes match exactly (`once`/`loop`/`pingpong`), pingpong
 * using the same branchless triangle `(tiles−1) − |vf − (tiles−1)|`. `offset` (optional node,
 * 0..tiles−1) shifts the start frame for per-particle random-start variety.
 */
export function spriteFrameNode(
  t: TslNode, tiles: number, mode: SpriteMode, cycles: number, offset?: TslNode,
): FloatNode {
  if (tiles <= 1) return float(0);
  const c = Math.max(1, cycles);
  let frame: FloatNode;
  if (mode === 'loop') {
    frame = floor(t.mul(tiles * c)).mod(tiles);
  } else if (mode === 'pingpong') {
    const period = 2 * tiles - 2; // forward 0..N-1 then back N-2..1
    const vf = floor(t.mul(period * c)).mod(period);
    frame = float(tiles - 1).sub(abs(vf.sub(float(tiles - 1))));
  } else {
    frame = floor(t.mul(float(tiles))).min(float(tiles - 1)); // once
  }
  return offset ? frame.add(offset).mod(tiles) : frame;
}

/**
 * Soft-particle depth fade: 1 normally, →0 as the fragment nears opaque geometry behind it,
 * so the billboard dissolves into surfaces instead of showing a hard intersection seam.
 */
export function softParticleFade(): FloatNode {
  return smoothstep(float(0), float(SOFT_FADE_DEPTH), viewportLinearDepth.sub(linearDepth()));
}
