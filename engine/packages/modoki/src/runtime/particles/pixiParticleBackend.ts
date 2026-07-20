/**
 * PixiJS 2D implementation of the particle backend — the 2D twin of `cpuTslBackend.ts`.
 * Each handle owns a **stable wrapper `Container`** (added to a Canvas2D ONCE by the sync layer);
 * the inner {@link ParticleContainer} of pooled particles lives as its single child. The shared
 * CPU simulator writes per-particle data into that inner container each frame via
 * {@link createPixiParticles}. Structural edits (maxParticles / blend / tiling / texture /
 * worldSpace) rebuild the INNER container inside the same wrapper — so the object the sync layer
 * mounted never changes identity (exactly like the 3D backend's stable Group + swapped mesh),
 * and an async texture load can't detach the live particles. Timing edits re-baseline the
 * emission clock. Same contract as the 3D backend, so the editor + ECS sync drive both identically.
 *
 * Scope (Phase 1): billboard sprites, blend/render-order/flipbook, async texture load. Trails and
 * sub-emitters are NOT implemented (deferred). The render-object factory is injectable so the
 * backend's sim-driving + lifecycle can be unit-tested without constructing real PixiJS objects.
 */

import { Container } from 'pixi.js';
import type { Matrix4 } from 'three';
import {
  renderStructuralKey, clampSimDt, PREWARM_STEP, seekSteps,
  type IParticleBackendCore, type ParticleEffectDef, type ParticleHandle,
} from './types';
import { CpuParticleSim } from './cpuSimulator';
import { createPixiParticles, type PixiParticleObject } from './pixiParticleObject';
import { resolveImageUrl } from '../rendering/renderUtils';
import { ensurePixiKtxTranscoder } from '../rendering/pixiKtxTranscoder';

/** The 2D (PixiJS) particle backend contract: the renderer-agnostic core plus the PixiJS
 *  `Container` to mount (the 2D counterpart of {@link IParticleBackend}'s `getObject3D`). */
export interface IParticle2DBackend extends IParticleBackendCore {
  /** The PixiJS container to add to the emitter's Canvas2D for this handle. */
  getContainer(handle: ParticleHandle): Container;
}

/** Factory for the render primitive — injectable so tests can drive the backend with a stub
 *  (no real PixiJS objects). Signature matches {@link createPixiParticles}. */
type RenderObjectFactory = typeof createPixiParticles;

interface Entry {
  id: number;
  def: ParticleEffectDef;
  sim: CpuParticleSim;
  obj: PixiParticleObject;
  /** Stable wrapper mounted by the sync layer; the inner ParticleContainer swaps inside it. */
  wrapper: Container;
  seed: number;
  playing: boolean;
  textureRef: string;
  /** Seconds simulated so far — lets seek() step forward instead of re-simulating from zero. */
  simTime: number;
}

export class PixiParticleBackend implements IParticle2DBackend {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();
  private readonly makeObject: RenderObjectFactory;

  constructor(makeObject: RenderObjectFactory = createPixiParticles) {
    this.makeObject = makeObject;
  }

  create(def: ParticleEffectDef): ParticleHandle {
    const id = this.nextId++;
    const seed = (id * 9973) >>> 0;
    const entry: Entry = {
      id, def, seed, playing: true,
      textureRef: def.render.texture ?? '',
      wrapper: new Container(),
      sim: null as unknown as CpuParticleSim,
      obj: null as unknown as PixiParticleObject,
      simTime: 0,
    };
    this.build(entry, def, null);
    this.entries.set(id, entry);
    if (entry.textureRef) this.loadTextureFor(entry);
    if (def.prewarm && def.duration > 0) this.prewarm(entry);
    return { id };
  }

  /** (Re)build the INNER render object + simulator for the current def + (optional) loaded
   *  texture, swapping it inside the stable wrapper so the mounted object keeps its identity. */
  private build(entry: Entry, def: ParticleEffectDef, texture: import('pixi.js').Texture | null): void {
    if (entry.obj) entry.obj.dispose(); // destroys the old inner container (removes it from the wrapper)
    entry.obj = this.makeObject(def.maxParticles, def.render, {
      texture,
      tilesX: def.render.tilesX,
      tilesY: def.render.tilesY,
    });
    entry.wrapper.addChild(entry.obj.container);
    if (def.render.renderOrder != null) entry.wrapper.zIndex = def.render.renderOrder;
    entry.sim = new CpuParticleSim(def, entry.obj.outputs, entry.seed);
    entry.simTime = 0;
  }

  private loadTextureFor(entry: Entry): void {
    const ref = entry.textureRef;
    if (!ref || typeof window === 'undefined') return; // headless: no async texture load
    const url = resolveImageUrl(ref);
    if (!url) return;
    ensurePixiKtxTranscoder(); // idempotent; registers the KTX2 loader before we fetch one
    // Lazy import Assets so a headless/test import of this module doesn't require a browser.
    import('pixi.js')
      .then(({ Assets }) => Assets.load(url))
      .then((tex) => {
        // Stale: entry disposed or its texture ref changed while loading.
        if (!this.entries.has(entry.id) || entry.textureRef !== ref) return;
        this.build(entry, entry.def, tex as import('pixi.js').Texture);
      })
      .catch((e) => console.warn(`[particles2d] texture load failed: ${ref}`, e));
  }

  private prewarm(entry: Entry): void {
    const total = entry.def.duration;
    let t = 0;
    for (; t < total; t += PREWARM_STEP) entry.sim.step(PREWARM_STEP);
    entry.simTime = t;
    entry.obj.commit(entry.sim.aliveCount);
  }

  getContainer(handle: ParticleHandle): Container {
    return this.req(handle).wrapper;
  }

  update(handle: ParticleHandle, dt: number): void {
    const e = this.entries.get(handle.id);
    if (!e || !e.playing) return;
    const cdt = clampSimDt(dt); // shared frame-step ceiling with the 3D backend
    e.sim.step(cdt);
    e.simTime += cdt;
    e.obj.commit(e.sim.aliveCount);
  }

  setTransform(handle: ParticleHandle, matrix: Matrix4): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const m = matrix.elements;
    const c = e.wrapper;
    if (e.def.worldSpace) {
      // Particles baked into world space at birth — keep the wrapper at origin and feed the
      // emitter matrix to the sim (consulted only for new spawns), matching the 3D backend.
      c.x = 0; c.y = 0; c.rotation = 0; c.scale.set(1, 1);
      e.sim.setEmitterMatrix(m);
    } else {
      // Local space: place the wrapper at the emitter's 2D world TRS (extracted from the
      // column-major 3D matrix — translation xy, z-rotation, and per-axis scale).
      c.x = m[12];
      c.y = m[13];
      c.rotation = Math.atan2(m[1], m[0]);
      c.scale.set(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]));
    }
  }

  setDef(handle: ParticleHandle, def: ParticleEffectDef): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const newTexRef = def.render.texture ?? '';
    const texChanged = newTexRef !== e.textureRef;
    const structural =
      renderStructuralKey(def) !== renderStructuralKey(e.def) ||
      (def.worldSpace ?? false) !== (e.def.worldSpace ?? false) ||
      texChanged;
    // Timing fields drive the emission clock; changing them while keeping accumulated `time`
    // straddles the old/new cycle boundary (spurious/missed burst). Re-baseline instead (F5).
    const timingChanged =
      (def.looping ?? false) !== (e.def.looping ?? false) ||
      (def.duration ?? 0) !== (e.def.duration ?? 0) ||
      burstSig(def) !== burstSig(e.def);
    e.def = def;
    if (texChanged) e.textureRef = newTexRef;
    if (structural) {
      // Rebuild radial (no texture) first; async-load the new texture after, if any.
      this.build(e, def, null);
      if (newTexRef) this.loadTextureFor(e);
    } else {
      e.sim.setDef(def);
      // renderOrder is a cheap live tweak on the wrapper (what the Canvas2D sorts) — no rebuild.
      if (def.render.renderOrder != null) e.wrapper.zIndex = def.render.renderOrder;
      if (timingChanged) {
        e.sim.reset();
        e.simTime = 0;
        e.obj.commit(e.sim.aliveCount); // live particles cleared → count 0
      }
    }
  }

  play(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = true; }
  pause(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = false; }

  setSpeedScale(handle: ParticleHandle, scale: number): void {
    const e = this.entries.get(handle.id);
    if (e) e.sim.setSpeedScale(scale);
  }

  restart(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.sim.reset();
    e.simTime = 0;
    e.obj.commit(e.sim.aliveCount); // count now 0
    e.playing = true;
  }

  seek(handle: ParticleHandle, seconds: number): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    if (seconds < e.simTime) { e.sim.reset(); e.simTime = 0; }
    const steps = seekSteps(e.simTime, seconds);
    for (let s = 0; s < steps; s++) e.sim.step(PREWARM_STEP);
    e.simTime += steps * PREWARM_STEP;
    e.obj.commit(e.sim.aliveCount);
  }

  dispose(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.obj.dispose(); // destroys the inner container (removes it from the wrapper)
    e.wrapper.destroy(); // then the now-empty stable wrapper
    this.entries.delete(handle.id);
  }

  private req(handle: ParticleHandle): Entry {
    const e = this.entries.get(handle.id);
    if (!e) throw new Error(`[particles2d] unknown handle ${handle.id}`);
    return e;
  }
}

/** Cheap signature of a def's burst list — drives the emission-clock re-baseline on a live
 *  timing edit (mirrors cpuTslBackend). Order-sensitive, fields only. */
function burstSig(def: ParticleEffectDef): string {
  return (def.emission?.bursts ?? []).map((b) => `${b.time}:${b.count}`).join('|');
}

/** Shared 2D particle backend singleton (parallel to the 3D `particleBackend` router). The
 *  Phase 2 `particleSync2D` drives emitters through this. */
export const pixiParticleBackend: IParticle2DBackend = new PixiParticleBackend();
