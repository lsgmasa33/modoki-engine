/** A prefab-instance override over a SoA field that is NOT in `meta.fields`.
 *
 *  Reproduces the reported data loss: a load→save on
 *  `games/3d-test/runtime/assets/scenes/skinned-test.json` REMOVED
 *  `entities[10](Cone).overrides.1.Animator.clips` (a populated bank naming a real
 *  clip guid) and `.clip`, while adding `fadeDuration`.
 *
 *  `meta.fields` is the INSPECTOR-RENDERING list, not the set of persistent
 *  fields — the koota schema is. `Animator.clips`/`clip` are schema fields
 *  deliberately omitted from `fields` because a custom Inspector section
 *  (AnimatorClipsSection) owns them. Both override paths used `field in
 *  meta.fields` as "does this field persist", so such a field was:
 *    - never APPLIED on load (SoA guard skipped it) and so never MARKED, and
 *    - never READ at capture (`readTraitData` reads `meta.fields` keys only),
 *  which means the mark-gate deleted it and the save dropped it.
 *
 *  The same wrong equivalence was already patched once, per-instance, for
 *  `EntityAttributes.editorFolder`; keying on the schema subsumes that case. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0, editorFolder: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });
/** Animator-shaped: `clips`/`clip` persist (schema) but are absent from `fields`
 *  (a custom Inspector section owns them); `activeClip` is runtime read-back. */
const Animator = trait({ clips: '[]' as string, clip: '' as string, speed: 1, activeClip: '' as string });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {} } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, parentId: {}, guid: {}, sortOrder: {} } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: {}, localId: {}, rootInstanceId: {} } },
  { name: 'Animator', trait: Animator, category: 'component', fields: { speed: {}, activeClip: { runtimeOnly: true } } },
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
/** Mirrors the real helper: every key the koota schema declares. */
function readTraitDataFullImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  const data = e.get(meta.trait);
  const schema = (meta.trait as { schema?: unknown }).schema;
  const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = data[k];
  return out;
}
function writeTraitFieldImpl(id: number, meta: any, field: string, value: unknown) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return;
  e.set(meta.trait, { ...e.get(meta.trait), [field]: value });
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
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  readTraitDataFull: (id: number, meta: any) => readTraitDataFullImpl(id, meta),
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

const getModule = () => import('../../src/editor/scene/prefab');

const CHILD = 'cccccccc-0000-4000-8000-00000000c0e8';
const CLIP_GUID = 'f1cc3b85-2c23-457b-938a-3470ada21b36';
const BANK = JSON.stringify([{ name: 'skin', clip: CLIP_GUID }]);

/** A prefab whose root carries an Animator with an EMPTY bank — the instance
 *  overrides it with a populated one (the skinned-test.json shape). */
const animatorPrefab = () => ({
  id: CHILD, version: 1 as const, name: 'Cone', rootLocalId: 1,
  entities: [{
    localId: 1, name: 'Cone',
    traits: {
      Transform: { x: 0, y: 0, z: 0 },
      EntityAttributes: { name: 'Cone', parentId: 0, guid: '' },
      Animator: { clips: '[]', clip: '', speed: 1 },
    },
  }],
});

async function instanceWithOverrides(overrides: Record<number, Record<string, Record<string, unknown>>>) {
  const { instantiatePrefab, setPrefabCache, setPrefabSource, applyOverridesByRootInstance } = await getModule();
  const prefab = animatorPrefab();
  setPrefabCache(CHILD, prefab as any);
  const root = instantiatePrefab(prefab as any);
  setPrefabSource(root, CHILD);
  applyOverridesByRootInstance(root, overrides);
  return { root, prefab };
}

describe('overrides over SoA fields absent from meta.fields', () => {
  it('APPLIES a clips/clip override instead of skipping it as an unknown field', async () => {
    const { root } = await instanceWithOverrides({ 1: { Animator: { clips: BANK, clip: 'skin' } } });
    const live = index.get(root).get(Animator) as Record<string, unknown>;
    expect(live.clips).toBe(BANK);
    expect(live.clip).toBe('skin');
  });

  it('MARKS an applied clips/clip override so the mark-gate keeps it', async () => {
    const { root } = await instanceWithOverrides({ 1: { Animator: { clips: BANK, clip: 'skin' } } });
    const { getOverrideMarkSet } = await import('../../src/runtime/loaders/overrideMarks');
    const marks = getOverrideMarkSet(root);
    expect(marks?.has('Animator.clips')).toBe(true);
    expect(marks?.has('Animator.clip')).toBe(true);
  });

  it('ROUND-TRIPS: apply → capture keeps clips + clip (the reported data loss)', async () => {
    const { root, prefab } = await instanceWithOverrides({ 1: { Animator: { clips: BANK, clip: 'skin' } } });
    const { captureInstanceOverrides } = await getModule();
    const captured = captureInstanceOverrides(root, prefab as any);
    expect(captured[1]?.Animator?.clips).toBe(BANK);
    expect(captured[1]?.Animator?.clip).toBe('skin');
  });

  it('NEVER captures a runtimeOnly field, even when it diverges from the base', async () => {
    const { root, prefab } = await instanceWithOverrides({ 1: { Animator: { clip: 'skin' } } });
    // Runtime read-back advances during play; it must not become an override.
    writeTraitFieldImpl(root, TRAITS[3], 'activeClip', 'skin');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    markOverride(root, 'Animator', 'activeClip'); // even a stray mark must not persist it
    const { captureInstanceOverrides } = await getModule();
    const captured = captureInstanceOverrides(root, prefab as any);
    expect(captured[1]?.Animator).not.toHaveProperty('activeClip');
  });

  it('still ignores a field the schema does NOT declare (stale/renamed)', async () => {
    const { root } = await instanceWithOverrides({ 1: { Animator: { retiredField: 1 } as never } });
    const live = index.get(root).get(Animator) as Record<string, unknown>;
    expect(live).not.toHaveProperty('retiredField');
    const { getOverrideMarkSet } = await import('../../src/runtime/loaders/overrideMarks');
    expect(getOverrideMarkSet(root)?.has('Animator.retiredField')).not.toBe(true);
  });

  it('EntityAttributes.editorFolder rides the schema rule, not a special case', async () => {
    const { root } = await instanceWithOverrides({ 1: { EntityAttributes: { editorFolder: 'Enemies/Ranged' } } });
    const live = index.get(root).get(EntityAttributes) as Record<string, unknown>;
    expect(live.editorFolder).toBe('Enemies/Ranged');
  });
});
