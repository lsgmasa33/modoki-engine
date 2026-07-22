/** Remember the last-opened animation clip across editor sessions.
 *
 *  The open-clip state (which `.anim.json` is loaded + which Animator entity it
 *  binds to) lives only in the editor store, so it's lost on reload. This module
 *  mirrors it to localStorage and restores it at startup.
 *
 *  The Animator binding is stored as the entity's stable `EntityAttributes.guid`
 *  (NOT its koota id, which is reassigned every scene load), and restore only
 *  fires when the SAME scene is loaded — guids are scene-scoped. Mirrors the
 *  guid-keyed approach in `selectionRestore.ts`. */

import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld } from '../../runtime/ecs/world';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { getCurrentScenePath } from '../scene/serialize';

const KEY = 'editor:lastAnimationClip';

interface PersistedClip {
  path: string;
  name: string;
  /** The Animator root's guid (null when the clip was opened unbound). */
  animatorGuid: string | null;
  /** Scene the clip was bound under — restore is skipped for any other scene. */
  scenePath: string | null;
}

/** Resolve an entity id → its EntityAttributes.guid (null if missing/unset). */
function guidForEntity(id: number): string | null {
  const meta = getTraitByName('EntityAttributes');
  const ent = findEntity(id);
  if (!meta || !ent) return null;
  const ea = ent.get(meta.trait) as { guid?: string } | undefined;
  return ea?.guid || null;
}

/** Resolve a guid → entity id in the current world (null if not present). */
function entityForGuid(guid: string): number | null {
  const meta = getTraitByName('EntityAttributes');
  if (!meta) return null;
  let found: number | null = null;
  try {
    getCurrentWorld().query(meta.trait).updateEach(([ea]: Record<string, unknown>[], entity: { id(): number }) => {
      if (found == null && (ea.guid as string) === guid) found = entity.id();
    });
  } catch { /* world/trait not ready */ }
  return found;
}

/** Resolve a persisted root guid to a USABLE Animator root: the entity must still exist
 *  AND still carry the `Animator` trait. A guid alone isn't enough — the component can be
 *  removed (undo, Inspector) after the binding was persisted, and restoring that guid
 *  leaves the panel "bound" to an entity with no Animator: no warning bar, no Bind button,
 *  and a live scrub preview for a clip that would never play at runtime. Returns null so
 *  the clip reopens UNBOUND and the fix-it path is reachable. */
function animatorRootForGuid(guid: string): number | null {
  const id = entityForGuid(guid);
  if (id == null) return null;
  const meta = getTraitByName('Animator');
  const ent = findEntity(id);
  return meta && ent?.has(meta.trait) ? id : null;
}

let registered = false;
let unsubscribe: (() => void) | null = null;

/** Persist the open clip whenever it changes. Idempotent — call once at startup. */
export function registerLastAnimationClipPersistence(): void {
  if (registered) return;
  registered = true;
  let prevPath = useEditorStore.getState().editingAnimationAsset?.path ?? null;
  let prevRoot = useEditorStore.getState().animatorRootEntityId;
  unsubscribe = useEditorStore.subscribe((state) => {
    const asset = state.editingAnimationAsset;
    const path = asset?.path ?? null;
    const rootId = state.animatorRootEntityId;
    // React when the open clip OR its Animator binding changes — the latter
    // covers auto-bind / setAnimatorRoot after a clip was opened unbound,
    // otherwise a reload would restore a stale (or null) binding.
    if (path === prevPath && rootId === prevRoot) return;
    prevPath = path;
    prevRoot = rootId;
    if (!asset) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } return; }
    const payload: PersistedClip = {
      path: asset.path,
      name: asset.name,
      animatorGuid: rootId != null ? guidForEntity(rootId) : null,
      scenePath: getCurrentScenePath(),
    };
    try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch { /* quota/private mode */ }
  });
}

/** Re-open the last clip into the editor store. No-op (returns false) when there
 *  is nothing saved, the JSON is bad, or it was bound under a different scene.
 *  Call after the scene has loaded so the Animator guid can be resolved. */
export function restoreLastAnimationClip(): boolean {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return false; }
  if (!raw) return false;
  let p: PersistedClip;
  try { p = JSON.parse(raw); } catch { return false; }
  if (!p?.path) return false;
  // Guids are scene-scoped — don't rebind into an unrelated scene.
  const scene = getCurrentScenePath();
  if (p.scenePath && scene && p.scenePath !== scene) return false;
  const rootId = p.animatorGuid ? animatorRootForGuid(p.animatorGuid) : null;
  useEditorStore.getState().openAnimationEditor({ path: p.path, type: 'animation', name: p.name }, rootId);
  return true;
}

// HMR: drop the old subscription so a hot reload doesn't leave a duplicate.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    registered = false;
  });
}
