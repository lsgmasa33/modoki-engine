/** Scene files omit trait fields that still hold their schema default.
 *
 *  WHY (owner's call, 2026-07-31): writing every schema field out FREEZES each scene at
 *  the defaults of the day it was saved. A later change to a trait default then silently
 *  stops reaching every already-saved scene — which is what put the repo-wide legacy
 *  scene migration on hold (47 scenes across 19 projects, 10 of them in published demos;
 *  see docs/scene-loading.md). Omitting default-valued fields keeps the default LIVE, and is lossless
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
