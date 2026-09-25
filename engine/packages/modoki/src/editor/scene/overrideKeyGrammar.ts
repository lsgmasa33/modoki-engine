/** The MEMBER part of an Apply-to-Prefab / Revert-Overrides key (#1468 Phase 4).
 *
 *  A key (`prefabOverrideKeys.ts` lists the shapes) names the prefab member it is about. It used to name
 *  it by `localId`, which is a POSITION in the prefab document: a template re-save can renumber it, and a
 *  key listed before the renumber then names whichever member inherited the number — silently, since
 *  both are plausible members. Keys are the one address in the editor that crosses CALLS (an agent
 *  lists them with `modoki_prefab overrides`, then acts on them later), so a template change between the
 *  two is an ordinary sequence, not a race.
 *
 *  So a key now names a member by its minted `nodeGuid` (prefab v5) when it has one, and by `localId`
 *  only when it does not (a pre-v5 template). Both spellings are ACCEPTED everywhere: every consumer turns
 *  the keys it is handed into the localId form against the document it is working on
 *  ({@link toLocalIdKey}), and everything after that point is unchanged — within ONE document a localId
 *  is a perfectly good address. That is the whole of the Phase 4 design in one sentence: a localId means
 *  something only together with the document it was read from, and nothing carries one across without
 *  translating it.
 *
 *  The two spellings cannot collide: a guid is 36 characters with hyphens, a localId is digits. Neither
 *  contains `.` or `:`, which is what lets the key shapes keep their separators. */

import { isGuid } from '../../runtime/core/assetRefRules';

/** What this module reads of a prefab document. */
export interface KeyDoc {
  entities: ReadonlyArray<{ localId: number; nodeGuid?: string; prefab?: string }>;
}
export type KeyDocReader = (prefabRef: string) => KeyDoc | null | undefined;

/** The member part a key should carry for row `localId` of `doc`: its `nodeGuid`, or the localId itself
 *  when the row has none. */
export function memberRef(doc: KeyDoc, localId: number): string {
  const g = doc.entities.find((e) => e.localId === localId)?.nodeGuid;
  return g && isGuid(g) ? g : String(localId);
}

/** The localId `ref` names in `doc`, or null when it names no row there. A numeric ref is taken at its
 *  word — the legacy spelling, and the only one a pre-v5 document has. */
export function localIdOfRef(doc: KeyDoc, ref: string): number | null {
  if (isGuid(ref)) return doc.entities.find((e) => e.nodeGuid === ref)?.localId ?? null;
  const n = Number(ref);
  return ref !== '' && Number.isInteger(n) ? n : null;
}

/** The identity-form key for a move of member `lid` inside the nested instance reached by `chain` (row
 *  localIds, outermost first) from `doc` — `~moved.<ref>.<ref>…:<ref>`, each part a ref in the document
 *  at its own depth. */
export function nestedMoveRef(doc: KeyDoc, chain: readonly number[], lid: number, readDoc: KeyDocReader): string {
  const refs: string[] = [];
  let cur: KeyDoc | null | undefined = doc;
  for (const row of chain) {
    refs.push(cur ? memberRef(cur, row) : String(row));
    const ref: string | undefined = cur?.entities.find((e) => e.localId === row)?.prefab;
    cur = ref ? readDoc(ref) : null;
  }
  return `~moved.${refs.join('.')}:${cur ? memberRef(cur, lid) : String(lid)}`;
}

/** `key` in its localId form against `doc` (nested parts through `readDoc`), or null when a member it
 *  names is not in the document — a key for a member the template no longer has, which must name
 *  NOTHING rather than whatever now holds a number — and so is a member part that is neither a guid nor
 *  a number. `+added.<guid>` names a live node, not a member, and passes through; so does a string with
 *  no separator at all, which no shape produces and every consumer already ignores. */
export function toLocalIdKey(key: string, doc: KeyDoc, readDoc: KeyDocReader): string | null {
  const one = (prefix: string, rest: string, tail = ''): string | null => {
    const lid = localIdOfRef(doc, rest);
    return lid === null ? null : `${prefix}${lid}${tail}`;
  };
  if (key.startsWith('+added.')) return key;
  if (key.startsWith('-removed.')) return one('-removed.', key.slice('-removed.'.length));
  for (const prefix of ['-trait.', '+trait.']) {
    if (!key.startsWith(prefix)) continue;
    const body = key.slice(prefix.length);
    const dot = body.indexOf('.');
    return dot < 0 ? key : one(prefix, body.slice(0, dot), body.slice(dot));
  }
  if (key.startsWith('~moved.')) {
    const body = key.slice('~moved.'.length);
    const colon = body.indexOf(':');
    if (colon < 0) return one('~moved.', body);
    const lids: number[] = [];
    let cur: KeyDoc | null | undefined = doc;
    for (const ref of body.slice(0, colon).split('.')) {
      const lid: number | null = cur ? localIdOfRef(cur, ref) : null;
      if (lid === null) return null;
      lids.push(lid);
      const prefab: string | undefined = cur!.entities.find((e) => e.localId === lid)?.prefab;
      cur = prefab ? readDoc(prefab) : null;
    }
    const lid = cur ? localIdOfRef(cur, body.slice(colon + 1)) : null;
    return lid === null ? null : `~moved.${lids.join('.')}:${lid}`;
  }
  const dot = key.indexOf('.');
  return dot < 0 ? key : one('', key.slice(0, dot), key.slice(dot));
}

/** {@link toLocalIdKey} over a set of keys, remembering what each came from so a result can report
 *  them in the caller's own spelling, and which named no member. */
export function toLocalIdKeys(keys: Iterable<string>, doc: KeyDoc, readDoc: KeyDocReader): {
  keys: Set<string>; original: Map<string, string>; unresolved: string[];
} {
  const out = new Set<string>();
  const original = new Map<string, string>();
  const unresolved: string[] = [];
  for (const k of keys) {
    const n = toLocalIdKey(k, doc, readDoc);
    if (n === null) { unresolved.push(k); continue; }
    out.add(n);
    if (!original.has(n)) original.set(n, k);
  }
  return { keys: out, original, unresolved };
}
