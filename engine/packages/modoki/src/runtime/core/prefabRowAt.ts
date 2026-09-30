/** Which row of a prefab document a localId names (#1880 F3c). Core, so every layer can ask it the one way. */

/** The row of a prefab document (or a row list) at `localId` — the LAST one when a hand edit or merge repeats the number
 *  (#1880 F3c). ⚠️ THE lookup: the spawner's `localToEcs` keeps the last row's entity at that number, so every reader that
 *  asks "which row is localId N" must answer the same, or it reads one row while the world shows another. A raw
 *  `.find((e) => e.localId === …)` took the FIRST; `tests/architecture/rowLookupCensus.test.ts` refuses a new one. The
 *  validator reports the repeat; no writer emits one. */
export function rowAt<T extends { localId?: number }>(src: { entities?: readonly T[] } | readonly T[] | null | undefined, localId: number | undefined): T | undefined {
  const rows = Array.isArray(src) ? src as readonly T[] : (src as { entities?: readonly T[] } | null | undefined)?.entities;
  if (!rows || localId === undefined) return undefined;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.localId === localId) return rows[i];
  return undefined;
}

/** {@link rowAt}, only when that row is a REFERENCE row (a nested instance): what the spawner expands at that number. */
export function referenceRowAt<T extends { localId?: number; prefab?: unknown }>(src: { entities?: readonly T[] } | readonly T[] | null | undefined, localId: number | undefined): T | undefined {
  const row = rowAt(src, localId);
  return row?.prefab ? row : undefined;
}
