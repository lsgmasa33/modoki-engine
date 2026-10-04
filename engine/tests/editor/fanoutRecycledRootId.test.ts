/** #2143 (#2001 S8b review R3): a fan-out's capture path reads each root it listed BY ENTITY ID after the reprojections
 *  ahead of it have respawned trees. koota hands a freed id straight back (LIFO), so an id listed for instance B can
 *  name another instance C by then; read by id, C's own guid passed the liveness check and the fan-out acted on C — an
 *  instance it was never asked to touch. Since S8b the capture path only rebuilds an entry holding no record, and refuses
 *  one whose instance lacks its record, so what it does to C is that refusal: C left, and the WORLD marked unsavable
 *  (`leftRecordless`) for an instance nobody listed. Both fan-outs carry it: an Apply's (`refreshInstances`) and a
 *  rebase's (`rebuildStaleFrames`). Each now reads the guids before any respawn and checks against those.
 *
 *  No natural op recycles a listed root inside one fan-out today (traced, not driven), so the recycle is FORCED: the
 *  first reprojection, run for real, is followed by B's teardown and C's spawn on B's freed id. The fan-out's own
 *  liveness check is the mechanism under test and is not mocked. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld, type Entity } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
/** Run once after the next reprojection returns — the respawn that frees and recycles an id in the real case. */
let afterReproject: (() => void) | null = null;
vi.mock('../../packages/modoki/src/editor/instance/instanceReproject', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/editor/instance/instanceReproject')>();
  return {
    ...real,
    reprojectFromStore: (...args: Parameters<typeof real.reprojectFromStore>) => {
      const out = real.reprojectFromStore(...args);
      const hook = afterReproject;
      afterReproject = null;
      hook?.();
      return out;
    },
  };
});

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { refreshInstances, rebuildStaleFrames } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { staleFrames } from '../../packages/modoki/src/editor/scene/prefabFrames';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { dropInstanceRecord, storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { frameRootDoc, noteFrameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';

registerAllTraits();
setActionCallback(pushAction);

const P = 'aaaaaaaa-0000-4000-8000-000000214301';
const GA = 'bbbbbbbb-0000-4000-8000-000000214311';
const GB = 'bbbbbbbb-0000-4000-8000-000000214312';
const GC = 'bbbbbbbb-0000-4000-8000-000000214313';
const doc = (x: number) => ({ id: P, rootLocalId: 1, entities: [
  { localId: 1, nodeGuid: 'cccccccc-0000-4000-8000-000000214321', traits: { EntityAttributes: { name: 'PRoot', parentId: 0, guid: '' }, Transform: { x, y: 0, z: 0 } } },
] });
const OLD = doc(0);

async function load(): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  const entry = (id: number, guid: string, name: string) => ({ id, prefab: P, guid, traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
  await loadSceneFile({ id: 's2143', version: 16, name: 'S', resources: [], entities: [entry(1, GA, 'A'), entry(2, GB, 'B')] } as unknown as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => { const w = getCurrentWorld(); for (const e of w.entities) if (e.id() === id) { destroyEntity(e, w); break; } },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const w = getCurrentWorld();
      const id = instantiatePrefabIntoWorld(w, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) for (const e of w.entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      return id ?? undefined;
    },
  });
}

const entityOf = (guid: string): Entity => getCurrentWorld().entities.find((e) => getAllEntities().some((r) => r.id === e.id() && r.guid === guid))!;

/** Tear B down and spawn C, a record-less instance of the same prefab, on B's freed id — as a respawn earlier in the
 *  fan-out would hand it on. C carries B's frame document, so only its guid tells it from B. Returns C's entity. */
function recycleBAsC(cell: { c?: Entity }): () => void {
  return () => {
    const w = getCurrentWorld();
    const b = entityOf(GB);
    const bId = b.id();
    const rec = frameRootDoc(w, b);
    destroyEntity(b, w);
    const cId = instantiatePrefabIntoWorld(w, OLD as never, 0, undefined, P);
    expect(cId, 'premise: koota recycled B\'s freed id for C').toBe(bId);
    const c = w.entities.find((e) => e.id() === cId)!;
    const ea = getTraitByName('EntityAttributes')!;
    c.set(ea.trait, { ...(c.get(ea.trait) as object), guid: GC, name: 'C' });
    if (rec) noteFrameRootDoc(w, c, rec);
    cell.c = c;
  };
}

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  prefabs.set(P, OLD);
  setPrefabCache(P, OLD as never);
  afterReproject = null;
  for (const k of ['log', 'warn', 'info', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});

describe('#2143: a fan-out does not act on an instance that took a listed root\'s id', () => {
  it('Apply fan-out (refreshInstances): C, on B\'s recycled id, is left as it was', async () => {
    await load();
    const w = getCurrentWorld();
    // A keeps its record and is reprojected; B's is gone, so B goes the capture path — listed by id.
    dropInstanceRecord(w, GB);
    expect(storedRecord(w, GA), 'premise: A reprojects from its record').toBeTruthy();
    expect(whyWorldNotAuthored(), 'premise: savable before the fan-out').toBeNull();
    const roots = [entityOf(GA).id(), entityOf(GB).id()];
    const cell: { c?: Entity } = {};
    afterReproject = recycleBAsC(cell);
    const NEW = doc(5);
    prefabs.set(P, NEW);
    setPrefabCache(P, NEW as never);
    const n = refreshInstances(P, roots, OLD as never, NEW as never);
    expect(cell.c, 'premise: the forced recycle ran').toBeDefined();
    // C was never listed: nothing refuses it, so the world stays savable.
    expect(whyWorldNotAuthored()).toBeNull();
    // …and the same entity (generation and all) stands, and only A counts as refreshed.
    expect(entityOf(GC)).toBe(cell.c);
    expect(n).toBe(1);
  });

  it('rebase (rebuildStaleFrames): C, on B\'s recycled id, is left as it was', async () => {
    await load();
    const w = getCurrentWorld();
    dropInstanceRecord(w, GB);
    const NEW = doc(5);
    prefabs.set(P, NEW);
    setPrefabCache(P, NEW as never);
    const stale = staleFrames({});
    expect(stale.map((s) => s.root).sort(), 'premise: both frames are stale').toEqual([entityOf(GA).id(), entityOf(GB).id()].sort());
    const cell: { c?: Entity } = {};
    afterReproject = recycleBAsC(cell);
    const n = rebuildStaleFrames(stale);
    expect(cell.c, 'premise: the forced recycle ran').toBeDefined();
    // C was never listed: nothing refuses it, so the world stays savable.
    expect(whyWorldNotAuthored()).toBeNull();
    expect(entityOf(GC)).toBe(cell.c);
    expect(n).toBe(1);
  });
});
