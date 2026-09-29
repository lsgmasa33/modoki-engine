/** Whether a prefab document expands to a ROOT (#1768). A document that loads but yields no root — its `rootLocalId`
 *  names no row, or names a reference row whose prefab cannot be read, or one that nests itself — cannot be expanded,
 *  exactly as a document that does not load cannot. I18 treats the two alike: the reference keeps its record
 *  (`keepUnresolvedEntry` / `spawnUnresolvedReference`), and the walk spawns nothing rather than a root-less scatter of
 *  rows that the next save writes as unrelated entities.
 *
 *  This is a second spelling of the rule the expansion applies (`instantiatePrefabIntoWorld` and the editor's
 *  `instantiatePrefab` return 0 when `rootLocalId` maps to nothing), pinned against both by
 *  `engine/tests/editor/missingPrefabPassThrough.test.ts`. */

/** Is `data` a prefab DOCUMENT: an object whose `entities` is an array of row objects (#1813)? The ONE shape check, asked
 *  wherever a prefab enters a cache — the loader's fetch and `replaceCachedPrefab`, the editor's fetch and its cache seat.
 *  Every reader then assumes the shape (about 53 `.entities` readers did, unguarded, and `preloadNestedPrefabs` threw on a
 *  hand-edited, truncated or agent-written file that reached the editor cache). A non-document is refused at the door, so
 *  it reads as a prefab that did not load — I18's missing prefab, with its record kept — never as an empty document, which
 *  would expand to no root. `entities: []` IS a document (it expands to no root, #1768's own case). */
export function isPrefabDocument(data: unknown): data is { entities: object[] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const rows = (data as { entities?: unknown }).entities;
  return Array.isArray(rows) && rows.every((r) => !!r && typeof r === 'object' && !Array.isArray(r));
}

type RootDoc = { id?: string; rootLocalId?: number; entities?: ReadonlyArray<{ localId?: number; prefab?: string }> };

const rootRowOf = (doc: RootDoc) => {
  const rid = doc.rootLocalId ?? 1;
  return (doc.entities ?? []).find((e) => (e.localId ?? 0) === rid);
};

/** `doc` expands to a root, reading a reference root's prefab through `read`. `stack` holds the documents already
 *  being expanded above this one (the walk's cycle stack), which a reference root may not name. */
export function expandsToRoot(doc: RootDoc, read: (source: string) => RootDoc | null | undefined, stack?: ReadonlySet<string>): boolean {
  const seen = new Set(stack);
  for (let d: RootDoc | null | undefined = doc; ;) {
    if (d.id) seen.add(d.id);
    const row = rootRowOf(d);
    if (!row) return false;
    if (!row.prefab) return true;
    d = read(row.prefab);
    if (!d || (d.id && seen.has(d.id))) return false;
  }
}

/** The loader's form: a reference root's prefab is FETCHED, as the entry's own document was, so an editor load whose
 *  runtime cache has not seen it yet does not read it as missing. */
export async function fetchedExpandsToRoot(doc: RootDoc, fetch: (source: string) => Promise<RootDoc | null | undefined>): Promise<boolean> {
  const seen = new Set<string>();
  for (let d: RootDoc | null | undefined = doc; ;) {
    if (d.id) seen.add(d.id);
    const row = rootRowOf(d);
    if (!row) return false;
    if (!row.prefab) return true;
    d = await fetch(row.prefab);
    if (!d || (d.id && seen.has(d.id))) return false;
  }
}
