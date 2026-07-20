/** Multi-select asset merge — the batch-Inspector analogue of inspectorMerge's
 *  readMergedTraits. Given N objects (resolved import settings / material params)
 *  and the keys to compare, returns a representative merged value plus the set of
 *  keys whose values differ across the selection (rendered as "Mixed"). Pure and
 *  unit-testable — no React, no backend. */

/** Merge a list of records over the given keys. `merged` takes the first record's
 *  value per key; `mixed` holds keys whose value isn't identical across all records
 *  (uses Object.is, matching readMergedTraits). */
export function mergeRecords<T extends Record<string, unknown>>(
  records: T[],
  keys: (keyof T)[],
): { merged: Partial<T>; mixed: Set<keyof T> } {
  const merged: Partial<T> = {};
  const mixed = new Set<keyof T>();
  if (records.length === 0) return { merged, mixed };
  for (const key of keys) {
    merged[key] = records[0][key];
    if (!records.every((r) => Object.is(r[key], records[0][key]))) mixed.add(key);
  }
  return { merged, mixed };
}
