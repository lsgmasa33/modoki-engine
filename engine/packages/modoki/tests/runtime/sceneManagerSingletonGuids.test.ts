/** The Time and Input singletons SceneManager materializes are addressable by guid, and neither reaches
 *  a scene file (#1248).
 *
 *  Before #1248 `spawnEntity` minted a guid only for an entity spawned WITH EntityAttributes, and both
 *  singletons are spawned without it. So they were the entities an agent could name only by a numeric id,
 *  which every reload reassigns. `spawnEntity` now gives every entity EntityAttributes. That also makes
 *  Input visible to the serializer, which it never was, so its spawn is tagged `Transient` like Time's.
 *
 *  Own file: every `loadScene` creates a koota World, and koota caps them at 16 per module graph. Mocks
 *  mirror `sceneManagerPlaceholderGuid.test.ts` (the SAME trait objects the registry hands out). */

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

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  fetchResponses['/plain.json'] = {
    id: '20000000-0000-4000-8000-0000000000e1',
    version: 10,
    resources: [],
    entities: [
      { id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Box', parentId: 0, guid: '20000000-0000-4000-8000-0000000000e2' } } },
    ],
  };
});

describe('SceneManager — the materialized singletons have guids (#1248)', () => {
  // Mutation: drop the EntityAttributes add in `spawnEntity` → both singletons lose their guid.
  it('Time and Input each carry a runtime guid that resolves back to them', async () => {
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    const { getCurrentWorld, findEntityByGuid } = await import('../../src/runtime/core/ecs/world');
    const { isRuntimeGuid } = await import('../../src/runtime/core/assetRefRules');

    await sceneManager.loadScene('/plain.json');
    const world = getCurrentWorld();

    for (const [label, t] of [['Time', TimeLike], ['Input', InputLike]] as const) {
      const e = world.queryFirst(t);
      expect(e, `premise: SceneManager materialized ${label}`).toBeDefined();
      const guid = (e!.get(EntityAttributes) as { guid?: string } | undefined)?.guid;
      expect(isRuntimeGuid(guid), `${label} has a runtime guid`).toBe(true);
      expect(findEntityByGuid(guid!, world), `${label}'s guid names ${label}`).toBe(e);
    }
  });

  // Mutation: drop `Transient` from either singleton spawn in SceneManager.
  it('both singletons are Transient, so a save writes neither', async () => {
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const { Transient } = await import('../../src/runtime/core/traits/Transient');

    await sceneManager.loadScene('/plain.json');
    const world = getCurrentWorld();

    expect(world.queryFirst(TimeLike)!.has(Transient), 'Time').toBe(true);
    expect(world.queryFirst(InputLike)!.has(Transient), 'Input').toBe(true);
  });
});
