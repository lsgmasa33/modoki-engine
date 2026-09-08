/** SceneAssetView — Inspector detail for `.json` scene assets (base-scene
 *  persistence, Phase 8). One field today: the scene's `baseScene` ref, edited
 *  via `AssetRefField` (`accept: ['scene']`) exactly like any other asset ref.
 *
 *  ⚠️ **This edit is MANUAL-SAVE as of #831, and it takes one of two routes.** It used to POST
 *  `/api/scene-mutate` the moment the field changed — no save action, while `get_editor_state`
 *  reported `persistenceMode:'manual'` — which is the same defect the four `persistAssetEdit`
 *  views had, reached down a different route. #831's own body cleared this view on the grounds
 *  that avoiding `persistAssetEdit` was deliberate; that was about the MECHANISM and said nothing
 *  about WHEN the bytes land.
 *
 *  It still does not use `persistAssetEdit`, and that part IS deliberate: a scene file is not a
 *  plain static asset like a material — it is also what the live editor world serializes INTO on
 *  save, so a whole-file overwrite would silently destroy unsaved live-world changes.
 *  `/api/scene-mutate` edits the one field and carries the guards that matter (it refuses while
 *  Playing/Paused, and while the editor holds unsaved live work its write would hot-reload away),
 *  and reusing it means this view and an agent's `modoki_mutate_scene` can never race with two
 *  different serializations of the same field.
 *
 *  **The OPEN scene does not go through that route at all.** `serializeScene` emits `baseScene`
 *  from `setCurrentBaseScene`'s module state, so for the active scene the ref is applied THERE and
 *  Cmd+S writes it with everything else. That is also a bug fix: `_currentBaseScene` was only ever
 *  set at LOAD, so setting a base on the open scene put the ref in the file and the next Cmd+S
 *  serialised the stale module value straight back over it.
 *
 *  **Any other scene** — one the editor has not loaded — parks in `pendingBaseScene` and is
 *  flushed by `saveAll`, LAST. See that module's header for why the ordering is load-bearing.
 *
 *  Cycle detection is a NEW check (nothing else validates it at ref-set time):
 *  resolve the candidate base's own chain and refuse if this scene's guid
 *  already appears in it. The load-time chain resolver (Phase 4) is the
 *  backstop for a hand-edit or agent write that skips this UI.
 *
 *  The pushAction below passes `fileDirect` rather than the hardcoded `true` it used to
 *  (undoManager.ts). For a NON-open scene it stays true: the edit is parked, `hasUnsavedChanges()`
 *  counts it on its own, and a bump as well would mark the ACTIVE scene dirty over an edit that
 *  has nothing to do with it — and self-block the flush's own scene-mutate via the "unsaved live
 *  changes" guard that route carries (found live while testing this view: clear-then-restore in
 *  one session tripped exactly this). For the OPEN scene it is false, because there the bump is
 *  the only thing telling Cmd+S the scene changed. */

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { pushAction } from '../../undo/undoManager';
import { getCurrentScenePath, setCurrentBaseScene } from '../../scene/serialize';
import {
  applyBaseSceneEdit, peekBaseSceneEdit, isBaseSceneDirty,
  subscribePendingBaseScenes, getPendingBaseScenesVersion,
} from '../../scene/pendingBaseScene';
import { makeBaseSceneUndo } from './baseSceneUndo';
import { AssetRefField, assetDisplayName } from '../AssetRefField';
import { isGuid, resolveGuidToPath } from '../../../runtime/loaders/assetManifest';
import { resolveSceneChain, type FetchSceneMeta } from '../../../runtime/scene/sceneChain';
import { parseAssetJson, isMissingAsset } from '../../../runtime/loaders/assetFetch';
import { UnsavedMetaBadge } from './UnsavedMetaBadge';

/** Editor-side `FetchSceneMeta`: fetch the scene FILE for a path, or resolve a
 *  guid to a path via the asset manifest first. Mirrors SceneManager.loadScene's
 *  runtime implementation of the same contract. */
const fetchSceneMetaForEditor: FetchSceneMeta = async (locator) => {
  const path = isGuid(locator) ? resolveGuidToPath(locator) : locator;
  if (!path) return null;
  try {
    const res = await fetch(path);
    const data = await parseAssetJson(res, path) as { id?: string; baseScene?: string };
    const guid = data.id && isGuid(data.id) ? data.id : `path:${path}`;
    return { guid, path, baseScene: data.baseScene };
  } catch {
    return null;
  }
};

/** ⚠️ `mutateScene` used to live here and now lives in `scene/pendingBaseScene.ts`, beside the
 *  flush that calls it — a `.tsx` is not importable from `scene/`, and the flush needs it. It is
 *  re-exported so the tests and tools that reach for it by this name keep working. */
export { mutateScene } from '../../scene/pendingBaseScene';

/** Pure (no React) cycle check: would pointing `myGuid`'s scene at `candidateGuid`
 *  as its base create a cycle? `fetchSceneMeta` accepts EITHER a guid or a path as
 *  its first locator (see `fetchSceneMetaForEditor`), so the candidate's own chain
 *  can be resolved directly from its guid — no separate guid→path step needed here.
 *  Returns a human-readable reason string when it would, else null. Exported for
 *  unit testing without mounting the component. */
export async function checkBaseSceneCycle(
  myGuid: string | null,
  myName: string,
  candidateGuid: string,
  fetchSceneMeta: FetchSceneMeta,
): Promise<string | null> {
  if (!candidateGuid) return null; // clearing is always safe
  if (myGuid && candidateGuid === myGuid) return 'A scene cannot be its own base.';
  const { chain } = await resolveSceneChain(candidateGuid, fetchSceneMeta);
  if (myGuid && chain.some((r) => r.guid === myGuid)) {
    const candidateName = chain.length ? assetDisplayName(chain[chain.length - 1].path) : candidateGuid;
    return `Setting this base would create a cycle — "${candidateName}" already depends on "${myName}".`;
  }
  return null;
}

export function SceneAssetView({ path, name }: { path: string; name: string }) {
  const [myGuid, setMyGuid] = useState<string | null>(null);
  const [baseScene, setBaseScene] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const baseSceneRef = useRef(baseScene);
  baseSceneRef.current = baseScene;


  // Re-render when the pending-edit registry moves, so the unsaved marker below is honest after a
  // Cmd+S or an agent discard — neither of which passes through this component.
  useSyncExternalStore(subscribePendingBaseScenes, getPendingBaseScenesVersion, getPendingBaseScenesVersion);
  const pendingHere = isBaseSceneDirty(path);

  useEffect(() => {
    const ac = new AbortController();
    setLoaded(false);
    setWarning(null);
    fetch(path, { signal: ac.signal })
      .then((r) => parseAssetJson(r, path))
      .catch((e) => { if (isMissingAsset(e)) return null; throw e; })
      .then((json) => {
        const data = json as { id?: string; baseScene?: string } | null;
        if (!data) return;
        setMyGuid(data.id && isGuid(data.id) ? data.id : null);
        // ⚠️ ASK THE REGISTRY BEFORE THE FILE, for the same reason every parking asset view does
        // (`pendingAssetDoc`): between the edit and Cmd+S the file still holds the PRE-edit ref,
        // so re-opening this panel on it would show the old value over a newer pending one.
        // `undefined` means nothing is parked; `null` means a parked CLEAR, which must show as
        // empty rather than falling through to the file's value.
        const parked = peekBaseSceneEdit(path);
        setBaseScene(parked !== undefined ? (parked ?? '') : (data.baseScene ?? ''));
        setLoaded(true);
      })
      .catch((e) => { if (e.name !== 'AbortError') setLoaded(true); });
    return () => ac.abort();
  }, [path]);

  // Apply the ref. Since #831 this NEVER reaches disk — see the header for the two routes and why
  // they differ. Returns whether it landed, because the undo/redo closures report on that.
  /** Which route the LAST `write` actually took. `fileDirect` is derived from this rather than
   *  from the render-time `isOpenScene`, and the difference is not cosmetic: `write` re-reads
   *  `getCurrentScenePath()` at APPLY time on purpose (see below), so the two disagree whenever
   *  the scene changed since this render. Taking `fileDirect` from the stale one is how an edit
   *  goes invisible — the live route deletes the park AND `_isFileDirect: true` suppresses the
   *  edit-version bump, so nothing anywhere reports it as unsaved: no badge, `hasUnsavedChanges()`
   *  false, Cmd+S writes nothing. One source, read once, used for both. */
  const lastRoute = useRef<'live' | 'parked'>('parked');

  const write = useCallback(async (v: string) => {
    // The routing (open scene → live editor state; anything else → parked) lives in
    // `applyBaseSceneEdit` so it is covered without mounting this panel. `getCurrentScenePath()`
    // is read HERE, at apply time, and NOWHERE ELSE in this component — a render-time copy of the
    // same comparison is stale for a scene swap, and for an undo replayed seconds later, and
    // having two of them is how the route and the `fileDirect` flag came to disagree.
    //
    // ⚠️ Raw string equality, and `/api/scene-mutate` learned the hard way that this comparison
    // can silently fail: the renderer can report a `/@fs/<abs>` path while a panel holds
    // `/assets/…`, which made that route's live path unreachable for months until it normalised
    // both sides through `toAssetRef` (editorBackendRouter.ts). It holds HERE because boot
    // canonicalises `_currentScenePath` (createEditor.tsx), and that was OBSERVED rather than
    // assumed — verified 2026-09-07 in the running editor on `games/skin-test`: selecting the open
    // `main.scene.json` and setting a base reported NO `pendingBaseScenes`, i.e. the live branch
    // was taken. Where canonicalisation cannot run (no projectRoot, an unregistered path) this
    // degrades to the parked route rather than failing loudly. If that is ever seen, normalise
    // both sides; do not "fix" it by comparing suffixes.
    lastRoute.current = applyBaseSceneEdit(path, v, getCurrentScenePath(), setCurrentBaseScene);
    setBaseScene(v);
    return true;
  }, [path]);

  const commit = useCallback(async (next: string) => {
    const old = baseSceneRef.current;
    if (!await write(next)) return;
    // Builder in baseSceneUndo.ts (#308) — a framework-free factory so the undo/redo
    // closures are unit-testable without mounting this panel.
    pushAction(makeBaseSceneUndo({ path, old, next, write, fileDirect: lastRoute.current === 'parked' }));
  }, [write, path]);

  const handleChange = useCallback(async (v: string) => {
    setWarning(null);
    const problem = await checkBaseSceneCycle(myGuid, name, v, fetchSceneMetaForEditor);
    if (problem) { setWarning(problem); return; }
    await commit(v);
  }, [commit, myGuid, name]);

  if (!loaded) return <div style={{ color: '#555', fontSize: '11px', padding: 4 }}>Loading...</div>;

  return (
    <>
      <div style={{ color: '#9aa', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 3px' }}>
        Base Scene
      </div>
      <AssetRefField
        label="Base Scene"
        value={baseScene}
        onChange={handleChange}
        accept={['scene']}
        hint="Loaded additively alongside this scene and carried across a swap to another scene sharing the same base (Time, camera, lights, rig authored once). Empty = no base."
        placeholder="drop a scene, or paste a GUID"
        dataUiId="assetView.scene.baseScene" dataUiLabel="Base Scene"
      />
      {warning && (
        <div style={{ color: '#e74c3c', fontSize: '10px', marginTop: 2, marginBottom: 4 }}>{warning}</div>
      )}
      {/* Manual save has to be LEGIBLE or it reads as "my edit did nothing" — the same reason the
          five asset editors carry an `Unsaved ● ⌘S` badge. Only shown for a scene the editor has
          not loaded: for the OPEN scene the ref is live editor state and the editor's ordinary
          unsaved indicator already covers it. */}
      <UnsavedMetaBadge dirty={pendingHere} dataUiId="assetView.scene.unsaved" />
    </>
  );
}
