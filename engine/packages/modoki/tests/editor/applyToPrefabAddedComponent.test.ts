/** applyToPrefabSelective — applying an ADDED component (a trait the prefab lacks
 *  at that localId) must write the whole trait into the prefab file. Regression
 *  for the silent-drop bug: the value path did `if (!traitBag) continue`, so a
 *  user-added component (e.g. ShipShake) was never persisted on Apply-to-Prefab.
 *
 *  Drives the real applyToPrefabSelective. The dev-server write is stubbed to
 *  capture the serialized prefab and return not-ok, which stops the function
 *  before the heavy refresh — we only need to assert what would be written. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, sortOrder: 0, parentId: 0, guid: '' as string, editorFolder: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });
const ShipShake = trait({ posAmpX: 0, posAmpY: 0, speed: 0 });
// Animator-shaped: `clips` PERSISTS (koota schema) but has no Inspector row —
// a custom section renders it. `activeClip` is runtime read-back.
const Animator = trait({ clips: '[]' as string, speed: 1, activeClip: '' as string });
// AoS (callback schema): its fields are OBJECTS/ARRAYS held by reference in the
// live trait store — the aliasing hazard when applying one into a template.
const AnimationLibrary = trait(() => ({ animSets: [] as string[], retarget: false }));

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, sortOrder: 0, parentId: 0, guid: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
  { name: 'ShipShake', trait: ShipShake, category: 'component', fields: { posAmpX: 0, posAmpY: 0, speed: 0 } },
  { name: 'Animator', trait: Animator, category: 'component', fields: { speed: {}, activeClip: { runtimeOnly: true } } },
  { name: 'AnimationLibrary', trait: AnimationLibrary, category: 'component', fields: { retarget: {} } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();
let entityInfos: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];

vi.mock('../../src/runtime/core/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => entityIndex.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); entityIndex.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => entityIndex.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => entityIndex.delete(e.id()))(e); e.destroy(); },
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => entityInfos,
  findEntity: (id: number) => entityIndex.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  writeTraitField: vi.fn(),
  readTraitData: (id: number, meta: any) => {
    const e = entityIndex.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(meta.fields)) out[k] = data[k];
    return out;
  },
  // Mirrors the real readTraitDataFull: the keys a trait PERSISTS — its koota
  // schema for a SoA trait, the live object's own keys for AoS.
  readTraitDataFull: (id: number, meta: any) => {
    const e = entityIndex.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

// Capture what would be written to disk; return not-ok so applyToPrefabSelective
// stops before refreshAllInstances (we only assert the serialized prefab).
let writtenContent: string | null = null;
/** Most tests stop the flow by failing the write; the aliasing test needs it to
 *  succeed so prefabCache.set runs. */
let writeOk = false;
// @ts-expect-error mock global
global.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.includes('/api/write-file') && init?.body) {
    writtenContent = JSON.parse(init.body).content;
  }
  return { ok: writeOk, json: async () => ({ ok: writeOk }) } as Response;
});

async function getModule() { return import('../../src/editor/scene/prefab'); }

const ROOT = 500;
const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'; // prefab source GUID

function makeOldPrefab() {
  // Prefab root (localId 1) has Transform + EntityAttributes but NO ShipShake.
  return {
    id: SRC, version: 1 as const, name: 'ship', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Ship', parentId: 0 } } }],
  };
}

/** TOP-LEVEL, not inside one describe: every describe in this file needs the same
 *  fresh world + cleared capture. Nested inside the first block it silently did
 *  NOT run for the others, so a later test read the previous block's leftovers —
 *  which is exactly how a passing assertion can mean nothing. */
beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
  entityInfos = [];
  writtenContent = null;
});

describe('applyToPrefabSelective — added component persists to the prefab', () => {

  it('writes the whole added trait (with live values) into the prefab file', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, makeOldPrefab() as any);

    // Live instance root: a prefab member (localId 1) the user gave a ShipShake.
    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      ShipShake({ posAmpX: 0.5, posAmpY: 0.25, speed: 3 }),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: ROOT }),
    );
    // Re-key on the real spawned id (ROOT is only a label; rootInstanceId must match id()).
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos.push({ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'ShipShake', 'PrefabInstance'] });

    // The dialog emits one key per overridden field of the added trait.
    await applyToPrefabSelective(rootId, new Set(['1.ShipShake.speed', '1.ShipShake.posAmpX']));

    expect(writtenContent).toBeTruthy();
    const written = JSON.parse(writtenContent!);
    const ship = written.entities.find((e: any) => e.localId === 1);
    expect(ship.traits.ShipShake).toBeDefined();
    // Seeded from the full live trait, so all fields are present (not just the keyed ones).
    expect(ship.traits.ShipShake).toMatchObject({ posAmpX: 0.5, posAmpY: 0.25, speed: 3 });
    // Pre-existing prefab traits remain intact.
    expect(ship.traits.Transform).toBeDefined();
    expect(ship.traits.EntityAttributes).toBeDefined();
  });
});

/** The same wrong equivalence as the override-capture bug, in the APPLY direction:
 *  `applyToPrefabSelective` gated on `fieldName in meta.fields` and then read via
 *  the curated `readTraitData`. So "Apply to Prefab" on a field a custom Inspector
 *  section owns (Animator.clips) skipped the key and changed nothing — while
 *  reporting success. See runtime/core/ecs/traitSchema.ts. */
describe('applyToPrefabSelective — a field with no Inspector row', () => {
  const BANK = JSON.stringify([{ name: 'skin', clip: 'f1cc3b85-2c23-457b-938a-3470ada21b36' }]);

  /** Prefab root already HAS an Animator with an empty bank, so this exercises the
   *  value-overlay path (not the added-component seed). */
  function prefabWithAnimator() {
    return {
      id: SRC, version: 1 as const, name: 'ship', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Ship', traits: {
        Transform: { x: 0, y: 0, z: 0 },
        EntityAttributes: { name: 'Ship', parentId: 0 },
        Animator: { clips: '[]', speed: 1 },
      } }],
    };
  }

  function spawnInstance(animator: Record<string, unknown>) {
    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      Animator(animator as never),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: ROOT }),
    );
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos.push({ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'Animator', 'PrefabInstance'] });
    return rootId;
  }

  it('APPLIES a clips override to the prefab instead of silently skipping it', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, prefabWithAnimator() as any);
    const rootId = spawnInstance({ clips: BANK, speed: 1, activeClip: '' });

    await applyToPrefabSelective(rootId, new Set(['1.Animator.clips']));

    expect(writtenContent).toBeTruthy();
    const written = JSON.parse(writtenContent!);
    expect(written.entities[0].traits.Animator.clips).toBe(BANK);
  });

  it('does NOT bake a runtimeOnly read-back field into the template', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, prefabWithAnimator() as any);
    const rootId = spawnInstance({ clips: BANK, speed: 1, activeClip: 'skin' });

    await applyToPrefabSelective(rootId, new Set(['1.Animator.clips', '1.Animator.activeClip']));

    const written = JSON.parse(writtenContent!);
    expect(written.entities[0].traits.Animator.clips).toBe(BANK);
    expect(written.entities[0].traits.Animator).not.toHaveProperty('activeClip');
  });
});

/** Applying an AoS object/array field must COPY it into the template. The
 *  meta.fields gate used to exclude such fields entirely; now that they apply,
 *  writing the live reference would alias the cached prefab to one instance —
 *  editing that instance afterwards would silently rewrite the template.
 *
 *  This one lets the write SUCCEED (the other tests stub it not-ok to stop early),
 *  because the alias only becomes reachable once `prefabCache.set(source, newPrefab)`
 *  runs. An assertion made before that point passes with or without the clone —
 *  measured, so don't "simplify" this back. */
describe('applyToPrefabSelective — a non-scalar field is copied, not aliased', () => {
  it('leaves the cached prefab holding a COPY, so later live edits do not rewrite it', async () => {
    const { setPrefabCache, applyToPrefabSelective, getCachedPrefabSync } = await getModule();
    setPrefabCache(SRC, {
      id: SRC, version: 1 as const, name: 'ship', rootLocalId: 1,
      entities: [{ localId: 1, name: 'Ship', traits: {
        Transform: { x: 0, y: 0, z: 0 },
        EntityAttributes: { name: 'Ship', parentId: 0 },
        AnimationLibrary: { animSets: [], retarget: false },
      } }],
    } as any);

    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      AnimationLibrary({ animSets: ['set-a'], retarget: true } as never),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: ROOT }),
    );
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos.push({ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'AnimationLibrary', 'PrefabInstance'] });

    writeOk = true;
    try {
      await applyToPrefabSelective(rootId, new Set(['1.AnimationLibrary.animSets']));
    } finally {
      writeOk = false;
    }

    const cachedSets = (getCachedPrefabSync(SRC) as any)?.entities?.[0]?.traits?.AnimationLibrary?.animSets;
    expect(cachedSets).toEqual(['set-a']);   // the value did reach the template

    // Now mutate the LIVE array. Without the clone this is the same object and
    // the template silently gains 'set-b'.
    (root.get(AnimationLibrary) as { animSets: string[] }).animSets.push('set-b');
    expect(getCachedPrefabSync(SRC)!.entities[0].traits.AnimationLibrary).toEqual(
      expect.objectContaining({ animSets: ['set-a'] }),
    );
  });
});

/** The scene-only rule holds on BOTH template-writing paths. Applying an
 *  editorFolder override into a prefab would file every future instance under
 *  one author's Hierarchy folder. (Capture into a SCENE keeps it — that is the
 *  point of the field; only templates exclude it.) */
describe('applyToPrefabSelective — scene-only fields stay out of the template', () => {
  it('refuses to write EntityAttributes.editorFolder into the prefab', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, makeOldPrefab() as any);

    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root', editorFolder: 'Enemies' } as never),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: ROOT }),
    );
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos.push({ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'PrefabInstance'] });

    const result = await applyToPrefabSelective(rootId, new Set(['1.EntityAttributes.editorFolder']));

    // The only selected key is excluded → nothing applicable, so no write at all.
    expect(writtenContent).toBeNull();
    expect(result.applied).toBe(false);
  });
});
