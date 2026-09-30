/** What in the editor USES a prefab (#1873 R1; moved here by #1880 W4 so the prefab step's adopt landing and the
 *  re-import door ask the same questions): a live frame, a frame whose record could not expand a row naming it, a Missing
 *  Prefab placeholder, or a loaded scene's ref. The adopt landing (`prefabCommit.ts`) seats a prefab's caches by these
 *  answers; the re-import (`prefabReimport.ts`) reports by them. */

import { type PrefabFile } from './prefab';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { resolveRef, isGuid, lastKnownPathOf } from '../../runtime/loaders/assetManifest';
import { type SceneId } from '../../runtime/loaders/meshTemplateCache';
import { UnresolvedPrefabRef, unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { frameRootDoc } from '../../runtime/core/ecs/identityParents';

/** Whether anything in the live world is built from, or waits for, a prefab named by one of `keys`: a frame of it, a frame
 *  whose record could not expand a row naming it, or a Missing Prefab placeholder of it. */
export function usedLive(keys: ReadonlySet<string>): boolean {
  const names = (ref: string | undefined) => !!ref && (keys.has(ref) || keys.has(resolvedRef(ref) ?? ''));
  const world = getCurrentWorld();
  const pi = getTraitByName('PrefabInstance');
  let used = false;
  if (pi) {
    world.query(pi.trait).updateEach(([data], entity) => {
      if (used) return;
      const d = data as { source?: string; rootInstanceId?: number };
      if (names(d.source)) { used = true; return; }
      if (d.rootInstanceId !== entity.id()) return;
      const rec = frameRootDoc(world, entity);
      const rows = (rec?.doc as PrefabFile | undefined)?.entities ?? [];
      if (rec?.unexpanded?.some((lid) => names(rowAt(rows, lid)?.prefab))) used = true;
    });
  }
  return used || placeholdersOf(keys).length > 0;
}

/** The guids of live frames and placeholders whose prefab lived at `path` before the manifest dropped it (a delete's
 *  prune, `lastKnownPathOf`). */
export function liveSourcesOnceAt(path: string): string[] {
  const out = new Set<string>();
  const at = (ref: string | undefined) => { if (ref && isGuid(ref) && lastKnownPathOf(ref) === path) out.add(ref); };
  const pi = getTraitByName('PrefabInstance');
  if (pi) getCurrentWorld().query(pi.trait).updateEach(([d]) => at((d as { source?: string }).source));
  getCurrentWorld().query(UnresolvedPrefabRef).forEach((e) => at(unresolvedRefOf(e)?.source));
  return [...out];
}

/** The loaded scenes whose prefab refs name one of `keys` (a ref, or the path it resolved to at load). A scene whose
 *  entry does not know what it uses counts as using it, as the #1702 gate reads it. */
export function scenesReferencing(keys: ReadonlySet<string>): SceneId[] {
  const out: SceneId[] = [];
  for (const [sid, entry] of sceneManager.getLoadedScenes()) {
    if (!entry.prefabRefs || [...entry.prefabRefs].some((r) => keys.has(r) || keys.has(resolvedRef(r) ?? ''))) out.push(sid);
  }
  return out;
}

/** Where a prefab ref resolves: a guid through the manifest, a path as itself. `resolveRef` handed a path refuses it
 *  loudly (GUID-only refs), and a loaded scene's `prefabRefs` holds the paths its refs resolved to beside the refs. */
export function resolvedRef(ref: string): string | undefined {
  return isGuid(ref) ? resolveRef(ref) : ref;
}

/** Every Missing Prefab placeholder (entry or node, `UnresolvedPrefabRef`) whose prefab is one of `sources` — by its ref or
 *  by where that ref resolves. */
export function placeholdersOf(sources: ReadonlySet<string>, _viaResolve = true): { entity: { id: number; name: string; guid?: string }; source: string; kind: 'entry' | 'node' }[] {
  const out: { entity: { id: number; name: string; guid?: string }; source: string; kind: 'entry' | 'node' }[] = [];
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  getCurrentWorld().query(UnresolvedPrefabRef).forEach((entity) => {
    const ref = unresolvedRefOf(entity);
    if (!ref || !(sources.has(ref.source) || sources.has(resolvedRef(ref.source) ?? ''))) return;
    const e = byId.get(entity.id());
    out.push({ entity: { id: entity.id(), name: e?.name ?? '', ...(e?.guid ? { guid: e.guid } : {}) }, source: ref.source, kind: ref.kind });
  });
  return out;
}

