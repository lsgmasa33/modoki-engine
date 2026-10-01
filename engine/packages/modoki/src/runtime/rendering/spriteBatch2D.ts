/**
 * Sprite batches, drawn: the primary `Scene2D` puts each registered batch (`spriteBatchRegistry.ts`, which
 * carries the contract and why it exists) into its anchor's canvas as Pixi `ParticleContainer`s — one per texture
 * source, since a ParticleContainer draws every particle from one source. Pack a batch's art into one atlas and it
 * is ONE draw. Groups draw in the order their source first appeared; within a group, in item order.
 */
import type { World } from 'koota';
import { Container, Particle, ParticleContainer, type Texture, type TextureSource } from 'pixi.js';

import { computeSpriteScale } from './render2DUtils';
import { spriteBatches2D } from './spriteBatchRegistry';

/** What `syncSpriteBatches2D` needs from the renderer, so it can be tested without one. */
export interface SpriteBatchCtx {
  canvasIdOf(entityId: number): number | null;
  /** Where an entity's display objects go in that canvas: its mask group's container, or the canvas's own
   *  (Scene2D's `containerFor`). Null when the canvas has no slot. */
  parentContainer(canvasId: number, entityId: number): Container | null;
  /** False for an entity switched off (itself or an ancestor: `EntityAttributes.isActive`). */
  isActive(entityId: number): boolean;
  /** The product of `GroupAlpha` over the entity's ancestry. */
  groupAlphaOf(entityId: number): number;
  markDirty(canvasId: number): void;
  /** A canvas's non-uniform scale compensation (Scene2D's `canvasCompensate`). */
  compensate(canvasId: number): { x: number; y: number };
  paintOf(entityId: number): number | undefined;
  /** The texture for a ref, or null while it loads (or when it never will). */
  textureOf(ref: string): Texture | null;
}

interface Group {
  pc: ParticleContainer;
  /** Particle objects reused frame to frame; the first `used` are this frame's. */
  particles: Particle[];
  used: number;
  /** How many it showed last frame (a change of count rebuilds its buffers: `update()`). */
  shown: number;
}

interface BatchState {
  container: Container;
  groups: Map<TextureSource, Group>;
  /** Whether anything was drawn last frame: a batch that draws nothing two frames running leaves its canvas
   *  alone, however many transparent items it carries. */
  lit: boolean;
  canvasId: number | null;
}

/** One renderer's batch containers, by key. */
export interface SpriteBatchState { batches: Map<string, BatchState> }

export function createSpriteBatchState(): SpriteBatchState {
  return { batches: new Map() };
}

function stateFor(state: SpriteBatchState, key: string): BatchState {
  let s = state.batches.get(key);
  if (!s) {
    const container = new Container({ label: `spriteBatch:${key}` });
    s = { container, groups: new Map(), lit: false, canvasId: null };
    state.batches.set(key, s);
  }
  return s;
}

function groupFor(s: BatchState, tex: Texture): Group {
  let g = s.groups.get(tex.source);
  if (!g) {
    // Everything moves, turns, resizes, re-tints and changes frame every frame: all dynamic.
    const pc = new ParticleContainer({
      texture: tex,
      dynamicProperties: { position: true, rotation: true, vertex: true, uvs: true, color: true },
    });
    g = { pc, particles: [], used: 0, shown: 0 };
    s.groups.set(tex.source, g);
    s.container.addChild(pc);
  }
  return g;
}

function detach(s: BatchState, ctx: SpriteBatchCtx): void {
  if (s.container.parent) s.container.removeFromParent();
  if (s.canvasId !== null) ctx.markDirty(s.canvasId);
  s.canvasId = null;
  s.lit = false;
}

/** Draw every registered batch into its canvas. Called by the primary Scene2D after its sprite passes. */
export function syncSpriteBatches2D(world: World, ctx: SpriteBatchCtx, state: SpriteBatchState): void {
  const batches = spriteBatches2D();
  for (const [key, s] of state.batches) {
    if (!batches.has(key)) { detach(s, ctx); disposeOne(s); state.batches.delete(key); }
  }
  for (const [key, batch] of batches) {
    const anchor = batch.anchor(world);
    const canvasId = anchor ? ctx.canvasIdOf(anchor.id()) : null;
    const slot = anchor && canvasId !== null ? ctx.parentContainer(canvasId, anchor.id()) : null;
    const s = stateFor(state, key);
    if (!anchor || canvasId === null || !slot || !ctx.isActive(anchor.id())) { detach(s, ctx); continue; }
    if (s.container.parent !== slot) {
      // A pool slot strips its children when it is reclaimed, so this re-homes the batch after that too.
      if (s.canvasId !== null && s.canvasId !== canvasId) ctx.markDirty(s.canvasId);
      slot.addChild(s.container);
      ctx.markDirty(canvasId);
    }
    s.canvasId = canvasId;
    const z = ctx.paintOf(anchor.id()) ?? 0;
    if (s.container.zIndex !== z) { s.container.zIndex = z; ctx.markDirty(canvasId); }
    const groupAlpha = ctx.groupAlphaOf(anchor.id());
    if (s.container.alpha !== groupAlpha) { s.container.alpha = groupAlpha; ctx.markDirty(canvasId); }

    const items = batch.sprites(world);
    const comp = ctx.compensate(canvasId);
    for (const g of s.groups.values()) g.used = 0;
    let lit = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // A transparent item, or one whose texture is still loading, is simply not drawn: no quad, no fill.
      const tex = it.opacity > 0 ? ctx.textureOf(it.sprite) : null;
      if (!tex) continue;
      lit = true;
      const g = groupFor(s, tex);
      let p = g.particles[g.used];
      if (!p) { p = new Particle(tex); g.particles.push(p); }
      g.used++;
      p.texture = tex;
      p.x = it.x;
      p.y = it.y;
      p.rotation = it.rotation;
      p.anchorX = it.pivotX;
      p.anchorY = it.pivotY;
      const { scaleX, scaleY } = computeSpriteScale(it.width, it.height, tex.width || 1, tex.height || 1, false);
      p.scaleX = scaleX * comp.x;
      p.scaleY = scaleY * comp.y;
      p.tint = it.color;
      p.alpha = it.opacity;
    }
    for (const g of s.groups.values()) {
      const list = g.pc.particleChildren;
      list.length = g.used;
      for (let i = 0; i < g.used; i++) list[i] = g.particles[i];
      if (g.used !== g.shown) { g.pc.update(); g.shown = g.used; }
    }
    // Something drawn this frame, or last frame's drawing just cleared: the canvas redraws. Transparent items do
    // not count — a game holding pieces at fixed indices keeps free ones at opacity 0, and they must not hold the
    // canvas redrawing every frame after the effect has ended.
    if (lit || s.lit) ctx.markDirty(canvasId);
    s.lit = lit;
  }
}

function disposeOne(s: BatchState): void {
  s.container.removeFromParent();
  // Textures are the renderer's (`textureOf` holds them), never the particles'.
  s.container.destroy({ children: true, texture: false, textureSource: false });
  s.groups.clear();
}

/** Drop every batch container (a world swap, the renderer stopping). The registry is the game's and stays. */
export function disposeSpriteBatchState(state: SpriteBatchState, ctx?: Pick<SpriteBatchCtx, 'markDirty'>): void {
  for (const s of state.batches.values()) {
    if (ctx && s.canvasId !== null) ctx.markDirty(s.canvasId);
    disposeOne(s);
  }
  state.batches.clear();
}
