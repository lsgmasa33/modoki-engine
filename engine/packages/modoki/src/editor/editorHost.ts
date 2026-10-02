/** What the renderer knows about the editor PROCESS it runs in, read once from `/api/identity` at boot (#2060).
 *
 *  The one seam a panel reads "is this the packaged editor?" through. A packaged flag did not reach the renderer at all
 *  before: `import.meta.env.DEV` cannot answer it (the packaged app runs a real Vite dev server, `electron/devServer.ts`),
 *  the preload exposes none, and `aiPanelModel.isPackaged` is the AI panel's own answer from its heavyweight
 *  connect-claude-status probe. A panel that needs it subscribes here rather than growing another global.
 *
 *  ⚠️ **SUBSCRIBED, not read plainly**: boot fetches identity AFTER the editor mounts, so an Inspector already showing an
 *  asset must re-render when the answer lands. Until it does — and under a host with no `/api/identity` (a browser
 *  pointed at Vite) — the answer is `false`, the dev behaviour, because the backend's own refusal (#1959,
 *  `MODOKI_PACKAGED`) is the gate and this only decides what the UI OFFERS. */
import { useSyncExternalStore } from 'react';
import { setOpenProjectRoots } from './scene/openProjectScenePath';
import { notifyListeners } from '../runtime/core/notifyListeners';

let _packaged = false;
const _listeners = new Set<() => void>();

/** Apply an `/api/identity` answer (or null when it could not be read). Only a literal `packaged: true` counts — a
 *  missing or malformed field is "not packaged", the answer that offers no less than the backend accepts in a dev
 *  clone. */
export function applyEditorIdentity(identity: unknown): void {
  const data = (identity !== null && typeof identity === 'object' ? identity : {}) as
    { projectRoot?: unknown; projectRootReal?: unknown; packaged?: unknown };
  const roots = [data.projectRoot, data.projectRootReal].filter((r): r is string => typeof r === 'string');
  setOpenProjectRoots(roots);
  setEditorPackaged(data.packaged === true);
}

export function setEditorPackaged(packaged: boolean): void {
  if (packaged === _packaged) return;
  _packaged = packaged;
  notifyListeners(_listeners, 'editorHost', []);
}

export function isEditorPackaged(): boolean {
  return _packaged;
}

export function subscribeEditorPackaged(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/** React form of `isEditorPackaged`, re-rendering when the boot read lands. */
export function useEditorPackaged(): boolean {
  return useSyncExternalStore(subscribeEditorPackaged, isEditorPackaged, isEditorPackaged);
}
