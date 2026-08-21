/** memberPath — address one entity inside an instantiated subtree by a NAME PATH.
 *
 *  `resolveMemberPath(world, rootId, 'Tile3/Solved/Num')` walks the parent/child hierarchy
 *  from `rootId` and returns exactly the entity at that path.
 *
 *  ## Why this is not `findAllInInstance` promoted out of Court
 *
 *  Court's helper (`games/court/runtime/sceneChrome.ts`) scans for
 *  `PrefabInstance.rootInstanceId === rootEcsId`, which is FLAT by construction —
 *  `instantiatePrefabIntoWorld` stamps `rootInstanceId` on *"this prefab's OWN members only
 *  (never inner members)"*. So on a page prefab holding 25 nested tile instances, that scan
 *  reaches ZERO of the tiles: each tile's members carry the TILE's rootInstanceId, not the
 *  page's. Walking `EntityAttributes.parentId` instead is agnostic to how many prefab
 *  boundaries the path crosses, which is exactly what a compound entry needs.
 *
 *  ## Full paths, and ambiguity is an ERROR
 *
 *  A segment names a DIRECT child. Two siblings with the same name make the path ambiguous
 *  and it resolves to `undefined` with a reason, rather than silently picking the first.
 *  This deliberately differs from Court's `patchUIInInstance`, which writes EVERY match and
 *  returns a count: a silent multi-write is the failure class this repo keeps rediscovering.
 *  `level-tile.prefab.json` alone carries three entities named `Num` (one per state face), so
 *  `'Tile3/Num'` names three things and must say so instead of writing one of them.
 */
import type { World } from 'koota';
import { getTraitByName } from './traitRegistry';

/** Address `EntityAttributes` through the REGISTRY, never by importing the trait.
 *
 *  Two reasons, and the first is enforced: this module is **L0 core**, which
 *  `docs/architecture-layers.md` forbids from importing anything above it — an ESLint zone
 *  rule fails the build on a direct `../traits/…` import here, and it caught exactly that
 *  during this change. The registry lives in L0 beside this file, so it is the legal path.
 *
 *  It is also the RIGHT path: the entities this walks are produced by
 *  `instantiatePrefabIntoWorld`, which resolves every trait via `getTraitByName`. Matching that
 *  is what lets the walker be tested against real instantiation rather than only against a
 *  hand-built index.
 *
 *  No EntityAttributes registered ⇒ nothing is addressable by name, so the index is empty and
 *  every path misses. That is the honest answer rather than a throw: a world with no attributes
 *  trait has no member names to walk. */

export type MemberPathFailure = 'not-found' | 'ambiguous';

export interface MemberPathResult {
  /** The resolved entity id, or 0 when the path did not resolve. */
  id: number;
  failure?: MemberPathFailure;
  /** The path prefix that failed, for a diagnostic that names the actual problem. */
  at?: string;
}

/** Split a member path into segments. `''` (the entry root) yields no segments.
 *  Tolerates leading/trailing/duplicate separators so an authored `'/Tile3/'` behaves. */
export function splitMemberPath(path: string): string[] {
  if (!path) return [];
  return path.split('/').filter(seg => seg.length > 0);
}

/** Index every entity that has EntityAttributes by parentId. Built per call: the caller
 *  (the entries system) resolves a batch of paths against one freshly-built index rather
 *  than paying a world scan per path. */
export function buildChildIndex(world: World): Map<number, { id: number; name: string }[]> {
  const byParent = new Map<number, { id: number; name: string }[]>();
  const t = getTraitByName('EntityAttributes')?.trait;
  if (!t) return byParent;
  for (const e of world.entities) {
    const entity = e as unknown as { id(): number; has(t: unknown): boolean; get(t: unknown): unknown };
    if (!entity.has(t)) continue;
    const attr = entity.get(t) as { name?: string; parentId?: number };
    const parent = attr.parentId ?? 0;
    let bucket = byParent.get(parent);
    if (!bucket) { bucket = []; byParent.set(parent, bucket); }
    bucket.push({ id: entity.id(), name: attr.name ?? '' });
  }
  return byParent;
}

/** Resolve a path against a prebuilt child index. Pure over the index, so the walk —
 *  including the ambiguity rule — is unit-testable with no world. */
export function resolveMemberPathIn(
  index: Map<number, { id: number; name: string }[]>,
  rootId: number,
  path: string,
): MemberPathResult {
  const segs = splitMemberPath(path);
  let current = rootId;
  const walked: string[] = [];
  for (const seg of segs) {
    const children = index.get(current);
    walked.push(seg);
    if (!children) return { id: 0, failure: 'not-found', at: walked.join('/') };
    let hit = 0;
    let count = 0;
    for (const c of children) {
      if (c.name !== seg) continue;
      count++;
      if (count === 1) hit = c.id;
      // Keep counting rather than breaking: the WHOLE point is to notice a second match.
      if (count > 1) break;
    }
    if (count === 0) return { id: 0, failure: 'not-found', at: walked.join('/') };
    if (count > 1) return { id: 0, failure: 'ambiguous', at: walked.join('/') };
    current = hit;
  }
  return { id: current };
}

/** Convenience: build the index and resolve one path. Prefer the two-step form when
 *  resolving several paths against the same world — this rebuilds the index each call. */
export function resolveMemberPath(world: World, rootId: number, path: string): MemberPathResult {
  return resolveMemberPathIn(buildChildIndex(world), rootId, path);
}
