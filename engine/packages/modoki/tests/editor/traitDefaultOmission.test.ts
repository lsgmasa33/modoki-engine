/** Scene files omit trait fields that still hold their schema default.
 *
 *  WHY (owner's call, 2026-07-31): writing every schema field out FREEZES each scene at
 *  the defaults of the day it was saved. A later change to a trait default then silently
 *  stops reaching every already-saved scene — which is what put the repo-wide legacy
 *  scene migration on hold (47 scenes across 19 projects as counted then; the migration was
 *  carried out 2026-08-04 over 48 across 20 — see docs/scene-loading.md). Omitting default-valued fields keeps the default LIVE, and is lossless
 *  because the loader rebuilds each trait with `meta.trait(partialData)` and koota fills
 *  every absent key from the same schema.
 *
 *  The two things this file pins:
 *  1. `isTraitDefault`'s scalar-only rule — the safety boundary of the whole change.
 *  2. An end-to-end save→load→save round trip: omitting must not change what LOADS. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
// A light-like trait carrying exactly the fields the todo caught being materialized
// into legacy scenes on save (shadowBias / shadowMapSize).
const Light = trait({ kind: 'directional', intensity: 1, shadowBias: -0.0003, shadowMapSize: 2048 });

vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    { name: 'Light', trait: Light, category: 'component', fields: { kind: {}, intensity: {}, shadowBias: {}, shadowMapSize: {} } },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const SCENE_GUID = '80000000-0000-4000-8000-00000000ffff';
const SCENE_PATH = '/assets/scenes/lights.json';

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  // completeResponse fills in text() — the stubs below only supply json(), and the loaders read
  // the body as text so they can spot Vite's index.html SPA fallback. See tests/stubs/assetResponse.ts.
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => structuredClone(body) });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

beforeEach(async () => {
  installLocalStorage();
  vi.resetModules();
  fetchResponses = {
    [SCENE_PATH]: {
      id: SCENE_GUID, version: 12, createdAt: '2024-04-04T04:04:04.000Z', resources: [],
      entities: [
        // One light left entirely at its defaults, one with two fields authored away
        // from them. A correct omission rule must tell these apart.
        { traits: { EntityAttributes: { name: 'DefaultLight', guid: 'g-dl' }, Light: {} } },
        { traits: { EntityAttributes: { name: 'TunedLight', guid: 'g-tl' }, Light: { intensity: 2.5, shadowMapSize: 4096 } } },
        // A third case the first two cannot express: fields EXPLICITLY PRESENT on disk at exactly
        // their schema default. "Absent" and "present at default" collapse into the same live state
        // on load, so the serializer cannot tell them apart and drops both — see the #405 describe
        // at the foot of this file for why that is the decided behaviour rather than a bug.
        { traits: { EntityAttributes: { name: 'SpelledOutLight', guid: 'g-sl' }, Light: { kind: 'directional', intensity: 1, shadowBias: -0.0003, shadowMapSize: 2048 } } },
      ],
    },
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

describe('isTraitDefault — the scalar-only safety boundary', () => {
  it('matches equal scalars, including NaN, and rejects a differing value', async () => {
    const { isTraitDefault } = await import('../../src/editor/scene/serialize');
    expect(isTraitDefault(0, 0)).toBe(true);
    expect(isTraitDefault('', '')).toBe(true);
    expect(isTraitDefault(true, true)).toBe(true);
    expect(isTraitDefault(null, null)).toBe(true);
    expect(isTraitDefault(NaN, NaN)).toBe(true); // Object.is, not ===
    expect(isTraitDefault(-0.0003, -0.0003)).toBe(true);

    expect(isTraitDefault(1, 0)).toBe(false);
    expect(isTraitDefault('2d', '')).toBe(false);
    expect(isTraitDefault(false, true)).toBe(false);
  });

  it('never omits a signed zero against a plain zero — a different authored value in a direction field', async () => {
    const { isTraitDefault } = await import('../../src/editor/scene/serialize');
    expect(isTraitDefault(-0, 0)).toBe(false);
    expect(isTraitDefault(0, -0)).toBe(false);
  });

  it('never omits a non-scalar, on EITHER side — a shared default array/object cannot be compared safely', async () => {
    const { isTraitDefault } = await import('../../src/editor/scene/serialize');
    const shared: number[] = [];
    // Identity-equal to the schema default: still written, because the entity may be
    // ALIASING that shared instance rather than genuinely holding the default.
    expect(isTraitDefault(shared, shared)).toBe(false);
    expect(isTraitDefault([], [])).toBe(false);
    expect(isTraitDefault({}, {})).toBe(false);
    expect(isTraitDefault([1, 2], [])).toBe(false);
    // A function-valued default (or value) is never comparable.
    expect(isTraitDefault(() => {}, () => {})).toBe(false);
    // null is an ordinary scalar here, not an object, despite typeof.
    expect(isTraitDefault(null, {})).toBe(false);
  });
});

describe('omitting defaults is LOSSLESS — save → load → save', () => {
  it('drops default-valued fields from the file while keeping authored ones', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);

    const saved = await ser.serializeScene();
    const dl = saved.entities.find((e) => e.name === 'DefaultLight')!.traits.Light as Record<string, unknown>;
    const tl = saved.entities.find((e) => e.name === 'TunedLight')!.traits.Light as Record<string, unknown>;

    // The trait's PRESENCE is meaningful even when every field is default — an
    // all-defaults trait must still serialize, as an empty object.
    expect(dl).toEqual({});
    // These four are exactly what the todo measured being materialized into legacy
    // scenes on save; only the two genuinely authored values survive.
    expect(tl).toEqual({ intensity: 2.5, shadowMapSize: 4096 });
    expect(tl).not.toHaveProperty('shadowBias');
    expect(tl).not.toHaveProperty('kind');
  });

  it('reloading the omitted file rebuilds identical live values, and a second save is byte-stable', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);
    const first = await ser.serializeScene();

    // Feed the SAVED (field-omitted) file back through a real load — this is the
    // claim that makes omission safe: koota refills every absent key from the schema.
    fetchResponses[SCENE_PATH] = first;
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);

    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const live: Record<string, Record<string, unknown>> = {};
    getCurrentWorld().query(EntityAttributes, Light).updateEach(([ea, light]: Record<string, unknown>[]) => {
      live[ea.name as string] = { ...light };
    });
    // The defaults came back, not `undefined` — the round trip is lossless.
    expect(live.DefaultLight).toEqual({ kind: 'directional', intensity: 1, shadowBias: -0.0003, shadowMapSize: 2048 });
    expect(live.TunedLight).toEqual({ kind: 'directional', intensity: 2.5, shadowBias: -0.0003, shadowMapSize: 4096 });

    // And saving again produces the same file — omission must not oscillate.
    const second = await ser.serializeScene();
    expect(second.entities).toEqual(first.entities);
  });
});

/** #405 — a field the file SPELLS OUT at its default is dropped too, and that is the decided
 *  behaviour, not an oversight.
 *
 *  Reported as a bug: an editor save of `games/court/main.scene.json` produced a ~1100-line diff
 *  across 33 entities, dropping 44 hand-authored default-valued fields (`AudioSource.bus: 'sfx'`,
 *  `UIAnchor.pivotY: 0`, `UIElement.text: ''`, …), and two Court tests that read the scene JSON RAW
 *  failed. The proposed fix was to never strip a value present on disk.
 *
 *  It was declined, because it reverses the 2026-07-31 call this file's banner records — a field
 *  written out is a field FROZEN at the default of its save day — and because the two premises did
 *  not hold. The churn was one-time, not per-edit: the scene had been hand-authored (its
 *  `"version": 13` is a number no code emits), and the save merely brought it to what the serializer
 *  has always produced. And the failing assertions were reading "the FILE spells this out" while
 *  claiming to test "the value is X" — `traitFieldOrDefault` fixes them and is strictly stronger,
 *  since it also fails when the ENGINE default moves.
 *
 *  What was genuinely missing is the guarantee below. The drop must be lossless BY DEFAULTS, not by
 *  silence: nothing else in this file distinguishes "absent on disk" from "present at default", and
 *  those are exactly the two inputs #405 is about. */
describe('#405 — a field PRESENT on disk at its default is dropped, losslessly', () => {
  it('drops it, exactly as if the file had never spelled it out', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);

    const saved = await ser.serializeScene();
    const spelled = saved.entities.find((e) => e.name === 'SpelledOutLight')!.traits.Light as Record<string, unknown>;
    const absent = saved.entities.find((e) => e.name === 'DefaultLight')!.traits.Light as Record<string, unknown>;

    // All four were authored on disk. All four equal the schema default. All four go.
    expect(spelled).toEqual({});
    // …and the entity that never spelled them out serializes IDENTICALLY. This equality is the
    // whole decision: the file stops recording which of the two an author happened to type, so a
    // later change to a trait default reaches BOTH — which is the property being bought.
    expect(spelled).toEqual(absent);
  });

  it('the value survives the round trip — the drop costs the SCENE nothing', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);
    const first = await ser.serializeScene();

    fetchResponses[SCENE_PATH] = first;
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);

    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    let live: Record<string, unknown> | undefined;
    getCurrentWorld().query(EntityAttributes, Light).updateEach(([ea, light]: Record<string, unknown>[]) => {
      if (ea.name === 'SpelledOutLight') live = { ...light };
    });
    // Every dropped field is back at the value the file used to state. A raw-JSON reader sees a
    // difference here and the GAME does not — which is why the fix for #405 belonged in the two
    // tests doing raw reads, not in the serializer.
    expect(live).toEqual({ kind: 'directional', intensity: 1, shadowBias: -0.0003, shadowMapSize: 2048 });
  });

  it('a NON-default value is still written, however ordinary it looks', async () => {
    // The other side of the boundary, and the assertion that stops a future "just write everything"
    // or "just write nothing" from passing this describe vacuously.
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(SCENE_PATH);
    ser.setCurrentScenePath(SCENE_PATH);

    const saved = await ser.serializeScene();
    const tuned = saved.entities.find((e) => e.name === 'TunedLight')!.traits.Light as Record<string, unknown>;
    expect(tuned).toEqual({ intensity: 2.5, shadowMapSize: 4096 });
  });
});
