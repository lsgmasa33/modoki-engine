/** A prefab instance's placeholder is unregistered when the loader replaces it (#1222 phase 4).
 *
 *  SceneManager's `onDeletePlaceholder` destroyed the placeholder with a bare `destroy()`. The placeholder
 *  carries the scene-authored root guid and sits in the guid index; the prefab root then reclaims its index
 *  and has the same guid stamped on without being indexed. `findEntityByGuid(rootGuid)` found the stale
 *  index entry, `guidOf(corpse)` read the root's guid back through the shared index, and the lookup answered
 *  with the DEAD placeholder: every scene-authored instance root read as gone to a liveness check.
 *
 *  Own file: every `loadScene` creates a koota World and koota caps them at 16 per module graph, which
 *  `sceneManagerBaseSceneChain.test.ts` already spends. Mocks mirror that file's (see its header for why
 *  Time/Input/EntityAttributes are mocked with the SAME trait objects the registry hands out). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
const TimeLike = trait({ delta: 0, elapsed: 0, frame: 0, smoothedDelta: 0, smoothedElapsed: 0, timeScale: 1 });
const InputLike = trait({});
const PrefabInstanceLike = trait({});

vi.mock('../../src/runtime/core/traits/Time', () => ({ Time: TimeLike }));
vi.mock('../../src/runtime/traits/Input', () => ({ Input: InputLike }));
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } } },
    { name: 'Time', trait: TimeLike, category: 'resource', fields: { timeScale: { type: 'number' } } },
    { name: 'Input', trait: InputLike, category: 'resource', fields: {} },
    { name: 'PrefabInstance', trait: PrefabInstanceLike, category: 'tag', fields: {} },
  ];
  return { getAllTraits: () => traits, getTraitByName: (name: string) => traits.find((t) => t.name === name) };
});

const fetchResponses: Record<string, unknown> = {};
// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => body });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

const PREFAB_GUID = '50000000-0000-4000-8000-0000000000f1';
const ROOT_GUID = '50000000-0000-4000-8000-0000000000f2';

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  fetchResponses['/p.prefab.json'] = {
    id: PREFAB_GUID,
    rootLocalId: 1,
    entities: [
      { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'PRoot', parentId: 0 } } },
      { localId: 2, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'PChild', parentId: 1 } } },
    ],
  };
  fetchResponses['/solo.json'] = {
    id: '20000000-0000-4000-8000-0000000000f3',
    version: 10,
    resources: [],
    entities: [
      { id: 7, prefab: PREFAB_GUID, guid: ROOT_GUID, traits: { Transform: { x: 3 }, EntityAttributes: { name: 'Inst', parentId: 0, guid: ROOT_GUID } } },
    ],
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(PREFAB_GUID, '/p.prefab.json', 'prefab');
});

describe('SceneManager — a prefab instance\'s placeholder is unregistered (#1222)', () => {
  // Mutation: restore the bare destroy in SceneManager's `onDeletePlaceholder`.
  it('the instance root is found by its scene guid ALIVE after a load', async () => {
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    const { getCurrentWorld, findEntityByGuid } = await import('../../src/runtime/core/ecs/world');

    await sceneManager.loadScene('/solo.json');

    const root = findEntityByGuid(ROOT_GUID, getCurrentWorld());
    expect((root?.get(EntityAttributes) as { name?: string } | undefined)?.name, 'premise: the instance was expanded').toBe('PRoot');
    expect(root!.isAlive(), 'the guid names the live root, not the destroyed placeholder').toBe(true);
  });
});
