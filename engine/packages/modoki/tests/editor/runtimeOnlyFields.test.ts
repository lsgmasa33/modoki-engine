/** Generic `runtimeOnly` field attribute — fields a trait marks `runtimeOnly`
 *  (recomputed each frame, e.g. Time.elapsed/frame) are EXCLUDED from scene
 *  serialization, while un-marked fields (e.g. the authored Time.timeScale) still
 *  persist. Guards against a scene save baking a transient runtime snapshot and
 *  churning the file on every save. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0, isActive: true, layer: '' as string });
// A Time-like resource: timeScale is authored; the rest are pure runtime state.
const TimeLike = trait({ timeScale: 1, delta: 0, elapsed: 0, frame: 0, smoothedDelta: 0, smoothedElapsed: 0 });

const TRAITS = [
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, parentId: { entityId: { onMissing: 'root' } }, guid: {}, sortOrder: {}, isActive: {}, layer: {} } },
  {
    name: 'TimeLike', trait: TimeLike, category: 'resource',
    fields: {
      // timeScale intentionally NOT marked → persists.
      delta: { type: 'number', runtimeOnly: true },
      elapsed: { type: 'number', runtimeOnly: true },
      frame: { type: 'number', runtimeOnly: true },
      smoothedDelta: { type: 'number', runtimeOnly: true },
      smoothedElapsed: { type: 'number', runtimeOnly: true },
    },
  },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name as string, parentId: d.parentId as number, sortOrder: (d.sortOrder as number) ?? 0, traits: traitNamesOf(e) });
  });
  return out;
}

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: () => null,
  // Mirrors the real readTraitDataFull: the keys a trait PERSISTS — its koota
  // schema for a SoA trait, the live object's own keys for AoS — NOT the
  // meta.fields Inspector subset that readTraitData reads.
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = index.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
  writeTraitField: vi.fn(),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), getCachedPrefab: vi.fn(() => null) }));
let guidN = 0;
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => `guid-${++guidN}`,
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  getAssetType: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  isExternalUrl: () => false,
  isInternalAssetPath: () => false,
  resolveRef: (g: string) => g,
  deriveGuid: (seed: string) => `derived-${seed}`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
vi.mock('../../src/runtime/scene/SceneManager', () => ({ sceneManager: { loadScene: vi.fn(), getLoadedScenes: () => new Map() } }));
vi.mock('../../src/editor/undo/undoManager', () => ({ clearHistory: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); index.clear(); guidN = 0; });

describe('runtimeOnly field serialization', () => {
  it('excludes runtimeOnly fields but keeps the authored field', async () => {
    const e = testWorld.spawn(
      EntityAttributes({ name: 'Time', guid: 'aaaa-bbbb', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
      TimeLike({ timeScale: 0.5, delta: 0.016, elapsed: 23511, frame: 1579504, smoothedDelta: 0.016, smoothedElapsed: 16117 }),
    );
    index.set(e.id(), e);

    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const scene = await serializeScene();

    const entry = scene.entities.find((x) => x.name === 'Time')!;
    expect(entry).toBeDefined();
    const t = entry.traits.TimeLike as Record<string, unknown>;
    // Authored knob persists…
    expect(t.timeScale).toBe(0.5);
    // …runtime state does not (would otherwise churn the scene every save).
    expect(t).not.toHaveProperty('delta');
    expect(t).not.toHaveProperty('elapsed');
    expect(t).not.toHaveProperty('frame');
    expect(t).not.toHaveProperty('smoothedDelta');
    expect(t).not.toHaveProperty('smoothedElapsed');
  });

  it('serializes every NON-DEFAULT field for a trait with no runtimeOnly markings', async () => {
    const e = testWorld.spawn(
      // sortOrder/isActive deliberately set AWAY from their schema defaults (0/true),
      // so this test pins the runtimeOnly filter alone. A field can now be absent for
      // two independent reasons — runtimeOnly, or "still equal to its default" — and
      // an assertion that can't tell them apart passes for the wrong reason. The
      // default-omission rule gets its own test below.
      EntityAttributes({ name: 'Plain', guid: 'cccc-dddd', parentId: 0, sortOrder: 7, isActive: false, layer: '2d' }),
    );
    index.set(e.id(), e);

    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const scene = await serializeScene();
    const entry = scene.entities.find((x) => x.name === 'Plain')!;
    const ea = entry.traits.EntityAttributes as Record<string, unknown>;
    // EntityAttributes marks nothing runtimeOnly → every authored field round-trips.
    expect(ea).toHaveProperty('name', 'Plain');
    expect(ea).toHaveProperty('sortOrder', 7);
    expect(ea).toHaveProperty('isActive', false);
    expect(ea).toHaveProperty('layer', '2d');
    // parentId now serializes as a GUID ('' for a root entity), not a koota id. It is
    // written unconditionally (guid-ified after the field loop), so the default rule
    // never applies to it.
    expect(ea).toHaveProperty('parentId', '');
  });

  it('omits a field still holding its schema default — defaults stay LIVE instead of being frozen into the file', async () => {
    const e = testWorld.spawn(
      EntityAttributes({ name: 'Defaulted', guid: 'eeee-ffff', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );
    index.set(e.id(), e);

    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const scene = await serializeScene();
    const entry = scene.entities.find((x) => x.name === 'Defaulted')!;
    const ea = entry.traits.EntityAttributes as Record<string, unknown>;
    // Authored (differs from the '' default) → written.
    expect(ea).toHaveProperty('name', 'Defaulted');
    expect(ea).toHaveProperty('guid', 'eeee-ffff');
    // Untouched defaults → absent, so a later change to the trait default still
    // reaches this scene. The loader rebuilds them via `meta.trait(partialData)`.
    expect(ea).not.toHaveProperty('sortOrder');
    expect(ea).not.toHaveProperty('isActive');
    expect(ea).not.toHaveProperty('layer');
  });

  it("serializes a child's parentId as the parent's GUID (not the koota id)", async () => {
    const parent = testWorld.spawn(
      EntityAttributes({ name: 'Parent', guid: 'parent-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );
    index.set(parent.id(), parent);
    const child = testWorld.spawn(
      EntityAttributes({ name: 'Child', guid: 'child-guid', parentId: parent.id(), sortOrder: 0, isActive: true, layer: '' }),
    );
    index.set(child.id(), child);

    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const scene = await serializeScene();
    const pe = scene.entities.find((x) => x.name === 'Parent')!;
    const ce = scene.entities.find((x) => x.name === 'Child')!;
    expect((pe.traits.EntityAttributes as Record<string, unknown>).parentId).toBe('');            // root
    expect((ce.traits.EntityAttributes as Record<string, unknown>).parentId).toBe('parent-guid'); // parent's guid
  });
});
