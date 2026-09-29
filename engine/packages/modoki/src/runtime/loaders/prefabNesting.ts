/** What a prefab document NESTS, and whether nesting one prefab in another would make a template contain itself (I16).
 *
 *  A leaf on purpose, in the runtime: the loader asks it when it expands a reference node (`refuseCyclicReferenceNode`),
 *  and the editor asks it from the prefab-edit refusal (`prefabEditRefusal.ts`), the save (`serializePrefab`) and Apply.
 *  The reader of cached documents is therefore a parameter: the runtime cache for the loader, the editor cache for the
 *  editor (`prefab.ts`'s `wouldCreateCycle`). */

import type { AddedEntity, NestedStructurePaths, SceneMemberRow } from './loadSceneFile';

export type ExpandingNode = { prefab?: string; children?: AddedEntity[]; added?: AddedEntity[]; nestedStructure?: NestedStructurePaths; members?: Record<string, SceneMemberRow> };

/** Reads a cached prefab document by guid, or null when it is not cached. Loose on purpose: the runtime and editor
 *  caches type their documents differently, and only the expanding slots are read. */
export type NestingReader = (guid: string) => { entities?: readonly object[]; name?: string } | null | undefined;

/** Every prefab ref a list of rows or added nodes EXPANDS, at any depth: a node's own `prefab`, its `children`,
 *  a reference node's own `added`, the `added` lists of its `nestedStructure` slots, and its member rows' `added` and
 *  `own` (a v6 row's or a reference node's `members`, #1817: a node the save folds into a nested row lands there, and a
 *  walk that skipped them let the prefab-edit save write a prefab containing itself). Never `traits` — a trait field
 *  that happens to be called `prefab` (a spawner naming what it spawns) is data, not nesting. */
export function expandedPrefabRefs(nodes: readonly ExpandingNode[]): string[] {
  const out: string[] = [];
  const walk = (n: ExpandingNode) => {
    if (n.prefab) out.push(n.prefab);
    for (const c of n.children ?? []) walk(c);
    for (const c of n.added ?? []) walk(c);
    for (const slot of Object.values(n.nestedStructure ?? {})) for (const c of slot.added ?? []) walk(c);
    for (const row of Object.values(n.members ?? {})) {
      for (const c of row.added ?? []) walk(c);
      for (const c of row.own ?? []) walk(c);
    }
  };
  for (const n of nodes) walk(n);
  return out;
}

/** Would nesting prefab `childGuid` inside `parentGuid` make `parentGuid` contain itself: is the child the parent, or
 *  does it transitively expand it? Best-effort over `read` — a document it cannot read counts as nesting nothing, and
 *  the expansion's own cycle stack is the backstop for what this cannot see. */
export function prefabNests(parentGuid: string, childGuid: string, read: NestingReader, seen = new Set<string>()): boolean {
  if (childGuid === parentGuid) return true;
  if (seen.has(childGuid)) return false;
  seen.add(childGuid);
  const child = read(childGuid);
  if (!child) return false;
  return expandedPrefabRefs((child.entities ?? []) as readonly ExpandingNode[]).some((ref) => prefabNests(parentGuid, ref, read, seen));
}

/** Does document `guid` contain ITSELF, at any depth (I16 broken on disk)? Only such a document can make an expansion
 *  recurse forever: every expansion of a prefab that does not contain itself ends, however often a scene nests it. */
export function prefabContainsItself(guid: string, read: NestingReader): boolean {
  const doc = read(guid);
  return !!doc && expandedPrefabRefs((doc.entities ?? []) as readonly ExpandingNode[]).some((ref) => prefabNests(guid, ref, read));
}
