/** #1724: Apply on a BASE scene's nested instance, through the REAL two-file path — `applyToPrefabSelective`, the
 *  plural `commitPrefabWrites`, and the undo history, over a fake route that honours if-match as the real one does.
 *
 *  A base's instance is not in the primary snapshot the undo reloads (`serializeScene` drops every base-owned entity),
 *  so the undo rebuilds it itself: the applied frame from its pre-Apply capture, every other base instance of each
 *  written file re-derived. An Apply whose first write is an ENCLOSING prefab (ruling (a)'s default for a field of a
 *  component the row adds; any "override in Prefab 'O'") dropped the capture, and the O refresh re-derived the frame
 *  from O's restored row: the instance's own edit, which the Apply had moved into O (U15), was gone — and the base
 *  being dirty, Save All wrote the loss.
 *
 *  The carry is modelled as the world simply kept (the real `loadScene` re-spawns a base with fresh ids and re-seeds
 *  its marks; neither is what this file pins). The restore's rebase is REAL: it rebuilds the carried O instance built
 *  from the document being undone, as production does. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk and switches. */
const fs = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  /** Every write the route was asked for, refused or not. */
  posts: [] as Array<{ path: string; content: string; ifMatch?: string }>,
  /** The next write fails as a backend error would (#1668). */
  fail: false,
  /** The next write is refused by the #1468 format gate, which runs BEFORE the if-match check. */
  tooNew: false,
  /** When set, every write waits for it — a write held in flight (#1667). */
  gate: null as Promise<void> | null,
  /** Writes waiting on `gate`. */
  waiting: 0,
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    if (fs.gate) { fs.waiting++; await fs.gate; fs.waiting--; }
    fs.posts.push({ path, content, ifMatch: opts?.ifMatch });
    const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    if (fs.fail) { fs.fail = false; return answer(500, { error: 'the disk is full' }); }
    if (fs.tooNew) { fs.tooNew = false; return answer(409, { ok: false, conflict: true, reason: 'prefab-format-too-new', error: 'a newer build wrote this prefab' }); }
    if (opts?.ifMatch !== undefined) {
      const cur = fs.disk.get(path);
      const hash = cur === undefined ? null : createHash('sha256').update(cur).digest('hex');
      if (hash !== opts.ifMatch) return answer(409, { ok: false, conflict: true, reason: 'if-match' });
    }
    fs.disk.set(path, content);
    return answer(200, { ok: true });
  },
}));

/** A titled scene whose world holds only base-owned entities: the restore's reload CARRIES them (kept as they are). */
const sm = vi.hoisted(() => ({
  path: 'scenes/Level.json' as string | null,
  loads: 0,
  saves: 0,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      // A swap's copy carry (#1939): this fake world holds no scene copies.
      captureSceneCopies: () => new Map(),
      getCurrent: () => (sm.path === null ? null : { path: sm.path }),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: async (path: string, opts?: { preloaded?: unknown }) => {
        sm.loads++;
        void opts;
        sm.path = path;
        return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
      },
    },
  };
});
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveScene: async () => { sm.saves++; return { saved: true, reason: 'ok' }; },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, instantiatePrefabIntoWorld,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { framesBuiltFromOtherRows } from '../../packages/modoki/src/editor/scene/prefabFrames';
import { rebaseStaleInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { isSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';

registerAllTraits();
setActionCallback(pushAction);
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
// The multi-file commit reads each file before it writes any (#1692): serve the fake disk.
vi.stubGlobal('fetch', async (url: string) => {
  const path = [...fs.disk.keys()].find((p) => String(url).includes(p));
  return path ? new Response(fs.disk.get(path)!, { status: 200 }) : new Response('', { status: 404 });
});

const P = 'aaaaaaaa-0000-4000-8000-000000001693';
const O = 'aaaaaaaa-0000-4000-8000-000000001694';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = G(93);
const ROOT2 = G(94);
const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, G(1), 'R', 0), row(2, G(2), 'A', 1)] });
/** O: OR → N (P), whose row sets A.x = 3. */
const oDoc = () => ({ id: O, version: 6, name: 'O', rootLocalId: 1, entities: [
  row(1, G(3), 'OR', 0),
  { localId: 2, nodeGuid: G(4), name: 'N', prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } }, overrides: { 2: { Transform: { x: 3 } } } },
] });
const install = (doc: { id: string }) => { prefabs.set(doc.id, doc); setPrefabCache(doc.id, doc as never); };
/** The base scene's guid, stamped on every entity of both O instances. */
const BASE = 'dddddddd-0000-4000-8000-000000001724';

const all = () => getAllEntities();
/** The entity named `name` inside the O instance whose root guid is `root`. */
const inO = (root: string, name: string) => {
  const byId = new Map(all().map((e) => [e.id, e]));
  const r = all().find((e) => e.guid === root)!.id;
  return all().find((e) => {
    if (e.name !== name) return false;
    for (let c: typeof e | undefined = e; c; c = byId.get(c.parentId)) if (c.id === r) return true;
    return false;
  })!.id;
};
const tfX = (id: number) => (getCurrentWorld().entities.find((e) => e.id() === id)!.get(getTraitByName('Transform')!.trait) as { x: number }).x;
const disk = (id: string) => JSON.parse(fs.disk.get(id)!) as PrefabFile;
/** The document the editor holds for `id`: the one an undo parked for Save (#1868), else the file's. */
const held = (id: string) => JSON.parse(JSON.stringify(peekDirtyAsset(id)?.data ?? disk(id))) as PrefabFile;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
/** Each O instance's A.x: [the applied one, the other one]. */
const xs = () => [tfX(inO(ROOT, 'A')), tfX(inO(ROOT2, 'A'))];
/** The nested P frame N1 of the applied instance, and its own listed field keys. */
const n1 = () => inO(ROOT, 'R');
const ownKeys = () => collectInstanceOverrideKeys(n1(), getCachedPrefabSync(P) as PrefabFile).fields.filter((k) => k.endsWith('.Transform.x'));

beforeEach(() => {
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('scenes/Level.json');
  prefabs.clear();
  install(pDoc());
  install(oDoc());
  fs.disk.clear();
  fs.disk.set(P, jsonFileBody(pDoc()));
  fs.disk.set(O, jsonFileBody(oDoc()));
  fs.posts.length = 0;
  sm.path = 'scenes/Level.json';
  useEditorStore.setState({ showToast: vi.fn() } as never);
  setCurrentScenePath('scenes/Level.json');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  for (const guid of [ROOT, ROOT2]) {
    const id = instantiatePrefabIntoWorld(getCurrentWorld(), oDoc() as never, 0, undefined, O);
    for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid });
  }
  for (const e of getCurrentWorld().entities) {
    if (e.has(eaMeta.trait)) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), sourceScene: BASE });
  }
});

describe('#1724: undo of an Apply on a base scene\'s nested instance keeps the instance\'s own edit', () => {
  /** N1's A.x = 5 over O's row (3), applied as `key` to `target`. */
  async function applyFive(target: string) {
    expect(xs()).toEqual([3, 3]); // precondition: O's row sets it in both
    writeTraitFieldWithUndo(inO(ROOT, 'A'), getTraitByName('Transform')!, 'x', 5);
    const [key] = ownKeys();
    expect(key).toBeDefined();
    const res = await quietly(() => applyToPrefabWithUndo(n1(), new Set([key!]), { perKey: { [key!]: target } }));
    expect(res.applied).toBe(true);
    return res;
  }

  it('target O (the first write is the ENCLOSING prefab): undo restores 5 and lists it again; redo applies it again', async () => {
    // Mutation: gate the base capture on the frame's own prefab being written (`ownWritten`, the pre-fix line) — the
    // undo re-derives N1 from O's restored row: [3, 3].
    //   And: drop the rebuild of the applied frame from its capture (`rederiveBaseInstances`) — the same [3, 3].
    const res = await applyFive(O);
    expect(res.writes?.map((w) => w.source)).toEqual([O]);
    expect((disk(O).entities[1]!.overrides?.[2]?.Transform as { x: number }).x).toBe(5);
    expect(xs()).toEqual([5, 5]);
    expect(ownKeys()).toEqual([]); // U15: the value is O's now, not the instance's

    await quietly(() => undo());
    expect(held(O)).toEqual(oDoc());
    expect(held(P)).toEqual(pDoc());
    expect(xs()).toEqual([5, 3]);
    expect(ownKeys()).toHaveLength(1); // an override of the instance again, so the dirty base's save writes it
    expect(isSceneDirty(BASE)).toBe(true);

    await quietly(() => redo());
    expect((disk(O).entities[1]!.overrides?.[2]?.Transform as { x: number }).x).toBe(5);
    expect(xs()).toEqual([5, 5]);
    expect(ownKeys()).toEqual([]);
  });

  it('target O, then P changes outside the history before the undo: the instance keeps P\'s new member AND its own 5', async () => {
    // Close-out review of #1724: the side is rebuilt onto the CURRENT copy of its own prefab (then `rebuildInstanceFromCapture`; `rebuildFrameFromSide` since #1880 F7d).
    // Mutation: rebuild it with `rebuildInstance` from the captured copy — the applied instance loses B (the member P
    // gained since), and its P frame reads as built from other rows, so Apply and Revert would refuse it.
    // [Old per-frame route, deleted in #1880 F7d: this mutation's target no longer exists and it was not re-measured on the entry route; the case stays as the outcome.]
    await applyFive(O);
    const grown = pDoc();
    (grown.entities as unknown[]).push(row(3, G(5), 'B', 1));
    ((grown.entities[2] as { traits: { Transform: { x: number } } }).traits.Transform).x = 7;
    install(grown);
    fs.disk.set(P, jsonFileBody(grown));
    await quietly(() => rebaseStaleInstances());
    expect([tfX(inO(ROOT, 'B')), tfX(inO(ROOT2, 'B'))]).toEqual([7, 7]); // precondition: both frames took it

    await quietly(() => undo());
    expect(xs()).toEqual([5, 3]);
    expect([tfX(inO(ROOT, 'B')), tfX(inO(ROOT2, 'B'))]).toEqual([7, 7]);
    expect(framesBuiltFromOtherRows(n1())).toEqual([]);
  });

  it('target P ([P, O]: U13 drops O\'s row): undo restores 5 on the applied instance and 3 on the other', async () => {
    // The control: the frame's own prefab is the first write, which the undo handled before #1724.
    // ⚠️ Not a guard for the rebuild ORDER or for the other instances' re-derive: the restore's real rebase already
    // rebuilds every frame built from the document being undone here, so dropping either stays green in THIS file.
    // `applyPrefabDirtiesBase` and `sceneMemberRowWriter` (#1483 review 3) pin both, with no rebase in the way.
    const res = await applyFive(P);
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]);
    expect(xs()).toEqual([5, 5]);

    await quietly(() => undo());
    expect(held(P)).toEqual(pDoc());
    expect(held(O)).toEqual(oDoc());
    expect(xs()).toEqual([5, 3]);
    expect(ownKeys()).toHaveLength(1);

    await quietly(() => redo());
    expect(xs()).toEqual([5, 5]);
  });
});

describe('#1741: undo of a U14 Apply made from the OUTER root keeps the nested frame\'s own edit', () => {
  /** The applied O instance's root. */
  const outer = () => all().find((e) => e.guid === ROOT)!.id;
  const nestedKeys = () => collectInstanceOverrideKeys(outer(), getCachedPrefabSync(O) as PrefabFile).nested;
  /** N1's A.x = 5 over O's row (3), applied from the OUTER root as its chain-qualified key, to `target`. */
  async function applyFiveFromOuter(target: string) {
    expect(xs()).toEqual([3, 3]); // precondition: O's row sets it in both
    writeTraitFieldWithUndo(inO(ROOT, 'A'), getTraitByName('Transform')!, 'x', 5);
    const [key] = nestedKeys();
    expect(key).toBeDefined(); // precondition: U14 lists the nested frame's edit on the outer root
    const res = await quietly(() => applyToPrefabWithUndo(outer(), new Set([key!]), { perKey: { [key!]: target } }));
    expect(res.applied).toBe(true);
    return res;
  }

  for (const [target, files] of [[O, [O]], [P, [P, O]]] as const) {
    it(`target ${target === O ? 'O' : 'P'}: undo restores 5 on the applied instance and 3 on the other, listed again; redo applies it again`, async () => {
      // Mutation: rebuild the side with the LIVE nested capture (drop `side.nested` in `restoreBaseInstance`) — the
      // Apply's `took` already moved N1's 5 out, so the undo re-derives it from O's restored row: [3, 3].
      const res = await applyFiveFromOuter(target);
      expect(res.writes?.map((w) => w.source)).toEqual(files);
      expect(xs()).toEqual([5, 5]);
      expect(nestedKeys()).toEqual([]);

      await quietly(() => undo());
      expect(held(O)).toEqual(oDoc());
      expect(held(P)).toEqual(pDoc());
      expect(xs()).toEqual([5, 3]);
      expect(nestedKeys()).toHaveLength(1); // the frame's own edit again, so the dirty base's save writes it
      expect(ownKeys()).toHaveLength(1);
      expect(isSceneDirty(BASE)).toBe(true);

      await quietly(() => redo());
      expect(xs()).toEqual([5, 5]);
      expect(nestedKeys()).toEqual([]);
    });
  }

  it('P is RENUMBERED on disk between the Apply and its undo: the captured frame is translated by nodeGuid, not by number', async () => {
    // The side's nested capture is keyed in the P it was read against; the frame expands the renumbered P by then (A is
    // row 7, and nothing is row 2). Mutation: skip the capture's translation in the re-apply (`translateLocalIds` in
    // `reapplyNestedInstanceOverrides`) — the 5 is written to row 2, which names nothing, and A reads 0.
    // [Old per-frame route, deleted in #1880 F7d: this mutation's target no longer exists and it was not re-measured on the entry route; the case stays as the outcome.]
    await applyFiveFromOuter(O);
    const renumbered = pDoc();
    (renumbered.entities[1] as { localId: number }).localId = 7;
    install(renumbered);
    fs.disk.set(P, jsonFileBody(renumbered));
    await quietly(() => rebaseStaleInstances());
    await quietly(() => undo());
    // Only the applied instance is asserted. The hand renumber leaves O's row keyed by P's OLD numbers (the editor never
    // renumbers: localIds are kept like Unity fileIDs, #1759), so the other instance's value is the renumber's own hazard.
    expect(tfX(inO(ROOT, 'A'))).toBe(5);
    expect(framesBuiltFromOtherRows(n1())).toEqual([]);
  });
});
