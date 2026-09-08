/** Remember the last-opened `.rig2d` rig in the Skin editor across editor sessions.
 *
 *  The open-rig state (which `.rig2d.json` is loaded) lives only in the editor store,
 *  so it's lost on reload. This module mirrors it to localStorage and restores it at
 *  startup — the 2D-skinning analogue of `lastAnimationClip.ts`.
 *
 *  A rig is SCENE-INDEPENDENT (unlike a clip's Animator binding): it's a standalone
 *  asset loaded by path, its sprites resolved through the manifest. So there's no
 *  scene/guid scoping here — restore just re-opens the same asset.
 *
 *  It IS project-scoped, though (#473). Scene-independent is not project-independent, and this
 *  module read it as if it were: the key was global, so the rig you opened in `games/skin-test`
 *  was re-opened into whatever project you launched next, where `/assets/rigs/…` addresses a
 *  different asset root and hits the dev server's SPA fallback. The human was then told their rig
 *  file was corrupt JSON (#460) about a file that was present and fine. See `projectScopedKey`. */

import { useEditorStore } from '../store/editorStore';
import { getGuidForPath } from '../../runtime/loaders/assetManifest';
import { clearUnscopedLegacyKey, projectScopedKey } from '../projectScopedKey';

const KEY_BASE = 'editor:lastSkinRig';

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
  clearUnscopedLegacyKey(KEY_BASE);
  let prevPath = useEditorStore.getState().editingSkinAsset?.path ?? null;
  unsubscribe = useEditorStore.subscribe((state) => {
    const asset = state.editingSkinAsset;
    const path = asset?.path ?? null;
    if (path === prevPath) return;
    prevPath = path;
    // Resolve the key per write, not once at register — see projectScopedKey.
    const key = projectScopedKey(KEY_BASE);
    if (!asset) { try { localStorage.removeItem(key); } catch { /* ignore */ } return; }
    const payload: PersistedRig = { path: asset.path, name: asset.name };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* quota/private mode */ }
  });
}

/** Re-open the last rig into the editor store. No-op (returns false) when there is
 *  nothing saved, the JSON is bad, or the remembered path is not an asset of the project now
 *  open. Call after the asset manifest has loaded — restore DEPENDS on it, both so the rig's
 *  sprite GUIDs resolve and for the existence check below.
 *
 *  The manifest check is what covers the case a per-project key cannot: a rig deleted, renamed or
 *  moved since it was remembered — routine under a live editor across a branch switch. Without
 *  it the panel re-opens on a path that no longer serves, the fetch takes the dev server's SPA
 *  fallback, and the human gets a load error about a file they never asked to open (#460). This
 *  is the same refusal the `open-skin-editor` agent op already makes; restore bypassed it by
 *  calling the store directly.
 *
 *  ⚠️ It REFUSES; it must never DELETE the entry. `ensureManifestLoaded` swallows a failed fetch
 *  and returns null — it warns, boot continues, and it clears its own memo so the next attempt
 *  retries — so a dev server restarting mid-boot leaves EVERY path unresolvable for one launch.
 *  Dropping on that would turn a transient, self-healing failure into permanent loss of the
 *  human's remembered rig, inside a loader written specifically to be recoverable. Keeping a
 *  stale entry costs nothing now that a miss is silent: nothing opens and nothing warns, it
 *  re-checks for free next launch, and it starts working again if the asset comes back. */
export function restoreLastSkinRig(): boolean {
  const key = projectScopedKey(KEY_BASE);
  let raw: string | null;
  try { raw = localStorage.getItem(key); } catch { return false; }
  if (!raw) return false;
  let p: PersistedRig;
  try { p = JSON.parse(raw); } catch { return false; }
  if (!p?.path) return false;
  if (!getGuidForPath(p.path)) return false;
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
