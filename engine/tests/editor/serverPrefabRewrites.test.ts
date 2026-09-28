/** #1751 F1: `/api/prefab-member-paths` rewrites other prefabs and scenes and marks those writes as the editor's own,
 *  so the watcher (which is also what refreshes the client) stays silent. `adoptServerPrefabRewrites` takes its place.
 *
 *  Driven end to end on real files: the REAL router answers every `/api/*` call (the repair route, and the commit's
 *  `/api/write-file` with its `ifMatch`), a GET reads the scratch disk, and the caches are the real ones. Only the
 *  renderer's `resolve-unsaved` answer and the SceneManager's "what is loaded" are stand-ins.
 *
 *  Each case is one symptom #1751 names:
 *  - both prefab caches keep the old tokens, so the next House write is refused as a conflict against its own repair;
 *  - the runtime entry is EVICTED instead of replaced (the watcher's way, #1308's blank);
 *  - the open scene's `lastWrittenSceneBytes` still names the pre-repair bytes (Apply undo's scene half refused);
 *  - the prefab open in prefab edit keeps a pre-repair baseline, so its save is refused as "changed on disk";
 *  - a parked scene's undo stack, recorded over the old refs, is never marked stale. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createWorld } from 'koota';

/** What the stand-in SceneManager reports as loaded: the current path, and the loaded scenes. */
const sm = vi.hoisted(() => ({ current: '' as string, loaded: new Map<string, { path: string; role: string; guid?: string }>() }));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      ...(real.sceneManager as object),
      getCurrent: () => (sm.current ? { path: sm.current } : null),
      getLoadedScenes: () => sm.loaded,
      getNext: () => null,
    },
  };
});

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { setCurrentWorld, getCurrentWorld, registerAsset, clearManifest } from '@modoki/engine/runtime';
import { acquirePrefab, getCachedPrefab, releaseAllForScene, disposeAllCachedResources } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite, prefabTextIsDocument } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { editBaselineFor, _seatEditBaselineForTest, _resetPrefabEditSessionRows } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { PREFAB_EDIT_SCENE_PREFIX } from '../../packages/modoki/src/editor/scene/prefabEditWorld';
import { lastWrittenSceneBytes, setCurrentScenePath, _recordWrittenSceneForTest } from '../../packages/modoki/src/editor/scene/serialize';
import { owedSceneFileChanges, _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { repairMemberPathsEverywhere } from '../../packages/modoki/src/editor/scene/serverPrefabRewrites';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const DOOR = 'aaaaaaaa-0000-4000-8000-0000000017d1';
const HOUSE = 'aaaaaaaa-0000-4000-8000-0000000017d2';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000017d1';
const UI = 'bbbbbbbb-0000-4000-8000-0000000017d2';
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const bind = (target: string) => ({ UIAction: { bindings: [{ event: 'click', action: 'noop', target }] } });
/** Door with Handle (3) under `handleParent`: the Apply moved it from under Frame (2) to the root (1). */
const door = (handleParent: number) => ({ id: DOOR, version: 8, name: 'Door', rootLocalId: 1, entities: [row(1, 'DoorRoot', 0), row(2, 'Frame', 1), row(3, 'Handle', handleParent)] });
const house = () => ({ id: HOUSE, version: 8, name: 'House', rootLocalId: 1, entities: [
  { ...row(1, 'HouseRoot', 0), traits: { ...row(1, 'HouseRoot', 0).traits, ...bind('@member:2.2.3') } }, row(2, 'Door', 1, { prefab: DOOR }),
] });
const OLD_HANDLE = deriveMemberGuid(ROOT, [2, 3]);
const scene = { id: 'cccccccc-0000-4000-8000-0000000017d1', version: 15, name: 'S', resources: [], entities: [
  { id: 1, prefab: DOOR, guid: ROOT, traits: { EntityAttributes: { name: 'DoorRoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  { id: 2, traits: { EntityAttributes: { name: 'Ui', parentId: 0, guid: UI }, ...bind(OLD_HANDLE) } },
] };
const P = { door: '/door.prefab.json', house: '/house.prefab.json', scene: '/s.scene.json', other: '/t.scene.json' };
const text = (doc: unknown) => JSON.stringify(doc, null, 2) + '\n';
const tokenOf = (doc: unknown) => ((doc as PrefabFile).entities[0]!.traits.UIAction as { bindings: { target: string }[] }).bindings[0]!.target;

let dir = '';
const read = (p: string) => fs.readFileSync(path.join(dir, p), 'utf-8');

beforeEach(() => {
  dir = makeScratchDir('modoki-1751-');
  // The Apply already wrote Door with Handle re-parented; every other file still names the old member path.
  const files: Record<string, unknown> = { [P.door]: door(1), [P.house]: house(), [P.scene]: scene, [P.other]: { ...scene, id: 'cccccccc-0000-4000-8000-0000000017d2' } };
  for (const [p, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), text(doc));
  const ctx = {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => path.join(dir, p.startsWith('/') ? p : `/${p}`),
    absToAssetUrl: (abs: string) => `/${path.relative(dir, abs)}`,
    getManifest: () => ({ version: 2, folders: [], assets: [
      { path: P.door, type: 'prefab', guid: DOOR }, { path: P.house, type: 'prefab', guid: HOUSE },
      { path: P.scene, type: 'scene' }, { path: P.other, type: 'scene' },
    ] }),
    markEditorWrite: () => {},
    // As the renderer answers: an open prefab edit is the live world, reported under `liveScene` with the prefab's path
    // (#1751: "a House open in prefab edit reports as liveScene"). Only the registries asked about are answered.
    requestBrowser: async (_op: string, params: unknown) => {
      const asked = (params as { registries?: string[] }).registries ?? [];
      const live = sm.current.startsWith(PREFAB_EDIT_SCENE_PREFIX) ? [{ path: P.house, registry: 'liveScene' }] : [];
      return { ok: true, holds: live.filter((h) => asked.includes(h.registry)), discarded: [], covers: asked };
    },
  } as unknown as BackendContext;
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const api = url.match(/\/api\/[^?]*/)?.[0];
    if (api) {
      const r = await handleBackendRequest(ctx, { method: init?.method ?? 'GET', urlPath: api, query: new URLSearchParams(url.split('?')[1] ?? ''), body: init?.body ? JSON.parse(String(init.body)) : undefined }) as { status?: number; body: unknown };
      const status = r.status ?? 200;
      return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as unknown as Response;
    }
    const file = path.join(dir, url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!);
    if (!fs.existsSync(file)) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) } as unknown as Response;
    const bytes = fs.readFileSync(file);
    return {
      ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => bytes.toString('utf-8'), json: async () => JSON.parse(bytes.toString('utf-8')),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }));
  clearManifest();
  registerAsset(DOOR, P.door, 'prefab');
  registerAsset(HOUSE, P.house, 'prefab');
  setCurrentWorld(createWorld());
  // What the editor held before the repair: House as it was read, in both caches (the runtime one owned by scene 1).
  setPrefabCache(HOUSE, house() as never);
  setPrefabCache(P.house, house() as never);
  sm.current = P.scene;
  sm.loaded = new Map([['s', { path: P.scene, role: 'primary' }]]);
  setCurrentScenePath(P.scene);
  _resetSceneAdoptionForTests();
  // No record from an earlier case: each case that needs one seats it.
  _recordWrittenSceneForTest(P.scene, '');
});

afterEach(() => {
  releaseAllForScene(1);
  disposeAllCachedResources();
  _resetPrefabEditSessionRows();
  useEditorStore.setState({ editingPrefab: null } as never);
  setCurrentScenePath(null);
  vi.unstubAllGlobals();
  getCurrentWorld()?.destroy();
});

const repair = (liveWorldRepaired = true) => repairMemberPathsEverywhere(DOOR, door(2), { liveWorldRepaired });

describe('a server prefab rewrite brings the client along (#1751 F1)', () => {
  // Mutation: skip the adopt in `repairMemberPathsEverywhere` — both reads keep '@member:2.2.3' and the commit is
  // refused as a conflict (the #1723 repro).
  it('both prefab caches hold the rewrite, and a later write of that prefab over its cached copy lands', async () => {
    await acquirePrefab(1, HOUSE);
    await repair();
    expect(read(P.house)).toContain('"@member:2.3"');
    expect(tokenOf(getCachedPrefabSync(HOUSE))).toBe('@member:2.3');
    expect(tokenOf(getCachedPrefabSync(P.house))).toBe('@member:2.3');
    expect(tokenOf(getCachedPrefab(HOUSE))).toBe('@member:2.3');
    const cached = getCachedPrefabSync(HOUSE)!;
    const edited = JSON.parse(JSON.stringify(cached)) as PrefabFile;
    edited.name = 'House, renamed later';
    const wrote = await commitPrefabWrite(HOUSE, edited, { expected: cached });
    expect(wrote).toMatchObject({ ok: true });
    expect(JSON.parse(read(P.house)).name).toBe('House, renamed later');
  });

  // The watcher's runtime half is `invalidatePrefab`, an eviction: a synchronous reader of a prefab the open scene owns
  // then reads `undefined` until the next load (#1308). Mutation: seat the runtime cache with `invalidatePrefab` in
  // `adoptServerPrefabRewrites` instead of `seatCaches`.
  it('the runtime entry of an owned prefab is REPLACED, never evicted', async () => {
    await acquirePrefab(1, HOUSE);
    await repair();
    expect(getCachedPrefab(HOUSE)).toBeDefined();
  });

  // Mutation: drop the `adoptRewrittenSceneBytes` call — the record keeps the pre-repair bytes.
  it('the open scene\'s record follows the rewrite when it held what the route read, and its stack stays', async () => {
    const before = read(P.scene);
    _recordWrittenSceneForTest(P.scene, before); // the editor's last save is what the disk holds
    await repair();
    expect(read(P.scene)).not.toBe(before);
    expect(lastWrittenSceneBytes(P.scene)).toBe(read(P.scene));
    expect(owedSceneFileChanges()).not.toContain(P.scene);
  });

  // A record that says something else is a real outside change: moving it would let a later ifMatch save overwrite
  // that change. Mutation: drop the prior comparison in `adoptRewrittenSceneBytes`.
  it('a record that did not hold what the route read stays as it is', async () => {
    // The disk holds something else than the editor's last save (an outside edit): the route reads THAT.
    const mine = read(P.scene).replace('"name": "S"', '"name": "S, as the editor last saved it"');
    _recordWrittenSceneForTest(P.scene, mine);
    await repair();
    expect(lastWrittenSceneBytes(P.scene)).toBe(mine);
  });

  // Mutation: drop the `recordSceneFileChanged` branch — the parked scene's stack is never marked stale.
  it('a scene no live world holds gets its undo stack marked stale, as the watcher would', async () => {
    await repair();
    expect(read(P.other)).not.toContain(OLD_HANDLE);
    expect(owedSceneFileChanges()).toContain(P.other);
    expect(owedSceneFileChanges()).not.toContain(P.scene);
  });

  // After a swap that bypassed the barrier nothing live is known to hold the repair. Mutation: ignore
  // `liveWorldRepaired` — the open scene's record moves and its stack is kept.
  it('with no live world known to hold the repair, no record moves and every rewritten scene is marked stale', async () => {
    const mine = read(P.scene);
    _recordWrittenSceneForTest(P.scene, mine);
    await repair(false);
    expect(lastWrittenSceneBytes(P.scene)).toBe(mine);
    expect(owedSceneFileChanges()).toEqual(expect.arrayContaining([P.scene, P.other]));
  });

  // Close-out review: Apply's undo repairs BEFORE its "still THAT world?" check, so it asks the question as a function,
  // answered once the route has returned. A world that replaced it meanwhile was loaded from the pre-repair bytes: no
  // record of it may move. Mutation: evaluate a function option as `true` in `repairMemberPathsEverywhere`.
  it('a liveness question is asked after the route returns, and "no" moves no record', async () => {
    const mine = read(P.scene);
    _recordWrittenSceneForTest(P.scene, mine);
    let asked = 0;
    await repairMemberPathsEverywhere(DOOR, door(2), { liveWorldRepaired: () => { asked++; return read(P.house).includes('"@member:2.2.3"'); } });
    expect(asked).toBe(1);
    expect(lastWrittenSceneBytes(P.scene)).toBe(mine);
    expect(owedSceneFileChanges()).toContain(P.scene);
  });
});

describe('the prefab open in prefab edit (#1751 F1, hub: pin the discard side)', () => {
  const openEdit = () => {
    sm.current = `${PREFAB_EDIT_SCENE_PREFIX}${HOUSE}`;
    sm.loaded = new Map();
    setCurrentScenePath(null);
    useEditorStore.setState({ editingPrefab: { guid: HOUSE, path: P.house, name: 'House' } } as never);
    _seatEditBaselineForTest(HOUSE, house() as unknown as PrefabFile);
  };

  // The edit world is adopted and savable when the route runs inside the Apply step, so its file is rewritten to agree
  // with it and the baseline follows. Mutation: drop `adoptRewrittenEditBaseline` — the save's precondition then
  // compares the rewritten file against the pre-repair baseline, and refuses.
  it('the baseline follows the rewrite, so the edit\'s save is conditional on what the file now holds', async () => {
    openEdit();
    await repair();
    expect(prefabTextIsDocument(read(P.house), editBaselineFor(HOUSE)!)).toBe(true);
    expect(tokenOf(editBaselineFor(HOUSE))).toBe('@member:2.3');
  });

  // DISCARD: the edit ends without a save. The file keeps the repaired refs (the route wrote them, not the edit's
  // save), and nothing left behind still describes the pre-repair bytes — a reopen reads the disk. Mutation: have the
  // route skip the prefab open in prefab edit (ask `liveScene` in its gate) — the file keeps '@member:2.2.3' and the
  // discard leaves House's ref dangling.
  it('a discarded edit leaves the file with the repaired refs and no pre-repair baseline', async () => {
    openEdit();
    await repair();
    // Exit without saving: the edit world goes, the flag is cleared, a real scene is live again.
    useEditorStore.setState({ editingPrefab: null } as never);
    sm.current = P.scene;
    setCurrentScenePath(P.scene);
    expect(read(P.house)).toContain('"@member:2.3"');
    expect(read(P.house)).not.toContain('"@member:2.2.3"');
    const kept = editBaselineFor(HOUSE);
    expect(kept === null || prefabTextIsDocument(read(P.house), kept)).toBe(true);
    expect(tokenOf(getCachedPrefabSync(HOUSE))).toBe('@member:2.3');
  });

  // A baseline that described something else is a real outside change the save must still refuse over. Mutation: drop
  // the `prefabTextIsDocument(prior, baseline)` check.
  it('a baseline that did not describe what the route read stays as it is', async () => {
    openEdit();
    const other = { ...house(), name: 'House as this edit opened it' } as unknown as PrefabFile;
    _seatEditBaselineForTest(HOUSE, other);
    await repair();
    expect(editBaselineFor(HOUSE)).toEqual(other);
  });

  // Mutation: drop the "session is open" check — a closed session's leftover baseline is moved by a repair run in a
  // scene world.
  it('no baseline moves while no edit of that prefab is open', async () => {
    _seatEditBaselineForTest(HOUSE, house() as unknown as PrefabFile); // a leftover from an edit that ended
    await repair();
    expect(tokenOf(editBaselineFor(HOUSE))).toBe('@member:2.2.3');
  });
});
