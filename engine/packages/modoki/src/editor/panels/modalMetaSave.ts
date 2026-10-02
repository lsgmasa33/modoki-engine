/** What a modal asset editor's Save lays over the texture's `.meta.json` (#2057) — the Sprite Editor's and the 9-Slice
 *  Editor's save DECISION, kept out of the `.tsx` so it carries a unit test rather than a jsdom mount (CLAUDE.md
 *  § Editor).
 *
 *  ## The defect this replaces
 *
 *  Both modals read the sidecar once, when they OPEN, and Save wrote that whole open-time document back with the
 *  editor's own keys laid over it. `/api/write-meta` replaces the file, and the write carried no `ifMatch`, so every key
 *  the modal does not own went back as its open-time value: an import setting an agent wrote
 *  (`modoki_write_asset_meta`) while the modal was open was silently reverted by Save. #2053 is the same mechanism on
 *  Project Settings.
 *
 *  ## The rule (the hub's #2053 ruling, applied to a sidecar)
 *
 *  Save re-reads the sidecar and lays over the FRESH document only the owned keys this editor CHANGED since it opened.
 *  A key someone else changed meanwhile and this editor did not is kept. A key both changed (to different values) is
 *  refused, naming it. The write carries the re-read's sha as `ifMatch`, so a write landing between the re-read and this
 *  one is refused too, not replaced. */

type Meta = Record<string, unknown>;

/** Key order is not a difference: a hand-written sidecar's `border` may list `t` before `l`, and the editor's never does. */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Meta)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export type ModalMetaSavePlan =
  /** Lay `set` over the fresh document and delete `remove` from it. */
  | { ok: true; set: Meta; remove: string[] }
  /** Owned keys this editor changed that ALSO changed on disk since it opened, to a different value. */
  | { ok: false; conflict: string[] };

/** `open` is the document the modal read when it opened, `fresh` the save-time re-read, and `next` the editor's value
 *  for EACH key it owns — `undefined` meaning "this key should be absent".
 *
 *  ⚠️ A caller whose edit state is UNCHANGED since it loaded must pass the OPEN values as `next`, not its own rendering
 *  of them: the editors normalise on load (9-slice fills a missing side with 0 and drops `scale: 1`), so their
 *  rendering of an untouched value can differ from the file's, and would read here as an edit — refused as a conflict
 *  if someone else changed that key, or written back over them.
 *
 *  `overwrite` names keys the human chose to replace after being told they changed underneath (the notice's Overwrite):
 *  those are set even though the file moved. */
export function planModalMetaSave(open: Meta, fresh: Meta, next: Meta, overwrite: readonly string[] = []): ModalMetaSavePlan {
  const set: Meta = {};
  const remove: string[] = [];
  const conflict: string[] = [];
  for (const [key, want] of Object.entries(next)) {
    if (same(want, open[key])) continue; // not changed here — whatever the file holds now stands
    if (!overwrite.includes(key) && !same(fresh[key], open[key]) && !same(fresh[key], want)) { conflict.push(key); continue; }
    if (want === undefined) remove.push(key);
    else set[key] = want;
  }
  return conflict.length ? { ok: false, conflict } : { ok: true, set, remove };
}
