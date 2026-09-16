/** SceneManager passes the scene's path down, so #1268's derivation actually runs in production.
 *
 *  `SceneManager` is the only non-test caller of `loadSceneFile`, so the single line
 *  `scenePath: ref.path` IS the entire production reach of #1268. Every other test for the feature
 *  calls `loadSceneFile` directly with an explicit path, which means deleting that line — by a tidy-up
 *  or a bad merge — left 16 tests green and the fix inert: real scene loads would derive nothing, and
 *  the next clone to open an unmigrated scene and save it would mint a random guid again and move the
 *  entity in the file. Exactly the defect, back, silently. This file closes that gap.
 *
 *  Own file: every `loadScene` creates a koota World and koota caps them at 16 per module graph.
 *  Mocks mirror `sceneManagerSingletonGuids.test.ts` (the SAME trait objects the registry hands out).
 *
 *  ⚠️ NOT covered here, deliberately: the opposite direction, `SceneManager`'s carried-snapshot call
 *  passing NO path. A carried entity is a `Persistent` one, and `markPersistent` guarantees it a
 *  durable guid before it can ever be snapshotted — so the derivation would decline to touch it even
 *  if a path were passed. A test there could not fail, and one that cannot fail is not coverage. */

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

vi.mock('../../src/runtime/core/traits/Time', () => ({ Time: TimeLike }));
vi.mock('../../src/runtime/traits/Input', () => ({ Input: InputLike }));
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } } },
    { name: 'Time', trait: TimeLike, category: 'resource', fields: { timeScale: { type: 'number' } } },
    { name: 'Input', trait: InputLike, category: 'resource', fields: {} },
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

const SCENE_PATH = '/bare.json';

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  fetchResponses[SCENE_PATH] = {
    id: '20000000-0000-4000-8000-0000000000f1',
    version: 10,
    resources: [],
    entities: [
      // The pre-#1248 shape the whole issue is about: a named entry with NO EntityAttributes.
      { id: 1, name: 'Bare Root', traits: { Transform: { x: 7 } } },
    ],
  };
});

describe('SceneManager wires #1268 derivation through to a real scene load', () => {
  // Mutation: delete `scenePath: ref.path` in SceneManager's chain-load call → the entity falls back
  // to a runtime guid and both assertions below go red. That mutation turns NOTHING else red, which
  // is precisely why this file exists.
  it('gives a guid-less entry the guid derived from the path it loaded, not a runtime one', async () => {
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    const { getCurrentWorld, findEntityByGuid } = await import('../../src/runtime/core/ecs/world');
    const { isRuntimeGuid, deriveGuid } = await import('../../src/runtime/core/assetRefRules');

    await sceneManager.loadScene(SCENE_PATH);
    const world = getCurrentWorld();

    const expected = deriveGuid(`scene:${SCENE_PATH}|path:/Bare Root`);
    // Aimed by GUID, not by `queryFirst(Transform)`: a trait aim would go red for the wrong
    // reason the day a Transform-bearing singleton is added, and it tells us nothing about
    // addressability — which is half of what #1210/#1248 were for.
    const entity = findEntityByGuid(expected, world);
    expect(entity, 'the derived guid names the spawned entry').toBeDefined();
    const guid = (entity!.get(EntityAttributes) as { guid?: string } | undefined)?.guid;

    // ⚠️ Assert PRESENT before asserting not-runtime: `isRuntimeGuid(undefined)` is false, so the
    // next line alone would pass for an entity that has no guid at all.
    expect(typeof guid, 'premise: the entry carries a guid').toBe('string');
    expect(isRuntimeGuid(guid), 'a runtime guid here means the derivation never ran').toBe(false);
    expect(guid).toBe(expected);
  });
});
