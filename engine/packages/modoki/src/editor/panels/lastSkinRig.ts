/** Remember the last-opened `.rig2d` rig in the Skin editor across editor sessions.
 *
 *  The open-rig state (which `.rig2d.json` is loaded) lives only in the editor store,
 *  so it's lost on reload. This module mirrors it to localStorage and restores it at
 *  startup — the 2D-skinning analogue of `lastAnimationClip.ts`.
 *
 *  A rig is SCENE-INDEPENDENT (unlike a clip's Animator binding): it's a standalone
 *  asset loaded by path, its sprites resolved through the manifest. So there's no
 *  scene/guid scoping here — restore just re-opens the same asset. */

import { useEditorStore } from '../store/editorStore';

const KEY = 'editor:lastSkinRig';

interface PersistedRig {
  path: string;
  name: string;
}

let registered = false;
let unsubscribe: (() => void) | null = null;

/** Persist the open rig whenever it changes. Idempotent — call once at startup. */
export function registerLastSkinRigPersistence(): void {
  if (registered) return;
  registered = true;
  let prevPath = useEditorStore.getState().editingSkinAsset?.path ?? null;
  unsubscribe = useEditorStore.subscribe((state) => {
    const asset = state.editingSkinAsset;
    const path = asset?.path ?? null;
    if (path === prevPath) return;
    prevPath = path;
    if (!asset) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } return; }
    const payload: PersistedRig = { path: asset.path, name: asset.name };
    try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch { /* quota/private mode */ }
  });
}

/** Re-open the last rig into the editor store. No-op (returns false) when there is
 *  nothing saved or the JSON is bad. Call after the asset manifest has loaded so the
 *  rig's sprite GUIDs resolve. If the file was since deleted, the SkinEditor load
 *  effect self-heals to an empty rig (its own fetch failure path). */
export function restoreLastSkinRig(): boolean {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return false; }
  if (!raw) return false;
  let p: PersistedRig;
  try { p = JSON.parse(raw); } catch { return false; }
  if (!p?.path) return false;
  useEditorStore.getState().openSkinEditor({ path: p.path, type: 'rig2d', name: p.name });
  return true;
}

// HMR: drop the old subscription so a hot reload doesn't leave a duplicate.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    registered = false;
  });
}
