/**
 * CPU-simulation + SpriteNodeMaterial billboard implementation of {@link IParticleBackend}.
 *
 * Each handle owns a stable THREE.Group (added to the scene by the caller) containing the
 * instanced billboard mesh. Simulation writes per-particle data straight into the mesh's
 * instance buffers each frame. Structural edits (maxParticles / blend / sprite-sheet tiling
 * / texture) rebuild the inner mesh inside the same Group, so the scene graph never needs
 * re-wiring — important for live editor edits and for the ECS sync map. Textures load
 * asynchronously and trigger a rebuild when ready.
 */

import * as THREE from 'three';
import { renderStructuralKey, clampSimDt, PREWARM_STEP, seekSteps, type IParticleBackend, type ParticleEffectDef, type ParticleHandle, type SubEmitter } from './types';
import { CpuParticleSim } from './cpuSimulator';
import { createBillboard, type BillboardObject } from './spriteBillboard';
import { createMeshParticles } from './meshParticles';
import { createTrail, type TrailObject } from './trailLines';
import { makeRng } from './curves';
import { getParticleEffect } from '../loaders/particleCache';
import { loadTexture3D, releaseTexture3D } from '../loaders/textureResolver';

/**
 * A nested sub-emitter instance. Its own continuous emission is disabled and its own
 * sub-emitters are stripped (depth-1) — it is driven purely by injected bursts at the
 * parent's birth/death event positions. Built lazily once the child effect asset loads;
 * `sim`/`render` stay null until then (we retry each frame).
 */
interface SubChild {
  config: SubEmitter;
  count: number;
  probability: number;
  inheritVelocity: number;
  seed: number;
  /** Per-child probability RNG seeded from this child's own `seed`, so one child's
   *  rolls don't depend on how many events a sibling consumed (F6 — was a shared
   *  parent `probRng`, which coupled sibling randomness order-dependently). */
  probRng: () => number;
  /** Set once we've warned that a burst overflowed this child's pool — keeps the
   *  warning to a single line instead of one per dropped particle per frame. */
  warnedTruncation: boolean;
  group: THREE.Group; // nested under the parent group (rides the emitter transform)
  sim: CpuParticleSim | null;
  render: BillboardObject | null;
  trail: TrailObject | null;
  childDef: ParticleEffectDef | null; // the def the current sim/render was built for
  texture: THREE.Texture | null;
  textureRef: string;
}

interface Entry {
  id: number;
  def: ParticleEffectDef;
  sim: CpuParticleSim;
  billboard: BillboardObject;
  trail: TrailObject | null; // optional motion-trail layer
  subs: SubChild[]; // sub-emitter children
  group: THREE.Group; // stable container added to the scene
  seed: number;
  playing: boolean;
  textureRef: string;
  texture: THREE.Texture | null;
  /** Seconds simulated so far — lets seek() step forward from here instead of
   *  re-simulating from zero on every scrub event. */
  simTime: number;
}

/** Cheap signature of a def's sub-emitter list to detect structural edits. */
function subSig(def: ParticleEffectDef): string {
  return (def.subEmitters ?? [])
    .map((s) => `${s.trigger}:${s.effect}:${s.count ?? ''}:${s.probability ?? ''}:${s.inheritVelocity ?? ''}`)
    .join('|');
}

/** Cheap signature of a def's burst list — drives the emission-clock re-baseline on a
 *  live timing edit (F5). Order-sensitive, fields only (no identity). */
function burstSig(def: ParticleEffectDef): string {
  return (def.emission?.bursts ?? [])
    .map((b) => `${b.time}:${b.count}`)
    .join('|');
}

export class CpuTslBackend implements IParticleBackend {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();

  create(def: ParticleEffectDef): ParticleHandle {
    const id = this.nextId++;
    const seed = (id * 9973) >>> 0;
    const group = new THREE.Group();
    group.name = `particles:${id}`;
    group.matrixAutoUpdate = false;
    const entry: Entry = {
      id, def, group, seed, playing: true,
      textureRef: def.render.texture ?? '', texture: null,
      sim: null as unknown as CpuParticleSim, billboard: null as unknown as BillboardObject, trail: null,
      subs: [], simTime: 0,
    };
    this.build(entry, def);
    this.entries.set(id, entry);
    if (entry.textureRef && def.render.mode !== 'mesh') this.loadTextureFor(entry);
    if (def.prewarm && def.duration > 0) this.prewarm(entry);
    return { id };
  }

  /** (Re)build the billboard mesh + simulator for the current def + loaded texture. */
  private build(entry: Entry, def: ParticleEffectDef): void {
    if (entry.billboard) {
      entry.group.remove(entry.billboard.mesh);
      entry.billboard.dispose();
    }
    if (entry.trail) {
      entry.group.remove(entry.trail.mesh);
      entry.trail.dispose();
      entry.trail = null;
    }
    entry.billboard = def.render.mode === 'mesh'
      ? createMeshParticles(def.maxParticles, def.render)
      : createBillboard(def.maxParticles, def.render, {
          texture: entry.texture,
          tilesX: def.render.tilesX,
          tilesY: def.render.tilesY,
        });
    entry.group.add(entry.billboard.mesh);
    if (def.trail?.enabled) {
      entry.trail = createTrail(def.maxParticles, def.trail.segments, def.render);
      entry.group.add(entry.trail.mesh);
    }
    entry.sim = new CpuParticleSim(def, entry.billboard.outputs, entry.seed, entry.trail?.outputs);
    entry.simTime = 0; // fresh sim — reset elapsed (prewarm below may advance it)

    // Sub-emitters: one nested group per configured child. The child sim/render is built
    // lazily (its effect asset loads async) — see tryBuildChild during advance().
    this.disposeSubs(entry);
    entry.subs = (def.subEmitters ?? []).map((s, idx) => {
      const g = new THREE.Group();
      g.name = `subfx:${entry.id}:${idx}`;
      entry.group.add(g);
      const seed = (entry.seed ^ (0x9e3779b1 * (idx + 1))) >>> 0;
      return {
        config: s,
        count: Math.max(1, Math.floor(s.count ?? 8)),
        probability: s.probability ?? 1,
        inheritVelocity: s.inheritVelocity ?? 0,
        seed,
        probRng: makeRng(seed ^ 0x5bd1e995),
        warnedTruncation: false,
        group: g, sim: null, render: null, trail: null, childDef: null,
        texture: null, textureRef: '',
      } satisfies SubChild;
    });
  }

  private disposeSubs(entry: Entry): void {
    if (!entry.subs) return;
    for (const c of entry.subs) {
      if (c.render) { c.group.remove(c.render.mesh); c.render.dispose(); }
      if (c.trail) { c.group.remove(c.trail.mesh); c.trail.dispose(); }
      releaseTexture3D(c.texture); c.texture = null; // shared, refcounted (texture-shader-font F3) — release
      entry.group.remove(c.group);
    }
    entry.subs = [];
  }

  /** Build (or rebuild) a sub-emitter child's render + sim for a resolved child def. */
  private buildChildRender(c: SubChild, childDef: ParticleEffectDef): void {
    if (c.render) { c.group.remove(c.render.mesh); c.render.dispose(); }
    if (c.trail) { c.group.remove(c.trail.mesh); c.trail.dispose(); c.trail = null; }
    c.render = childDef.render.mode === 'mesh'
      ? createMeshParticles(childDef.maxParticles, childDef.render)
      : createBillboard(childDef.maxParticles, childDef.render, {
          texture: c.texture, tilesX: childDef.render.tilesX, tilesY: childDef.render.tilesY,
        });
    c.group.add(c.render.mesh);
    if (childDef.trail?.enabled) {
      c.trail = createTrail(childDef.maxParticles, childDef.trail.segments, childDef.render);
      c.group.add(c.trail.mesh);
    }
    c.sim = new CpuParticleSim(childDef, c.render.outputs, c.seed, c.trail?.outputs);
    c.childDef = childDef;
  }

  /** Try to materialize a not-yet-built sub-emitter child once its asset has loaded. */
  private tryBuildChild(entry: Entry, c: SubChild): void {
    const raw = getParticleEffect(c.config.effect);
    if (!raw) return; // not loaded yet (or failed) — retry next frame
    // Disable the child's own continuous emission + sub-emitters: it is driven purely by
    // injected bursts, and recursion is capped at depth 1.
    const childDef: ParticleEffectDef = {
      ...raw,
      emission: { rateOverTime: 0 },
      subEmitters: undefined,
    };
    this.buildChildRender(c, childDef);
    // Async-load a billboard child's texture, then rebuild it once ready.
    const texRef = childDef.render.mode !== 'mesh' ? (childDef.render.texture ?? '') : '';
    if (texRef && texRef !== c.textureRef) {
      c.textureRef = texRef;
      loadTexture3D(texRef)
        .then((tex) => {
          if (!this.entries.has(entry.id) || c.childDef !== childDef) { releaseTexture3D(tex); return; } // stale — release our ref
          releaseTexture3D(c.texture); // release prior before replacing
          c.texture = tex;
          this.buildChildRender(c, childDef);
        })
        .catch((e) => console.warn(`[particles] sub-emitter texture load failed: ${texRef}`, e));
    }
  }

  /** Advance the parent sim one frame, then dispatch lifecycle events to sub-emitters. */
  private advance(entry: Entry, dt: number): void {
    entry.sim.step(dt);
    if (!entry.subs.length) return;
    const births = entry.sim.birthEvents;
    const deaths = entry.sim.deathEvents;
    for (const c of entry.subs) {
      if (!c.sim) { this.tryBuildChild(entry, c); if (!c.sim) continue; }
      const ev = c.config.trigger === 'birth' ? births : deaths;
      const inh = c.inheritVelocity;
      let dropped = false;
      for (let k = 0; k < ev.length; k += 6) {
        if (c.probability < 1 && c.probRng() > c.probability) continue;
        const x = ev[k], y = ev[k + 1], z = ev[k + 2];
        const vx = ev[k + 3] * inh, vy = ev[k + 4] * inh, vz = ev[k + 5] * inh;
        for (let n = 0; n < c.count; n++) dropped = !c.sim.injectAt(x, y, z, vx, vy, vz) || dropped;
      }
      if (dropped && !c.warnedTruncation) {
        c.warnedTruncation = true;
        console.warn(`[particles] sub-emitter "${c.config.effect}" burst exceeded its pool (maxParticles=${c.childDef?.maxParticles ?? '?'}); excess particles dropped. Raise the child's maxParticles or lower its count/rate.`);
      }
      c.sim.step(dt);
    }
  }

  /** Upload the parent + every built sub-emitter child this frame. */
  private commitAll(entry: Entry): void {
    entry.billboard.commit(entry.sim.aliveCount);
    entry.trail?.commit(entry.sim.aliveCount);
    for (const c of entry.subs) {
      if (!c.sim || !c.render) continue;
      c.render.commit(c.sim.aliveCount);
      c.trail?.commit(c.sim.aliveCount);
    }
  }

  private loadTextureFor(entry: Entry): void {
    const ref = entry.textureRef;
    if (!ref) return;
    loadTexture3D(ref)
      .then((tex) => {
        // stale: entry disposed or ref changed mid-load. The texture is shared +
        // refcounted (texture-shader-font F3) — release our ref so it's freed when
        // the last holder drops it (here, immediately, if no one else acquired it).
        if (!this.entries.has(entry.id) || entry.textureRef !== ref) { releaseTexture3D(tex); return; }
        releaseTexture3D(entry.texture); // release any prior texture before replacing
        entry.texture = tex;
        this.build(entry, entry.def);
      })
      .catch((e) => console.warn(`[particles] texture load failed: ${ref}`, e));
  }

  private prewarm(entry: Entry): void {
    const total = entry.def.duration;
    let t = 0;
    for (; t < total; t += PREWARM_STEP) this.advance(entry, PREWARM_STEP);
    entry.simTime = t; // = number-of-steps * PREWARM_STEP
    this.commitAll(entry);
  }

  getObject3D(handle: ParticleHandle): THREE.Object3D {
    return this.req(handle).group;
  }

  update(handle: ParticleHandle, dt: number): void {
    const e = this.entries.get(handle.id);
    if (!e || !e.playing) return;
    // Clamp the frame step once (shared ceiling with the GPU backend) and use
    // the SAME value for integration and the sim clock so a long frame can't
    // teleport particles or desync time from motion.
    const cdt = clampSimDt(dt);
    this.advance(e, cdt);
    e.simTime += cdt;
    this.commitAll(e);
  }

  setTransform(handle: ParticleHandle, matrix: THREE.Matrix4): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    if (e.def.worldSpace) {
      // Particles are baked into world space at birth — keep the render group at identity
      // and feed the emitter matrix to the sim (consulted only for new spawns).
      e.group.matrix.identity();
      e.sim.setEmitterMatrix(matrix.elements);
    } else {
      e.group.matrix.copy(matrix);
    }
    e.group.matrixWorldNeedsUpdate = true;
  }

  setDef(handle: ParticleHandle, def: ParticleEffectDef): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const newTexRef = def.render.texture ?? '';
    const isMesh = def.render.mode === 'mesh';
    const texChanged = newTexRef !== e.textureRef;
    const structural =
      renderStructuralKey(def) !== renderStructuralKey(e.def) ||
      (def.trail?.enabled ?? false) !== (e.def.trail?.enabled ?? false) ||
      (def.trail?.segments ?? 8) !== (e.def.trail?.segments ?? 8) ||
      (def.worldSpace ?? false) !== (e.def.worldSpace ?? false) || // clean restart, no mixed-space particles
      subSig(def) !== subSig(e.def) ||
      texChanged;
    // Timing fields drive the emission clock (the burst-crossing window is
    // `time % cycle`, cycle = looping ? duration : Infinity). Changing them while
    // keeping the accumulated `time` makes the next step straddle the old/new cycle
    // boundary → a spurious double burst or a skipped one for one cycle. They're not
    // geometry-structural, so a full rebuild is overkill — instead re-baseline the
    // sim's emission clock (a clean restart) so the new cycle starts at t=0. (F5)
    const timingChanged =
      (def.looping ?? false) !== (e.def.looping ?? false) ||
      (def.duration ?? 0) !== (e.def.duration ?? 0) ||
      burstSig(def) !== burstSig(e.def);
    e.def = def;
    if (texChanged) {
      releaseTexture3D(e.texture); // shared, refcounted (F3) — release before dropping the reference
      e.textureRef = newTexRef;
      e.texture = null; // drop old texture; rebuild radial, then async-load the new one
    }
    if (structural) {
      this.build(e, def); // fresh sim → emission clock already clean
      if (texChanged && newTexRef && !isMesh) this.loadTextureFor(e);
    } else {
      e.sim.setDef(def);
      if (timingChanged) {
        // Clean restart of the emission clock (keeps geometry/buffers + the current
        // play state; a paused emitter stays paused, empty until played).
        e.sim.reset();
        for (const c of e.subs) c.sim?.reset();
        e.simTime = 0;
        this.commitAll(e); // live particles cleared → counts now 0
      }
    }
  }

  play(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = true; }
  pause(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = false; }

  setSpeedScale(handle: ParticleHandle, scale: number): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.sim.setSpeedScale(scale);
    // Sub-emitter children inherit the same throttle so a scaled-up plume's
    // sparks/streaks lengthen with it.
    for (const c of e.subs) c.sim?.setSpeedScale(scale);
  }

  restart(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.sim.reset();
    for (const c of e.subs) c.sim?.reset();
    e.simTime = 0;
    this.commitAll(e); // all counts now 0
    e.playing = true;
  }

  seek(handle: ParticleHandle, seconds: number): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    // Step forward from where we already are (cheap for forward scrubs); only rewind+resim
    // when seeking backward. Cap the work per call so a far jump can't freeze the UI
    // (>SEEK_MAX_STEPS·PREWARM_STEP seconds approximates rather than fully simulating).
    if (seconds < e.simTime) {
      e.sim.reset();
      for (const c of e.subs) c.sim?.reset();
      e.simTime = 0;
    }
    const steps = seekSteps(e.simTime, seconds);
    for (let s = 0; s < steps; s++) this.advance(e, PREWARM_STEP);
    e.simTime += steps * PREWARM_STEP;
    this.commitAll(e);
  }

  dispose(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.group.remove(e.billboard.mesh);
    e.billboard.dispose();
    if (e.trail) { e.group.remove(e.trail.mesh); e.trail.dispose(); }
    this.disposeSubs(e);
    releaseTexture3D(e.texture); e.texture = null; // shared, refcounted (F3) — release on teardown
    this.entries.delete(handle.id);
  }

  private req(handle: ParticleHandle): Entry {
    const e = this.entries.get(handle.id);
    if (!e) throw new Error(`[particles] unknown handle ${handle.id}`);
    return e;
  }
}
