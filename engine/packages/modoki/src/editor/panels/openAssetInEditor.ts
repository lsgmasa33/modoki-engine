/** openAssetInEditor — open an asset in its dedicated editor/window (or load it,
 *  for scenes). Shared by the Assets panel double-click AND the Asset Inspector's
 *  "Open in …" buttons so both routes behave identically (esp. the animation-clip
 *  Animator-root binding). Mirrors the per-type dispatch that used to live inline
 *  in Assets.tsx handleDoubleClick. */

import { useEditorStore, type SelectedAsset } from '../store/editorStore';
import { getGuidForPath, resolveRef } from '../../runtime/loaders/assetManifest';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { getAllEntities, findEntity } from '../../runtime/ecs/entityUtils';
import { parseAnimClipBank } from '../../runtime/animation/animClipBank';

/** Resolve the Animator entity a clip should bind to (so its tracks resolve their
 *  relative paths). Prefer the Animator that references the clip; else fall back to
 *  the selected entity when it has an Animator.
 *
 *  `fallbackToSelection: false` keeps only the exact match — used by the Animation
 *  panel's re-bind-on-nonce recovery, where "whatever happens to be selected" would
 *  silently bind the clip to an unrelated Animator after the user chose to leave it
 *  unbound. */
export function resolveAnimatorRootForClip(path: string, { fallbackToSelection = true } = {}): number | null {
  const guid = getGuidForPath(path);
  const animMeta = getTraitByName('Animator');
  if (!animMeta) return null;
  for (const e of getAllEntities()) {
    if (!e.traits.includes('Animator')) continue;
    const ent = findEntity(e.id);
    const data = ent?.get(animMeta.trait) as { clips?: unknown } | undefined;
    // An Animator references a clip through its `clips` BANK — each entry's `clip` is a
    // .anim.json GUID. (NOT the `clip` field, which is the active-clip NAME pointer, e.g.
    // "spin"/"" — comparing that against a GUID never matched, so auto-bind always failed.)
    if (parseAnimClipBank(data?.clips).some((c) => c.clip === guid || resolveRef(c.clip) === path)) return e.id;
  }
  if (!fallbackToSelection) return null;
  const sel = useEditorStore.getState().selectedEntityId;
  const ent = sel != null ? findEntity(sel) : null;
  if (ent && ent.has(animMeta.trait)) return sel;
  return null;
}

/** Resolve the Director entity a timeline should bind to (so its tracks resolve their
 *  relative name-paths). Prefer the Director whose `timeline` GUID references this asset;
 *  else fall back to the selected entity when it has a Director. */
export function resolveDirectorRootForTimeline(path: string): number | null {
  const guid = getGuidForPath(path);
  const dirMeta = getTraitByName('Director');
  if (!dirMeta) return null;
  for (const e of getAllEntities()) {
    if (!e.traits.includes('Director')) continue;
    const ent = findEntity(e.id);
    const data = ent?.get(dirMeta.trait) as Record<string, unknown> | undefined;
    const ref = data?.timeline as string | undefined;
    if (ref && (ref === guid || resolveRef(ref) === path)) return e.id;
  }
  const sel = useEditorStore.getState().selectedEntityId;
  const ent = sel != null ? findEntity(sel) : null;
  if (ent && ent.has(dirMeta.trait)) return sel;
  return null;
}

/** Open an asset in its editor/window. No-op for types without a dedicated editor. */
export async function openAssetInEditor(asset: SelectedAsset): Promise<void> {
  const { path, type, name } = asset;
  const store = useEditorStore.getState();
  switch (type) {
    case 'prefab': {
      const { openPrefabForEditing } = await import('../scene/prefabEdit');
      openPrefabForEditing({ path, name });
      return;
    }
    case 'scene': {
      const { loadScene } = await import('../scene/serialize');
      const ok = await loadScene(path);
      if (ok) console.log(`[openAssetInEditor] Opened scene: ${path}`);
      return;
    }
    case 'particle':
      store.openParticleEditor({ path, type, name });
      return;
    case 'spriteanim':
      store.openSpriteAnimEditor({ path, type, name });
      return;
    case 'rig2d':
      store.openSkinEditor({ path, type, name });
      return;
    case 'animation':
      store.openAnimationEditor({ path, type, name }, resolveAnimatorRootForClip(path));
      return;
    case 'timeline':
      store.openTimelineEditor({ path, type, name }, resolveDirectorRootForTimeline(path));
      return;
  }
}
