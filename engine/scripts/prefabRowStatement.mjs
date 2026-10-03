// What a prefab reference row STATES about its nested instance, in one comparable form (#2001 S6).
//
// A row before prefab v10 states it in localId channels (`overrides[<localId>]`, ...); a v10 row states it on
// `members`, keyed by the nested prefab's node identities (the nested root on "/"). A re-save takes a file from one
// form to the other, so comparing the raw fields reports every row as changed, which hides a row whose statement did
// change. `check-prefab-churn.mjs` compares this form instead.
//
// Deliberately narrow: it restates the ONE legacy shape it can restate without the engine's parser, a row that states
// only `overrides`, each localId one the nested document has, with a `nodeGuid` on its row (or the nested root). Any
// other row answers null, and the gate falls back to printing the raw fields.

const LEGACY = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'templateMoved', 'nestedOverrides', 'nestedStructure'];

const isBag = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with every object's keys sorted: two statements that differ only in key order compare equal. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isBag(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** The statement of `row` (a reference row of a prefab document) as member rows, or null when this module cannot
 *  restate it. `nested` is the document the row's `prefab` names, when the caller has it. An empty statement is `{}`. */
export function rowStatement(row, nested) {
  if (!isBag(row)) return null;
  const legacy = LEGACY.filter((k) => row[k] !== undefined && !(isBag(row[k]) && !Object.keys(row[k]).length) && !(Array.isArray(row[k]) && !row[k].length));
  if (row.members !== undefined && !isBag(row.members)) return null;
  const out = { ...(row.members ?? {}) };
  if (!legacy.length) return out;
  if (legacy.length > 1 || legacy[0] !== 'overrides' || !isBag(row.overrides) || !isBag(nested)) return null;
  const byLocalId = new Map((Array.isArray(nested.entities) ? nested.entities : []).map((e) => [String(e?.localId), e]));
  for (const [lid, bag] of Object.entries(row.overrides)) {
    if (!isBag(bag)) return null;
    const node = byLocalId.get(lid);
    const key = lid === String(nested.rootLocalId) ? '/' : typeof node?.nodeGuid === 'string' && node.nodeGuid ? `/${node.nodeGuid}` : null;
    // A row that states the same member in both forms is not restated here: which one wins is the parser's rule.
    if (key === null || !node || out[key] !== undefined) return null;
    out[key] = { traits: bag };
  }
  return out;
}
