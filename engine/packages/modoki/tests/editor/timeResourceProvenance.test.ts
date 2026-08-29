/** The `Time` resource singleton is serialized when a scene AUTHORED it, and never
 *  when SceneManager materialized it.
 *
 *  Two facts make provenance the only workable discriminator:
 *   - A file-authored Time entry carries no `EntityAttributes` (it serializes as a bare
 *     `{ name: 'Time (resource)', traits: { Time: {...} } }`), exactly like the
 *     materialized one — so shape cannot tell them apart.
 *   - Post-#410 an authored Time is byte-identical to the materialized one at EVERY value, not
 *     just the default — every field, `timeScale` included, is `runtimeOnly` now. That only
 *     STRENGTHENS the case for provenance-based tagging: no value-based rule could ever work.
 *
 *  So `SceneManager` tags the one it spawns `Transient`, whose whole job is "must live in
 *  the world, must never be written to a scene file".
 *
 *  What this protects: a save used to GROW any scene lacking a Time entity by one
 *  (measured: ui-focus-demo.json, 9 → 10 entities; see docs/scene-loading.md), breaking A10's "a no-op
 *  save is a no-op". And because serialize's foreign-entity filter skips entities without
 *  `EntityAttributes`, the stray singleton was not even confined to the primary — it
 *  landed in whichever file was being saved, a shared BASE scene included. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
// Mirrors the real Time schema. It MUST be mocked rather than imported: `vi.resetModules()`
// in beforeEach hands SceneManager a fresh copy of the module, and a statically-imported
// `Time` would be a DIFFERENT koota trait identity — so the query below would find nothing
// and every assertion here would pass for the wrong reason. Same gotcha the sibling scene
// tests document at length for EntityAttributes.
const Time = trait({ delta: 0, elapsed: 0, frame: 0, smoothedDelta: 0, smoothedElapsed: 0, timeScale: 1 });

vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));
vi.mock('../../src/runtime/core/traits/Time', () => ({ Time }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    // Same trait identity SceneManager spawns (see the Time mock above).
    {
      name: 'Time', trait: Time, category: 'resource',
      fields: {
        delta: { runtimeOnly: true }, elapsed: { runtimeOnly: true }, frame: { runtimeOnly: true },
        smoothedDelta: { runtimeOnly: true }, smoothedElapsed: { runtimeOnly: true },
        // Mirrors the real registration post-#410 (engine/app/ecs/registerTraits.ts) — every
        // Time field is runtime state, timeScale included. The anti-drift assertion against the
        // REAL registry (which this mock cannot see) lives in
        // engine/tests/editor/serialize.test.ts, describe('Time.timeScale registration (#410)').
        timeScale: { runtimeOnly: true },
      },
    },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const NO_TIME_PATH = '/assets/scenes/no-time.json';
const AUTHORED_PATH = '/assets/scenes/authored-time.json';

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
    [NO_TIME_PATH]: {
      id: '90000000-0000-4000-8000-000000000001', version: 12, createdAt: '2024-01-01T00:00:00.000Z', resources: [],
      entities: [{ traits: { EntityAttributes: { name: 'Thing', guid: 'g-thing' } } }],
    },
    [AUTHORED_PATH]: {
      id: '90000000-0000-4000-8000-000000000002', version: 12, createdAt: '2024-01-01T00:00:00.000Z', resources: [],
      entities: [
        { traits: { EntityAttributes: { name: 'Thing', guid: 'g-thing' } } },
        // Authored at the DEFAULT timeScale on purpose: this is the case a
        // value-based rule would wrongly delete.
        { name: 'Time (resource)', traits: { Time: { timeScale: 1 } } },
      ],
    },
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

async function loadAndSave(path: string) {
  const sceneMod = await import('../../src/runtime/scene/SceneManager');
  const ser = await import('../../src/editor/scene/serialize');
  sceneMod.sceneManager.resetForTesting();
  await sceneMod.sceneManager.loadScene(path);
  ser.setCurrentScenePath(path);
  return { saved: await ser.serializeScene(), sceneMod };
}

describe('Time resource: authored vs materialized', () => {
  it('a scene with no Time entity does not GAIN one on save — load+save is identity', async () => {
    const { saved, sceneMod } = await loadAndSave(NO_TIME_PATH);

    // The singleton must still exist in the live world — systems that read delta
    // are no-ops without it, so skipping the spawn is NOT an acceptable fix.
    let liveCount = 0;
    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    getCurrentWorld().query(Time).updateEach(() => { liveCount++; });
    expect(liveCount).toBe(1);
    void sceneMod;

    // …but it must not reach the file.
    expect(saved.entities).toHaveLength(1);
    expect(saved.entities.some((e) => e.traits.Time !== undefined)).toBe(false);
  });

  it('a scene that AUTHORED its Time keeps it — even at the default timeScale', async () => {
    const { saved } = await loadAndSave(AUTHORED_PATH);

    const timeEntries = saved.entities.filter((e) => e.traits.Time !== undefined);
    expect(timeEntries).toHaveLength(1);
    // The authored entity survives a round trip; `timeScale` itself is omitted as a
    // default-valued field (traitDefaultOmission.test.ts) — what matters here is that
    // the ENTITY is still there to carry the resource for the chain.
    expect(timeEntries[0].traits.Time).toEqual({});
  });

  // #410: this is a DELIBERATE reversal, not a fix to what used to be a passing test.
  // `timeScale` is no longer round-tripped through the file — every writer of it (the
  // `set-timescale`/`sim-step` agent ops, the device Time tab) is transient, so persisting the
  // value only meant an ordinary debug move plus any save could ship a scene frozen. The Time
  // ENTITY still survives (a base scene can still author the resource itself), but the value
  // it carried in is gone the moment it's re-saved.
  it('a timeScale never reaches the file — the entity survives, the value does not', async () => {
    fetchResponses[AUTHORED_PATH] = {
      ...(fetchResponses[AUTHORED_PATH] as Record<string, unknown>),
      entities: [{ name: 'Time (resource)', traits: { Time: { timeScale: 0.25 } } }],
    };
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    sceneMod.sceneManager.resetForTesting();
    await sceneMod.sceneManager.loadScene(AUTHORED_PATH);

    // Mid-flight: the LOAD side (gated on isPersistentTraitField, not runtimeOnly) must have
    // actually applied the authored 0.25 to the live world. Without this the test would stay
    // green even if the loader silently stopped applying timeScale at all — the post-save
    // `toEqual({})` below is satisfied either way, so it can't tell "save drops it" from "load
    // never applied it". This assertion is what makes the two hypotheses distinguishable.
    let liveTimeScale: number | undefined;
    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    getCurrentWorld().query(Time).updateEach(([t]) => { liveTimeScale = t.timeScale; });
    expect(liveTimeScale).toBe(0.25);

    ser.setCurrentScenePath(AUTHORED_PATH);
    const saved = await ser.serializeScene();

    const time = saved.entities.find((e) => e.traits.Time !== undefined);
    expect(time, 'the Time entity is still present').toBeDefined();
    expect(time!.traits.Time).toEqual({});
  });

  it('saving twice does not accumulate Time entities', async () => {
    const ser = await import('../../src/editor/scene/serialize');
    const { saved: first } = await loadAndSave(NO_TIME_PATH);
    const second = await ser.serializeScene();

    expect(second.entities).toEqual(first.entities);
  });
});
