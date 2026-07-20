/** Parse an `AudioSource.clips` bank — a JSON-string `[{ "key", "ref" }, …]`
 *  (key → audio GUID). A JSON-string SCALAR (like `Collider2D.points`) keeps the
 *  bank boundary-safe (opaque to serialize/undo/prefab), so this is the ONE place
 *  that decodes it. Guarded: any malformed / non-array / bad-entry input → `[]`
 *  (never throws). Entries missing a string `key`/`ref` are dropped. */
export interface ClipBankEntry { key: string; ref: string; }

export function parseClipBank(src: unknown): ClipBankEntry[] {
  if (typeof src !== 'string' || src === '') return [];
  let raw: unknown;
  try { raw = JSON.parse(src); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: ClipBankEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { key, ref } = e as Record<string, unknown>;
    if (typeof key !== 'string' || typeof ref !== 'string') continue;
    out.push({ key, ref });
  }
  return out;
}

/** Serialize a bank back to its JSON-string form (inverse of `parseClipBank`).
 *  `''` for an empty bank (keeps a bank-less source's field clean). */
export function stringifyClipBank(entries: ClipBankEntry[]): string {
  return entries.length ? JSON.stringify(entries) : '';
}

/** Resolve a bank `key` → clip GUID, or '' if absent. */
export function clipRefForKey(clips: unknown, key: string): string {
  return parseClipBank(clips).find((c) => c.key === key)?.ref ?? '';
}
