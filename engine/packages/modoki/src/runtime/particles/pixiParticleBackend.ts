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
  TEXTURE_WAIT_BUDGET_MS,
  renderBuildKey, renderQuadKey, clampSimDt, PREWARM_STEP, seekSteps,
  type IParticleBackendCore, type ParticleEffectDef, type ParticleHandle,
} from './types';
import { rawNow } from '../core/clock';
import { CpuParticleSim } from './cpuSimulator';
import { createPixiParticles, type PixiParticleObject } from './pixiParticleObject';
import { resolveImageUrl } from '../core/textureRefs';
import { textureProvider } from '../core/textureProvider';
import { resolveGravity, type Vec3 } from './simSpec';

/** The default soft-circle texture's side length (`getDefaultParticleTexture` in
 *  `pixiParticleObject.ts`) — the reference size `startSize` multiplies when an effect sets no
 *  custom `render.texture`. Used only as a heuristic for {@link warnIfSubPixel2D}: a custom
 *  texture's real size isn't known until it loads async, so the warning can under/over-estimate
 *  for those effects — acceptable for a diagnostic, not load-bearing for rendering. */
const DEFAULT_TEXTURE_PX = 64;

/** Effect ids currently flagged as sub-pixel in 2D (per module instance — an editor session's
 *  worth of dedup is enough; this is a diagnostic, not a persisted record). An id is REMOVED the
 *  moment a def with that id reads clean, so a live edit that fixes an effect re-arms the warning
 *  if it's later edited back into sub-pixel territory — "once per bad state", not "once ever". */
const warnedSubPixel2D = new Set<string>();
const _gravityScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * A 2D-routed effect authored in 3D (metre-scale) units renders technically-correctly but
 * invisibly: the CPU sim is unit-agnostic (see `pixiParticleMap.ts`), so a `startSize`/`startSpeed`
 * meant as metres becomes the same number of Canvas2D DESIGN PIXELS, shrinking a normal 3D effect
 * to a fraction of a pixel on screen. Nothing else signals this — no error, no zero particle count
 * (the sim runs fine), `modoki_diagnose` sees nothing wrong. Warn once per bad state so an author
 * gets a lead instead of a silently blank viewport (see docs/particles.md "2D vs 3D units").
 *
 * KNOWN LIMITATIONS (deliberately not chased further — this is a cheap heuristic, not a render):
 * it reads `def` alone, so it CANNOT see a per-instance `Transform.scale` an author used to make a
 * shared/metre-scale asset visible in this one placement (the CLAUDE.md-sanctioned fix — scale the
 * SCENE entity, not fork the asset) — that placement will warn every session regardless. And the
 * reach estimate below is still an upper bound that ignores drag and an early collision plane, so
 * it can UNDER-estimate a real sim's travel in the other direction.
 */
function warnIfSubPixel2D(def: ParticleEffectDef): void {
  const id = def.id;
  if (!id) return;
  // Speed × lifetime (ignoring drag/collision, which only shrink it further) PLUS the ballistic
  // drop from gravity alone (½·|g|·life² — the distance gravity contributes even at zero start
  // speed, e.g. a falling/rising effect with a strong pull and a weak launch). Together an upper
  // bound on travel. Thresholds (16 / 24 design px) are picked so a real metre-scale 3D effect
  // (e.g. startSize ~0.1-0.2, speed ~3-6, life ~2-3 → sprite ~6-13px, reach ~18px) trips it, while
  // a properly 2D-authored effect (tens-to-hundreds of design px) does not.
  const life = def.startLifetime.max;
  const g = resolveGravity(def.gravity, _gravityScratch);
  const gravityMag = Math.hypot(g.x, g.y, g.z);
  const reachDesignPx = def.startSpeed.max * life + 0.5 * gravityMag * life * life;
  // Sprite size is only checkable against the DEFAULT soft-circle texture (a known 64px
  // constant) — a `render.texture` effect's real size isn't known until the async load
  // completes (see `loadTextureFor`), and guessing 64px false-positives on any real sprite sheet
  // authored bigger than that (confirmed against games/court's shipped win-sequence confetti,
  // which uses a custom texture and a startSize that reads as sub-pixel ONLY under the 64px
  // default-texture assumption). So a textured effect skips this half and is judged on reach
  // alone — worse recall for that case, but no false positive on real, working content.
  const spriteDesignPx = def.render.texture ? Infinity : def.startSize.max * DEFAULT_TEXTURE_PX;
  if (spriteDesignPx >= 16 && reachDesignPx >= 24) {
    warnedSubPixel2D.delete(id); // now reads clean — allow a future regression to warn again
    return;
  }
  if (warnedSubPixel2D.has(id)) return; // already told this session, in the same bad state
  warnedSubPixel2D.add(id);
  const spritePart = Number.isFinite(spriteDesignPx) ? `sprite ≈ ${spriteDesignPx.toFixed(2)} design px, ` : '';
  console.warn(
    `[particles2d] effect "${def.name || id}" (${id}) renders sub-pixel in 2D: ${spritePart}` +
    `plume reach ≈ ${reachDesignPx.toFixed(2)} design px. ` +
    `2D sim units are Canvas2D design pixels, not metres — this effect looks authored for the 3D ` +
    `backend. See docs/particles.md "2D vs 3D units".`,
  );
}

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
  /** Bounded hidden-wait for a declared sprite texture (#338) — see the 3D twin in
   *  `cpuTslBackend`, whose `TEXTURE_WAIT_BUDGET_MS` this shares by import. */
  awaitingTexture: boolean;
  /** `rawNow()` past which the emitter is revealed untextured. */
  textureDeadline: number;
}

export class PixiParticleBackend implements IParticle2DBackend {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();
  private readonly makeObject: RenderObjectFactory;

  constructor(makeObject: RenderObjectFactory = createPixiParticles) {
    this.makeObject = makeObject;
  }

  create(def: ParticleEffectDef): ParticleHandle {
    warnIfSubPixel2D(def);
    const id = this.nextId++;
    const seed = (id * 9973) >>> 0;
    const entry: Entry = {
      id, def, seed, playing: true,
      textureRef: def.render.texture ?? '',
      wrapper: new Container(),
      sim: null as unknown as CpuParticleSim,
      obj: null as unknown as PixiParticleObject,
      simTime: 0, awaitingTexture: false, textureDeadline: 0,
    };
    this.build(entry, def, null);
    this.entries.set(id, entry);
    if (entry.textureRef) {
      // ⚠️ Same bounded hidden-wait as the 3D CPU backend (#338 close-out F4). `build()` here
      // ALSO constructs the render object and a new CpuParticleSim together, and the texture
      // `.then` calls it again — so a cold sprite discards every live particle and resets the
      // clock, on screen. The 2D route is exactly as close to reachable as the sub-emitter one
      // (nothing pairs `space:'2d'` with `render.texture` today), and fixing one while leaving
      // the other is how the second instance survives a sweep.
      entry.awaitingTexture = true;
      entry.textureDeadline = rawNow() + TEXTURE_WAIT_BUDGET_MS;
      entry.wrapper.visible = false;
      this.loadTextureFor(entry);
    }
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

  /** Stop waiting on a texture and draw this emitter. Idempotent. */
  private revealEmitter(entry: Entry): void {
    entry.awaitingTexture = false;
    entry.wrapper.visible = true;
  }

  private loadTextureFor(entry: Entry): void {
    const ref = entry.textureRef;
    // Headless / no resolvable url: nothing will ever arrive, so do not leave the emitter hidden.
    if (!ref || typeof window === 'undefined') { this.revealEmitter(entry); return; }
    const url = resolveImageUrl(ref);
    if (!url) { this.revealEmitter(entry); return; }
    textureProvider.get()?.ensurePixiKtxTranscoder(); // idempotent; registers the KTX2 loader before we fetch one
    // Lazy import so a headless/test import of this module doesn't require a browser.
    //
    // ⚠️ **Goes through `loadPixiTexture`, not a bare `Assets.load`.** This was the FIFTH consumer
    // of Pixi's texture cache and `12fea928`'s sweep enumerated four — it missed this one because
    // the sweep searched for the `cache.has(url)` → `Assets.get(url)` shape and this path has no
    // `has()` check at all, it loads straight. Both of the shim's guarantees were therefore absent
    // here: no `blob:` parser forcing (so a PLAYABLE build's particle textures never load) and no
    // sourceless-entry eviction (so a torn-down shared texture is handed back dead — and
    // `pixiParticleObject`'s flipbook path reads `base.source.width` with no guard, which is a
    // TypeError rather than a blank sprite).
    import('./../rendering/pixiTextureLoad')
      .then(({ loadPixiTexture }) => loadPixiTexture(url))
      .then((tex) => {
        // Stale: entry disposed or its texture ref changed while loading. Reveal on the way out —
        // a swapped-away ref starts no replacement load, so returning silently strands it hidden.
        if (!this.entries.has(entry.id) || entry.textureRef !== ref) {
          if (this.entries.has(entry.id)) this.revealEmitter(entry);
          return;
        }
        this.build(entry, entry.def, tex as import('pixi.js').Texture);
        if (entry.def.prewarm && entry.def.duration > 0) this.prewarm(entry); // the rebuild dropped it
        this.revealEmitter(entry);
      })
      .catch((e) => {
        console.warn(`[particles2d] texture load failed: ${ref}`, e);
        this.revealEmitter(entry); // a dead sprite must never hide an emitter forever
      });
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
    if (!e) return;
    // Spent BEFORE the play gate, for the reason the 3D twin documents at length: reveal has only
    // two sources, and a paused emitter whose load went stale would otherwise stay hidden forever.
    if (e.awaitingTexture && rawNow() >= e.textureDeadline) this.revealEmitter(e);
    if (!e.playing) return;
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
    warnIfSubPixel2D(def);
    const newTexRef = def.render.texture ?? '';
    const texChanged = newTexRef !== e.textureRef;
    const structural =
      renderBuildKey(def) !== renderBuildKey(e.def) ||
      (def.worldSpace ?? false) !== (e.def.worldSpace ?? false) ||
      texChanged;
    // Compared against the OLD def, before it's overwritten below — a bare aspect/anchor/
    // offset edit is applied in place (#769), never a rebuild.
    const quadChanged = !structural && renderQuadKey(def) !== renderQuadKey(e.def);
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
      if (newTexRef) {
        // Re-arm the hidden-wait for the NEW sprite — the 3D twin's reasoning verbatim: the
        // rebuild above is UNTEXTURED, so drawing it is the wrong material, not a lesser one.
        e.awaitingTexture = true;
        e.textureDeadline = rawNow() + TEXTURE_WAIT_BUDGET_MS;
        e.wrapper.visible = false;
        this.loadTextureFor(e);
      } else if (e.awaitingTexture) {
        // No sprite at all now — nothing will arrive, so stop waiting and draw. (No `texChanged`
        // guard needed here, unlike the 3D twins: this backend reloads whenever `newTexRef` is
        // set, so reaching this branch already means there is nothing outstanding.)
        this.revealEmitter(e);
      }
    } else {
      e.sim.setDef(def);
      if (quadChanged) {
        e.obj.setQuad(def.render); // no rebuild, no texture reload, no hidden-wait re-arm
        // `aspect`/`offsetX`/`offsetY` only take effect on the next commit, but `update()`
        // returns before committing while paused/stopped — commit here too so an edit made
        // while stopped applies in full immediately instead of only moving `anchorY` (which
        // `setQuad` writes straight onto the pooled particles) and leaving aspect/offset stale
        // until play resumes.
        e.obj.commit(e.sim.aliveCount);
      }
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
