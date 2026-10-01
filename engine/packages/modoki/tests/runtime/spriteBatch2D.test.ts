/** Sprite batches (spriteBatch2D.ts): a game's entity-free sprites, drawn into their anchor's canvas.
 *
 *  Driven with real Pixi containers and a fake renderer context, so each property the renderer relies on is
 *  pinned on its own: where the batch mounts, its depth, what a sprite is drawn from, what is hidden, and that a
 *  reclaimed slot or a world swap does not strand it. */
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, type Entity, type World } from 'koota';
import { Container, Particle, ParticleContainer, Rectangle, Texture, TextureSource } from 'pixi.js';

import { createSpriteBatchState, disposeSpriteBatchState, syncSpriteBatches2D, type SpriteBatchCtx } from '../../src/runtime/rendering/spriteBatch2D';
import { registerSpriteBatch2D, unregisterSpriteBatch2D, type BatchSprite2D } from '../../src/runtime/rendering/spriteBatchRegistry';

const item = (o: Partial<BatchSprite2D> = {}): BatchSprite2D => ({
  sprite: 'tex', x: 10, y: 20, width: 8, height: 4, rotation: 0.5, color: 0xff0000, opacity: 0.25, pivotX: 0.5, pivotY: 1, ...o,
});

function setup(paint = 7) {
  const world: World = createWorld();
  const anchor: Entity = world.spawn();
  const slot = new Container();
  const otherSlot = new Container();
  const dirty: number[] = [];
  const source = new TextureSource({ width: 64, height: 64 });
  const tex = new Texture({ source, frame: new Rectangle(0, 0, 32, 16) });
  const tex2 = new Texture({ source, frame: new Rectangle(32, 0, 32, 32) });
  const other = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
  const where = { cid: 1 as number | null, active: true, alpha: 1 };
  const ctx: SpriteBatchCtx = {
    canvasIdOf: (id) => (id === anchor.id() ? where.cid : null),
    parentContainer: (cid) => (cid === 1 ? slot : cid === 2 ? otherSlot : null),
    isActive: () => where.active,
    groupAlphaOf: () => where.alpha,
    markDirty: (cid) => { dirty.push(cid); },
    compensate: () => ({ x: 1, y: 2 }),
    paintOf: (id) => (id === anchor.id() ? paint : undefined),
    textureOf: (ref) => (ref === 'tex' ? tex : ref === 'tex2' ? tex2 : ref === 'other' ? other : null),
  };
  return { world, anchor, slot, other: otherSlot, dirty, tex, tex2, where, ctx, state: createSpriteBatchState() };
}

afterEach(() => unregisterSpriteBatch2D('t'));

/** The batch's ParticleContainers (one per texture source) in a canvas slot. */
const groups = (c: Container) => (c.children[0] as Container).children as ParticleContainer[];
/** Every particle drawn, in draw order. */
const drawn = (c: Container): Particle[] => groups(c).flatMap((g) => g.particleChildren as Particle[]);

describe('syncSpriteBatches2D', () => {
  it('mounts one container in the anchor\'s canvas at the anchor\'s paint rank, and redraws that canvas', () => {
    const s = setup(7);
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.slot.children).toHaveLength(1);
    expect(s.slot.children[0].zIndex).toBe(7);
    expect(s.dirty).toContain(1);
  });

  it('draws each item as Renderable2D would: half extents, pivot, tint, alpha, rotation, compensation', () => {
    const s = setup();
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    const [p] = drawn(s.slot);
    expect(p.texture).toBe(s.tex);
    expect([p.x, p.y, p.rotation, p.alpha, p.tint]).toEqual([10, 20, 0.5, 0.25, 0xff0000]);
    expect([p.anchorX, p.anchorY]).toEqual([0.5, 1]);
    // 8 half-wide over a 32 x 16 frame, times the canvas compensation 1 x 2.
    expect(p.scaleX).toBeCloseTo((8 * 2) / 32, 9);
    expect(p.scaleY).toBeCloseTo(((4 * 2) / 16) * 2, 9);
  });

  it('draws everything from one source as ONE particle container, and a second source as its own', () => {
    const s = setup();
    let list = [item(), item({ sprite: 'tex2' }), item(), item({ sprite: 'other' })];
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => list });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(groups(s.slot).map((g) => g.particleChildren.length)).toEqual([3, 1]);
    // Two frames of one atlas in one container: each particle keeps its own frame.
    expect(groups(s.slot)[0].particleChildren.map((p) => p.texture)).toEqual([s.tex, s.tex2, s.tex]);
    list = [item({ sprite: 'tex2' })];
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(groups(s.slot).map((g) => g.particleChildren.length)).toEqual([1, 0]);
  });

  it('does not draw transparent items or those whose texture is not loaded, and redraws when the batch empties', () => {
    const s = setup();
    let list = [item(), item(), item()];
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => list });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(drawn(s.slot)).toHaveLength(3);
    list = [item({ sprite: 'loading' }), item({ opacity: 0 }), item({ x: 99 })];
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(drawn(s.slot).map((p) => p.x)).toEqual([99]);
    // The frame that empties the batch redraws, or its last particles would stay on screen; an empty batch that
    // was already empty does not.
    list = [];
    s.dirty.length = 0;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(drawn(s.slot)).toEqual([]);
    expect(s.dirty).toContain(1);
    s.dirty.length = 0;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.dirty).toEqual([]);
  });

  it('a batch of only transparent items stops redrawing its canvas once they are hidden (the free slots a game keeps)', () => {
    const s = setup();
    let list = [item(), item()];
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => list });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    list = [item({ opacity: 0 }), item({ opacity: 0 }), item({ opacity: 0 })];
    s.dirty.length = 0;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.dirty, 'the frame that hides them redraws').toContain(1);
    s.dirty.length = 0;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.dirty, 'then nothing').toEqual([]);
    expect(drawn(s.slot)).toEqual([]);
  });

  it('leaves while its anchor is switched off, and fades with the anchor\'s GroupAlpha', () => {
    const s = setup();
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    s.where.alpha = 0.4;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.slot.children[0].alpha).toBeCloseTo(0.4, 9);
    s.where.active = false;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.slot.children).toHaveLength(0);
  });

  it('re-mounts after its slot dropped it, follows the anchor to another canvas, and leaves when it has none', () => {
    const s = setup();
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    s.slot.removeChildren(); // a pool slot reclaimed and handed back strips its children
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.slot.children).toHaveLength(1);
    s.where.cid = 2;
    s.dirty.length = 0;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect([s.slot.children.length, s.other.children.length]).toEqual([0, 1]);
    expect(s.dirty).toEqual(expect.arrayContaining([1, 2]));
    s.where.cid = null;
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.other.children).toHaveLength(0);
  });

  it('drops a batch the game unregistered, and everything on dispose', () => {
    const s = setup();
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    unregisterSpriteBatch2D('t');
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    expect(s.slot.children).toHaveLength(0);
    expect(s.state.batches.size).toBe(0);
    registerSpriteBatch2D('t', { anchor: () => s.anchor, sprites: () => [item()] });
    syncSpriteBatches2D(s.world, s.ctx, s.state);
    disposeSpriteBatchState(s.state, s.ctx);
    expect(s.slot.children).toHaveLength(0);
    expect(s.state.batches.size).toBe(0);
    expect(s.tex.destroyed).toBe(false);
  });
});
