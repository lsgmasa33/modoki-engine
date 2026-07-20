/** Dotted-path get/set for animation tracks whose `field` addresses a NESTED value inside a
 *  trait — e.g. `overrides.0.source.value` (a `constant` MaterialInstance override's value) rather
 *  than a flat trait field. Flat tracks (`rx`) never contain a `.` and don't go through here.
 *
 *  `setPath` is IMMUTABLE — it clones each object/array along the path so a fresh top-level
 *  reference is produced (koota change-detection + any `changed`-query consumers see the update),
 *  while sibling entries are preserved by reference. Numeric segments index arrays. */

/** Read `obj` at a dotted path. `undefined` if any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  const segs = path.split('.');
  let cur: unknown = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** Return a copy of `obj` with `value` written at the dotted path, cloning every node on the way. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  return setRec(obj, path.split('.'), 0, value) as T;
}

function setRec(node: unknown, segs: string[], i: number, value: unknown): unknown {
  const key = segs[i];
  const isLast = i === segs.length - 1;
  if (Array.isArray(node)) {
    const idx = Number(key);
    // Stale/out-of-range index (e.g. an animation track for `overrides.5.*` after the
    // overrides array shrank) → DROP the write and return the node unchanged, rather than
    // growing a sparse array / writing a phantom entry. A dangling track is inert, not corrupting.
    if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return node;
    const copy = node.slice();
    copy[idx] = isLast ? value : setRec(node[idx], segs, i + 1, value);
    return copy;
  }
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
  return { ...obj, [key]: isLast ? value : setRec(obj[key] ?? {}, segs, i + 1, value) };
}
