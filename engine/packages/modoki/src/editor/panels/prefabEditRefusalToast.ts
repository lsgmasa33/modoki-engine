/** How the panels show a prefab-edit refusal (#1817, #1836): as a warning toast in the editor's own words. The refusal
 *  itself is asked inside the shared choke points (`prefabEditRefusal.ts`); this is only its human surface, so a panel
 *  gesture that is refused says why instead of doing nothing (or throwing out of a key handler). */
import { useEditorStore } from '../store/editorStore';
import { PrefabEditRefusalError, PREFAB_EDIT_REFUSAL_TEXT, type PrefabEditRefusalReason } from '../scene/prefabEditRefusal';

/** Run a gesture; a prefab-edit refusal it throws becomes a toast (and `undefined`). Anything else propagates. */
export function withPrefabEditRefusalToast<T>(gesture: () => T): T | undefined {
  try {
    return gesture();
  } catch (e) {
    if (!(e instanceof PrefabEditRefusalError)) throw e;
    useEditorStore.getState().showToast(e.message, 'warn');
    return undefined;
  }
}

/** Toast a refused plan's reason when it is a prefab-edit one; true when it was. */
export function toastIfPrefabEditReason(reason: string): boolean {
  if (!(reason in PREFAB_EDIT_REFUSAL_TEXT)) return false;
  useEditorStore.getState().showToast(PREFAB_EDIT_REFUSAL_TEXT[reason as PrefabEditRefusalReason], 'warn');
  return true;
}
