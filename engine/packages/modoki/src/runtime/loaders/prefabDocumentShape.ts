// Dependency-free on purpose: `documentIdentity.ts` reads it, and the backend's Node-side write gate imports that
// (#1937 C-A step 6) — `prefabRoot.ts` reaches the whole runtime through a type import of `loadSceneFile`.

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
