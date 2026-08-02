/** #73 — hand-authored string-vocabulary fields warn once on an unrecognised value instead
 *  of silently falling through. Each site here preserves EXACTLY today's fallback behaviour
 *  (that's the policy — see the issue); these tests assert (a) a bad value warns exactly
 *  once even across repeated calls, (b) a legitimate value never warns, and (c) the
 *  resulting behaviour is unchanged from before #73. */

import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { Joint2D } from '../../src/runtime/traits/Joint2D';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';

import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { Joint3D } from '../../src/runtime/traits/Joint3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/physics/physics3DSystem';
import { initRapier3D } from '../../src/runtime/physics/rapier3DLoader';

import { computeCanvasScale } from '../../src/runtime/rendering/canvas2DScaler';

import { CpuParticleSim, type ParticleOutputs } from '../../src/runtime/particles/cpuSimulator';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';
import { resolveCollider, collide, type CollisionHit } from '../../src/runtime/particles/colliders';
import type { CollisionConfig } from '../../src/runtime/particles/types';

import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { loadTexture3D, disposeAllSharedTextures } from '../../src/runtime/loaders/textureResolver';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

import { warnVocabOnce } from '../../src/runtime/core/warnVocab';

// ── shared helper ──

describe('warnVocabOnce', () => {
  it('warns exactly once per scope|field|value, across repeated calls', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnVocabOnce('testscope', 'Test.field', 'bogus1', "treated as 'x'");
    warnVocabOnce('testscope', 'Test.field', 'bogus1', "treated as 'x'");
    warnVocabOnce('testscope', 'Test.field', 'bogus1', "treated as 'x'");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('testscope');
    expect(spy.mock.calls[0][0]).toContain('Test.field');
    expect(spy.mock.calls[0][0]).toContain('bogus1');
    spy.mockRestore();
  });

  it('warns again for a DIFFERENT bad value on the same scope/field', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnVocabOnce('testscope2', 'Test.field', 'bogusA', 'x');
    warnVocabOnce('testscope2', 'Test.field', 'bogusB', 'x');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

// ── 1/2: RigidBody2D/3D.bodyType ──

describe('RigidBody2D.bodyType — unrecognised value', () => {
  beforeAll(async () => { await initRapier2D(); });
  let tw: TestWorld | undefined;
  afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

  // NOTE on the assertion below: `createBody` takes the `dynamic()` branch for a typo'd
  // bodyType (confirmed: this test warns "treated as 'dynamic'"), but a PRE-EXISTING,
  // separate quirk (`BodyRec.bodyType` caches the RAW authored string, and the Rapier→ECS
  // pull-back gate checks `rec.bodyType !== 'dynamic'` literally) means the Transform is
  // never pulled back for anything other than the exact string 'dynamic' — so a typo'd
  // value is physically dynamic in Rapier but reads as FROZEN in the ECS Transform. That
  // is today's real effective behaviour (verified by running this scenario before adding
  // the warn), not "falls like a normal dynamic body" as the fallback's else-branch alone
  // would suggest — #73's policy is to preserve it exactly, not to fix it here.
  it('warns once; Transform stays frozen (the pre-existing bodyType-cache quirk), unchanged from before #73', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ systems: [{ name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    const box = tw.spawn(
      Transform({ x: 0, y: -500 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RigidBody2D({ bodyType: 'statc' as any }),
      Collider2D({ shape: 'box', halfW: 25, halfH: 25 }),
    );
    tw.step(30);
    tw.step(30); // second reconcile pass — sig unchanged, body not rebuilt, no re-warn
    const tf = tw.trait<{ y: number }>(Transform, box);
    expect(tf.y).toBe(-500); // frozen — matches today's pre-existing behaviour exactly
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('RigidBody2D.bodyType'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('statc');
    spy.mockRestore();
  });

  it('a legitimate "dynamic" value never warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ systems: [{ name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: -500 }), RigidBody2D({ bodyType: 'dynamic' }), Collider2D({ shape: 'box', halfW: 25, halfH: 25 }));
    tw.step(10);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('RigidBody2D.bodyType'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });
});

describe('RigidBody3D.bodyType — unrecognised value', () => {
  beforeAll(async () => { await initRapier3D(); });
  let tw: TestWorld | undefined;
  afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

  // Same pre-existing bodyType-cache quirk as the 2D case above (physics3DSystem.ts:881
  // gates the pull-back on `rec.bodyType !== 'dynamic'` against the raw authored string).
  it('warns once; Transform stays frozen (the pre-existing bodyType-cache quirk), unchanged from before #73', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ systems: [{ name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
    const box = tw.spawn(
      Transform({ x: 0, y: 10, z: 0 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RigidBody3D({ bodyType: 'statc' as any }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );
    tw.step(30);
    const tf = tw.trait<{ y: number }>(Transform, box);
    expect(tf.y).toBe(10); // frozen — matches today's pre-existing behaviour exactly
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('RigidBody3D.bodyType'));
    expect(warns.length).toBe(1);
    spy.mockRestore();
  });
});

// ── 6: Joint2D/3D.type ──

describe('Joint2D.type — unrecognised value', () => {
  beforeAll(async () => { await initRapier2D(); });
  let tw: TestWorld | undefined;
  afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

  it('warns once; no joint is created (matches the existing silent `default: return`)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ systems: [{ name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    tw.spawn(EntityAttributes({ guid: 'anchor' }), Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }), Collider2D({ shape: 'circle', radius: 10 }));
    const bob = tw.spawn(EntityAttributes({ guid: 'bob' }), Transform({ x: 0, y: 50 }), RigidBody2D({ bodyType: 'dynamic' }), Collider2D({ shape: 'circle', radius: 10 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tw.spawn(Joint2D({ type: 'sprung' as any, entityA: 'anchor', entityB: 'bob', length: 20 }));
    tw.step(60);
    tw.step(60); // reconcile again — dedup means still one warn
    const tf = tw.trait<{ y: number }>(Transform, bob);
    expect(tf.y).toBeGreaterThan(50); // fell freely — unconstrained, exactly as the silent `return` behaved
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('Joint2D.type'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('sprung');
    spy.mockRestore();
  });
});

describe('Joint3D.type — unrecognised value', () => {
  beforeAll(async () => { await initRapier3D(); });
  let tw: TestWorld | undefined;
  afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

  it('warns once; no joint is created (matches the existing silent `default: return`)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ systems: [{ name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    tw.spawn(EntityAttributes({ guid: 'anchor' }), Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }));
    const bob = tw.spawn(EntityAttributes({ guid: 'bob' }), Transform({ x: 0, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }), Collider3D({ shape: 'sphere', radius: 0.3 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tw.spawn(Joint3D({ type: 'sprung' as any, entityA: 'anchor', entityB: 'bob', length: 2 }));
    tw.step(60);
    const tf = tw.trait<{ y: number }>(Transform, bob);
    expect(tf.y).toBeLessThan(5); // fell freely — unconstrained, exactly as the silent `return` behaved
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('Joint3D.type'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('sprung');
    spy.mockRestore();
  });
});

// ── 5: Canvas2D.scaleMode ──

describe('computeCanvasScale — unrecognised scaleMode', () => {
  it('warns once and behaves exactly like "none" (1:1, centered)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = computeCanvasScale(800, 600, 1600, 900, 'stretch' as any);
    const none = computeCanvasScale(800, 600, 1600, 900, 'none');
    expect(bad).toEqual(none);
    computeCanvasScale(800, 600, 1600, 900, 'stretch' as unknown as never); // repeat — still one warn
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('Canvas2D.scaleMode'));
    expect(warns.length).toBe(1);
    spy.mockRestore();
  });

  it('a legitimate "none" never warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    computeCanvasScale(800, 600, 1600, 900, 'none');
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('Canvas2D.scaleMode'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });
});

// ── 3 (CPU half): EmitterShape.type ──

function makeOutputs(max: number): ParticleOutputs {
  return {
    offsets: new Float32Array(max * 3),
    scales: new Float32Array(max),
    colors: new Float32Array(max * 3),
    opacities: new Float32Array(max),
    rotations: new Float32Array(max),
    frames: new Float32Array(max),
  };
}

describe('CpuParticleSim — unrecognised EmitterShape.type', () => {
  it('warns once and spawns exactly like "point" (origin, +Y direction)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badDef = {
      ...defaultParticleEffect(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shape: { type: 'sperhe' as any },
      emission: { rateOverTime: 0 },
      startSpeed: { min: 0, max: 0 },
    } as ParticleEffectDef;
    const pointDef = { ...badDef, shape: { type: 'point' as const } } as ParticleEffectDef;

    const badOut = makeOutputs(4);
    const pointOut = makeOutputs(4);
    const badSim = new CpuParticleSim(badDef, badOut, 1);
    const pointSim = new CpuParticleSim(pointDef, pointOut, 1);
    badSim.injectAt(0, 0, 0);
    pointSim.injectAt(0, 0, 0);
    badSim.step(0); pointSim.step(0); // flush internal state to the shared `out` buffers
    expect(badOut.offsets.slice(0, 3)).toEqual(pointOut.offsets.slice(0, 3));

    badSim.injectAt(0, 0, 0); // repeat — still one warn
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('EmitterShape.type'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('sperhe');
    spy.mockRestore();
  });

  it('a legitimate "point" shape never warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = {
      ...defaultParticleEffect(),
      shape: { type: 'point' as const },
      emission: { rateOverTime: 0 },
    } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, makeOutputs(4), 1);
    sim.injectAt(0, 0, 0);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('EmitterShape.type'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });
});

// ── 4: particle CollisionConfig.shape ──

describe('particle CollisionConfig.shape — unrecognised value', () => {
  it('warns once and collides exactly like a solid "box"', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badCfg = { mode: 'bounce', bounce: 1, shape: 'shpere' as any, width: 2, height: 2, depth: 2 } as CollisionConfig;
    const boxCfg: CollisionConfig = { mode: 'bounce', bounce: 1, shape: 'box', width: 2, height: 2, depth: 2 };
    const rcBad = resolveCollider(badCfg);
    const rcBox = resolveCollider(boxCfg);
    const outBad: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const outBox: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const hitBad = collide(rcBad, 5, 0, 0, -1, 0, 0, 1, outBad); // outside +X face
    const hitBox = collide(rcBox, 5, 0, 0, -1, 0, 0, 1, outBox);
    expect(hitBad).toBe(hitBox);
    expect(outBad).toEqual(outBox);

    collide(rcBad, 5, 0, 0, -1, 0, 0, 1, outBad); // repeat — still one warn
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('CollisionConfig.shape'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('shpere');
    spy.mockRestore();
  });

  it('a legitimate "box" shape never warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg: CollisionConfig = { mode: 'bounce', bounce: 1, shape: 'box', width: 2, height: 2, depth: 2 };
    const rc = resolveCollider(cfg);
    const out: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    collide(rc, 5, 0, 0, -1, 0, 0, 1, out);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('CollisionConfig.shape'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });
});

// ── 7/8: texture wrapS/wrapT/colorspace ──

describe('texture wrapS/wrapT/colorspace — unrecognised value', () => {
  const GUID = '22222222-2222-4222-8222-222222222222';
  const PATH = '/games/g/assets/tex/bad.png';
  let loadAsyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearManifest();
    loadAsyncSpy = vi.spyOn(THREE.Loader.prototype, 'loadAsync').mockImplementation(async () => new THREE.Texture() as never);
  });
  afterEach(() => { disposeAllSharedTextures(); loadAsyncSpy.mockRestore(); });

  it('unrecognised wrapS warns once and leaves wrapS unset, same as before #73', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, PATH, 'texture', {
      ...DEFAULT_TEXTURE_SETTINGS, format: 'png',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapS: 'reapeat' as any,
    });
    const tex = await loadTexture3D(GUID);
    expect(tex.wrapS).toBeUndefined(); // preserved fallthrough — NOT three's own ClampToEdgeWrapping default
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('wrapS'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('reapeat');
    spy.mockRestore();
  });

  it('a legitimate wrapS value never warns', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', wrapS: 'clamp' });
    const tex = await loadTexture3D(GUID);
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('wrapS'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });

  it('unrecognised colorspace warns once and still resolves to SRGBColorSpace (today\'s fallback)', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, PATH, 'texture', {
      ...DEFAULT_TEXTURE_SETTINGS, format: 'png',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      colorspace: 'linaer' as any,
    });
    const tex = await loadTexture3D(GUID);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('colorspace'));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain('linaer');
    spy.mockRestore();
  });

  it('a legitimate "srgb" colorspace never warns', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', colorspace: 'srgb' });
    const tex = await loadTexture3D(GUID);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('colorspace'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });

  it('a legitimate "linear" colorspace never warns', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', colorspace: 'linear' });
    const tex = await loadTexture3D(GUID);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes('colorspace'));
    expect(warns.length).toBe(0);
    spy.mockRestore();
  });
});
