/** Explicit override marks: a recorded per-instance override must SURVIVE a
 *  serialize even when its value coincides with the prefab base (e.g. after the
 *  base was edited to match). Reproduces the reported bug: "edited the Engine
 *  Flame prefab position and lost the position override on the flames in the
 *  Spaceship prefab". The override was inferred from value!=base, so editing the
 *  base to a value an instance overrode collapsed the diff to zero and dropped it.
 *  Marks (seeded from the file's override map at apply, read at capture) fix it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
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
function readTraitDataImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  const data = e.get(meta.trait);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta.fields)) out[k] = data[k];
  return out;
}
function writeTraitFieldImpl(id: number, meta: any, field: string, value: unknown) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return;
  e.set(meta.trait, { ...e.get(meta.trait), [field]: value });
}

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));
vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => writeTraitFieldImpl(id, meta, field, value),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

beforeEach(async () => {
  testWorld = createWorld();
  index.clear();
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});

const getModule = () => import('../../src/editor/scene/prefab');

const CHILD = 'cccccccc-0000-4000-8000-00000000c0e8';

/** Engine-Flame-like child prefab: a single root with a Transform position. */
const childAtX = (x: number) => ({
  id: CHILD, version: 1 as const, name: 'Flame', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Flame', traits: { Transform: { x, y: 0, z: 0 }, EntityAttributes: { name: 'Flame', parentId: 0, guid: '' } } }],
});

describe('override mark survival across a base edit', () => {
  it('keeps a position override even after the prefab base is edited to match it', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();

    // Child base at x=0. Instantiate, then apply a recorded override x=-4.1 (as
    // loading from a parent file would, via applyOverridesByRootInstance).
    const oldChild = childAtX(0);
    setPrefabCache(CHILD, oldChild as any);
    const root = instantiatePrefab(oldChild as any);
    setPrefabSource(root, CHILD);
    const { applyOverridesByRootInstance } = await getModule();
    applyOverridesByRootInstance(root, { 1: { Transform: { x: -4.1 } } });

    // Sanity: with the OLD base (x=0), the override is captured (value != base).
    expect(captureInstanceOverrides(root, oldChild as any)[1]?.Transform?.x).toBe(-4.1);

    // Now the user edits the CHILD prefab base to x=-4.1 (coincides with the
    // override). Re-cache the new base and re-capture against it.
    const newChild = childAtX(-4.1);
    setPrefabCache(CHILD, newChild as any);
    const captured = captureInstanceOverrides(root, newChild as any);

    // BUG (pre-fix): diff(-4.1, base -4.1) == 0 → override dropped.
    // FIX: the field is MARKED, so it's emitted with its live value regardless.
    expect(captured[1]?.Transform?.x).toBe(-4.1);
  });

  it('a non-overridden member that coincidentally matches base reports NO override', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    const child = childAtX(0);
    setPrefabCache(CHILD, child as any);
    const root = instantiatePrefab(child as any);
    setPrefabSource(root, CHILD);
    // No override applied, no edit → no mark → nothing captured.
    const captured = captureInstanceOverrides(root, child as any);
    expect(captured[1]).toBeUndefined();
  });

  it('a user edit on an instance member marks the field so it survives a base edit', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    const oldChild = childAtX(0);
    setPrefabCache(CHILD, oldChild as any);
    const root = instantiatePrefab(oldChild as any);
    setPrefabSource(root, CHILD);

    // Simulate a user edit: set the live value AND mark it (what entityActions does).
    writeTraitFieldImpl(root, TRAITS[0], 'x', 7);
    markOverride(root, 'Transform', 'x');

    // Edit the base to 7 (coincides). The marked override must still serialize.
    const newChild = childAtX(7);
    setPrefabCache(CHILD, newChild as any);
    expect(captureInstanceOverrides(root, newChild as any)[1]?.Transform?.x).toBe(7);
  });
});
