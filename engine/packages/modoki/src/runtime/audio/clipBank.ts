/** Parse an `AudioSource.clips` bank — a JSON-string `[{ "key", "ref" }, …]`
 *  (key → audio GUID). A JSON-string SCALAR (like `Collider2D.points`) keeps the
 *  bank boundary-safe (opaque to serialize/undo/prefab), so this is the ONE place
 *  that decodes it. Guarded: any malformed / non-array / bad-entry input → `[]`
 *  (never throws). Entries missing a string `key`/`ref` are dropped.
 *
 *  `parseClipBankResult` (below) additionally reports WHETHER the input was malformed, for a
 *  caller that wants to warn on it (#731); `parseClipBank` stays the plain never-throws `[]`
 *  contract every existing caller (including the public barrel re-export) already relies on —
 *  same split as `loadVendorPlugins.mjs`'s `loadEnginePluginModuleResult`/`loadEnginePluginModule`. */
export interface ClipBankEntry { key: string; ref: string; }

export interface ClipBankResult {
  entries: ClipBankEntry[];
  /** True when `src` was a non-empty string that could NOT be decoded into a valid clip-bank
   *  array — corrupt/truncated JSON, or JSON of the wrong top-level shape. `false` for "no bank
   *  authored" (absent/empty `src`) — a caller deciding whether to warn must not conflate the two
   *  (#731). Does NOT flag an otherwise-valid array containing a dropped entry (missing
   *  `key`/`ref`) — that is normal authoring, not corruption. */
  malformed: boolean;
}

export function parseClipBankResult(src: unknown): ClipBankResult {
  if (typeof src !== 'string' || src === '') return { entries: [], malformed: false };
  let raw: unknown;
  try { raw = JSON.parse(src); } catch { return { entries: [], malformed: true }; }
  if (!Array.isArray(raw)) return { entries: [], malformed: true };
  const out: ClipBankEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { key, ref } = e as Record<string, unknown>;
    if (typeof key !== 'string' || typeof ref !== 'string') continue;
    out.push({ key, ref });
  }
  return { entries: out, malformed: false };
}

export function parseClipBank(src: unknown): ClipBankEntry[] {
  return parseClipBankResult(src).entries;
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
