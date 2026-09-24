/** Rebuilding an instance whose OWNED nested frame was moved within it (#1437) — #1499.
 *
 *  The fixture: O = OR → Slot → N (a row expanding P); P = R → A, plus row 5 (Qrow) expanding Q = QR → QX. The scene
 *  sets QX.x = 8 and moves QR — still owned, still linked — under OR or Slot (outside the P frame's live subtree) or
 *  under A (inside it, the control).
 *
 *  1. An Apply from a plain P instance rebuilds the nested P frame. Its capture walked LIVE children, so it never saw
 *     the moved-out Q frame, which the teardown destroyed and re-expanded anyway: QX.x went back to 0.
 *  2. An Apply from a plain Q instance rebuilds QR by itself. The respawn got two of an owned root's three identity
 *     fields back, not the owner link (`ownerGuid`), so it read as user-added and the save unlinked it from its row.
 *
 *  Driven through the real loader, the real capture and the real Apply. Each case names the mutation that turns it
 *  red. */


import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
const writes: Array<{ path: string; content: string }> = [];
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string) => {
    writes.push({ path, content });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, reparentEntity,
} from '@modoki/engine/editor';
import {
  setPrefabCache, applyToPrefabSelective, rebaseStaleInstances, revertOverridesSelective, staleInstanceRefusal, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import {
  collectInstanceOverrideKeys,
} from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001491';
const O = 'cccccccc-0000-4000-8000-000000001490';
const HOLDER = 'dddddddd-0000-4000-8000-000000001490';
const ROOT1 = 'dddddddd-0000-4000-8000-000000001491';
const gR = 'eeeeeeee-0000-4000-8000-000000001401';
const gA = 'eeeeeeee-0000-4000-8000-000000001402';
const gOR = 'eeeeeeee-0000-4000-8000-000000001403';
const gSlot = 'eeeeeeee-0000-4000-8000-000000001404';
const gSlot2 = 'eeeeeeee-0000-4000-8000-000000001405';
const gN = 'eeeeeeee-0000-4000-8000-000000001406';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, x = 0) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
});
/** R → A; `rootTf` overlays R's authored Transform. */
const pDoc = (rootTf: Record<string, number> = {}) => {
  const r = row(1, 'R', 0, gR);
  r.traits.Transform = { ...r.traits.Transform, ...rootTf };
  return { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [r, row(2, 'A', 1, gA)] };
};
/** OR → Slot (x = `slotX`) → N (a reference row expanding P, which — like every real writer's — carries no
 *  Transform of its own); OR → Slot2. */
const oDoc = (slotX = 0) => ({ id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot, slotX), row(3, 'Slot2', 1, gSlot2),
  { localId: 4, name: 'N', nodeGuid: gN, prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 2, guid: '' } } },
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

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

const rootOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
/** The entity named `name` in the instance rooted at `guid` (the root itself included). */
const inInstance = (guid: string, name: string): number => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const root = rootOf(guid);
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === root) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} in ${guid}`);
  return hits[0]!.id;
};
const meta = (t: string) => getTraitByName(t)!;
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
const parentName = (id: number) => {
  const all = getAllEntities();
  const self = all.find((e) => e.id === id)!;
  return all.find((e) => e.id === self.parentId)?.name;
};
const tfOf = (id: number) => readTraitData(id, meta('Transform')) as Record<string, number>;
const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((p) => p.id === id).pop();

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  // Apply repairs refs in other files after a re-parent; nothing else is on disk here.
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
const Q = 'cccccccc-0000-4000-8000-000000001499';
const gQR = 'eeeeeeee-0000-4000-8000-000000001499';
const gQX = 'eeeeeeee-0000-4000-8000-000000001500';
const gQrow = 'eeeeeeee-0000-4000-8000-000000001501';
const PLAIN_P = 'dddddddd-0000-4000-8000-000000001499';
const PLAIN_Q = 'dddddddd-0000-4000-8000-000000001500';
const FRESH_P = 'dddddddd-0000-4000-8000-000000001501';
afterAll(() => { for (const id of [P, O, Q]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'QX', 1, gQX)] });
/** P with row 5 (Qrow, under R) expanding Q; `qrowOverrides` on that row. */
const pqDoc = (qrowOverrides?: Record<number, unknown>) => {
  const d = pDoc() as { id: string; entities: unknown[] };
  d.entities.push({ localId: 5, name: 'Qrow', nodeGuid: gQrow, prefab: Q, ...(qrowOverrides ? { overrides: qrowOverrides } : {}), traits: { EntityAttributes: { name: 'Qrow', parentId: 1, guid: '' } } });
  return d;
};
/** Holder → an O instance, a plain P instance and a plain Q instance. */
const mixed = (): SceneData => ({
  id: 'r1499', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    ...[[O, ROOT1], [P, PLAIN_P], [Q, PLAIN_Q]].map(([prefab, guid], i) => ({ id: 2 + i, prefab, guid, traits: { EntityAttributes: { name: `Inst${i}`, parentId: HOLDER } } })),
  ],
} as unknown as SceneData);
const saveO = async () => {
  const s = await serializeScene() as unknown as SceneData;
  return { scene: s, entry: (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.prefab === O)! };
};
/** Load, set QX.x = 8, move QR under `target` of the O instance. */
const setup = async (target: string) => {
  install(qDoc(), pqDoc(), oDoc());
  await load(mixed());
  writeTraitFieldWithUndo(inInstance(ROOT1, 'QX'), meta('Transform'), 'x', 8);
  reparentEntity(inInstance(ROOT1, 'QR'), inInstance(ROOT1, target));
  expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
};
/** Apply one field edit from the plain instance `root` (of P or Q) to its prefab. */
const applyEdit = async (root: string, member: string, source: string) => {
  writeTraitFieldWithUndo(inInstance(root, member), meta('Transform'), 'z', 3);
  const keys = collectInstanceOverrideKeys(rootOf(root), prefabs.get(source) as PrefabFile);
  expect(keys.fields.length).toBe(1);
  expect((await applyToPrefabSelective(rootOf(root), new Set(keys.fields))).applied).toBe(true);
};

describe('an edit inside an owned frame moved out of the rebuilt frame survives the rebuild (#1499, 1)', () => {
  for (const target of ['OR', 'Slot', 'A']) {
    it(`P frame rebuilt, QR moved under ${target}${target === 'A' ? ' (inside the P frame: the control)' : ''}`, async () => {
      // Mutation: capture from the LIVE subtree in `captureNestedInstanceOverridesIn` (`collectSubtreeIds` from the
      // outer root instead of `rebuildTeardown(...).toDestroy`) — OR and Slot go back to 0; A stays green.
      await setup(target);
      await applyEdit(PLAIN_P, 'A', P);
      expect(tfOf(inInstance(ROOT1, 'A')).z).toBe(3); // precondition: the nested P frame WAS rebuilt
      expect(x(inInstance(ROOT1, 'QX'))).toBe(8);
      expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
      const { scene: s } = await saveO();
      install(written(P)!);
      await load(s);
      expect(x(inInstance(ROOT1, 'QX'))).toBe(8);
      expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
    });
  }
});

describe('a moved owned root rebuilt on its own stays linked to its row (#1499, 2)', () => {
  for (const target of ['OR', 'Slot', 'A']) {
    it(`QR rebuilt alone, moved under ${target}${target === 'A' ? ' (inside its owner frame: the control)' : ''}`, async () => {
      // Mutation: drop the `ownerGuid` restore in `rebuildInstance` — OR and Slot save `…/Qrow: {removed: true}` plus
      // QR as a scene-added reference node, and a later change to P's Qrow row never reaches it; A stays green.
      await setup(target);
      await applyEdit(PLAIN_Q, 'QX', Q);
      expect(tfOf(inInstance(ROOT1, 'QX')).z).toBe(3); // precondition: QR WAS rebuilt
      const { scene: s, entry } = await saveO();
      expect(JSON.stringify(entry)).not.toContain('"removed":true');
      expect(entry.added).toBeUndefined();
      // Still the row's expansion: a later change to P's Qrow row reaches it.
      install(written(Q)!, pqDoc({ 2: { Transform: { y: 4 } } }));
      await load(s);
      expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
      expect(tfOf(inInstance(ROOT1, 'QX'))).toMatchObject({ x: 8, y: 4, z: 3 });
    });
  }
});

describe('the teardown parks what is not its own at every depth (#1499, 3)', () => {
  it('a member of the OUTER frame moved in under the moved-out Q frame survives the P frame\'s rebuild', async () => {
    // The reverse case takes QR (its frame, P, is torn down) with its subtree — which now holds O's Slot2, a member
    // of a frame this rebuild does not respawn. Mutation: in `rebuildTeardown`, take the reverse-case OR the unpark
    // subtree without the park test (the pre-#1499 walks; either one alone) — Slot2 is destroyed, nothing respawns it.
    await setup('OR');
    reparentEntity(inInstance(ROOT1, 'Slot2'), inInstance(ROOT1, 'QX'));
    await applyEdit(PLAIN_P, 'A', P);
    expect(parentName(inInstance(ROOT1, 'Slot2'))).toBe('QX');
    const { scene: s } = await saveO();
    install(written(P)!);
    await load(s);
    expect(parentName(inInstance(ROOT1, 'Slot2'))).toBe('QX');
    expect(x(inInstance(ROOT1, 'QX'))).toBe(8);
  });
});

describe('the reload rebase rebuilds a stale frame that owns a moved-out frame (#1499, the #1493 skip lifted)', () => {
  // A carried frame built from an older document is rebuilt by `rebaseStaleInstances`. The #1493 close-out skipped every
  // frame whose rebuild reached outside its live subtree, because the rebuild then lost the edits out there (1) or
  // unlinked a moved root (2). Each case changes a document under the live tree and rebases.
  const pWithB = () => { const d = pqDoc() as { id: string; entities: unknown[] }; d.entities.push(row(6, 'B', 1, 'eeeeeeee-0000-4000-8000-000000001502')); return d; };
  const qWithQY = () => { const d = qDoc() as { id: string; entities: unknown[] }; d.entities.push(row(3, 'QY', 1, 'eeeeeeee-0000-4000-8000-000000001503')); return d; };
  const members = (root: string) => getAllEntities().filter((e) => {
    try { return inInstance(root, e.name) === e.id; } catch { return false; }
  }).map((e) => e.name).sort();
  const check = async (target: string) => {
    expect(x(inInstance(ROOT1, 'QX'))).toBe(8);
    expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
    const { scene: s, entry } = await saveO();
    expect(JSON.stringify(entry)).not.toContain('"removed":true');
    expect(entry.added).toBeUndefined();
    await load(s);
    expect(x(inInstance(ROOT1, 'QX'))).toBe(8);
    expect(parentName(inInstance(ROOT1, 'QR'))).toBe(target);
  };
  for (const target of ['OR', 'Slot']) {
    it(`P gains a member: the P frame is rebuilt, QR moved under ${target} keeps its edit`, async () => {
      await setup(target);
      install(pWithB());
      expect(await rebaseStaleInstances()).toBeGreaterThan(0);
      expect(members(ROOT1)).toContain('B');
      await check(target);
    });
    it(`Q gains a member: QR, moved under ${target}, is rebuilt alone and stays linked`, async () => {
      await setup(target);
      install(qWithQY());
      expect(await rebaseStaleInstances()).toBeGreaterThan(0);
      expect(parentName(inInstance(ROOT1, 'QY'))).toBe('QR');
      await check(target);
    });
    it(`an Apply fan-out REFUSES a frame whose teardown holds a stale moved-out frame; the rebase then updates both (QR under ${target})`, async () => {
      // Mutation: judge the LIVE subtree in `framesBuiltFromOtherRows` (collectSubtreeIds from the root instead of the
      // teardown set) — the P frame is rebuilt, its capture reads the stale QR against Q's new rows, QY reads as
      // REMOVED by the scene, and stays removed.
      await setup(target);
      install(qWithQY()); // Q changed on disk; QR is still the old expansion — as a carried instance's is (#1483)
      // …beside a P instance expanded AFTER the change, so the Apply's own source is current and not refused.
      const fresh = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(P) as never, rootOf(HOLDER), undefined, P);
      const eaMeta = getTraitByName('EntityAttributes')!;
      for (const e of getCurrentWorld().entities) if (e.id() === fresh) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: FRESH_P });
      await applyEdit(FRESH_P, 'A', P);
      expect(tfOf(inInstance(ROOT1, 'A')).z).toBe(0); // refused: the O instance's P frame was not rebuilt
      await rebaseStaleInstances();
      expect(tfOf(inInstance(ROOT1, 'A')).z).toBe(3);
      expect(parentName(inInstance(ROOT1, 'QY'))).toBe('QR');
      await check(target);
    });
    it(`Apply and Revert on the P frame REFUSE while the Q frame moved out of it is stale (QR under ${target})`, async () => {
      // Close-out review: only the refresh judged the teardown set, so a Revert on the P frame rebuilt it, captured the
      // stale QR against Q's new rows, and saved QY as REMOVED. Mutation: as above — both go through.
      await setup(target);
      writeTraitFieldWithUndo(inInstance(ROOT1, 'A'), meta('Transform'), 'z', 3);
      install(qWithQY());
      const pFrame = inInstance(ROOT1, 'R');
      expect(staleInstanceRefusal(pFrame)).toContain(Q);
      expect(await revertOverridesSelective(pFrame, new Set([`${gA}.Transform.z`]))).toBeNull();
      expect((await applyToPrefabSelective(pFrame, new Set([`${gA}.Transform.z`]))).applied).toBe(false);
      expect(tfOf(inInstance(ROOT1, 'A')).z).toBe(3);
      await rebaseStaleInstances();
      expect(parentName(inInstance(ROOT1, 'QY'))).toBe('QR');
      await check(target);
    });
    it(`BOTH gain a member: both frames are rebuilt, QR moved under ${target}`, async () => {
      await setup(target);
      install(pWithB(), qWithQY());
      await rebaseStaleInstances();
      expect(members(ROOT1)).toContain('B');
      expect(parentName(inInstance(ROOT1, 'QY'))).toBe('QR');
      await check(target);
    });
  }
});
