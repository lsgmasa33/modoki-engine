/** A save writes an instance's override field objects in ONE key order, so an unchanged scene re-saves to the same bytes
 *  (#1896, Unity's deterministic serialization).
 *
 *  `captureInstanceOverrides` built each trait's object in HISTORY order: the value diff in schema order, then the marked
 *  fields whose value equals the base appended in mark-set insertion order. A reload re-seeds the marks in FILE order, and
 *  a rotation mark pulls in its whole group, so a root whose `x` was marked before it was rotated saved `{rx,x,ry,rz}`
 *  and, reloaded, `{rx,ry,rz,x}`. Since #2001 S6 a save writes the instance's RECORD, in its own order (load → save is
 *  verbatim), so the order is set where a gesture lands on the record (`inWrittenOrder`, #2001 S8b): written in gesture
 *  order, the same edits made in two orders saved two byte orders. Driven through the real loader and the real
 *  `serializeScene`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001896';
const INST = 'dddddddd-0000-4000-8000-000000001896';
const gR = 'eeeeeeee-0000-4000-8000-000000001891';
const gA = 'eeeeeeee-0000-4000-8000-000000001892';
const tf = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
/** P = R → A. */
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [
  { localId: 1, name: 'R', nodeGuid: gR, traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: { ...tf } } },
  { localId: 2, name: 'A', nodeGuid: gA, traits: { EntityAttributes: { name: 'A', parentId: 1, guid: '' }, Transform: { ...tf } } },
] });
const scene = (): SceneData => ({
  id: 's1896', version: 16, name: 'S', resources: [],
  entities: [{ id: 1, prefab: P, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
} as unknown as SceneData);

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const byName = (name: string) => getAllEntities().find((e) => e.name === name)!.id;
/** The file's entities as text: `JSON.stringify` keeps key order, which is what the owner's git diff sees. (The scene's
 *  own `id` is left out: this harness sets no current scene, so each save mints one.) */
const saveText = async () => { const saved = await serializeScene(); return JSON.stringify({ version: saved.version, entities: saved.entities }, null, 2); };
const entry = (text: string) => (JSON.parse(text) as { entities: Array<Record<string, unknown>> }).entities.find((e) => e.guid === INST)!;

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  prefabs.set(P, pDoc());
  setPrefabCache(P, pDoc() as never);
  await load(scene());
});

describe('an override field object is written in one key order (#1896)', () => {
  /** The root rotated, THEN its `x` moved: the record states [rx, ry, rz, x], in the order the gestures came (#2001 S8b:
   *  a save writes the record, which the load parsed, not a capture of marks). */
  const markedThenRotated = () => {
    const r = byName('R');
    writeTraitFieldWithUndo(r, getTraitByName('Transform')!, 'rx', 10);
    writeTraitFieldWithUndo(r, getTraitByName('Transform')!, 'x', 3);
  };

  // The record keeps the order the load read (rule 4), so this holds with or without `inWrittenOrder`: it guards the
  // reload, not the gesture order (the cases below do).
  it('save → reload → save writes the same bytes', async () => {
    markedThenRotated();
    const first = await saveText();
    await load({ ...scene(), ...JSON.parse(first) } as SceneData);
    const second = await saveText();
    expect(second).toBe(first);
  });

  // Mutation: drop `inWrittenOrder`'s call in the door's field write — the save's order is the gestures', x after rx.
  it("the root override lists its fields in the trait's schema order", async () => {
    markedThenRotated();
    // Scene v20 (#2001 S6): the root's records are its `"/"` row's.
    const rows = entry(await saveText()).members as Record<string, { traits: Record<string, Record<string, unknown>> }>;
    expect(Object.keys(rows['/']!.traits.Transform!)).toEqual(['x', 'rx', 'ry', 'rz']);
  });

  // A member row's object is ordered the same way: `y` changed, then `x`.
  // Mutation: as above — the row's Transform reads {y,x}.
  it("a member row's override is in schema order too", async () => {
    const a = byName('A');
    writeTraitFieldWithUndo(a, getTraitByName('Transform')!, 'y', 2);
    writeTraitFieldWithUndo(a, getTraitByName('Transform')!, 'x', 3);
    const text = await saveText();
    const found: string[][] = [];
    JSON.stringify(entry(text), (k, v) => {
      if (k === 'Transform' && v && typeof v === 'object' && 'y' in v) found.push(Object.keys(v));
      return v;
    });
    expect(found).toEqual([['x', 'y']]);
  });

  // TRAITS are ordered too, by the registry (Transform before EntityAttributes): a rename, then a move.
  // Mutation: `inWrittenOrder` returns before its trait sort (fields ordered, traits not) — the row reads [EntityAttributes, Transform].
  it('traits are in registry order', async () => {
    const a = byName('A');
    writeTraitFieldWithUndo(a, getTraitByName('EntityAttributes')!, 'name', 'A2');
    writeTraitFieldWithUndo(a, getTraitByName('Transform')!, 'x', 3);
    const found: string[][] = [];
    JSON.stringify(entry(await saveText()), (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'Transform' in v && 'EntityAttributes' in v) found.push(Object.keys(v));
      return v;
    });
    expect(found).toEqual([['Transform', 'EntityAttributes']]);
  });
});
