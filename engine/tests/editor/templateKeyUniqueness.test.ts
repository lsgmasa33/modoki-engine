/** #1809 (owner ruling 2026-09-30): template keys are unique within one prefab document, as Unity's fileIDs are within
 *  one file. A keyed node's guid is its frame's path plus its key, so two nodes of one frame sharing a key share a guid
 *  (I7). Kept unique at the SOURCES: a prefab-edit copy mints every key no nested prefab declares, and a promotion does
 *  not carry a key its target declares or already wrote. A same-frame repeat a hand edit or a merge brings in is
 *  REPORTED by the prefab validator, never rewritten (owner ruling (A)).
 *
 *  Driven through the real loader, copy and Apply. Each case names the mutation that turns it red. */

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
    const doc = JSON.parse(content) as { id?: string };
    if (doc.id && prefabs.has(doc.id)) prefabs.set(doc.id, doc);
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));
// Which prefab's edit world a copy is made in: the one question `copySnapshot` asks of it. Everything else is real.
const world = vi.hoisted(() => ({ editing: null as string | null }));
vi.mock('../../packages/modoki/src/editor/scene/prefabEditWorld', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prefabEditWorldGuid: () => world.editing,
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory } from '@modoki/engine/editor';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { snapshotEntity, copySnapshot, respawnFromSnapshot, type EntitySnapshot } from '../../packages/modoki/src/editor/undo/entityActions';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { detachPrefabInstance } from '../../packages/modoki/src/editor/scene/prefabLink';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { templateKeyOf, setTemplateKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { templateKeysOf, type TemplateKeyDoc } from '../../packages/modoki/src/runtime/loaders/templateKeyRecovery';
import { validatePrefabData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000018191';
const S = 'cccccccc-0000-4000-8000-000000018192';
const O = 'cccccccc-0000-4000-8000-000000018193';
const ROOT = 'dddddddd-0000-4000-8000-000000018191';
const ROOT2 = 'dddddddd-0000-4000-8000-000000018192';
const KX = 'aaaaaaaa-0000-4000-8000-0000000181a1';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 9, name: 'P', rootLocalId: 1, nextLocalId: 3, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-0000000181e1'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-0000000181e2'),
] });
/** S: SR → SA — a second prefab O nests, whose frame declares no key of O's. */
const sDoc = () => ({ id: S, version: 9, name: 'S', rootLocalId: 1, nextLocalId: 3, entities: [
  row(1, 'SR', 0, 'eeeeeeee-0000-4000-8000-0000000181f1'), row(2, 'SA', 1, 'eeeeeeee-0000-4000-8000-0000000181f2'),
] });
const extraNode = (key = KX) => ({ parentLocalId: 2, guid: '', key, name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6 } }, children: [] });
/** O: OR → N (a P row whose layer adds Extra under A), M (an S row), and — given `n2Key` — N2 (another P row adding
 *  its own Extra under that key). */
const oDoc = (opts: { n2Key?: string } = {}) => ({ id: O, version: 9, name: 'O', rootLocalId: 1, nextLocalId: 5, entities: [
  row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-0000000181d1'),
  row(2, 'N', 1, 'eeeeeeee-0000-4000-8000-0000000181d2', { prefab: P, added: [extraNode()] }),
  row(3, 'M', 1, 'eeeeeeee-0000-4000-8000-0000000181d3', { prefab: S }),
  ...(opts.n2Key ? [row(4, 'N2', 1, 'eeeeeeee-0000-4000-8000-0000000181d4', { prefab: P, added: [extraNode(opts.n2Key)] })] : []),
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };
const scene = (roots: string[]): SceneData => ({
  id: 'key-unique', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: roots.map((guid, i) => ({ id: i + 1, prefab: O, guid, traits: { EntityAttributes: { name: `Inst${i + 1}`, parentId: 0 } } })),
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
      const w = getCurrentWorld();
      for (const e of w.entities) if (e.id() === id) { destroyEntity(e, w); break; }
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

const named = (name: string, root: string) => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const top = all.find((e) => e.guid === root)!.id;
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === top) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} under ${root}`);
  return hits[0]!;
};
const rootId = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
const handleOf = (id: number) => [...getCurrentWorld().entities].find((e) => e.id() === id)!;
const setParent = (id: number, parentId: number) => {
  const ea = getTraitByName('EntityAttributes')!;
  const e = handleOf(id);
  e.set(ea.trait, { ...(e.get(ea.trait) as object), parentId });
};
const find = (s: EntitySnapshot, name: string): EntitySnapshot | undefined => {
  const ea = s.traits.find((t) => t.meta.name === 'EntityAttributes')?.data as { name?: string } | undefined;
  if (ea?.name === name) return s;
  for (const c of s.children) { const hit = find(c, name); if (hit) return hit; }
  return undefined;
};
const keyIn = (s: EntitySnapshot | undefined) => {
  const tk = s?.markers?.TemplateAddedKey;
  return tk && tk !== true ? (tk as { key: string }).key : '';
};
const guidIn = (s: EntitySnapshot | undefined) => (s?.traits.find((t) => t.meta.name === 'EntityAttributes')?.data as { guid?: string } | undefined)?.guid ?? '';

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  writes.length = 0;
  prefabs.clear();
  world.editing = null;
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }), text: async () => '' }));
});
afterAll(() => { for (const id of [P, O]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('the prefab validator reports a key repeated within ONE frame, and only that', () => {
  // #1872's fixture shape: a merge brought `k-dup` in twice under N's own list. Mutation: `sameFrameRepeatedKeys` keyed
  // by the key alone (one frame label for the whole document) — the cross-frame case is reported too; or never noting a
  // repeat — the same-frame case goes silent.
  const dup = (x: number) => ({ parentLocalId: 1, guid: '', key: 'k-dup', name: 'Dup', traits: { EntityAttributes: { name: 'Dup', parentId: 0 }, Transform: { x } }, children: [] });
  it('a same-frame repeat is an error naming the prefab, the frame and the key', () => {
    const doc = oDoc();
    (doc.entities.find((e) => e.localId === 2) as unknown as { added: unknown[] }).added.push(dup(1), dup(2));
    const errors = validatePrefabData(doc).warnings.filter((w) => w.startsWith('ERROR:'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"O"');
    expect(errors[0]).toContain('k-dup');
    expect(errors[0]).toContain('row localId=2');
  });
  it('the same key in two frames (two rows of P) is not reported', () => {
    expect(validatePrefabData(oDoc({ n2Key: KX })).warnings.filter((w) => w.startsWith('ERROR:'))).toEqual([]);
  });
});

describe('I7: two nested copies of one prefab keep their keyed nodes apart by FRAME', () => {
  // The same key under N and under N2 (a file from before keys were unique; the mocked cache skips the load-path re-key,
  // so both reach the world). The frame is part of a keyed node's identity, so the two still derive different guids.
  // Mutation: `keyedFrameRoot` climbing to the OUTERMOST instance root instead of stopping at the first frame — both
  // derive [OR's path, '+KX'] and collide.
  it('each derives from its own nested frame root, and no guid repeats', async () => {
    install(pDoc(), sDoc(), oDoc({ n2Key: KX }));
    await load(scene([ROOT]));
    const extras = getAllEntities().filter((e) => e.name === 'Extra').map((e) => e.guid!);
    expect(extras).toHaveLength(2);
    expect(new Set(extras).size).toBe(2);
    expect(extras.sort()).toEqual([deriveMemberGuid(ROOT, [2, `+${KX}`]), deriveMemberGuid(ROOT, [4, `+${KX}`])].sort());
  });
});

describe('a copy in a prefab being EDITED mints fresh keys; a scene copy of an instance keeps them (#1430)', () => {
  // Mutation: build `fresh` whatever the world — the scene copy re-keys, the first case goes red; or never — the second
  // does; or re-key every marked key (drop `!own.has(key)`) — the third does.
  it('a scene copy of a whole instance keeps its template key, on the guid a reload derives from the copy', async () => {
    install(pDoc(), oDoc());
    await load(scene([ROOT]));
    const copy = copySnapshot(snapshotEntity(rootId(ROOT))!);
    const extra = find(copy, 'Extra');
    expect(keyIn(extra)).toBe(KX);
    expect(guidIn(extra)).toBe(deriveMemberGuid(guidIn(copy), [2, `+${KX}`]));
  });

  it('a copy in the prefab-edit world takes a fresh key, and its guid derives with that key', async () => {
    install(pDoc(), oDoc());
    await load(scene([ROOT]));
    world.editing = O;
    const copy = copySnapshot(snapshotEntity(rootId(ROOT))!);
    const extra = find(copy, 'Extra');
    const fresh = keyIn(extra);
    expect(fresh).not.toBe('');
    expect(fresh).not.toBe(KX);
    expect(guidIn(extra)).toBe(deriveMemberGuid(guidIn(copy), [2, `+${fresh}`]));
  });
});

describe('a prefab-edit copy keeps the keys a NESTED prefab declares (close-out review)', () => {
  const P2 = 'cccccccc-0000-4000-8000-000000018194';
  const O2 = 'cccccccc-0000-4000-8000-000000018195';
  const ROOT3 = 'dddddddd-0000-4000-8000-000000018193';
  const KP = 'aaaaaaaa-0000-4000-8000-0000000181a2';
  const KO = 'aaaaaaaa-0000-4000-8000-0000000181a3';
  // P2 nests P and adds Deep under P's A (P2 declares KP); O2 nests P2 and adds Top under P2's root (O2 declares KO).
  const p2 = () => ({ id: P2, version: 9, name: 'P2', rootLocalId: 1, nextLocalId: 3, entities: [
    row(1, 'R2', 0, 'eeeeeeee-0000-4000-8000-0000000181c1'),
    row(2, 'PN', 1, 'eeeeeeee-0000-4000-8000-0000000181c2', { prefab: P, added: [{ ...extraNode(KP), name: 'Deep', traits: { EntityAttributes: { name: 'Deep', parentId: 0 } } }] }),
  ] });
  const o2 = () => ({ id: O2, version: 9, name: 'O2', rootLocalId: 1, nextLocalId: 3, entities: [
    row(1, 'OR2', 0, 'eeeeeeee-0000-4000-8000-0000000181b1'),
    row(2, 'N', 1, 'eeeeeeee-0000-4000-8000-0000000181b2', { prefab: P2, added: [{ ...extraNode(KO), parentLocalId: 1, name: 'Top', traits: { EntityAttributes: { name: 'Top', parentId: 0 } } }] }),
  ] });

  it('editing O2, a copy mints for Top (O2 declares it) and keeps Deep\'s key (P2 declares it)', async () => {
    install(pDoc(), p2(), o2());
    await load({ id: 'k2', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
      entities: [{ id: 1, prefab: O2, guid: ROOT3, traits: { EntityAttributes: { name: 'I', parentId: 0 } } }] } as unknown as SceneData);
    world.editing = O2;
    const copy = copySnapshot(snapshotEntity(rootId(ROOT3))!);
    expect(keyIn(find(copy, 'Deep'))).toBe(KP);
    const top = keyIn(find(copy, 'Top'));
    expect(top).not.toBe('');
    expect(top).not.toBe(KO);
  });
});

describe('a promotion does not carry a key its target document already declares', () => {
  // A STALE template-key marker on a plain node: Detach left one on every unpacked node until #1874, which strips them, so
  // the test plants it after the Detach — the defence is for a stale marker from any source. Move the detached Extra into an instance's S frame,
  // which declares no key of O's, and it is listed as an added node there; Apply it into O and `toTemplateNodes` took the
  // stale marker, so O held KX twice — and the load's re-key then gave the SECOND in document order a new key, which could
  // be the original's. Mutation: drop `!declared?.has(marker)` in `toTemplateNodes` — the promoted node carries KX.
  it('a detached node moved into another frame of O and applied into O gets a key of its own', async () => {
    install(pDoc(), sDoc(), oDoc());
    await load(scene([ROOT, ROOT2]));
    const detached = named('Extra', ROOT).id;
    detachPrefabInstance(rootId(ROOT));
    expect(templateKeyOf(handleOf(detached))).toBe(''); // #1874: the Detach strips it…
    setTemplateKey(handleOf(detached), KX); // …so the stale marker is planted
    setParent(detached, named('SA', ROOT2).id);
    const keys = collectInstanceOverrideKeys(named('SR', ROOT2).id, getCachedPrefabSync(S) as PrefabFile).added;
    expect(keys).toHaveLength(1); // premise: listed as an added node of the nested S instance
    const res = await applyToPrefabSelective(named('SR', ROOT2).id, new Set(keys), { perKey: { [keys[0]!]: O } });
    expect(res.targets).toEqual([{ key: keys[0], target: O }]);
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === O).pop()!;
    const promoted = written.entities.find((e) => e.localId === 3)!.added!;
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.key).toBeTruthy();
    expect(promoted[0]!.key).not.toBe(KX);
    const all = templateKeysOf(written as TemplateKeyDoc);
    expect(new Set(all).size).toBe(all.length);
  });

  // Two detached copies of O's Extra both carry KX, which T does not declare, so the first may keep it; the second is a
  // second node with the same key in one promotion. Mutation: drop `declared?.add(key)` in `toTemplateNodes` — both
  // are written with KX.
  it('two nodes carrying one marker, promoted in one Apply, get distinct keys', async () => {
    const T = 'cccccccc-0000-4000-8000-000000018196';
    const ROOT4 = 'dddddddd-0000-4000-8000-000000018194';
    const tDoc = { id: T, version: 9, name: 'T', rootLocalId: 1, nextLocalId: 3, entities: [
      row(1, 'TR', 0, 'eeeeeeee-0000-4000-8000-0000000181a1'), row(2, 'TM', 1, 'eeeeeeee-0000-4000-8000-0000000181a2', { prefab: S }),
    ] };
    install(pDoc(), sDoc(), oDoc(), tDoc);
    await load({ id: 'k4', version: SCENE_FORMAT_VERSION, name: 'S', resources: [], entities: [
      ...[ROOT, ROOT2].map((guid, i) => ({ id: i + 1, prefab: O, guid, traits: { EntityAttributes: { name: `I${i}`, parentId: 0 } } })),
      { id: 3, prefab: T, guid: ROOT4, traits: { EntityAttributes: { name: 'IT', parentId: 0 } } },
    ] } as unknown as SceneData);
    const extras = [named('Extra', ROOT).id, named('Extra', ROOT2).id];
    detachPrefabInstance(rootId(ROOT));
    detachPrefabInstance(rootId(ROOT2));
    for (const id of extras) setParent(id, named('SA', ROOT4).id);
    const keys = collectInstanceOverrideKeys(named('SR', ROOT4).id, getCachedPrefabSync(S) as PrefabFile).added;
    expect(keys).toHaveLength(2); // premise
    await applyToPrefabSelective(named('SR', ROOT4).id, new Set(keys), { perKey: Object.fromEntries(keys.map((k) => [k, T])) });
    const written = writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === T).pop()!;
    const all = templateKeysOf(written as TemplateKeyDoc);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(2);
  });
});

describe('the derive does not climb past an unmarked node; the heal does (close-out re-review)', () => {
  // Two O instances placed under an S instance's member and then DETACHED, their Extras holding stale KX markers (Detach
  // left them until #1874, which strips them, so the test plants them). Duplicating the S instance must not derive both
  // Extras from the S frame root plus KX. Mutation: let the derive
  // climb past unmarked ancestors (`pastUnmarked` true in `derivesFrom`) — both copies take one guid.
  it('a duplicate holding two detached copies of one keyed node gives them distinct guids', async () => {
    const ROOTS = 'dddddddd-0000-4000-8000-000000018197';
    install(pDoc(), sDoc(), oDoc());
    await load({ id: 'k5', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
      entities: [{ id: 1, prefab: S, guid: ROOTS, traits: { EntityAttributes: { name: 'IS', parentId: 0 } } }] } as unknown as SceneData);
    const at = named('SA', ROOTS).id;
    for (let i = 0; i < 2; i++) {
      const d = instantiatePrefab(getCachedPrefabSync(O) as PrefabFile, at);
      setPrefabSource(d, { id: O });
      detachPrefabInstance(d);
    }
    const extras = getAllEntities().filter((e) => e.name === 'Extra');
    expect(extras.map((e) => templateKeyOf(handleOf(e.id)))).toEqual(['', '']); // #1874: the Detach strips them…
    for (const e of extras) setTemplateKey(handleOf(e.id), KX); // …so the stale markers are planted
    const copy = copySnapshot(snapshotEntity(rootId(ROOTS))!);
    const guids: string[] = [];
    const walk = (s: EntitySnapshot) => { if (find(s, 'Extra') === s) guids.push(guidIn(s)); s.children.forEach(walk); };
    walk(copy);
    expect(guids).toHaveLength(2);
    expect(new Set(guids).size).toBe(2);
  });

  // In the edit world a copy mints for every key no NESTED prefab declares — including one minted by an earlier copy this
  // session, which the cached edited document does not hold. Mutation: mint only keys the cached edited document
  // declares (the rule before the re-review) — the copy of the copy keeps the first copy's key.
  it('a copy of a copy in the prefab-edit world takes a key of its own', async () => {
    install(pDoc(), sDoc(), oDoc());
    await load(scene([ROOT]));
    world.editing = O;
    const first = copySnapshot(snapshotEntity(rootId(ROOT))!);
    const k1 = keyIn(find(first, 'Extra'));
    const spawned = respawnFromSnapshot(first);
    const second = copySnapshot(snapshotEntity(spawned)!);
    const k2 = keyIn(find(second, 'Extra'));
    expect(k1).not.toBe(KX);
    expect(k2).not.toBe(k1);
    expect(k2).not.toBe('');
  });
});
