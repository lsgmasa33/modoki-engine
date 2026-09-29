/** A REBUILD of an existing prefab from a fresh tree keeps each row's identity by its hierarchy PATH (#1782).
 *
 *  Import Model over an existing prefab and the 2D skin-rig update in place spawn a fresh tree and serialize it over the
 *  file. They numbered rows 1..n by position with fresh nodeGuids, so each new row derived the member guid the old row
 *  at its POSITION had, and a scene's ref or edit of an old member retargeted onto whatever node now sat at that number.
 *  Both now go through `serializeRebuildOver`: a node whose path (the names from the root down) matches one row keeps
 *  that row's `localId` and `nodeGuid` (#1759 option 1; Unity's model importer keeps identity across a reimport by path,
 *  hub ruling 2026-09-29), a new node goes above the old high-water mark (#1774), and a path that is not unique mints.
 *
 *  Driven through the REAL skin-rig writer (`makeRigPrefabAsset`) and its real commit; Import Model is a React callback,
 *  so its call of the same entry point is pinned by `prefabSerializeCallSites.test.ts`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

/** Files on disk, path → text. The commit writes here; every GET is served from here. */
const onDisk = new Map<string, string>();
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string) => {
    onDisk.set(path, content);
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import { getCurrentWorld, setCurrentWorld, setRunMode } from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, undoRefusedReason, getEditVersion, undo } from '@modoki/engine/editor';
import { swapHistory, undoLabel } from '../../packages/modoki/src/editor/undo/undoManager';
import { makeRigPrefabAsset } from '../../packages/modoki/src/editor/scene/skinPrefab';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { registerAsset } from '@modoki/engine/runtime';

registerAllTraits();
setActionCallback(pushAction);

const RIG = '/assets/rigs/r1782.rig2d.json';
const SAVE = '/assets/rigs/R1782.prefab.json';
type Bone = { name: string; parent: number; x?: number; y?: number; rot?: number };
const rig = (bones: Bone[]) => ({ id: 'aaaaaaaa-0000-4000-8000-000000001782', bones: bones.map((b) => ({ x: 0, y: 0, rot: 0, ...b })) }) as never;

beforeEach(() => {
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  clearHistory();
  onDisk.clear();
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  vi.stubGlobal('fetch', async (url: string) => {
    const hit = [...onDisk].find(([p]) => String(url).endsWith(p));
    return hit
      ? new Response(hit[1], { status: 200 })
      : { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  });
});

/** Build (or update) the rig prefab from `bones`, and return the document written. */
async function build(bones: Bone[]): Promise<PrefabFile> {
  const r = await makeRigPrefabAsset(RIG, rig(bones), SAVE, 'Rig');
  expect(r).not.toBeNull();
  const doc = JSON.parse(onDisk.get(SAVE)!) as PrefabFile;
  setPrefabCache(doc.id!, null); // the next build reads the FILE, as a later session would
  return doc;
}
/** Each row's path (names from below the root, `/`-joined) → its localId and nodeGuid. */
function rowsByPath(doc: PrefabFile): Map<string, { localId: number; nodeGuid?: string }> {
  const byLocal = new Map(doc.entities.map((e) => [e.localId, e] as const));
  const out = new Map<string, { localId: number; nodeGuid?: string }>();
  for (const e of doc.entities) {
    if (e.localId === (doc.rootLocalId ?? 1)) continue;
    const names: string[] = [];
    for (let at: typeof e | undefined = e; at && at.localId !== (doc.rootLocalId ?? 1);
      at = byLocal.get((at.traits?.EntityAttributes as { parentId?: number } | undefined)?.parentId ?? 0)) names.unshift(at.name ?? '');
    out.set(names.join('/'), { localId: e.localId, nodeGuid: e.nodeGuid });
  }
  return out;
}

describe('the skin-rig update keeps each bone\'s row by its path (#1782)', () => {
  // v1: hips → armL → tip, hips → armR → tip (two bones named "tip", under different parents).
  const v1: Bone[] = [
    { name: 'hips', parent: -1 },
    { name: 'armL', parent: 0 }, { name: 'armR', parent: 0 },
    { name: 'tip', parent: 1 }, { name: 'tip', parent: 2 },
  ];
  // v2: the same bones REORDERED (armR first, and its tip listed before armL's), plus a new "spine".
  const v2: Bone[] = [
    { name: 'hips', parent: -1 },
    { name: 'armR', parent: 0 }, { name: 'tip', parent: 1 },
    { name: 'spine', parent: 0 },
    { name: 'armL', parent: 0 }, { name: 'tip', parent: 4 },
  ];

  it('a reordered bone keeps its localId and nodeGuid; a new bone goes above the old mark', async () => {
    // Mutation: in `serializeRebuildOver`, pass no `replacing` — rows renumber by position, and armL takes armR's number.
    const doc1 = await build(v1);
    const doc2 = await build(v2);
    expect(doc2.id).toBe(doc1.id); // precondition: an update in place, under the prefab's guid
    const before = rowsByPath(doc1);
    const after = rowsByPath(doc2);
    for (const path of ['hips', 'hips/armL', 'hips/armR']) expect(after.get(path), path).toEqual(before.get(path));
    const mark = doc1.nextLocalId ?? Math.max(...doc1.entities.map((e) => e.localId)) + 1;
    expect(after.get('hips/spine')!.localId).toBeGreaterThanOrEqual(mark);
    expect([...before.values()].map((r) => r.nodeGuid)).not.toContain(after.get('hips/spine')!.nodeGuid);
  });

  it('two same-named bones under different parents BOTH keep their rows — the path, not the bare name', async () => {
    // Mutation: `match: 'name'` in `serializeRebuildOver` — "tip" is not a unique name, so both mint above the mark.
    const doc1 = await build(v1);
    const doc2 = await build(v2);
    const before = rowsByPath(doc1);
    const after = rowsByPath(doc2);
    expect(after.get('hips/armL/tip'), 'armL/tip').toEqual(before.get('hips/armL/tip'));
    expect(after.get('hips/armR/tip'), 'armR/tip').toEqual(before.get('hips/armR/tip'));
  });

  it('a path that is not unique matches nothing, and each such bone mints above the mark', async () => {
    // Mutation: let a duplicated path match (drop the `liveNames`/`rowNames` count check) — the two bones share one row.
    const twins: Bone[] = [{ name: 'hips', parent: -1 }, { name: 'twin', parent: 0 }, { name: 'twin', parent: 0 }];
    const doc1 = await build(twins);
    const doc2 = await build(twins);
    const mark = doc1.nextLocalId ?? Math.max(...doc1.entities.map((e) => e.localId)) + 1;
    const twinRows = doc2.entities.filter((e) => e.name === 'twin');
    expect(twinRows).toHaveLength(2);
    for (const r of twinRows) expect(r.localId).toBeGreaterThanOrEqual(mark);
    expect(new Set(twinRows.map((r) => r.nodeGuid)).size).toBe(2);
  });
});

describe("the rig writer's undo entry is a parked DOCUMENT's edit that rebuilds live frames (#1857, #1868)", () => {
  // Both halves restore the prefab in memory and park it (#1868): the document outlives a discarded world, and the rebase
  // lands on the live world, so a preview must refuse it. A fresh make is a new asset and pushes no entry at all.
  // Mutations: drop `_isFileDirect` from skinPrefab's entry — the discard drops it; drop `_rebasesLiveFrames` — the
  // preview gate lets it through; push the fresh make's entry again — the first label check goes red.
  it('survives a discarding history swap, and is refused inside a preview envelope', async () => {
    const v0 = getEditVersion();
    const empty = undoLabel();
    await build([{ name: 'hips', parent: -1 }]);
    expect(undoLabel()).toBe(empty); // a fresh make pushes nothing (#1868)
    await build([{ name: 'hips', parent: -1 }, { name: 'spine', parent: 0 }]);
    // #1858, OBSERVED: Skin "Make prefab" marked the open scene unsaved. It changes a file, not the scene file.
    expect(getEditVersion()).toBe(v0);
    expect(undoLabel()).toBe('Update prefab "Rig"');
    swapHistory('/other-1857.json', { discardOutgoing: true });
    swapHistory('');
    expect(undoLabel()).toBe('Update prefab "Rig"');
    setRunMode('scrub');
    try {
      expect(undoRefusedReason('undo')).toMatch(/Exit the preview/);
    } finally { setRunMode('stopped'); }
  });
});

/** #1868 hub call (e): a rig update's undo restores in memory BY GUID, so a Rename of the prefab since the update does not
 *  strand it. Mutation: key the restore by `savePath` in skinPrefab's undo — the park lands at the old path. */
describe('a rig update undone after a Rename (#1868)', () => {
  it('restores the prior document where the prefab is NOW', async () => {
    const first = await build([{ name: 'hips', parent: -1 }]);
    await build([{ name: 'hips', parent: -1 }, { name: 'spine', parent: 0 }]);
    const MOVED = '/assets/rigs/Moved1868.prefab.json';
    onDisk.set(MOVED, onDisk.get(SAVE)!);
    onDisk.delete(SAVE);
    registerAsset(first.id!, MOVED, 'prefab');
    applyAssetPathMoves([{ from: SAVE, to: MOVED }]);
    await undo();
    expect(peekDirtyAsset(SAVE)).toBeNull();
    const parkedDoc = peekDirtyAsset(MOVED)?.data as PrefabFile | undefined;
    expect(parkedDoc?.entities.map((e) => e.name)).not.toContain('spine');
    expect(parkedDoc?.id).toBe(first.id);
  });
});
