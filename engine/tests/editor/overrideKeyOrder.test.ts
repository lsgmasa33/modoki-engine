/** A save writes an instance's override field objects in ONE key order, so an unchanged scene re-saves to the same bytes
 *  (#1896, Unity's deterministic serialization).
 *
 *  `captureInstanceOverrides` built each trait's object in HISTORY order: the value diff in schema order, then the marked
 *  fields whose value equals the base appended in mark-set insertion order. A reload re-seeds the marks in FILE order, and
 *  a rotation mark pulls in its whole group, so a root whose `x` was marked before it was rotated saved `{rx,x,ry,rz}`
 *  and, reloaded, `{rx,ry,rz,x}`. Driven through the real loader and the real `serializeScene`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, findEntity,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
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
const saveText = async () => JSON.stringify({ entities: (await serializeScene()).entities }, null, 2);
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
  /** The root's `x` marked while equal to its base, THEN the root rotated: the mark set reads [x, rx, ry, rz]. */
  const markedThenRotated = () => {
    const r = byName('R');
    markOverride(findEntity(r)!, 'Transform', 'x');
    writeTraitFieldWithUndo(r, getTraitByName('Transform')!, 'rx', 10);
  };

  // Mutation: `result[localId] = diffs` (drop `inCanonicalOrder`) — save 1 writes {rx,x,ry,rz}, save 2 {rx,ry,rz,x}.
  it('save → reload → save writes the same bytes', async () => {
    markedThenRotated();
    const first = await saveText();
    await load({ ...scene(), ...JSON.parse(first) } as SceneData);
    const second = await saveText();
    expect(second).toBe(first);
  });

  // Mutation: as above — the first save's order is the mark set's, x after rx.
  it("the root override lists its fields in the trait's schema order", async () => {
    markedThenRotated();
    const overrides = entry(await saveText()).overrides as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(overrides['1']!.Transform!)).toEqual(['x', 'rx', 'ry', 'rz']);
  });

  // The member-row channel (`moveChannelsOntoRows`) takes the same object. A marked `x` equal to its base and a changed
  // `y` wrote {y,x}: the value diff first, the fold after it.
  // Mutation: as above — the row's Transform reads {y,x}.
  it("a member row's override is in schema order too", async () => {
    const a = byName('A');
    markOverride(findEntity(a)!, 'Transform', 'x');
    writeTraitFieldWithUndo(a, getTraitByName('Transform')!, 'y', 2);
    const text = await saveText();
    const found: string[][] = [];
    JSON.stringify(entry(text), (k, v) => {
      if (k === 'Transform' && v && typeof v === 'object' && 'y' in v) found.push(Object.keys(v));
      return v;
    });
    expect(found).toEqual([['x', 'y']]);
  });

  // TRAITS are ordered too, by the registry (Transform before EntityAttributes): the value diff put EntityAttributes (a
  // rename) first, and the fold appended Transform after it.
  // Mutation: `const byTrait = diffs` (fields ordered, traits not) — the row reads [EntityAttributes, Transform].
  it('traits are in registry order', async () => {
    const a = byName('A');
    markOverride(findEntity(a)!, 'Transform', 'x');
    writeTraitFieldWithUndo(a, getTraitByName('EntityAttributes')!, 'name', 'A2');
    const found: string[][] = [];
    JSON.stringify(entry(await saveText()), (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'Transform' in v && 'EntityAttributes' in v) found.push(Object.keys(v));
      return v;
    });
    expect(found).toEqual([['Transform', 'EntityAttributes']]);
  });
});
