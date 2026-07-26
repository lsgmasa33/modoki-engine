/** Persistent-snapshot FIDELITY (base-scene plan, Phase 0).
 *
 *  The carry-across-a-swap snapshot must serialize a trait's koota `.schema`
 *  field set, not just the curated Inspector `meta.fields`. `meta.fields` is
 *  deliberately a SUBSET (see sceneSchema.ts), so snapshotting through it
 *  silently drops real runtime state. Two concrete losses this pins:
 *    - `Time.timeScale` — in Time's koota schema, NOT in its registered fields.
 *    - AoS fields (AnimationLibrary.animSets, SkinnedMeshRenderer.materials) —
 *      never in `meta.fields` at all.
 *
 *  Mocks fetch() for the two scene files and the trait registry, mirroring
 *  SceneManager.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

// ── Test traits ──────────────────────────────────────────────────────────

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });
// Mirrors the real Time trait: `timeScale` IS in the koota schema but is NOT
// one of the registered Inspector fields (engine/app/ecs/registerTraits.ts).
const TimeLike = trait({ delta: 0, elapsed: 0, frame: 0, timeScale: 1 });
// AoS trait — schema is a factory, and its field is not in meta.fields.
const AnimationLibraryLike = trait(() => ({ animSets: [] as unknown[] }));

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
    // NOTE: timeScale deliberately absent from `fields` — that is the bug's shape.
    { name: 'TimeLike', trait: TimeLike, category: 'resource', fields: { delta: { type: 'number' }, elapsed: { type: 'number' }, frame: { type: 'number' } } },
    { name: 'AnimationLibraryLike', trait: AnimationLibraryLike, category: 'component', fields: {} },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
  };
});

// ── fetch() mock ────────────────────────────────────────────────────────

const fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return { ok: true, json: async () => body } as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as Response;
});

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];

  fetchResponses['/sceneA.json'] = {
    version: 6,
    resources: [],
    entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'A1', parentId: 0 } } }],
  };
  fetchResponses['/sceneB.json'] = {
    version: 6,
    resources: [],
    entities: [{ id: 2, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'B1', parentId: 0 } } }],
  };

  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;

  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

describe('persistent snapshot fidelity', () => {
  it('carries schema-only fields (Time.timeScale shape) and AoS fields across a scene swap', async () => {
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');

    await sceneManager.loadScene('/sceneA.json');

    const root = getCurrentWorld().spawn(
      Transform({ x: 5 }),
      EntityAttributes({ name: 'Session', parentId: 0 }),
      TimeLike({ delta: 0.016, elapsed: 12.5, frame: 700, timeScale: 0.3 }),
      AnimationLibraryLike({ animSets: [{ name: 'idle' }] }),
    );
    markPersistent(root, 'test-guid-session');

    await sceneManager.loadScene('/sceneB.json');

    const newWorld = getCurrentWorld();
    const carried: Record<string, unknown>[] = [];
    newWorld.query(TimeLike).updateEach(([t]: Record<string, unknown>[]) => {
      carried.push({ ...t });
    });

    expect(carried).toHaveLength(1);
    expect(carried[0].elapsed).toBe(12.5);   // registered field — passed before the fix too
    expect(carried[0].frame).toBe(700);
    expect(carried[0].timeScale).toBe(0.3);  // schema-only field — the bug

    const sets: unknown[] = [];
    newWorld.query(AnimationLibraryLike).updateEach(([a]: Record<string, unknown>[]) => {
      sets.push(a.animSets);
    });
    expect(sets).toEqual([[{ name: 'idle' }]]);
  });
});
