/** #1417 review: SceneManager must never count the OLD PRIMARY as a kept base. Opening a base scene
 *  itself, then a level whose `baseScene` is that file, used to mark the base "kept" — but a
 *  primary's entities carry `sourceScene: ''`, so the carry snapshotted nothing, the base's content
 *  vanished from the world, and `getLoadedScenes()` listed two primaries.
 *
 *  Own file for the koota world budget (16): sceneManagerBaseSceneChain.test.ts, whose harness this
 *  copies, has none left. */

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
  // Keyed by the packed entity, like the real module (#868).
  const marks = new Map<number, Set<string>>();
  const setFor = (e: { valueOf(): number }) => {
    let s = marks.get(e.valueOf());
    if (!s) { s = new Set(); marks.set(e.valueOf(), s); }
    return s;
  };
  return {
    markOverride: (e: { valueOf(): number }, t: string, f: string) => { setFor(e).add(`${t}.${f}`); },
    restoreOverrideMarks: (e: { valueOf(): number }, keys: Iterable<string>) => { const s = setFor(e); for (const k of keys) s.add(k); },
    getOverrideMarkSet: (e: { valueOf(): number }) => marks.get(e.valueOf()),
    clearOverrideMarks: (e: { valueOf(): number }) => { marks.delete(e.valueOf()); },
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

describe('SceneManager: the old primary is never a kept base (#1417 review)', () => {
  it('#1417 review: the old PRIMARY becoming a base is reloaded, not "kept" — its entities have no sourceScene to carry by', async () => {
    const { sceneManager } = await getSceneManager();
    await sceneManager.loadScene('/base.json'); // open the base scene ITSELF
    const next = await sceneManager.loadScene('/level1.json'); // a level whose baseScene is that file

    expect(next.keptBaseGuids.size).toBe(0);
    const { getCurrentWorld } = await getWorld();
    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => { const n = (attr as { name: string }).name; if (n) names.push(n); }); // unnamed = a materialized Time/Input (#1248)
    expect(names).toContain('Camera'); // the base's content, loaded fresh as a base
    const roles = [...sceneManager.getLoadedScenes().values()].map((e) => e.role).sort();
    expect(roles).toEqual(['base', 'primary']);
  });
});
