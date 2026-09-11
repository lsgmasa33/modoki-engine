/**
 * #993 close-out § 2d — the CALL SITES, not the helpers.
 *
 * ⚠️ This file exists because of a measured hole, and the hole is the whole point of it.
 * `vocabTableProtoKeys.test.ts` covers `resolveBus`, `resolveCollisionMode`, `resolveColliderShape`
 * and the rest as PURE FUNCTIONS — and a review reverted all seven lines that actually *call* them
 * back to their pre-fix form and the package suite still reported **763/763 files, 11337/11337
 * tests passing**. Every helper was proven; every wiring line could have been deleted.
 *
 * That is the fourth instance of one pattern in this change: *the asserted observable is produced
 * by something other than the line under test.* The first three were WebIDL coercing a function to
 * 0 inside `new PointerEvent`, a ref reported as a GUID rather than a path, and a unit read in two
 * places where the probe reached one.
 *
 * So every test here drives a PUBLIC entry point and asserts on an observable that only the wiring
 * can produce. If a block can pass with its call site reverted, it does not belong in this file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  setAudioRecordMode, clearAudioLog, getAudioLog, play,
} from '../../src/runtime/audio/audioService';
import { type ParticleEffectDef, type CollisionConfig } from '../../src/runtime/particles/types';
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

// ⚠️ NOT COVERED HERE, and it is the one that matters most: `cpuSimulator.ts`'s
// `resolveCollisionMode(coll?.mode)` call site. The behavioural assertion is "a typo'd mode makes
// the particle fall THROUGH the plane (GPU behaviour) rather than bounce (the old CPU
// behaviour)" — but a fixture built from `defaultParticleEffect()` with
// `gravity: {x:0,y:-10,z:0}` does not move the particle at all: measured, y stays at its injected
// 5 for 240 steps across `none`/`bounce`/`bounse` alike. `resolveGravity(def.gravity, …)`
// (simSpec.ts) evidently wants a different shape, and a fixture that cannot make the particle
// FALL cannot tell a collision from no collision — which is exactly the class of vacuous test
// this file exists to stop. Pinned as follow-up rather than committed green-and-meaningless.

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
