/** Shared override-key enumeration (`prefabOverrideKeys.ts`) — the walk
 *  `ApplyPrefabDialog.tsx` and the `modoki_prefab {prefabAction:'overrides'|'apply'|'revert'}`
 *  agent op both build their key set from. Covers the four key-format helpers plus
 *  `collectInstanceOverrideKeys` finding a field override, an added entity, and a
 *  removed trait — the three diff categories a caller needs to see to act on any of
 *  them (`+added.*`/`-trait.*` shapes need their own coverage; a field-only fixture
 *  can't exercise them). Fixture setup mirrors revertOverrides.test.ts. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EngineFlame = trait({ idleScale: 0, boostScale: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EngineFlame', trait: EngineFlame, category: 'component', fields: { idleScale: 0, boostScale: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: any[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name, parentId: d.parentId, sortOrder: d.sortOrder ?? 0, traits: traitNamesOf(e) });
  });
  return out;
}
function findEntityImpl(id: number) { return index.get(id); }
function readTraitDataImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  if (meta.category === 'tag') return {};
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
function deleteEntitiesImpl(ids: number[]) {
  for (const id of ids) {
    const e = index.get(id);
    if (!e) continue;
    e.destroy();
    index.delete(id);
  }
}

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => findEntityImpl(id),
  markStructureDirty: vi.fn(),
  deleteEntities: (ids: number[]) => deleteEntitiesImpl(ids),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = findEntityImpl(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => writeTraitFieldImpl(id, meta, field, value),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
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

const SRC = 'dddddddd-0000-4000-8000-00000000d0e8';
// Two-member prefab: root "Ship" (localId 1) with child "Flame" (localId 2).
const shipPrefab = {
  id: SRC, version: 1 as const, name: 'Ship', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Ship', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Flame', traits: { Transform: { x: 0, y: 0, z: 0 }, EngineFlame: { idleScale: 0.1, boostScale: 3 }, EntityAttributes: { name: 'Flame', parentId: 1, guid: '' } } },
  ],
};

async function setup() {
  const m = await import('../../src/editor/scene/prefab');
  m.setPrefabCache(SRC, shipPrefab as any);
  const root = m.instantiatePrefab(shipPrefab as any);
  m.setPrefabSource(root, SRC);
  return { m, root };
}

describe('key-format helpers', () => {
  it('produce the exact string shapes applyToPrefabSelective/revertOverridesSelective consume', async () => {
    const { fieldKey, addedKey, removedEntityKey, removedTraitKey } = await import('../../src/editor/scene/prefabOverrideKeys');
    expect(fieldKey(2, 'EngineFlame', 'idleScale')).toBe('2.EngineFlame.idleScale');
    expect(addedKey('some-guid')).toBe('+added.some-guid');
    expect(removedEntityKey(2)).toBe('-removed.2');
    expect(removedTraitKey(2, 'EngineFlame')).toBe('-trait.2.EngineFlame');
  });
});

describe('collectInstanceOverrideKeys', () => {
  it('finds a field override', async () => {
    const { root } = await setup();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');

    const flameId = (() => { let id = 0; testWorld.query(PrefabInstance).updateEach(([pi], e) => { if ((pi as any).localId === 2 && (pi as any).rootInstanceId === root) id = e.id(); }); return id; })();
    writeTraitFieldImpl(flameId, TRAITS[1], 'idleScale', 0.5); markOverride(flameId, 'EngineFlame', 'idleScale');

    const prefab = shipPrefab as any;
    const keys = collectInstanceOverrideKeys(root, prefab);
    expect(keys.fields).toEqual(['2.EngineFlame.idleScale']);
    expect(keys.all).toContain('2.EngineFlame.idleScale');
    expect(keys.added).toEqual([]);
    expect(keys.removedTraits).toEqual([]);
  });

  it('finds an added entity', async () => {
    const { root } = await setup();
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');

    // A live plain child hanging under the root member, not itself a prefab member —
    // captureInstanceStructure classifies this as an "added" subtree.
    const extra = testWorld.spawn(
      EntityAttributes({ name: 'Antenna', parentId: root, guid: 'antenna-guid' }),
      Transform({ x: 1, y: 0, z: 0 }),
    );
    index.set(extra.id(), extra);

    const prefab = shipPrefab as any;
    const keys = collectInstanceOverrideKeys(root, prefab);
    expect(keys.added).toEqual(['+added.antenna-guid']);
    expect(keys.all).toContain('+added.antenna-guid');
  });

  it('finds a removed trait', async () => {
    const { root } = await setup();
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');

    // Remove EngineFlame (prefab-defined on Flame, localId 2) from the live member —
    // captureInstanceStructure records this as a removed-component diff.
    const flameId = (() => { let id = 0; testWorld.query(PrefabInstance).updateEach(([pi], e) => { if ((pi as any).localId === 2 && (pi as any).rootInstanceId === root) id = e.id(); }); return id; })();
    const flameEntity = index.get(flameId);
    flameEntity.remove(EngineFlame);

    const prefab = shipPrefab as any;
    const keys = collectInstanceOverrideKeys(root, prefab);
    expect(keys.removedTraits).toEqual(['-trait.2.EngineFlame']);
    expect(keys.all).toContain('-trait.2.EngineFlame');
  });
});

describe('the keys a caller must NOT be handed blindly (close-out review)', () => {
  it('an added subtree with NO guid is omitted and COUNTED, never keyed as "+added."', async () => {
    // `EntityAttributes.guid` is minted lazily, so an entity created this session and never
    // saved carries ''. Two such additions would both key to the identical string "+added.",
    // and that key mis-targets in BOTH directions: applyToPrefabSelective builds addedByGuid
    // from the same value (second overwrites first — only one subtree is inserted), and
    // subtractRevertedStructure's has(n.guid) matches both (reverting the single key tears
    // down two subtrees the caller could never have told apart). Omitting + counting is the
    // only honest answer: a key that cannot name one thing is worse than no key.
    const { root } = await setup();
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');

    for (const name of ['Unsaved A', 'Unsaved B']) {
      const e = testWorld.spawn(
        EntityAttributes({ name, parentId: root, guid: '' }),
        Transform({ x: 1, y: 0, z: 0 }),
      );
      index.set(e.id(), e);
    }

    const keys = collectInstanceOverrideKeys(root, shipPrefab as any);
    expect(keys.added).toEqual([]);                       // no ambiguous key offered
    expect(keys.all.filter((k) => k.startsWith('+added.'))).toEqual([]);
    expect(keys.unaddressableAdded).toBe(2);              // ...but the caller is TOLD
  });

  it('a guided addition alongside an unguided one is still offered', async () => {
    // The omission must be surgical — dropping the addressable sibling too would make the
    // guard worse than the bug.
    const { root } = await setup();
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');

    for (const [name, guid] of [['Named', 'real-guid'], ['Unsaved', '']] as const) {
      const e = testWorld.spawn(
        EntityAttributes({ name, parentId: root, guid }),
        Transform({ x: 1, y: 0, z: 0 }),
      );
      index.set(e.id(), e);
    }

    const keys = collectInstanceOverrideKeys(root, shipPrefab as any);
    expect(keys.added).toEqual(['+added.real-guid']);
    expect(keys.unaddressableAdded).toBe(1);
  });

  it('applyExcluded is empty when every override IS representable in a template', async () => {
    // The baseline half of the apply/revert asymmetry: a plain field override carries no
    // exclusion, so `apply` must not start reporting phantom skippedKeys for ordinary work.
    const { root } = await setup();
    const { collectInstanceOverrideKeys } = await import('../../src/editor/scene/prefabOverrideKeys');
    const keys = collectInstanceOverrideKeys(root, shipPrefab as any);
    expect(keys.applyExcluded).toEqual([]);
  });
});
