/** #1844 + #1834: a file an undo or redo PUTS BACK is re-announced to the renderer in the same step.
 *
 *  The delete pruned the file's guid from the renderer's manifest and evicted the prefab from both caches; the restore goes
 *  through `/api/write-file`, which rebuilds nothing, and is the editor's own write, which no watcher refresh follows. So
 *  the step itself loads the manifest from ONE rescan's reply and refetches an owned prefab (`reannounceRestoredFiles`),
 *  and leaves an unsavable world to the undo manager's GATE, which refuses before it pops the entry. The loader's half of
 *  #1834 (the delete evicts its entry, keeping the owners) is asserted here too, against the same fake disk.
 *
 *  The fake route's rescan answers a manifest built from its disk, and nothing PUSHES one: a guid that resolves after the
 *  step resolved through the reply. Each case names the mutation that turns it red. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeAssetRoute, sha256, type FakeAssetRoute } from './fakeAssetRoute';
import { makeDeleteUndo, makeFileImportUndo, type DeleteResult } from '../../src/editor/panels/assetUndo';
import { applyAssetPathMoves } from '../../src/editor/panels/assetEditorBindings';
import { clearManifest, loadManifestJson, registerAsset, resolveGuidToPath } from '../../src/runtime/loaders/assetManifest';
import { acquirePrefab, getCachedPrefab, getResourceStats, disposeAllCachedResources } from '../../src/runtime/loaders/meshTemplateCache';
import { pushAction, undoStep, canUndo, setPreviewUndoSession, _resetHistoryContexts } from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';
import { useEditorStore } from '../../src/editor/store/editorStore';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

const G = 'aaaaaaaa-1844-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-1844-4000-8000-000000000002';
const P = '/assets/prefabs/Q.prefab.json';
const O = '/assets/prefabs/Other.prefab.json';
const doc = (id: string, name: string) => JSON.stringify({ version: 8, id, name, rootLocalId: 1, entities: [] });

let route: FakeAssetRoute;
let spies: Array<{ mockRestore: () => void }> = [];

/** What the real rescan answers: a complete scan of the disk as it is now. */
const manifestOfDisk = () => ({
  version: 2, folders: [],
  assets: [...route.disk.keys()].filter((p) => p.endsWith('.prefab.json'))
    .map((p) => ({ path: p, type: 'prefab', guid: (JSON.parse(route.text(p)!) as { id: string }).id })),
});
const rescans = () => route.calls.filter((c) => c.url.endsWith('/api/rescan-assets')).length;
const A = (path: string): AssetEntry => ({ path, name: path.split('/').pop()!, type: 'prefab' } as AssetEntry);
/** The forward delete, as the editor ends it: the file gone, the route's pruning rebuild landed, both caches evicted. */
const trashQ = () => {
  route.disk.delete(P);
  loadManifestJson(manifestOfDisk(), { prune: true });
  applyAssetPathMoves([{ from: P, to: null }]);
};
const deleted = (): DeleteResult => ({ asset: A(P), snapshots: [{ path: P, content: doc(G, 'Q') }], deletePaths: [P] });

beforeEach(() => {
  setRunMode('stopped');
  setPreviewUndoSession(null);
  _resetHistoryContexts();
  clearManifest();
  route = makeFakeAssetRoute();
  route.rescanBody = manifestOfDisk;
  route.put(P, doc(G, 'Q'));
  route.put(O, doc(OTHER, 'Other'));
  const fetch = route.fetch;
  // An imported JSON's identity is decided by the backend (#1713): kept as it is here.
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => (String(url).endsWith('/api/import-identity')
    ? new Response(JSON.stringify({ content: (JSON.parse(init!.body!) as { content: string }).content, id: G }), { status: 200 })
    : fetch(url, init)));
  loadManifestJson(manifestOfDisk(), { prune: true });
  useEditorStore.setState({ toast: null });
  spies.push(vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}));
});
afterEach(() => {
  setPreviewUndoSession(null);
  setRunMode('stopped');
  for (const s of spies) s.mockRestore();
  spies = [];
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('a delete\'s undo re-announces what it put back (#1844)', () => {
  it('the restored prefab\'s guid resolves the moment the undo returns, through ONE rescan\'s reply — no push', async () => {
    // Mutation: drop `loadManifestJson` from `reannounceRestoredFiles` (or its call in `makeDeleteUndo`) — the guid stays
    // pruned until a push that never comes.
    trashQ();
    expect(resolveGuidToPath(G)).toBeUndefined(); // precondition: the delete pruned it
    route.calls.length = 0;
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    expect(route.text(P)).toBe(doc(G, 'Q'));
    expect(resolveGuidToPath(G)).toBe(P);
    expect(rescans()).toBe(1);
  });

  it('a manifest push landing AFTER the reply changes nothing: it is a complete scan too (pruning, or additive)', async () => {
    // The host's push (Vite's ws, Electron's IPC) is not ordered against the HTTP reply the step awaited.
    trashQ();
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    loadManifestJson(manifestOfDisk(), { prune: true }); // the dev server's full rescan
    expect(resolveGuidToPath(G)).toBe(P);
    loadManifestJson(manifestOfDisk()); // Electron's additive update
    expect(resolveGuidToPath(G)).toBe(P);
    expect(resolveGuidToPath(OTHER)).toBe(O);
  });

  it('the reply is loaded ADDITIVELY: a file another route wrote after the scan was taken keeps its guid', async () => {
    // Mutation: load the reply with `prune` (the first version) — X, registered by a concurrent route's additive update
    // between the scan and the reply, is pruned, and packaged Electron has no pruning push to put it back.
    const X = 'aaaaaaaa-1844-4000-8000-000000000003';
    const XP = '/assets/prefabs/X.prefab.json';
    trashQ();
    route.rescanBody = () => {
      const scan = manifestOfDisk(); // taken at T, before X exists
      route.put(XP, doc(X, 'X'));
      loadManifestJson({ ...scan, assets: [...scan.assets, { path: XP, type: 'prefab', guid: X }] }); // the concurrent route's push
      return scan;
    };
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    expect(resolveGuidToPath(G)).toBe(P);
    expect(resolveGuidToPath(X)).toBe(XP);
  });

  it('an unsavable world is refused by the GATE, which keeps the entry: the same Cmd+Z works once Play stops', async () => {
    // The refusal is the undo manager's (`undoRefusedReason`), before it pops. Mutation: a refusal thrown from INSIDE the
    // step (the first version's `restoreRefusal`) — it cannot reach this, the gate answers first; see the next case.
    trashQ();
    pushAction(makeDeleteUndo([deleted()], vi.fn()));
    setRunMode('playing');
    const r = await undoStep('undo');
    expect(r.refused).toBeTruthy();
    expect(route.disk.has(P)).toBe(false);
    expect(canUndo()).toBe(true); // kept
    setRunMode('stopped');
    expect((await undoStep('undo')).did).toBe(true);
    expect(resolveGuidToPath(G)).toBe(P);
  });

  it('an entry pushed INSIDE a preview session undoes inside it: the gate lets it through, and the file is restored', async () => {
    // Mutation: throw an `UndoRefusedError` from the undo when the world is not authored (the first version's
    // `restoreRefusal`) — the step is refused AND dropped, so the delete can never be undone (close-out review).
    trashQ();
    setPreviewUndoSession(7);
    setRunMode('scrub');
    pushAction(makeDeleteUndo([deleted()], vi.fn()));
    const r = await undoStep('undo');
    expect(r.failed).toBeFalsy();
    expect(r.did).toBe(true);
    expect(route.text(P)).toBe(doc(G, 'Q'));
    expect(resolveGuidToPath(G)).toBe(P);
  });

  it('a failed rescan is REPORTED: the file is back, the index is not', async () => {
    // Mutation: drop the `!told.ok` report in `makeDeleteUndo` — the undo reads as clean with the guid unresolvable.
    trashQ();
    route.fail.add('/api/rescan-assets');
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    expect(route.text(P)).toBe(doc(G, 'Q'));
    // Outside a step window the report is the console's (a step collects it into one toast, #1823).
    const said = (spies as Array<{ mock?: { calls: unknown[][] } }>).flatMap((sp) => sp.mock?.calls ?? []).map((c) => c.map(String).join(' '));
    expect(said.some((l) => l.includes('Delete Q.prefab.json') && l.includes('asset index was not refreshed'))).toBe(true);
  });
});

describe('an import\'s redo re-announces what it put back (#1844, the second site)', () => {
  it('the re-imported prefab resolves after the redo, and the redo scans ONCE (the settled read reuses it)', async () => {
    // Mutation: drop `reannounceRestoredFiles` from `makeFileImportUndo`'s redo — the guid stays pruned. Mutation: drop
    // `rescanned` from its `settledHashes` call — two full scans for one step.
    const action = makeFileImportUndo({ imported: [{ path: P, content: Buffer.from(doc(G, 'Q')).toString('base64'), sha256: sha256(doc(G, 'Q')) }], refresh: vi.fn() });
    await action.undo();
    expect(route.disk.has(P)).toBe(false);
    loadManifestJson(manifestOfDisk(), { prune: true }); // the delete route's pruning rebuild
    expect(resolveGuidToPath(G)).toBeUndefined();
    route.calls.length = 0;
    await action.redo();
    expect(resolveGuidToPath(G)).toBe(P);
    expect(rescans()).toBe(1);
  });

  it('an import pushed inside a preview session redoes inside it after its undo: the file is back and resolves', async () => {
    // Mutation: throw an `UndoRefusedError` from the redo when the world is not authored — the redo is dropped, and the
    // import is lost (close-out review: the import's undo, a trash, never had such a check, so undo → redo lost it).
    setPreviewUndoSession(7);
    setRunMode('scrub');
    pushAction(makeFileImportUndo({ imported: [{ path: P, content: Buffer.from(doc(G, 'Q')).toString('base64'), sha256: sha256(doc(G, 'Q')) }], refresh: vi.fn() }));
    expect((await undoStep('undo')).did).toBe(true);
    expect(route.disk.has(P)).toBe(false);
    const r = await undoStep('redo');
    expect(r.failed).toBeFalsy();
    expect(route.text(P)).toBe(doc(G, 'Q'));
    expect(resolveGuidToPath(G)).toBe(P);
  });
});

describe('the loader\'s cache follows a delete and its undo (#1834)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a delete evicts the owned entry and keeps the owner; the undo refetches it', async () => {
    // Mutation: drop `evictDeletedPrefabs` from `applyAssetPathMoves`' delete branch — the deleted prefab is still served.
    // Mutation: drop `refetchOwnedPrefab` from `reannounceRestoredFiles` — the owner reads nothing until the next load.
    await acquirePrefab(1, G);
    expect(getCachedPrefab(G)).toBeDefined(); // precondition
    trashQ();
    registerAsset(G, P, 'prefab'); // Electron's additive view: G still maps, so only the eviction can make this miss
    expect(getCachedPrefab(G)).toBeUndefined();
    expect(getResourceStats().prefabs[P]).toBe(1); // the scene still owns it
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    await settle();
    expect((getCachedPrefab(G) as { name?: string } | undefined)?.name).toBe('Q');
  });

  it('a load that met the 404 between the delete and the undo does not block the refetch', async () => {
    // Mutation: drop `prefabFailures.forget` from `refetchOwnedPrefab` — the remembered 404 blocks the fetch.
    await acquirePrefab(1, G);
    trashQ();
    loadManifestJson({ ...manifestOfDisk(), assets: [...manifestOfDisk().assets, { path: P, type: 'prefab', guid: G }] }); // Electron's additive view: G still maps
    await acquirePrefab(1, G); // a reload of the owning scene: 404, remembered
    expect(getCachedPrefab(G)).toBeUndefined();
    await makeDeleteUndo([deleted()], vi.fn()).undo();
    await settle();
    expect((getCachedPrefab(G) as { name?: string } | undefined)?.name).toBe('Q');
  });
});
