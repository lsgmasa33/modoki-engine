import { prefabContainsItself, type NestingReader } from './prefabNesting';
import { rowAt } from '../core/prefabRowAt';
import { rootReferenceRefusal } from './variantForm';

export { rootReferenceRefusal };

/** Whether a prefab document expands to a ROOT (#1768). A document that loads but yields no root — its `rootLocalId`
 *  names no row, or names a reference row whose prefab cannot be read, or one that nests itself — cannot be expanded,
 *  exactly as a document that does not load cannot. I18 treats the two alike: the reference keeps its record
 *  (`keepUnresolvedEntry` / `spawnUnresolvedReference`), and the walk spawns nothing rather than a root-less scatter of
 *  rows that the next save writes as unrelated entities.
 *
 *  This is a second spelling of the rule the expansion applies (`instantiatePrefabIntoWorld`, which the editor's
 *  `instantiatePrefab` calls, returns 0 when `rootLocalId` maps to nothing), pinned against both by
 *  `engine/tests/editor/missingPrefabPassThrough.test.ts`. */

export { isPrefabDocument } from './prefabDocumentShape';

type RootDoc = { id?: string; rootLocalId?: number; entities?: ReadonlyArray<{ localId?: number; prefab?: string }> };

const rootRowOf = (doc: RootDoc) => {
  const rid = doc.rootLocalId ?? 1;
  return rowAt(doc, rid);
};

/** `doc` expands to a root: its root row is a row, and a plain one. A root that is a reference is the Prefab Variant form,
 *  which nothing expands since #2001 S5 (owner ruling (b), #2042: `rootReferenceRefusal`), so it does not expand here
 *  either. The predicate and both expansions answer alike (the twin pin, `missingPrefabPassThrough.test.ts`); before S5
 *  a reference root was followed into its prefab (through `read`, with `stack` as the walk's cycle stack). Those two stay
 *  in the signature for the variants stage that will follow it again. */
export function expandsToRoot(doc: RootDoc, _read: (source: string) => RootDoc | null | undefined, _stack?: ReadonlySet<string>): boolean {
  const row = rootRowOf(doc);
  return !!row && !row.prefab;
}

/** The loader's form ({@link expandsToRoot}): it fetched a reference root's prefab, as the entry's own document was. */
export async function fetchedExpandsToRoot(doc: RootDoc, _fetch: (source: string) => Promise<RootDoc | null | undefined>): Promise<boolean> {
  return expandsToRoot(doc, () => null);
}

/** Must reference node `node` be refused as a cycle (I16)? Only when its prefab is being expanded ABOVE it (`ancestors`,
 *  the expansion's cycle stack in push order) AND that prefab's own document contains itself: a self-containing file
 *  written before #1817's save guard (or by hand). That is the one shape that recurses forever. A scene nesting a prefab
 *  inside its own instance is legal (#1446) and ends, so a repeat alone is not refused; the caller then expands the
 *  node from `stackForReferenceNode`, which carries only self-containing ancestors.
 *
 *  When it refuses it logs the refusal, naming the node and the chain it sits in, and the caller spawns nothing for the
 *  node — not a placeholder, which would write the cycle straight back on the next save. The one reference-node
 *  spawner (`spawnReferenceNode`, run by the loader's structure apply and the editor's) asks it before it expands a node. `read` is the caller's cache. */
export function refuseCyclicReferenceNode(
  ancestors: ReadonlySet<string>,
  node: { prefab?: string; guid?: string; key?: string; traits?: Record<string, unknown> },
  read: NestingReader,
  logPrefix: string,
): boolean {
  const ref = node.prefab;
  if (!ref || !ancestors.has(ref) || !prefabContainsItself(ref, read)) return false;
  const label = (id: string) => `"${read(id)?.name ?? id}"`;
  const nodeName = (node.traits?.EntityAttributes as { name?: unknown } | undefined)?.name;
  const nodeLabel = [typeof nodeName === 'string' && nodeName ? `"${nodeName}"` : '', node.guid || node.key || ''].filter(Boolean).join(' ');
  console.error(
    `${logPrefix} cycle: prefab ${label(ref)} contains itself (I16), so its reference node ${nodeLabel || '(unnamed)'} ` +
    `inside ${[...ancestors].map(label).join(' › ')} is not expanded. A prefab-edit save of the file holding that node ` +
    `refuses until the node is removed.`,
  );
  return true;
}

/** The cycle stack a reference node's expansion starts from: only the ancestors whose documents contain THEMSELVES.
 *  Those are the only ones an endless loop can pass through again, so carrying them lets a loop through two or more
 *  files (A holds a B node, B holds an A node) meet its own start and be refused. Every other ancestor is dropped: a
 *  scene may nest a prefab inside its own instance (#1446), and a statement forwarded down from an outer layer is
 *  applied under levels that did not state it, so a plain repeat would trip the expansion's own guard ("nests itself")
 *  on a legal file. A fresh set: the expansion pushes and pops. */
export function stackForReferenceNode(ancestors: ReadonlySet<string>, read: NestingReader): Set<string> {
  return new Set([...ancestors].filter((id) => prefabContainsItself(id, read)));
}
