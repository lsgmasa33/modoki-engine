/** Detach prefab instance (editor "Detach Prefab"). Severing the prefab link
 *  must strip the `PrefabInstance` trait off the instance root AND every
 *  descendant — including nested-instance members — turning the live tree into
 *  plain, unlinked entities. The captured snapshot must restore every trait on
 *  undo (reattach). Other traits (Transform, etc.) are untouched. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
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
  readTraitData: vi.fn(),
  writeTraitField: vi.fn(),
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });

const getModule = () => import('../../src/editor/scene/prefab');

const SRC = 'aaaaaaaa-0000-4000-8000-00000000 src1'.replace(' src1', '0001');
const INNER_SRC = 'aaaaaaaa-0000-4000-8000-00000000 src2'.replace(' src2', '0002');

/** Spawn a 3-deep instance tree:
 *   Root (instance root, src SRC) → Child (member) → InnerRoot (nested instance,
 *   src INNER_SRC) → InnerChild (nested member). */
function spawnNestedInstance() {
  const root = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Root', parentId: 0 }), PrefabInstance({ source: SRC, localId: 1, rootInstanceId: 0 }));
  index.set(root.id(), root);
  root.set(PrefabInstance, { source: SRC, localId: 1, rootInstanceId: root.id() });

  const child = testWorld.spawn(Transform({ x: 2 }), EntityAttributes({ name: 'Child', parentId: root.id() }), PrefabInstance({ source: SRC, localId: 2, rootInstanceId: root.id() }));
  index.set(child.id(), child);

  const innerRoot = testWorld.spawn(Transform({ x: 3 }), EntityAttributes({ name: 'InnerRoot', parentId: child.id() }), PrefabInstance({ source: INNER_SRC, localId: 1, rootInstanceId: 0 }));
  index.set(innerRoot.id(), innerRoot);
  innerRoot.set(PrefabInstance, { source: INNER_SRC, localId: 1, rootInstanceId: innerRoot.id() });

  const innerChild = testWorld.spawn(Transform({ x: 4 }), EntityAttributes({ name: 'InnerChild', parentId: innerRoot.id() }), PrefabInstance({ source: INNER_SRC, localId: 2, rootInstanceId: innerRoot.id() }));
  index.set(innerChild.id(), innerChild);

  return { root, child, innerRoot, innerChild };
}

const hasPI = (e: any) => e.has(PrefabInstance);

describe('detachPrefabInstance', () => {
  it('strips PrefabInstance off the root and every descendant (nested included)', async () => {
    const { detachPrefabInstance } = await getModule();
    const { root, child, innerRoot, innerChild } = spawnNestedInstance();

    const snapshot = detachPrefabInstance(root.id());

    // All four entities had PrefabInstance → four captured, none left.
    expect(snapshot).toHaveLength(4);
    expect(hasPI(root)).toBe(false);
    expect(hasPI(child)).toBe(false);
    expect(hasPI(innerRoot)).toBe(false);
    expect(hasPI(innerChild)).toBe(false);

    // Other traits are untouched — entities still exist with their transforms.
    expect(root.has(Transform)).toBe(true);
    expect((innerChild.get(Transform) as Record<string, number>).x).toBe(4);
    expect(getAllEntitiesImpl()).toHaveLength(4);
  });

  it('reattach restores every captured PrefabInstance trait (undo)', async () => {
    const { detachPrefabInstance, reattachPrefabInstance } = await getModule();
    const { root, child, innerRoot, innerChild } = spawnNestedInstance();

    const snapshot = detachPrefabInstance(root.id());
    reattachPrefabInstance(snapshot);

    expect(hasPI(root)).toBe(true);
    expect(hasPI(child)).toBe(true);
    expect(hasPI(innerRoot)).toBe(true);
    expect(hasPI(innerChild)).toBe(true);

    // Inner members keep their OWN (inner) source + rootInstanceId, not the outer's.
    expect((innerRoot.get(PrefabInstance) as Record<string, unknown>).source).toBe(INNER_SRC);
    expect((innerRoot.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(innerRoot.id());
    expect((child.get(PrefabInstance) as Record<string, unknown>).source).toBe(SRC);
    expect((child.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(root.id());
  });

  it('returns an empty snapshot for a plain (non-instance) entity', async () => {
    const { detachPrefabInstance } = await getModule();
    const plain = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Plain', parentId: 0 }));
    index.set(plain.id(), plain);

    expect(detachPrefabInstance(plain.id())).toHaveLength(0);
  });
});
