/** SceneAssetView — Inspector detail for `.json` scene assets (base-scene
 *  persistence, Phase 8). One field today: the scene's `baseScene` ref, edited
 *  via `AssetRefField` (`accept: ['scene']`) exactly like any other asset ref.
 *
 *  Writes go through `POST /api/scene-mutate` with the `setBaseScene` op
 *  (Phase 7), NOT the generic `persistAssetEdit` whole-file-overwrite other
 *  asset views use. A scene file is not a plain static asset like a material —
 *  it is also what the live editor world serializes INTO on save, and
 *  scene-mutate already carries the guards that matter here: it refuses to
 *  write while Playing/Paused (a mid-Play edit would be discarded on Stop) and
 *  while the editor holds unsaved live-world changes for THIS scene (a raw
 *  whole-file write would silently destroy them). Reusing it also means this
 *  view and an agent's `modoki_mutate_scene` calls can never race each other
 *  with two different serializations of the same field.
 *
 *  Cycle detection is a NEW check (nothing else validates it at ref-set time):
 *  resolve the candidate base's own chain and refuse if this scene's guid
 *  already appears in it. The load-time chain resolver (Phase 4) is the
 *  backstop for a hand-edit or agent write that skips this UI.
 *
 *  The pushAction below sets `_isFileDirect: true` (undoManager.ts) — this edit
 *  is already persisted via scene-mutate, unlike a normal trait/entity edit
 *  that's genuinely pending a Cmd+S. Without it, the undo stack's unconditional
 *  edit-version bump would falsely mark the active scene dirty and self-block
 *  a follow-up scene-mutate call via the same "unsaved live changes" guard
 *  this view's own write goes through (found live while testing this view:
 *  clear-then-restore in one session tripped exactly this). */

import { useState, useEffect, useCallback, useRef } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { pushAction } from '../../undo/undoManager';
import { makeBaseSceneUndo } from './baseSceneUndo';
import { AssetRefField, assetDisplayName } from '../AssetRefField';
import { isGuid, resolveGuidToPath } from '../../../runtime/loaders/assetManifest';
import { resolveSceneChain, type FetchSceneMeta } from '../../../runtime/scene/sceneChain';
import { parseAssetJson, isMissingAsset } from '../../../runtime/loaders/assetFetch';

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

// Exported for unit testing without mounting the component.
export async function mutateScene(path: string, baseScene: string | null): Promise<{ ok: boolean; errors: string[] }> {
  // Resolve `{ok:false}` on a THROWN request too, matching every sibling backend wrapper
  // in assetOps (each is `try { … return res.ok } catch { return false }`). Without this
  // the fetch rejection escaped `write()` and, through it, this view's undo/redo closures —
  // and a throw from an undo closure is the one failure mode #308 rules out: `undo()` pops
  // the action BEFORE awaiting it, so the rejection skips `redoStack.push` and the `!undo`
  // event and loses the action from BOTH stacks. An HTTP error already resolved false; only
  // a network-level failure could throw, which is exactly when the editor is least able to
  // afford losing an undo entry.
  let res: Response;
  try {
    res = await backendFetch('/api/scene-mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ops: [{ op: 'setBaseScene', baseScene }] }),
    });
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const body = await res.json().catch(() => ({ ok: false, errors: [`HTTP ${res.status}`] }));
  return { ok: res.ok && body.ok !== false, errors: body.errors ?? (res.ok ? [] : [body.error ?? `HTTP ${res.status}`]) };
}

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
        setBaseScene(data.baseScene ?? '');
        setLoaded(true);
      })
      .catch((e) => { if (e.name !== 'AbortError') setLoaded(true); });
    return () => ac.abort();
  }, [path]);

  const write = useCallback(async (v: string) => {
    const { ok, errors } = await mutateScene(path, v || null);
    if (!ok) { console.error(`[SceneAssetView] setBaseScene failed for ${path}:`, errors); return false; }
    setBaseScene(v);
    return true;
  }, [path]);

  const commit = useCallback(async (next: string) => {
    const old = baseSceneRef.current;
    if (!await write(next)) return;
    // Builder in baseSceneUndo.ts (#308) — a framework-free factory so the undo/redo
    // closures are unit-testable without mounting this panel.
    pushAction(makeBaseSceneUndo({ path, old, next, write }));
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
      />
      {warning && (
        <div style={{ color: '#e74c3c', fontSize: '10px', marginTop: 2, marginBottom: 4 }}>{warning}</div>
      )}
    </>
  );
}
