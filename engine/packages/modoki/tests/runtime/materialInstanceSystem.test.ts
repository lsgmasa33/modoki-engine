/** materialInstanceSystem — drives MaterialInstance parameter overrides into an
 *  entity's live objects (uniform → object.userData). The material broker is mocked
 *  so the system runs headless without a real renderer; we assert on the fake
 *  object's userData. Time comes from the REAL Time trait via getVisualDelta, so
 *  pause/timeScale gating is exercised too. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/traits/Time';
import { MaterialInstance, type MaterialParamOverride } from '../../src/runtime/traits/MaterialInstance';
import { Renderable3DPrimitive } from '../../src/runtime/traits/Renderable3DPrimitive';
import { setPlayState } from '../../src/runtime/systems/playState';

// entity.id() → its fake drawable objects. The system reads this through the broker.
const fakeObjects = new Map<number, { userData: Record<string, unknown>; material?: unknown }[]>();
vi.mock('../../src/runtime/rendering/materialBroker', () => ({
  getEntityObjects: (_w: unknown, id: number) => fakeObjects.get(id) ?? [],
}));
// The prop path resolves the base material from the entity's GUID via meshTemplateCache —
// mock it to hand back a per-GUID fake base (a clone-able stub).
const fakeBases = new Map<string, unknown>();
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  resolveMaterial: (guid: string) => fakeBases.get(guid),
}));
// onWorldSwap is a lightweight callback registry; keep the real one (the system
// registers a clock-clear on it at import) — no THREE pulled in.

import { materialInstanceSystem, resetMaterialInstanceClocks } from '../../src/runtime/systems/materialInstanceSystem';
import { resetMaterialInstanceClones } from '../../src/runtime/rendering/materialInstanceClones';
import { registerReadSource, __resetReadSourcesForTesting } from '../../src/runtime/ui/readSourceRegistry';
import { register2DMaterialShaderMap, isEntity2DMaterialDirty } from '../../src/runtime/rendering/sprite2DMaterialBroker';

// koota caps at 16 live worlds/process — track and destroy each test's world.
const _worlds: ReturnType<typeof createWorld>[] = [];
function newWorld() {
  const w = createWorld();
  _worlds.push(w);
  return w;
}

function spawnTime(world: ReturnType<typeof createWorld>, smoothedDelta = 0.5, timeScale = 1) {
  return world.spawn(Time({ smoothedDelta, delta: smoothedDelta, timeScale }));
}

function attach(world: ReturnType<typeof createWorld>, overrides: MaterialParamOverride[]) {
  const e = world.spawn(MaterialInstance({ overrides }));
  const obj = { userData: {} as Record<string, unknown> };
  fakeObjects.set(e.id(), [obj]);
  return { e, obj };
}

/** A minimal stand-in for a THREE.Mesh whose `.material` is a clone-able stub —
 *  enough to exercise the prop clone path without a real renderer. */
function makeMaterial(props: Record<string, unknown> = {}) {
  const mat: Record<string, unknown> = { opacity: 1, transparent: false, dispose: () => {}, ...props };
  mat.clone = () => makeMaterial({ ...mat });
  return mat;
}
function meshWith(material: unknown) {
  return { material, userData: {} as Record<string, unknown> };
}

/** Spawn an entity with a MaterialInstance + a Renderable3DPrimitive material GUID, register
 *  its fake mesh(es), and register the resolvable base material for that GUID. */
let _guidSeq = 0;
function attachProp(
  world: ReturnType<typeof createWorld>,
  overrides: MaterialParamOverride[],
  baseProps: Record<string, unknown> = {},
  meshCount = 1,
) {
  const guid = `mat-${++_guidSeq}`;
  const base = makeMaterial(baseProps);
  fakeBases.set(guid, base);
  const e = world.spawn(MaterialInstance({ overrides }), Renderable3DPrimitive({ material: guid }));
  const meshes = Array.from({ length: meshCount }, () => meshWith(base));
  fakeObjects.set(e.id(), meshes);
  return { e, base, meshes };
}

beforeEach(() => {
  setPlayState('playing');
  fakeObjects.clear();
  fakeBases.clear();
  resetMaterialInstanceClocks();
  resetMaterialInstanceClones();
  __resetReadSourcesForTesting();
});
afterEach(() => {
  setPlayState('playing');
  for (const w of _worlds) w.destroy();
  _worlds.length = 0;
});

describe('materialInstanceSystem', () => {
  it('writes a constant uniform override to object.userData', () => {
    const world = newWorld();
    spawnTime(world);
    const { obj } = attach(world, [{ target: 'glow', kind: 'uniform', source: { type: 'constant', value: 0.7 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.glow).toBeCloseTo(0.7, 9);
  });

  it('advances a time uniform by the visual delta each frame', () => {
    const world = newWorld();
    spawnTime(world, 0.5);
    const { obj } = attach(world, [{ target: 'stripeTime', kind: 'uniform', source: { type: 'time' } }]);
    materialInstanceSystem(world);
    expect(obj.userData.stripeTime).toBeCloseTo(0.5, 9);
    materialInstanceSystem(world);
    expect(obj.userData.stripeTime).toBeCloseTo(1.0, 9); // accumulates
  });

  it('applies the time source speed multiplier', () => {
    const world = newWorld();
    spawnTime(world, 0.5);
    const { obj } = attach(world, [{ target: 't', kind: 'uniform', source: { type: 'time', speed: 3 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.t).toBeCloseTo(1.5, 9); // clock 0.5 × speed 3
  });

  it('freezes the time clock while paused (delta 0)', () => {
    const world = newWorld();
    spawnTime(world, 0.5);
    const { obj } = attach(world, [{ target: 'stripeTime', kind: 'uniform', source: { type: 'time' } }]);
    materialInstanceSystem(world);
    expect(obj.userData.stripeTime).toBeCloseTo(0.5, 9);
    setPlayState('paused'); // getVisualDelta → 0
    materialInstanceSystem(world);
    expect(obj.userData.stripeTime).toBeCloseTo(0.5, 9); // unchanged — no coast
  });

  it('wraps the time clock to dodge the float32 cliff', () => {
    const world = newWorld();
    spawnTime(world, 6); // 6 s/frame
    const { obj } = attach(world, [{ target: 't', kind: 'uniform', source: { type: 'time', wrap: 10 } }]);
    materialInstanceSystem(world); // clock 6
    expect(obj.userData.t).toBeCloseTo(6, 9);
    materialInstanceSystem(world); // 12 % 10 = 2
    expect(obj.userData.t).toBeCloseTo(2, 9);
  });

  it('reads a store source live from the read-source registry (× scale)', () => {
    const world = newWorld();
    spawnTime(world);
    let live = 4;
    registerReadSource('hp', () => live);
    const { obj } = attach(world, [{ target: 'glow', kind: 'uniform', source: { type: 'store', key: 'hp', scale: 0.25 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.glow).toBeCloseTo(1.0, 9); // 4 × 0.25
    live = 8;                                       // store changes
    materialInstanceSystem(world);
    expect(obj.userData.glow).toBeCloseTo(2.0, 9); // reads live each frame
  });

  it('falls back to a store source default when the key is absent or non-numeric', () => {
    const world = newWorld();
    spawnTime(world);
    registerReadSource('label', () => 'not-a-number');
    const { obj } = attach(world, [{ target: 'x', kind: 'uniform', source: { type: 'store', key: 'label', default: 0.5 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(0.5, 9);
  });

  it('returns the LITERAL store default (scale NOT applied to the fallback)', () => {
    const world = newWorld();
    spawnTime(world);
    // key 'missing' is unregistered → fallback. default 5, scale 0.1 → must be 5, not 0.5.
    const { obj } = attach(world, [{ target: 'x', kind: 'uniform', source: { type: 'store', key: 'missing', default: 5, scale: 0.1 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(5, 9);
  });

  it('coerces a boolean store reading to 0/1 AND applies scale (a real reading)', () => {
    const world = newWorld();
    spawnTime(world);
    let flag = true;
    registerReadSource('flag', () => flag);
    // A boolean IS a real reading → coerced (true→1) and multiplied by scale (×2 → 2).
    const { obj } = attach(world, [{ target: 'x', kind: 'uniform', source: { type: 'store', key: 'flag', scale: 2 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(2, 9); // true → 1 × 2
    flag = false;
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(0, 9); // false → 0 × 2
  });

  it('a NaN store reading falls back to the LITERAL default (unscaled) — same as an absent key', () => {
    const world = newWorld();
    spawnTime(world);
    // A NON-FINITE number (NaN) is NOT a real reading, so it returns the literal default (5),
    // NOT default×scale (0.5). This matches the absent-key path — the "default is never scaled"
    // contract holds for any non-reading, whether the key is missing or reads NaN/Infinity.
    registerReadSource('n', () => NaN);
    const { obj } = attach(world, [{ target: 'x', kind: 'uniform', source: { type: 'store', key: 'n', default: 5, scale: 0.1 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(5, 9); // NOT 0.5
  });

  it('an Infinity store reading also falls back to the LITERAL default (unscaled)', () => {
    const world = newWorld();
    spawnTime(world);
    registerReadSource('inf', () => Infinity);
    const { obj } = attach(world, [{ target: 'x', kind: 'uniform', source: { type: 'store', key: 'inf', default: 5, scale: 0.1 } }]);
    materialInstanceSystem(world);
    expect(obj.userData.x).toBeCloseTo(5, 9); // literal default, not scaled
  });

  it('does not crash the frame on a malformed curve (missing driver or points)', () => {
    const world = newWorld();
    spawnTime(world);
    const { obj } = attach(world, [
      { target: 'a', kind: 'uniform', source: { type: 'curve', points: [{ t: 0, v: 1 }] } as unknown as MaterialParamOverride['source'] }, // no driver
      { target: 'b', kind: 'uniform', source: { type: 'curve', driver: { type: 'constant', value: 0.5 } } as unknown as MaterialParamOverride['source'] }, // no points
      { target: 'c', kind: 'uniform', source: { type: 'constant', value: 7 } }, // valid — must still run
    ]);
    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(obj.userData.a).toBe(0);  // degraded to 0, not a crash
    expect(obj.userData.b).toBe(0);
    expect(obj.userData.c).toBeCloseTo(7, 9); // sibling override unaffected
  });

  it('samples a curve source by its driver value', () => {
    const world = newWorld();
    spawnTime(world);
    // Curve maps t∈[0,1]: 0→0, 1→10. Driver is a constant 0.5 → mid → 5.
    const { obj } = attach(world, [{
      target: 'r', kind: 'uniform',
      source: { type: 'curve', points: [{ t: 0, v: 0 }, { t: 1, v: 10 }], driver: { type: 'constant', value: 0.5 } },
    }]);
    materialInstanceSystem(world);
    expect(obj.userData.r).toBeCloseTo(5, 9);
  });

  it('loops a curve with a wrap:1 time driver (sawtooth 0..1)', () => {
    const world = newWorld();
    spawnTime(world, 0.3); // 0.3 s/frame
    const { obj } = attach(world, [{
      target: 'r', kind: 'uniform',
      source: { type: 'curve', points: [{ t: 0, v: 0 }, { t: 1, v: 1 }], driver: { type: 'time', wrap: 1 } },
    }]);
    materialInstanceSystem(world); // driver clock 0.3 → curve → 0.3
    expect(obj.userData.r).toBeCloseTo(0.3, 6);
    materialInstanceSystem(world); // 0.6
    expect(obj.userData.r).toBeCloseTo(0.6, 6);
    materialInstanceSystem(world); // 0.9
    expect(obj.userData.r).toBeCloseTo(0.9, 6);
    materialInstanceSystem(world); // 1.2 % 1 = 0.2 (wrapped)
    expect(obj.userData.r).toBeCloseTo(0.2, 6);
  });

  it('binds a per-entity clone (from the resolved GUID base) and writes a prop onto it', () => {
    const world = newWorld();
    spawnTime(world);
    const { base, meshes: [mesh] } = attachProp(world, [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }], { opacity: 1 });
    materialInstanceSystem(world);
    expect(mesh.material).not.toBe(base);          // swapped to a clone
    expect((mesh.material as { opacity: number }).opacity).toBeCloseTo(0.5, 9);
    expect((mesh.material as { transparent: boolean }).transparent).toBe(true); // <1 → blending on
    expect(base.opacity).toBe(1);                  // shared base untouched
  });

  it('SKIPS a prop on a single default-material primitive (no GUID — unsupported, leak-prone) and warns once', () => {
    const world = newWorld();
    spawnTime(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeMaterial({ roughness: 0.5 });
    const mesh = meshWith(base);
    // Renderable3DPrimitive with an EMPTY material GUID → single default material → NOT a valid base.
    const e = world.spawn(
      MaterialInstance({ overrides: [{ target: 'roughness', kind: 'prop', source: { type: 'constant', value: 0.1 } }] }),
      Renderable3DPrimitive({ material: '' }),
    );
    fakeObjects.set(e.id(), [mesh]);
    materialInstanceSystem(world);
    expect(mesh.material).toBe(base);              // untouched — not cloned
    expect(base.roughness).toBe(0.5);             // base never mutated
    materialInstanceSystem(world);                // second frame: still skipped
    expect(mesh.material).toBe(base);
    if (import.meta.env?.DEV) expect(warn).toHaveBeenCalledTimes(1); // one warning per entity, not per frame
    warn.mockRestore();
  });

  it('drives a prop on a BAKED multi-material mesh (no GUID, material is an array → per-slot clones)', () => {
    const world = newWorld();
    spawnTime(world);
    const slotA = makeMaterial({ roughness: 0.5 });
    const slotB = makeMaterial({ roughness: 0.5 });
    const baked = [slotA, slotB];                 // baked array base, no GUID
    const mesh = meshWith(baked);
    const e = world.spawn(
      MaterialInstance({ overrides: [{ target: 'roughness', kind: 'prop', source: { type: 'constant', value: 0.1 } }] }),
      Renderable3DPrimitive({ material: '' }),
    );
    fakeObjects.set(e.id(), [mesh]);
    materialInstanceSystem(world);
    const clone = mesh.material as unknown[];
    expect(Array.isArray(clone)).toBe(true);
    expect(clone).not.toBe(baked);                // swapped to a per-slot clone array
    expect(clone[0]).not.toBe(slotA);
    expect((clone[0] as { roughness: number }).roughness).toBeCloseTo(0.1, 9); // every slot driven
    expect((clone[1] as { roughness: number }).roughness).toBeCloseTo(0.1, 9);
    expect(slotA.roughness).toBe(0.5);            // baked base untouched
    expect(slotB.roughness).toBe(0.5);
    // Stable across frames (cached array base, not re-read).
    materialInstanceSystem(world);
    expect(mesh.material).toBe(clone);
  });

  it('switching a prop base from a baked ARRAY to an explicit GUID re-clones from the single GUID base', () => {
    const world = newWorld();
    spawnTime(world);
    // Start with a baked multi-material array base (no GUID) — resolvePropBase caches the array.
    const slotA = makeMaterial({ opacity: 1 });
    const slotB = makeMaterial({ opacity: 1 });
    const mesh = meshWith([slotA, slotB]);
    const e = world.spawn(
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
      Renderable3DPrimitive({ material: '' }),
    );
    fakeObjects.set(e.id(), [mesh]);
    materialInstanceSystem(world);
    expect(Array.isArray(mesh.material)).toBe(true); // cloned as a per-slot array

    // Now give the entity an explicit, resolvable GUID material. resolvePropBase clears the cached
    // array (_defaultBaseCache) and re-clones from the SINGLE GUID base → a non-array clone.
    const guid = 'mat-guid-switch';
    fakeBases.set(guid, makeMaterial({ opacity: 1 }));
    e.set(Renderable3DPrimitive, { material: guid });
    materialInstanceSystem(world);
    expect(Array.isArray(mesh.material)).toBe(false); // single clone from the GUID base
    expect((mesh.material as { opacity: number }).opacity).toBeCloseTo(0.5, 9);
  });

  it('drives a prop from a time source and keeps ONE clone across frames', () => {
    const world = newWorld();
    spawnTime(world, 0.1);
    const { meshes: [mesh] } = attachProp(world, [{ target: 'roughness', kind: 'prop', source: { type: 'time' } }], { roughness: 0 });
    materialInstanceSystem(world);
    const clone = mesh.material;
    expect((clone as { roughness: number }).roughness).toBeCloseTo(0.1, 9);
    materialInstanceSystem(world);
    expect(mesh.material).toBe(clone);             // not re-cloned each frame
    expect((clone as { roughness: number }).roughness).toBeCloseTo(0.2, 9);
  });

  it('binds ONE clone across both surfaces for a prop override', () => {
    const world = newWorld();
    spawnTime(world);
    const { base, meshes: [a, b] } = attachProp(world, [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.25 } }], { opacity: 1 }, 2);
    materialInstanceSystem(world);
    expect(a.material).toBe(b.material);          // same single clone
    expect(a.material).not.toBe(base);
    expect((a.material as { opacity: number }).opacity).toBeCloseTo(0.25, 9);
  });

  it('applies a color prop as a packed hex via setHex', () => {
    const world = newWorld();
    spawnTime(world);
    let setTo = -1;
    attachProp(world, [{ target: 'color', kind: 'prop', source: { type: 'constant', value: 0xff8800 } }], { color: { setHex: (h: number) => { setTo = h; } } });
    materialInstanceSystem(world);
    expect(setTo).toBe(0xff8800);
  });

  it('skips a prop override when the material GUID is unresolved (async) — no clone, no throw', () => {
    const world = newWorld();
    spawnTime(world);
    // Spawn a prop entity but do NOT register a base for its GUID (resolveMaterial → undefined).
    const e = world.spawn(
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
      Renderable3DPrimitive({ material: 'unresolved-guid' }),
    );
    const mesh = meshWith(makeMaterial());
    fakeObjects.set(e.id(), [mesh]);
    const before = mesh.material;
    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(mesh.material).toBe(before);           // untouched until the base resolves
  });

  it('re-clones a prop entity when its resolved base changes (async load / ref swap)', () => {
    const world = newWorld();
    spawnTime(world);
    const { e, meshes: [mesh] } = attachProp(world, [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }], { opacity: 1 });
    materialInstanceSystem(world);
    const cloneA = mesh.material;
    // Point the entity's GUID at a NEW base (simulate a mat-ref swap / late resolve).
    const guid2 = 'mat-swapped';
    fakeBases.set(guid2, makeMaterial({ opacity: 1 }));
    e.set(Renderable3DPrimitive, { material: guid2 });
    materialInstanceSystem(world);
    expect(mesh.material).not.toBe(cloneA);       // fresh clone from the new base
    expect((mesh.material as { opacity: number }).opacity).toBeCloseTo(0.5, 9);
  });

  it('treats an override with omitted kind as a uniform (writes userData, no clone)', () => {
    const world = newWorld();
    spawnTime(world);
    const { base, meshes: [mesh] } = attachProp(world, [{ target: 'glow', source: { type: 'constant', value: 0.6 } } as MaterialParamOverride], { opacity: 1 });
    materialInstanceSystem(world);
    expect(mesh.userData.glow).toBeCloseTo(0.6, 9); // written as a uniform
    expect(mesh.material).toBe(base);               // NOT cloned (kind !== 'prop')
  });

  it('handles a mixed uniform + prop entity: userData set AND material cloned', () => {
    const world = newWorld();
    spawnTime(world);
    const { base, meshes: [mesh] } = attachProp(world, [
      { target: 'glow', kind: 'uniform', source: { type: 'constant', value: 0.9 } },
      { target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.3 } },
    ], { opacity: 1 });
    materialInstanceSystem(world);
    expect(mesh.userData.glow).toBeCloseTo(0.9, 9);           // uniform written
    expect(mesh.material).not.toBe(base);                     // prop cloned
    expect((mesh.material as { opacity: number }).opacity).toBeCloseTo(0.3, 9);
  });

  it('does not crash the frame on a malformed override missing source', () => {
    const world = newWorld();
    spawnTime(world);
    const { obj } = attach(world, [
      { target: 'bad' } as unknown as MaterialParamOverride,          // malformed → skipped
      { target: 'glow', kind: 'uniform', source: { type: 'constant', value: 0.4 } },
    ]);
    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(obj.userData.glow).toBeCloseTo(0.4, 9);            // the valid override still ran
    expect(obj.userData.bad).toBeUndefined();
  });

  it('no-ops when the entity has no objects on any surface', () => {
    const world = newWorld();
    spawnTime(world);
    const e = world.spawn(MaterialInstance({ overrides: [{ target: 'x', kind: 'uniform', source: { type: 'constant', value: 1 } }] }));
    // deliberately do NOT register fake objects for e
    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(fakeObjects.get(e.id())).toBeUndefined();
  });

  it('writes to every drawable object of the entity (both surfaces)', () => {
    const world = newWorld();
    spawnTime(world);
    const e = world.spawn(MaterialInstance({ overrides: [{ target: 'glow', kind: 'uniform', source: { type: 'constant', value: 0.9 } }] }));
    const a = { userData: {} as Record<string, unknown> };
    const b = { userData: {} as Record<string, unknown> };
    fakeObjects.set(e.id(), [a, b]); // e.g. GameView + SceneView clones
    materialInstanceSystem(world);
    expect(a.userData.glow).toBeCloseTo(0.9, 9);
    expect(b.userData.glow).toBeCloseTo(0.9, 9);
  });

  it("a kind:'texture' override on a 3D material is a no-op and warns once (2D-only)", () => {
    const world = newWorld();
    spawnTime(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, obj } = attach(world, [{ target: 'uReveal', kind: 'texture', ref: 'guid-metal' }]);

    materialInstanceSystem(world);
    materialInstanceSystem(world);
    expect(obj.userData.uReveal).toBeUndefined(); // texture ref not written as a 3D uniform
    void e;
    if (import.meta.env?.DEV) expect(warn.mock.calls.filter((c) => String(c[0]).includes("kind:'texture'"))).toHaveLength(1);
    warn.mockRestore();
  });
});

// ── 2D materials (Phase 3): drive a PixiJS Shader's uniforms ──
// The system reaches an entity's live 2D-material Shader(s) via sprite2DMaterialBroker.
// We register a fake per-entity shader map (a real broker registration) and assert its
// matUniforms.uniforms are driven — sharing the SAME evalSource + clocks as the 3D path.
const shaders2d = new Map<number, { resources: { matUniforms: { uniforms: Record<string, unknown> } }; destroyed: boolean }>();
register2DMaterialShaderMap(shaders2d as never);

function fakeShader(declared: Record<string, unknown> = {}) {
  return { resources: { matUniforms: { uniforms: { ...declared } } }, destroyed: false };
}
function attach2D(world: ReturnType<typeof createWorld>, overrides: MaterialParamOverride[], declared: Record<string, unknown> = {}) {
  const e = world.spawn(MaterialInstance({ overrides }));
  const sh = fakeShader(declared);
  shaders2d.set(e.id(), sh);
  return { e, sh };
}

describe('materialInstanceSystem — 2D materials', () => {
  beforeEach(() => { shaders2d.clear(); });

  it('writes a uniform override into the entity\'s matUniforms group (declared target)', () => {
    const world = newWorld();
    spawnTime(world);
    const { sh } = attach2D(world, [{ target: 'uAmount', kind: 'uniform', source: { type: 'constant', value: 0.75 } }], { uAmount: 0 });

    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uAmount).toBeCloseTo(0.75, 9);
  });

  // Perf gate (MaterialSnap): the driver flags an entity 2D-material-dirty ONLY when a uniform
  // value actually changes, so the 2D render pass can skip the GPU redraw of a static material.
  it('flags a CHANGED uniform 2D-material-dirty; leaves an unchanged (already-equal) one clean', () => {
    const world = newWorld();
    spawnTime(world);
    const { e: changed } = attach2D(world, [{ target: 'uA', kind: 'uniform', source: { type: 'constant', value: 0.75 } }], { uA: 0 });    // 0 → 0.75
    const { e: settled } = attach2D(world, [{ target: 'uK', kind: 'uniform', source: { type: 'constant', value: 0.5 } }], { uK: 0.5 });    // already 0.5

    materialInstanceSystem(world);

    expect(isEntity2DMaterialDirty(changed.id())).toBe(true);
    expect(isEntity2DMaterialDirty(settled.id())).toBe(false); // no write → no redraw needed
  });

  it('re-clears the dirty set each frame — a settled constant is dirty once, then clean', () => {
    const world = newWorld();
    spawnTime(world);
    const { e } = attach2D(world, [{ target: 'uA', kind: 'uniform', source: { type: 'constant', value: 0.75 } }], { uA: 0 });

    materialInstanceSystem(world);
    expect(isEntity2DMaterialDirty(e.id())).toBe(true);  // 0 → 0.75 (first write)
    materialInstanceSystem(world);
    expect(isEntity2DMaterialDirty(e.id())).toBe(false); // value unchanged this frame → set cleared, not re-marked
  });

  it('does NOT write an undeclared uniform (avoids dead keys)', () => {
    const world = newWorld();
    spawnTime(world);
    const { sh } = attach2D(world, [{ target: 'uMissing', kind: 'uniform', source: { type: 'constant', value: 1 } }], { uAmount: 0 });

    materialInstanceSystem(world);
    expect('uMissing' in sh.resources.matUniforms.uniforms).toBe(false);
    expect(sh.resources.matUniforms.uniforms.uAmount).toBe(0); // untouched
  });

  it("ignores a kind:'texture' override (static per-instance ref — resolved by the renderer, not driven)", () => {
    const world = newWorld();
    spawnTime(world);
    // A texture override has NO source; the scalar driver must skip it — no uniform write,
    // no dirty flag, no crash. (Scene2D resolves the ref into the shader's extra sampler.)
    const { e, sh } = attach2D(world, [{ target: 'uReveal', kind: 'texture', ref: 'guid-metal' }], { uReveal: 0 });

    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(sh.resources.matUniforms.uniforms.uReveal).toBe(0); // untouched (not a scalar drive)
    expect(isEntity2DMaterialDirty(e.id())).toBe(false);        // no uniform change → no redraw
  });

  it('scrolls a time uniform each frame and FREEZES on pause (deterministic clock)', () => {
    const world = newWorld();
    spawnTime(world, /* smoothedDelta */ 0.5);
    const { sh } = attach2D(world, [{ target: 'uTime', kind: 'uniform', source: { type: 'time' } }], { uTime: 0 });

    materialInstanceSystem(world);
    const a = sh.resources.matUniforms.uniforms.uTime as number;
    materialInstanceSystem(world);
    const b = sh.resources.matUniforms.uniforms.uTime as number;
    expect(b).toBeGreaterThan(a); // advanced

    setPlayState('paused');
    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uTime).toBeCloseTo(b, 9); // frozen while paused
  });

  it('tracks a store source live', () => {
    const world = newWorld();
    spawnTime(world);
    let hp = 0.2;
    registerReadSource('hp', () => hp);
    const { sh } = attach2D(world, [{ target: 'uHp', kind: 'uniform', source: { type: 'store', key: 'hp' } }], { uHp: 0 });

    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uHp).toBeCloseTo(0.2, 9);
    hp = 0.9;
    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uHp).toBeCloseTo(0.9, 9);
  });

  it('drives two entities off one material independently', () => {
    const world = newWorld();
    spawnTime(world);
    const { sh: a } = attach2D(world, [{ target: 'uK', kind: 'uniform', source: { type: 'constant', value: 0.1 } }], { uK: 0 });
    const { sh: b } = attach2D(world, [{ target: 'uK', kind: 'uniform', source: { type: 'constant', value: 0.9 } }], { uK: 0 });

    materialInstanceSystem(world);
    expect(a.resources.matUniforms.uniforms.uK).toBeCloseTo(0.1, 9);
    expect(b.resources.matUniforms.uniforms.uK).toBeCloseTo(0.9, 9);
  });

  it('writes into EVERY live renderer\'s Shader for the entity (GameView + SceneView)', () => {
    const world = newWorld();
    spawnTime(world);
    const { e, sh } = attach2D(world, [{ target: 'uK', kind: 'uniform', source: { type: 'constant', value: 0.5 } }], { uK: 0 });
    // A second renderer's map with its OWN shader for the same entity.
    const map2 = new Map<number, typeof sh>();
    const sh2 = fakeShader({ uK: 0 });
    map2.set(e.id(), sh2);
    const unreg = register2DMaterialShaderMap(map2 as never);

    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uK).toBeCloseTo(0.5, 9);
    expect(sh2.resources.matUniforms.uniforms.uK).toBeCloseTo(0.5, 9);
    unreg();
  });

  it('a prop override on a 2D material is a no-op and warns once', () => {
    const world = newWorld();
    spawnTime(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sh } = attach2D(world, [{ target: 'uAmount', kind: 'prop', source: { type: 'constant', value: 1 } }], { uAmount: 0 });

    materialInstanceSystem(world);
    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uAmount).toBe(0); // prop ignored
    if (import.meta.env?.DEV) expect(warn.mock.calls.filter((c) => String(c[0]).includes('2D material'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('SKIPS a non-scalar (vec/color Float32Array) uniform + warns once (no NaN corruption)', () => {
    const world = newWorld();
    spawnTime(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tint = new Float32Array([0, 0, 0]); // a vec3/color uniform
    const { sh } = attach2D(world, [{ target: 'uTint', kind: 'uniform', source: { type: 'constant', value: 0.5 } }], { uTint: tint });

    materialInstanceSystem(world);
    materialInstanceSystem(world);
    // The Float32Array is untouched (NOT overwritten by the scalar) — no NaN.
    expect(sh.resources.matUniforms.uniforms.uTint).toBe(tint);
    expect(Array.from(tint)).toEqual([0, 0, 0]);
    if (import.meta.env?.DEV) expect(warn.mock.calls.filter((c) => String(c[0]).includes('non-scalar'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('a malformed override (no source) is skipped; a valid sibling still writes', () => {
    const world = newWorld();
    spawnTime(world);
    const { sh } = attach2D(world, [
      { target: 'uBad', kind: 'uniform' } as unknown as MaterialParamOverride, // no source
      { target: 'uK', kind: 'uniform', source: { type: 'constant', value: 0.7 } },
    ], { uBad: 0, uK: 0 });

    expect(() => materialInstanceSystem(world)).not.toThrow();
    expect(sh.resources.matUniforms.uniforms.uK).toBeCloseTo(0.7, 9); // valid sibling unaffected
  });

  it('a destroyed Shader is skipped (never written after its slot is torn down)', () => {
    const world = newWorld();
    spawnTime(world);
    const { sh } = attach2D(world, [{ target: 'uK', kind: 'uniform', source: { type: 'constant', value: 1 } }], { uK: 0 });
    sh.destroyed = true;

    materialInstanceSystem(world);
    expect(sh.resources.matUniforms.uniforms.uK).toBe(0); // not written into freed state
  });
});
