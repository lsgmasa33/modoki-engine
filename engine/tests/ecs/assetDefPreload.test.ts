// @vitest-environment jsdom
/**
 * #1162 — the four remaining lazily-cached asset defs are preloaded at scene load, like #1097's
 * Animator clips.
 *
 * Each kind's per-frame consumer SKIPS the entity while its def is null, and the getter only STARTS
 * a fetch on a miss. So unless the scene acquire has already loaded the def, a new world's first
 * frames paint the entity's authored state: a flipbook's authored sprite, an invisible 2D rig
 * (measured live: 1-2 frames cold on skin-test Zombie), an emitter that starts late, and a bare rig
 * that holds its bind pose because its animset's clips were never merged.
 *
 * These drive the REAL `sceneManager.loadScene` with only `fetch` stubbed, and hold each def's
 * fetch OPEN, so "the load waited for it, before the swap" is observable. A stub that settles in
 * microtasks cannot tell an awaited preload from a fire-and-forget one (#1097's review finding).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Entity } from 'koota';
import {
  sceneManager, getCurrentWorld, registerAsset, newGuid, EntityAttributes,
  spriteAnimationSystem, skin2DSystem, getSkin2DBuffer, clearSkin2DBuffers,
  Renderable2D, SkinnedSprite2D,
  getSpriteAnim, clearSpriteAnimCache, getRig2D, clearRig2DCache,
  getAnimSet, clearAnimSetCache, getParticleEffect, clearParticleCache,
  getResourceStats, invalidateRig2D,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { markKtx2CapsReady } from '../../packages/modoki/src/runtime/core/activeRenderer';
import { loadRig2DNow } from '../../packages/modoki/src/runtime/loaders/rig2dCache';

const SPRITEANIM_PATH = '/assets/anims/preload-flip.spriteanim.json';
const RIG_PATH = '/assets/rigs/preload-rig.rig2d.json';
const ANIMSET_PATH = '/assets/anims/preload.animset.json';
const PARTICLE_PATH = '/assets/particles/preload.particle.json';
const SOURCE_GLB_PATH = '/assets/models/preload-clips.glb';

const BASE = 'http://localhost';
const AUTHORED_SPRITE = newGuid();
const FRAME_0 = newGuid();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function scene(entityTraits: Record<string, unknown>) {
  return {
    id: newGuid(), version: 1, resources: [],
    entities: [{
      id: 1, name: 'Subject',
      traits: { EntityAttributes: { name: 'Subject', guid: newGuid() }, Transform: {}, ...entityTraits },
    }],
  };
}

function rigBody(id: string) {
  return {
    id,
    bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
    sprite: newGuid(),
    mesh: { verts: [[0, 0], [10, 0], [0, 10]], uvs: [[0, 0], [1, 0], [0, 1]], tris: [0, 1, 2] },
    skinIndices: [0, 0, 0],
    skinWeights: [1, 1, 1],
  };
}

function subject(): Entity {
  let found: Entity | undefined;
  getCurrentWorld().query(EntityAttributes).forEach((e) => {
    if (e.get(EntityAttributes)?.name === 'Subject') found = e;
  });
  return found!;
}

describe('#1162 — spriteanim / rig2d / animset / particle defs are preloaded at scene load', () => {
  /** Path → body. A path listed in `gates` is held until that gate is released. */
  let bodies: Map<string, unknown>;
  let gates: Map<string, Promise<void>>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function hold(path: string): () => void {
    let release!: () => void;
    gates.set(path, new Promise<void>((r) => { release = r; }));
    return release;
  }

  const urlPath = (u: RequestInfo | URL) => new URL(u instanceof Request ? u.url : String(u), BASE).pathname;
  const requested = (path: string) => fetchMock.mock.calls.some(([u]) => urlPath(u).endsWith(path));
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function startLoad(sceneJson: unknown) {
    const h = { settled: false, worldBefore: getCurrentWorld(), load: Promise.resolve() };
    h.load = sceneManager.loadScene(`/assets/scenes/preload-${newGuid()}.scene.json`, { preloaded: sceneJson as never })
      .then(() => { h.settled = true; });
    return h;
  }

  /** Prove the load is parked on `path`'s fetch BEFORE the swap. `settled === false` alone also
   *  passes a preload awaited after `setCurrentWorld` (#1097 close-out §2d). */
  async function expectParkedOn(h: ReturnType<typeof startLoad>, path: string) {
    for (let i = 0; i < 200 && !h.settled && !requested(path); i++) await tick();
    for (let i = 0; i < 50 && !h.settled; i++) await tick();
    expect(requested(path)).toBe(true);
    expect(h.settled).toBe(false);
    // Boolean form: a failing `toBe(world)` diffs two koota worlds and crashes the worker.
    expect(getCurrentWorld() === h.worldBefore).toBe(true);
  }

  beforeEach(() => {
    registerAllTraits();
    // The rigged GLB load waits on KTX2 caps, which a headless run never detects on its own.
    markKtx2CapsReady('probe');
    clearSpriteAnimCache(); clearRig2DCache(); clearAnimSetCache(); clearParticleCache(); clearSkin2DBuffers();
    bodies = new Map();
    gates = new Map();
    // three's FileLoader (the rigged GLB load) builds a `Request` from the relative asset URL,
    // which Node rejects outright and a browser resolves against the page — give it a base.
    const RealRequest = globalThis.Request;
    vi.stubGlobal('Request', class extends RealRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === 'string' ? new URL(input, BASE) : input, init); }
    });
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = urlPath(url);
      const key = [...bodies.keys()].find((p) => path.endsWith(p));
      if (!key) return new Response('not found', { status: 404 });
      const gate = gates.get(key);
      if (gate) await gate;
      return json(bodies.get(key));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSpriteAnimCache(); clearRig2DCache(); clearAnimSetCache(); clearParticleCache(); clearSkin2DBuffers();
  });

  it('spriteanim: the spawn tick shows the clip\'s first frame, not the authored sprite', async () => {
    const guid = newGuid();
    registerAsset(guid, SPRITEANIM_PATH, 'spriteanim');
    bodies.set(SPRITEANIM_PATH, { id: guid, clips: { idle: { frames: [FRAME_0, newGuid()], fps: 8, mode: 'loop' } } });
    const release = hold(SPRITEANIM_PATH);

    const h = startLoad(scene({
      Renderable2D: { sprite: AUTHORED_SPRITE },
      SpriteAnimator: { clipSet: guid, clip: 'idle', playing: false },
    }));
    await expectParkedOn(h, SPRITEANIM_PATH);
    release();
    await h.load;

    expect(getSpriteAnim(guid, { load: false })).not.toBeNull();
    expect((subject().get(Renderable2D) as { sprite: string }).sprite).toBe(AUTHORED_SPRITE); // nothing has run yet
    spriteAnimationSystem(getCurrentWorld());
    expect((subject().get(Renderable2D) as { sprite: string }).sprite).toBe(FRAME_0);
  });

  it('rig2d: the spawn tick builds the skin buffer, so the entity is not invisible', async () => {
    const guid = newGuid();
    registerAsset(guid, RIG_PATH, 'rig2d');
    bodies.set(RIG_PATH, rigBody(guid));
    const release = hold(RIG_PATH);

    const h = startLoad(scene({ SkinnedSprite2D: { rig: guid } }));
    await expectParkedOn(h, RIG_PATH);
    release();
    await h.load;

    expect(getRig2D(guid, { load: false })).not.toBeNull();
    const id = subject().id();
    expect(subject().has(SkinnedSprite2D)).toBe(true);
    expect(getSkin2DBuffer(id)).toBeFalsy(); // nothing has run yet
    skin2DSystem(getCurrentWorld());
    expect(getSkin2DBuffer(id)).toBeTruthy();
  });

  it('particle: the effect def is resolvable synchronously when the world goes live', async () => {
    const guid = newGuid();
    registerAsset(guid, PARTICLE_PATH, 'particle');
    bodies.set(PARTICLE_PATH, { id: guid });
    const release = hold(PARTICLE_PATH);

    const h = startLoad(scene({ ParticleEmitter: { effect: guid } }));
    await expectParkedOn(h, PARTICLE_PATH);
    release();
    await h.load;

    // The particle syncs run in the render callbacks (`if (!def) return;`), so the def being in the
    // cache at the swap IS the precondition of an emitter on the first rendered frame.
    expect(getParticleEffect(guid, { load: false })).not.toBeNull();
  });

  it('animset: the set is loaded AND its source GLB is acquired under the new scene, both before the swap', async () => {
    const guid = newGuid();
    const sourceGuid = newGuid();
    registerAsset(guid, ANIMSET_PATH, 'animset');
    registerAsset(sourceGuid, SOURCE_GLB_PATH, 'model');
    bodies.set(ANIMSET_PATH, { id: guid, source: sourceGuid, clips: [{ name: 'bent', speed: 2 }] });
    bodies.set(SOURCE_GLB_PATH, { not: 'a glb' }); // parse fails → the loader resolves anyway
    const releaseSet = hold(ANIMSET_PATH);
    const releaseGlb = hold(SOURCE_GLB_PATH);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = startLoad(scene({ SkeletalAnimator: { animSet: guid } }));
      await expectParkedOn(h, ANIMSET_PATH);
      expect(requested(SOURCE_GLB_PATH)).toBe(false);
      releaseSet();
      // The source GLB is only known once the set is parsed, so the load parks a second time on it.
      await expectParkedOn(h, SOURCE_GLB_PATH);
      expect(getAnimSet(guid, { load: false })).not.toBeNull();
      // Owned by the scene acquire — the render sync's lazy path (the only other owner) never ran here.
      expect(getResourceStats().rigged[SOURCE_GLB_PATH]).toBe(1);
      releaseGlb();
      await h.load;
      // …still owned once the new world is live: an acquire under the OUTGOING scene would have been
      // released at this very swap, and the render sync would re-fetch it — the pop-in again…
      expect(getResourceStats().rigged[SOURCE_GLB_PATH]).toBe(1);
      // …and released WITH that scene, not pinned: an owner no scene release reaches survives this.
      await sceneManager.loadScene(`/assets/scenes/preload-empty-${newGuid()}.scene.json`, { preloaded: scene({}) as never });
      expect(getResourceStats().rigged[SOURCE_GLB_PATH]).toBeUndefined();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('an animset whose source is not a string still loads the scene, and acquires no model', async () => {
    const guid = newGuid();
    registerAsset(guid, ANIMSET_PATH, 'animset');
    bodies.set(ANIMSET_PATH, { id: guid, source: 5, clips: [] }); // hand-edited JSON: nothing validates `source`
    const before = Object.keys(getResourceStats().rigged).length;
    await expect(sceneManager.loadScene(`/assets/scenes/preload-bad-source-${newGuid()}.scene.json`, {
      preloaded: scene({ SkeletalAnimator: { animSet: guid } }) as never,
    })).resolves.toBeUndefined();
    expect(getAnimSet(guid, { load: false })).not.toBeNull();
    expect(Object.keys(getResourceStats().rigged)).toHaveLength(before);
  });

  it('a preload refused by a mid-flight invalidation resolves null without starting a second fetch', async () => {
    // `awaitLazyLoad` re-reads through the getter's `{ load: false }` PEEK. Re-reading through the
    // loading getter instead would find the invalidated cache empty and start a fetch nobody awaits.
    const guid = newGuid();
    registerAsset(guid, RIG_PATH, 'rig2d');
    bodies.set(RIG_PATH, rigBody(guid));
    const release = hold(RIG_PATH);
    const preload = loadRig2DNow(guid);
    invalidateRig2D(guid);
    release();
    await expect(preload).resolves.toBeNull();
    for (let i = 0; i < 10; i++) await tick();
    expect(fetchMock.mock.calls.filter(([u]) => urlPath(u).endsWith(RIG_PATH))).toHaveLength(1);
  });

  it('a def that fails to load does not fail or block the scene load', async () => {
    const guids = { sa: newGuid(), rig: newGuid(), set: newGuid(), fx: newGuid() };
    registerAsset(guids.sa, SPRITEANIM_PATH, 'spriteanim');
    registerAsset(guids.rig, RIG_PATH, 'rig2d');
    registerAsset(guids.set, ANIMSET_PATH, 'animset');
    registerAsset(guids.fx, PARTICLE_PATH, 'particle');
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(sceneManager.loadScene('/assets/scenes/preload-fail.scene.json', { preloaded: {
        id: newGuid(), version: 1, resources: [],
        entities: [
          { id: 1, name: 'A', traits: { EntityAttributes: { name: 'A', guid: newGuid() }, Transform: {}, Renderable2D: { sprite: AUTHORED_SPRITE }, SpriteAnimator: { clipSet: guids.sa } } },
          { id: 2, name: 'B', traits: { EntityAttributes: { name: 'B', guid: newGuid() }, Transform: {}, SkinnedSprite2D: { rig: guids.rig } } },
          { id: 3, name: 'C', traits: { EntityAttributes: { name: 'C', guid: newGuid() }, Transform: {}, SkeletalAnimator: { animSet: guids.set } } },
          { id: 4, name: 'D', traits: { EntityAttributes: { name: 'D', guid: newGuid() }, Transform: {}, ParticleEmitter: { effect: guids.fx } } },
        ],
      } as never })).resolves.toBeUndefined();
      for (const p of [SPRITEANIM_PATH, RIG_PATH, ANIMSET_PATH, PARTICLE_PATH]) expect(requested(p)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
