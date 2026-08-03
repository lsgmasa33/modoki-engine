/** SceneManager base-scene chain — THE BET (base-scene plan, Phase 5).
 *
 *  Additive chain load + carry-across-swap: a level declaring `baseScene` loads
 *  its base additively; swapping to ANOTHER level sharing the same base carries
 *  the base's live entities across (snapshot-and-respawn — the world itself
 *  cannot survive, koota caps live worlds at 16) instead of reloading it from
 *  file. This is the plan's headline gate: `Time.elapsed` stays monotonic across
 *  a level→level swap, there is exactly ONE Time entity after the swap, base
 *  entities appear once, and the base's resources are not released.
 *
 *  Own file (fresh module graph + koota counter) mirroring
 *  sceneManagerLifecycle.test.ts's rationale — this needs its own careful world
 *  budget given how many loadScene calls a chain scenario drives. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

// ── Test traits ──────────────────────────────────────────────────────────

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
const Renderable3D = trait({ mesh: '', material: '', isVisible: true });
const PrefabInstanceLike = trait({});
// SceneManager.ts imports Time/Input DIRECTLY (not via the trait registry), so
// this test must mock those two modules too — with the SAME trait objects the
// traitRegistry mock below hands out. A dynamic re-import of the REAL Time/Input
// inside the registry mock factory is NOT safe here: vi.resetModules() + a
// dynamic import inside a vi.mock factory can resolve to a DIFFERENT module
// instance than SceneManager.ts's own static import picks up, silently splitting
// "the Time entity" into two distinct koota component identities (one the
// registry spawns entities with, a different one SceneManager's own `hasTime`
// check queries against — its false negative then spawns a phantom SECOND Time
// entity). Defining the trait ONCE here and mocking both import sites with it
// guarantees a single identity, matching how the real app registers ONE Time
// trait everywhere (registerTraits.ts).
const TimeLike = trait({ delta: 0, elapsed: 0, frame: 0, smoothedDelta: 0, smoothedElapsed: 0, timeScale: 1 });
const InputLike = trait({});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(path: string, onLoad: (gltf: any) => void) {
      onLoad({ scene: { position: { set: () => {} }, rotation: { set: () => {} }, scale: { setScalar: () => {} }, updateMatrixWorld: () => {}, traverse: () => {} } });
    }
  },
}));

// Override marks are keyed by raw ecs id, so the global clear is a WORLD-scoped
// concern — but it used to run on every `loadSceneFile` CALL, which meant a chain
// (N scene files into ONE world, bases first / primary last) had the primary wipe
// the marks the base had just seeded (A9 defect 1). Count the clears so the
// "exactly once per staging world" contract is pinned, not just assumed.
// See docs/reviews/a9-carried-instance-overrides-investigation.md.
const markCounters = vi.hoisted(() => ({ clearAllCalls: 0 }));
vi.mock('../../src/runtime/loaders/overrideMarks', () => {
  const marks = new Map<number, Set<string>>();
  return {
    markOverride: (id: number, t: string, f: string) => {
      let s = marks.get(id);
      if (!s) { s = new Set(); marks.set(id, s); }
      s.add(`${t}.${f}`);
    },
    getOverrideMarkSet: (id: number) => marks.get(id),
    clearOverrideMarks: (id: number) => { marks.delete(id); },
    clearAllOverrideMarks: () => { markCounters.clearAllCalls++; marks.clear(); },
  };
});

vi.mock('../../src/runtime/core/traits/Time', () => ({ Time: TimeLike }));
vi.mock('../../src/runtime/traits/Input', () => ({ Input: InputLike }));
// `runtime/core/ecs/world.ts` (registerEntity/findEntityByGuid/guidOf) imports the REAL
// EntityAttributes trait directly — same identity-split hazard as Time/Input above.
// The cross-scene-parenting guard test below resolves a parentId GUID ref through
// findEntityByGuid, which is a no-op unless the entities it's indexing carry the
// SAME trait identity the traitRegistry mock spawns them with.
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } } },
    { name: 'Renderable3D', trait: Renderable3D, category: 'component', fields: { mesh: { type: 'string' }, material: { type: 'string' }, isVisible: { type: 'boolean' } } },
    { name: 'Time', trait: TimeLike, category: 'resource', fields: { delta: { type: 'number', runtimeOnly: true }, elapsed: { type: 'number', runtimeOnly: true }, frame: { type: 'number', runtimeOnly: true }, timeScale: { type: 'number' } } },
    { name: 'Input', trait: InputLike, category: 'resource', fields: {} },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
    { name: 'PrefabInstance', trait: PrefabInstanceLike, category: 'tag', fields: {} },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
  };
});

// ── fetch() mock ────────────────────────────────────────────────────────

let fetchCalls: Record<string, number> = {};
const fetchResponses: Record<string, unknown> = {};

const MAT_GUIDS: Record<string, string> = {
  '/materials/base.mat.json': '30000000-0000-4000-8000-000000000001',
  '/materials/l1.mat.json': '30000000-0000-4000-8000-000000000002',
  '/materials/l2.mat.json': '30000000-0000-4000-8000-000000000003',
};
const M = (p: string) => MAT_GUIDS[p];
const BASE_GUID = '10000000-0000-4000-8000-0000000000ba';

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  fetchCalls[url] = (fetchCalls[url] || 0) + 1;
  // completeResponse fills in text() — the stubs below only supply json(), and the loaders read
  // the body as text so they can spot Vite's index.html SPA fallback. See tests/stubs/assetResponse.ts.
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => body });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

function defineMaterials() {
  fetchResponses['/materials/base.mat.json'] = { color: 0x111111 };
  fetchResponses['/materials/l1.mat.json'] = { color: 0x222222 };
  fetchResponses['/materials/l2.mat.json'] = { color: 0x333333 };
}

const BASE_CAMERA_GUID = '40000000-0000-4000-8000-00000000ca4e';

function defineBase() {
  fetchResponses['/base.json'] = {
    id: BASE_GUID,
    version: 10,
    resources: [{ type: 'material', path: M('/materials/base.mat.json') }],
    entities: [
      { id: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Camera', parentId: 0, guid: BASE_CAMERA_GUID }, Renderable3D: { mesh: '', material: M('/materials/base.mat.json') } } },
      { id: 2, traits: { Time: { delta: 0, elapsed: 0, frame: 0, timeScale: 1 }, EntityAttributes: { name: 'Time', parentId: 0 } } },
    ],
  };
}

/** Same as defineBase(), but the base ALSO contains a prefab-instance entity —
 *  used to test the "editor bookkeeping may not survive a carry" warning. */
function defineBaseWithPrefabInstance() {
  fetchResponses['/base.json'] = {
    id: BASE_GUID,
    version: 10,
    resources: [{ type: 'material', path: M('/materials/base.mat.json') }],
    entities: [
      { id: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Camera', parentId: 0, guid: BASE_CAMERA_GUID }, Renderable3D: { mesh: '', material: M('/materials/base.mat.json') } } },
      { id: 2, traits: { Time: { delta: 0, elapsed: 0, frame: 0, timeScale: 1 }, EntityAttributes: { name: 'Time', parentId: 0 } } },
      { id: 3, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'FishInstance', parentId: 0 }, PrefabInstance: true } },
    ],
  };
}

function defineLevel1() {
  fetchResponses['/level1.json'] = {
    id: '20000000-0000-4000-8000-000000000001',
    version: 10,
    baseScene: BASE_GUID,
    resources: [{ type: 'material', path: M('/materials/l1.mat.json') }],
    entities: [
      { id: 10, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Level1Thing', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/l1.mat.json') } } },
    ],
  };
}

function defineLevel2() {
  fetchResponses['/level2.json'] = {
    id: '20000000-0000-4000-8000-000000000002',
    version: 10,
    baseScene: BASE_GUID,
    resources: [{ type: 'material', path: M('/materials/l2.mat.json') }],
    entities: [
      { id: 20, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'Level2Thing', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/l2.mat.json') } } },
    ],
  };
}

beforeEach(async () => {
  vi.resetModules();
  fetchCalls = {};
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  defineMaterials();
  defineBase();
  defineLevel1();
  defineLevel2();

  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  const persistentMeta = getAllTraits().find((m: any) => m.name === 'Persistent');
  if (persistentMeta) (persistentMeta as any).trait = Persistent;

  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  for (const [path, guid] of Object.entries(MAT_GUIDS)) manifest.registerAsset(guid, path, 'material');
  // The base scene is never loaded via a direct loadScene(path) call — only
  // reached through its `baseScene` guid ref — so it must be resolvable via the
  // manifest exactly like any other GUID-only asset ref (this is the real-world
  // invariant: the dev-server/prod manifest already knows every scene's guid→path
  // before the first load, from the asset scanner / bulk manifest fetch).
  manifest.registerAsset(BASE_GUID, '/base.json', 'scene');
});

async function getSceneManager() {
  const mod = await import('../../src/runtime/scene/SceneManager');
  mod.sceneManager.resetForTesting();
  return mod;
}
async function getWorld() { return import('../../src/runtime/core/ecs/world'); }
async function getCache() { return import('../../src/runtime/loaders/meshTemplateCache'); }

describe('SceneManager base-scene chain — additive load + carry-across-swap', () => {
  it('loading a level with a baseScene additively loads the base alongside it', async () => {
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/level1.json');

    const world = getCurrentWorld();
    const names: string[] = [];
    world.query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names.sort()).toEqual(['Camera', 'Level1Thing', 'Time']);

    // Base-origin entities are stamped with the base's guid; the level's own
    // entity keeps the schema default '' (Phase 3's load-bearing rule).
    const sourceScenes = new Map<string, string>();
    world.query(EntityAttributes).updateEach(([attr]: any[]) => sourceScenes.set((attr as any).name, (attr as any).sourceScene));
    expect(sourceScenes.get('Camera')).toBe(BASE_GUID);
    expect(sourceScenes.get('Time')).toBe(BASE_GUID);
    expect(sourceScenes.get('Level1Thing')).toBe('');
  });

  it('clears override marks ONCE per staging world, not once per scene in the chain (A9 defect 1)', async () => {
    const { sceneManager } = await getSceneManager();

    // A 2-scene chain (base + level1). Before the fix this cleared twice — the
    // second clear wiping the base's freshly-seeded marks, which is what made
    // every chained prefab instance serialize with EMPTY overrides.
    markCounters.clearAllCalls = 0;
    await sceneManager.loadScene('/level1.json');
    expect(markCounters.clearAllCalls).toBe(1);

    // The swap to a level sharing the base carries the base (no reload) and
    // respawns the snapshot — still exactly one clear for the new world.
    markCounters.clearAllCalls = 0;
    await sceneManager.loadScene('/level2.json');
    expect(markCounters.clearAllCalls).toBe(1);
  });

  it('opening a level standalone still works — the base loads with it', async () => {
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();
    await sceneManager.loadScene('/level2.json');
    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names.sort()).toEqual(['Camera', 'Level2Thing', 'Time']);
  });

  it('THE HEADLINE GATE: Time.elapsed is monotonic across a level->level swap sharing a base, and there is exactly ONE Time entity after', async () => {
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/level1.json');

    // Simulate ticks: advance the live Time entity, as timeSystem would.
    const world1 = getCurrentWorld();
    world1.query(TimeLike).updateEach(([t]: any[]) => { t.elapsed = 12.5; t.frame = 700; t.timeScale = 0.3; });

    await sceneManager.loadScene('/level2.json');

    const world2 = getCurrentWorld();
    const timeRows: any[] = [];
    world2.query(TimeLike).updateEach(([t]: any[]) => timeRows.push({ ...t }));

    // Exactly one Time entity — the live bug the plan calls out (getTime is
    // queryFirst, timeSystem is query().updateEach — two entities means an
    // arbitrary winner for every read AND a double setJournalTick every frame).
    expect(timeRows).toHaveLength(1);
    // Carried, not reset to the base file's authored 0 — the headline gate.
    expect(timeRows[0].elapsed).toBe(12.5);
    expect(timeRows[0].frame).toBe(700);
    expect(timeRows[0].timeScale).toBe(0.3); // schema-only carry fidelity (Phase 0)

    // Base entities appear exactly once (not duplicated by a fresh reload).
    let cameraCount = 0;
    world2.query(EntityAttributes).updateEach(([attr]: any[]) => { if ((attr as any).name === 'Camera') cameraCount++; });
    expect(cameraCount).toBe(1);

    // Level1's own entity is gone; level2's is present.
    const names: string[] = [];
    world2.query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names).not.toContain('Level1Thing');
    expect(names).toContain('Level2Thing');
  });

  /** A9 defect 2 — the carry path never re-seeded override marks.
   *
   *  A carried snapshot is FLATTENED (no `overrides` map), and
   *  `instantiatePrefabIntoWorld` — the only place marks are normally seeded from
   *  a file — never runs on the carry path. So an authored override on a carried
   *  instance had nothing to gate on at serialize time and came back as "no
   *  override", reverting to the prefab's bare defaults on the next load.
   *
   *  Asserted PER ENTITY, not as a total count: mis-attributing per-entity
   *  bookkeeping across entities is the cross-contamination failure that got an
   *  earlier A8 attempt reverted, and a count-only assertion cannot see it. */
  it('carries override marks across a swap, attributed to the right entity (A9 defect 2)', async () => {
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();
    const { markOverride, getOverrideMarkSet } = await import('../../src/runtime/loaders/overrideMarks');

    const idsByName = (world: any) => {
      const out = new Map<string, number>();
      world.query(EntityAttributes).updateEach(([attr]: any[], e: any) => out.set((attr as any).name, e.id()));
      return out;
    };

    await sceneManager.loadScene('/level1.json');
    const before = idsByName(getCurrentWorld());
    // Two DIFFERENT carried base entities with DIFFERENT marks — the attribution test.
    markOverride(before.get('Camera')!, 'Transform', 'x');
    markOverride(before.get('Time')!, 'Time', 'timeScale');

    await sceneManager.loadScene('/level2.json'); // carries the base

    const after = idsByName(getCurrentWorld());
    // Fresh world → fresh ids, so this is a real remap, not an id coincidence.
    expect(after.get('Camera')).toBeDefined();
    expect(after.get('Time')).toBeDefined();

    expect([...(getOverrideMarkSet(after.get('Camera')!) ?? [])]).toEqual(['Transform.x']);
    expect([...(getOverrideMarkSet(after.get('Time')!) ?? [])]).toEqual(['Time.timeScale']);
  });

  it("the base's resources are NOT released across the swap (no re-fetch, refcount survives)", async () => {
    const { sceneManager } = await getSceneManager();
    const { getResourceStats } = await getCache();

    await sceneManager.loadScene('/level1.json');
    expect(fetchCalls['/materials/base.mat.json']).toBe(1);
    const statsAfterLevel1 = getResourceStats();
    expect(statsAfterLevel1.materials['/materials/base.mat.json']).toBe(1);

    await sceneManager.loadScene('/level2.json');

    // The base scene's FILE is re-fetched for chain-resolution METADATA (its own
    // guid/baseScene) on every load — resolving "is the chain still the same"
    // requires reading it. What must NOT happen is a RESOURCE re-fetch/re-acquire:
    // the base scene isn't reloaded (it's kept), so its material is untouched.
    expect(fetchCalls['/base.json']).toBe(2);
    expect(fetchCalls['/materials/base.mat.json']).toBe(1);
    // Still held (by the base's own unchanged sceneId) — level1's own material is gone.
    const stats = getResourceStats();
    expect(stats.materials['/materials/base.mat.json']).toBe(1);
    expect(stats.materials['/materials/l1.mat.json']).toBeUndefined();
    expect(stats.materials['/materials/l2.mat.json']).toBe(1);
  });

  it('getLoadedScenes reflects the chain — one primary + one base, correct roles', async () => {
    const { sceneManager } = await getSceneManager();
    await sceneManager.loadScene('/level1.json');

    const loaded = sceneManager.getLoadedScenes();
    expect(loaded.size).toBe(2);
    const entries = [...loaded.values()];
    const primary = entries.find((e) => e.role === 'primary');
    const base = entries.find((e) => e.role === 'base');
    expect(primary?.path).toBe('/level1.json');
    expect(base?.path).toBe('/base.json');
    expect(base?.guid).toBe(BASE_GUID);
  });

  // ── Phase 5 "editor bookkeeping" warning — fires on the CARRY, not on every fresh load ──

  it('a base with a prefab instance does NOT warn on its own fresh load', async () => {
    defineBaseWithPrefabInstance();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sceneManager } = await getSceneManager();

    await sceneManager.loadScene('/level1.json');

    expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('editor'))).toBe(false);
    warn.mockRestore();
  });

  it('warns exactly when a base containing a prefab instance is CARRIED across a swap, not before', async () => {
    defineBaseWithPrefabInstance();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sceneManager } = await getSceneManager();

    // Fresh load of level1 — base loads fresh too. No carry has happened yet.
    await sceneManager.loadScene('/level1.json');
    expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('does not survive this carry'))).toBe(false);

    // Swap to level2, which shares the SAME base guid — the base is now CARRIED
    // (kept, not freshly reloaded). This is the moment bookkeeping actually gets lost.
    await sceneManager.loadScene('/level2.json');
    expect(warn.mock.calls.some(([msg]) =>
      typeof msg === 'string' && msg.includes('/base.json') && msg.includes('does not survive this carry'),
    )).toBe(true);

    warn.mockRestore();
  });

  it('a resolved base hop re-registers its guid→path mapping, so a LATER chain walk referencing it by guid alone still resolves (338b1446 torn-read-race fix)', async () => {
    // Regression test for the SceneManager.ts half of 338b1446: "[sceneChain] could
    // not resolve <base-guid> while walking the chain" during a reload right after
    // Save All. Root cause was a torn write dropping the manifest's guid→path entry
    // for a base scene; the fix makes SceneManager itself re-register a resolved
    // base hop's mapping (fetchSceneMeta, SceneManager.ts ~line 305) instead of
    // depending SOLELY on the external asset-scanner rescan for that knowledge.
    //
    // To exercise the fix (not just the harness's own upfront registration in
    // beforeEach), this level references the base by its raw PATH, not its guid —
    // a `baseScene` locator that resolves WITHOUT any manifest lookup at all. That
    // first resolution is where the fix's registerAsset call fires for the first
    // time, seeding a mapping the manifest never had.
    fetchResponses['/level-path-base.json'] = {
      id: '20000000-0000-4000-8000-0000000000pb',
      version: 10,
      baseScene: '/base.json', // path-style ref, not BASE_GUID — bypasses resolveGuidToPath
      resources: [],
      entities: [{ id: 10, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'PathBaseLevel', parentId: 0 } } }],
    };
    // A second, independent level referencing the SAME base by GUID — this is the
    // hop that fails without the fix, since the manifest has no other source for
    // BASE_GUID→'/base.json' in this scenario.
    fetchResponses['/level-guid-base.json'] = {
      id: '20000000-0000-4000-8000-0000000000gb',
      version: 10,
      baseScene: BASE_GUID,
      resources: [],
      entities: [{ id: 10, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'GuidBaseLevel', parentId: 0 } } }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();
    const manifest = await import('../../src/runtime/loaders/assetManifest');

    // Simulate a fresh process where the scanner hasn't (yet) registered the base
    // scene's guid — the ONLY thing beforeEach normally provides for BASE_GUID.
    manifest.unregisterAsset(BASE_GUID);

    await sceneManager.loadScene('/level-path-base.json');
    // The base loaded fine (path-style ref needs no manifest lookup) — and the
    // fix means the manifest now knows BASE_GUID→'/base.json' too.
    expect(manifest.resolveGuidToPath(BASE_GUID)).toBe('/base.json');

    await sceneManager.loadScene('/level-guid-base.json');

    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    // The base's Camera entity must be present — without the fix, chain resolution
    // for '/level-guid-base.json' degrades to primary-only (the guid can't be
    // resolved), silently dropping the base from the world.
    expect(names).toContain('Camera');
    expect(names).toContain('GuidBaseLevel');
    expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('could not resolve'))).toBe(false);
    warn.mockRestore();
  });

  it('a swap to a level WITHOUT a baseScene drops the base entirely', async () => {
    fetchResponses['/level3.json'] = {
      id: '20000000-0000-4000-8000-000000000003',
      version: 10,
      resources: [],
      entities: [{ id: 30, traits: { Transform: { x: 3 }, EntityAttributes: { name: 'Level3Thing', parentId: 0 } } }],
    };
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();
    const { getResourceStats } = await getCache();

    await sceneManager.loadScene('/level1.json');
    await sceneManager.loadScene('/level3.json');

    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names).toEqual(['Level3Thing']);
    expect(sceneManager.getLoadedScenes().size).toBe(1);
    expect(getResourceStats().materials['/materials/base.mat.json']).toBeUndefined();
  });

  // ── Phase 6: save filtering + guards ──────────────────────────────────

  it('A4 duplicate-guid guard: a level sharing a guid with its base spawns it exactly once and warns', async () => {
    fetchResponses['/level-dupguid.json'] = {
      id: '20000000-0000-4000-8000-0000000000dd',
      version: 10,
      baseScene: BASE_GUID,
      resources: [],
      // Same guid as the base's Camera — the A4 scenario: a level duplicated
      // from another before it was thinned down to its own FieldSource.
      entities: [{ id: 10, traits: { Transform: { x: 9 }, EntityAttributes: { name: 'DupCamera', parentId: 0, guid: BASE_CAMERA_GUID } } }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/level-dupguid.json');

    const world = getCurrentWorld();
    let matches = 0;
    let matchedName = '';
    world.query(EntityAttributes).updateEach(([attr]: any[]) => {
      if ((attr as any).guid === BASE_CAMERA_GUID) { matches++; matchedName = (attr as any).name; }
    });
    // Exactly one entity carries the guid — the base's (root-most-base-first
    // load order means the base wins; the level's colliding duplicate is
    // dropped, not the other way around).
    expect(matches).toBe(1);
    expect(matchedName).toBe('Camera');
    expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Duplicate guid'))).toBe(true);
    warn.mockRestore();
  });

  it('cross-scene parenting guard: a level entity parented to a base entity warns at load', async () => {
    fetchResponses['/level-crossparent.json'] = {
      id: '20000000-0000-4000-8000-0000000000cc',
      version: 10,
      baseScene: BASE_GUID,
      resources: [],
      // parentId is the BASE camera's guid — a level entity reaching across
      // into the base scene's hierarchy (breaks save provenance + teardown).
      entities: [{ id: 10, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'ChildOfBase', parentId: BASE_CAMERA_GUID } } }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sceneManager } = await getSceneManager();

    await sceneManager.loadScene('/level-crossparent.json');

    expect(warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Cross-scene parenting'))).toBe(true);
    warn.mockRestore();
  });

  // ── Phase 12: A7 — forceReloadBases ────────────────────────────────────

  it('A7: a normal reload of the SAME primary keeps (carries) an unchanged-guid base — the fresh file content never reaches the world', async () => {
    const { sceneManager } = await getSceneManager();
    await sceneManager.loadScene('/level1.json');

    // Edit the base's file on disk (guid unchanged) and reload the SAME primary.
    // Chain resolution still re-fetches the base's raw bytes (it needs to read the
    // file's own `.baseScene`/`.id` to rebuild the chain graph EVERY load) — but the
    // base's guid still matches the old chain, so it is "kept" and its ENTITIES are
    // carried from the OLD in-memory snapshot, never respawned from this fresh
    // fetch. The fetch happening is not the bug; the fetched data never landing is.
    fetchResponses['/base.json'] = {
      ...fetchResponses['/base.json'] as object,
      entities: [
        { id: 1, traits: { Transform: { x: 999 }, EntityAttributes: { name: 'CameraEdited', parentId: 0, guid: BASE_CAMERA_GUID }, Renderable3D: { mesh: '', material: M('/materials/base.mat.json') } } },
        { id: 2, traits: { Time: { delta: 0, elapsed: 0, frame: 0, timeScale: 1 }, EntityAttributes: { name: 'Time', parentId: 0 } } },
      ],
    };
    await sceneManager.loadScene('/level1.json');

    const { getCurrentWorld } = await getWorld();
    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names).not.toContain('CameraEdited'); // stale copy still live
    expect(names).toContain('Camera'); // the ORIGINAL base entity, carried unchanged
  });

  it('A7 fix: forceReloadBases makes the SAME reload pick up the base\'s new file content', async () => {
    const { sceneManager } = await getSceneManager();
    await sceneManager.loadScene('/level1.json');
    const fetchesAfterFirstLoad = fetchCalls['/base.json'] ?? 0;

    fetchResponses['/base.json'] = {
      ...fetchResponses['/base.json'] as object,
      entities: [
        { id: 1, traits: { Transform: { x: 999 }, EntityAttributes: { name: 'CameraEdited', parentId: 0, guid: BASE_CAMERA_GUID }, Renderable3D: { mesh: '', material: M('/materials/base.mat.json') } } },
        { id: 2, traits: { Time: { delta: 0, elapsed: 0, frame: 0, timeScale: 1 }, EntityAttributes: { name: 'Time', parentId: 0 } } },
      ],
    };
    await sceneManager.loadScene('/level1.json', { forceReloadBases: [BASE_GUID] });

    expect(fetchCalls['/base.json'] ?? 0).toBeGreaterThan(fetchesAfterFirstLoad); // re-fetched
    const { getCurrentWorld } = await getWorld();
    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => names.push((attr as any).name));
    expect(names).toContain('CameraEdited');
    expect(names).not.toContain('Camera'); // the stale entity is gone, not duplicated
    // Still exactly one base entry in the chain, still correctly ROLE'd — forcing a
    // reload doesn't turn the base into a second primary or drop its role.
    const base = [...sceneManager.getLoadedScenes().values()].find((e) => e.role === 'base');
    expect(base?.guid).toBe(BASE_GUID);
  });
});
