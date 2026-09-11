/**
 * #993 close-out § 2d, #1069 — the CALL SITES, not the helpers.
 *
 * ⚠️ This file exists because of a measured hole, and the hole is the whole point of it.
 * `vocabTableProtoKeys.test.ts` covers `resolveBus`, `resolveCollisionMode`, `resolveColliderShape`
 * and the rest as PURE FUNCTIONS — and a review reverted all seven lines that actually *call* them
 * back to their pre-fix form and the whole package suite still passed. Every helper was proven;
 * every wiring line could have been deleted. The commit that fixed three of them then reproduced
 * the defect on the six wiring lines IT wrote (#1069), which is why the rest are here too.
 *
 * That is the fourth instance of one pattern in this change: *the asserted observable is produced
 * by something other than the line under test.* The first three were WebIDL coercing a function to
 * 0 inside `new PointerEvent`, a ref reported as a GUID rather than a path, and a unit read in two
 * places where the probe reached one.
 *
 * So every test here drives a PUBLIC entry point and asserts on an observable that only the wiring
 * can produce. If a block can pass with its call site reverted, it does not belong in this file.
 *
 * Two of #1069's lines are BUILD-time plugins, handled beside their own suites instead:
 * `engine/tests/plugins/detectModules.test.ts` covers its call site, and
 * `engine/tests/plugins/threeAdapter.test.ts` pins why its call site is UNREACHABLE today
 * (gltf-transform's reader throws on a prototype-named semantic first — measured, so there is no
 * behaviour to test). The pending-cue journal emission needs a real-decoder mock, so it lives in
 * `audioCueRetry.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';

import {
  setAudioRecordMode, clearAudioLog, getAudioLog, play, type BusName,
} from '../../src/runtime/audio/audioService';
import { audioSystem, stopWorldAudio } from '../../src/runtime/audio/audioSystem';
import { cueClip, cueSound } from '../../src/runtime/audio/audioCues';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { AudioSettings } from '../../src/runtime/traits/AudioSettings';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
import { journalEvents, clearJournal } from '../../src/runtime/core/journal';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { buildEntityCreateSpecs } from '../../src/runtime/scene/entityCreateSpecs';
import { defaultParticleEffect, type ParticleEffectDef, type CollisionConfig } from '../../src/runtime/particles/types';
import { CpuParticleSim } from '../../src/runtime/particles/cpuSimulator';
import { normalizeParticleDef } from '../../src/runtime/loaders/particleCache';
import { collide, resolveCollider, type ResolvedCollider, type CollisionHit } from '../../src/runtime/particles/colliders';

// ── audioService.play — the record log reports the RESOLVED bus ───────────────────────────────

describe('play() routes AudioSource.bus through resolveBus (#993 § 2d wiring)', () => {
  beforeEach(() => { setAudioRecordMode(true); clearAudioLog(); });
  afterEach(() => { setAudioRecordMode(false); clearAudioLog(); });

  it('a prototype-named bus is logged as sfx, not echoed back', () => {
    // Reverting the call site to `spec.bus ?? 'sfx'` makes this read 'constructor'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play({ clip: 'c', bus: 'constructor' as any });
    expect((getAudioLog()[0] as { bus?: string }).bus).toBe('sfx');
  });

  it('an ordinary typo is logged as sfx too — the harness must agree with the graph', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play({ clip: 'c', bus: 'Music' as any });
    expect((getAudioLog()[0] as { bus?: string }).bus).toBe('sfx');
  });

  it('ACCEPT: a real bus is logged as itself, and an absent one as sfx', () => {
    play({ clip: 'a', bus: 'music' });
    play({ clip: 'b', bus: 'ui' });
    play({ clip: 'c' });
    expect(getAudioLog().map((e) => (e as { bus?: string }).bus)).toEqual(['music', 'ui', 'sfx']);
  });
});

// ── audioSystem — the voice cap and the journal decide from the RESOLVED bus (#1069) ──────────

describe('audioSystem reads the RESOLVED bus for the voice cap and the journal (#1069)', () => {
  let world: World | undefined;
  const prevState = getPlayState();
  const mintClip = (): string => {
    const guid = newGuid();
    registerAsset(guid, `/games/x/assets/audio/${guid}.mp3`, 'audio');
    return guid;
  };
  const events = () =>
    journalEvents({ type: '@audio' }, world!).map((e) => e.payload as { phase: string; clip?: string; bus?: string });
  const startBuses = (clip: string) => events().filter((p) => p.phase === 'start' && p.clip === clip).map((p) => p.bus);
  // The trait field and the cue option are both typed as the union — the value that arrives from a
  // scene file is not, which is the whole defect class.
  const typo = (s: string) => s as BusName;

  beforeEach(() => {
    setAudioRecordMode(true);
    clearAudioLog();
    setPlayState('playing');
    world = createWorld();
    setCurrentWorld(world);
    clearJournal(world);
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // resolveBus warns the typo by name
  });
  afterEach(() => {
    // destroy(), not just drop the reference — koota hard-caps at 16 live worlds.
    if (world) { stopWorldAudio(world); world.destroy(); }
    world = undefined;
    vi.restoreAllMocks();
    setAudioRecordMode(false);
    clearAudioLog();
    clearManifest();
    setPlayState(prevState);
  });

  it("a typo'd sfx bus is COUNTED against sfxVoiceLimit — playOneShot's cap decision", () => {
    // Reverting `resolveBus(spec.bus)` to the raw field makes 'Sfx' !== 'sfx', so the cap is skipped
    // and nothing is ever stolen — while both shots still PLAY on the sfx bus. The accept side (a
    // real music/ui bus is never capped) is already pinned in audioJournal.test.ts.
    world!.spawn(AudioSettings({ sfxVoiceLimit: 1 }));
    const [a, b] = [mintClip(), mintClip()];
    cueClip(a, { bus: typo('Sfx') }, world!);
    cueClip(b, { bus: typo('Sfx') }, world!);
    audioSystem(world!);
    expect(events().filter((p) => p.phase === 'stolen').map((p) => p.clip)).toEqual([a]);
  });

  it('a clip cue journals the resolved bus — playCues, fresh cue', () => {
    const clip = mintClip();
    cueClip(clip, { bus: typo('constructor') }, world!);
    audioSystem(world!);
    expect(startBuses(clip)).toEqual(['sfx']);
  });

  it('a named cue journals the resolved bus of the AudioSource it fans out to', () => {
    const clip = mintClip();
    world!.spawn(AudioSource({ clip, playOnCue: 'hit', bus: typo('constructor') }), EntityAttributes({ guid: newGuid() }));
    cueSound('hit', world!);
    audioSystem(world!);
    expect(startBuses(clip)).toEqual(['sfx']);
  });

  it("an AudioSource's own playback journals the resolved bus — startOrSwap", () => {
    const clip = mintClip();
    world!.spawn(AudioSource({ clip, autoplay: true, bus: typo('constructor') }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);
    expect(startBuses(clip)).toEqual(['sfx']);
  });

  it('ACCEPT: a real bus is journalled as itself on all three paths', () => {
    // Without this, a call site that journalled a constant 'sfx' would pass every case above.
    const [cue, named, own] = [mintClip(), mintClip(), mintClip()];
    cueClip(cue, { bus: 'ui' }, world!);
    world!.spawn(AudioSource({ clip: named, playOnCue: 'hit', bus: 'music' }), EntityAttributes({ guid: newGuid() }));
    cueSound('hit', world!);
    world!.spawn(AudioSource({ clip: own, autoplay: true, bus: 'music' }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);
    expect([startBuses(cue), startBuses(named), startBuses(own)]).toEqual([['ui'], ['music'], ['music']]);
  });
});

// ── entityCreateSpecs.lightSpecs — validate BEFORE cap(kind) ──────────────────────────────────

describe('lightSpecs refuses an absent light kind with the message, not a TypeError (#993 § 2d, #1069)', () => {
  it('{ kind: "light" } with no `light` field names the valid kinds', () => {
    // `vocabTableProtoKeys.test.ts` passes every prototype NAME, which reaches the refusal whatever
    // order the two lines are in. Only an ABSENT kind needs the refusal to run before
    // `cap(kind)` — reverted, this dies with "Cannot read properties of undefined (reading 'charAt')".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildEntityCreateSpecs({ kind: 'light' } as any, 0)).toThrow(/unknown light kind "undefined" — nothing was created\. Valid: /);
  });
});

// ── CpuParticleSim — collision.mode through resolveCollisionMode ──────────────────────────────

describe('CpuParticleSim routes collision.mode through resolveCollisionMode (#993 review, #1069)', () => {
  /** Where a particle dropped from y=5 onto a floor plane at y=0 ends up after 4 simulated seconds.
   *
   *  ⚠️ `gravity` is an ARRAY on purpose. `resolveGravity` (particles/simSpec.ts) takes
   *  `number | [x,y,z]` and resolves any other shape to ZERO — the first attempt at this test used
   *  `{x,y,z}`, the particle never moved, and a particle that never falls cannot tell a collision
   *  from no collision. That attempt was abandoned rather than committed green (#1069). */
  function finalY(mode: string): number {
    const base = defaultParticleEffect();
    const def = {
      ...base,
      maxParticles: 1,
      gravity: [0, -10, 0],
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      shape: { type: 'point' },
      emission: { ...base.emission, rateOverTime: 0, fillPool: false },
      collision: { mode, bounce: 1, shape: 'plane', planePoint: [0, 0, 0], planeNormal: [0, 1, 0] },
    } as unknown as ParticleEffectDef;
    const out = {
      offsets: new Float32Array(3), scales: new Float32Array(1), colors: new Float32Array(3),
      opacities: new Float32Array(1), rotations: new Float32Array(1), frames: new Float32Array(1),
    };
    const sim = new CpuParticleSim(def, out, 1);
    expect(sim.injectAt(0, 5, 0)).toBe(true);
    for (let i = 0; i < 240; i++) sim.step(1 / 60);
    return out.offsets[1];
  }

  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the fixture can tell a collision from none — bounce stays above the floor, none falls through', () => {
    // This is what makes the case below evidence. Free fall for 4s from y=5 at g=10 ends near y=-75.
    expect(finalY('bounce')).toBeGreaterThan(-0.5);
    expect(finalY('none')).toBeLessThan(-20);
  });

  it("a typo'd mode falls THROUGH the floor, as the GPU backend does — it does not bounce", () => {
    // Reverting the call site to the raw `coll.mode` makes 'bounse' !== 'none', so the collider is
    // built, no `=== 'kill'` branch matches, and the particle bounces — the CPU/GPU split #993 closed.
    expect(finalY('bounse')).toBeLessThan(-20);
  });
});

// ── particleCache.normalizeParticleDef — the seam the INSPECTOR shares ────────────────────────

describe('normalizeParticleDef normalises collision.shape (#993 § 2d wiring)', () => {
  const shapeOf = (collision: unknown): string | undefined =>
    normalizeParticleDef({ collision } as Partial<ParticleEffectDef>).collision?.shape;

  it.each(['constructor', 'toString', 'spere'])('shape %s is normalised to plane before the Inspector sees it', (shape) => {
    // Unnormalised, the Shape dropdown shows a value absent from its own options AND every
    // geometry block (`shape === 'plane'`, …) is ===-guarded, so the author can see neither the
    // typo nor the collider the runtime is simulating.
    expect(shapeOf({ mode: 'bounce', bounce: 1, shape })).toBe('plane');
  });

  it('ACCEPT: a real shape survives, and the LEGACY planeY migration still runs', () => {
    expect(shapeOf({ mode: 'bounce', bounce: 1, shape: 'sphere' })).toBe('sphere');
    const legacy = normalizeParticleDef({
      collision: { mode: 'bounce', bounce: 1, planeY: 3 },
    } as unknown as Partial<ParticleEffectDef>).collision;
    expect(legacy?.shape).toBe('plane');
    expect(legacy?.planePoint).toEqual([0, 3, 0]);
  });
});

// ── colliders.collide — the else-branch guard, which is DEAD until a member is added ──────────

describe('collide() names a shape with no CPU math (#993 § 2d)', () => {
  it('warns when a ResolvedCollider carries a shape this chain cannot handle', () => {
    // ⚠️ Unreachable today BY CONSTRUCTION — `resolveColliderShape` makes every `ResolvedCollider`
    // carry a real member, and plane/sphere/cylinder/inverted-box all return earlier. The guard is
    // for the case it names: a shape ADDED to COLLIDER_SHAPES with no CPU math written. The GPU's
    // `Record<ColliderShape, number>` fails to COMPILE for that; this if/else chain would silently
    // run solid-box math. Constructing the state by hand is the only way to test it, and without
    // this the guard is a comment.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rc: ResolvedCollider = {
      ...resolveCollider({ mode: 'bounce', bounce: 1, shape: 'box', width: 2, height: 2, depth: 2 } as CollisionConfig),
      shape: 'capsule' as unknown as ResolvedCollider['shape'],
    };
    const out: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const hit = collide(rc, 0, -0.5, 0, 0, -1, 0, 1, out);
    expect(hit).toBe(true);                       // it DID fall through to box math
    expect(out.y).toBe(-1);                       // …the box's -Y face, i.e. exactly box math
    const msgs = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('CollisionConfig.shape'));
    expect(msgs.length).toBe(1);
    expect(String(msgs[0][0])).toContain('no CPU collider math');
    warn.mockRestore();
  });

  it('ACCEPT: a real box does NOT warn — the guard is not just always-on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'box', width: 2, height: 2, depth: 2 } as CollisionConfig);
    const out: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    collide(rc, 0, -0.5, 0, 0, -1, 0, 1, out);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('CollisionConfig.shape')).length).toBe(0);
    warn.mockRestore();
  });
});
