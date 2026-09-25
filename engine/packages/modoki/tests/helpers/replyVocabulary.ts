/** The count names docs/mcp-tool-conventions.md §2 retired, and the walker that finds them in a reply.
 *
 *  Shared by the engine ops' walk (`engine/tests/framework/replyCountVocabulary.test.ts`) and every
 *  game's tool tests (#1561): a game tool's reply reaches the same agent through the same relay, so
 *  one rule has to cover both — a copy of the set in each game would drift on the next rename. */

export const RETIRED_COUNT_KEYS = new Set(['entityCount']);

/** #1266 retires `count` and `total` as well — but only at the TOP LEVEL of a reply, which is the
 *  distinction the first pass of this change got wrong and the guard itself caught.
 *
 *  A bare top-level `count` is the ambiguity §2 is about: `modoki_journal`, `get_console_logs`,
 *  `modoki_handles` and `modoki_list_assets` each answered `count` and/or `total`, meaning "rows
 *  here" on some and "everything that matched" on others — `entityCount`'s collision in a shorter
 *  word. Those are now `returnedCount`/`totalCount`.
 *
 *  A NESTED `count` is qualified by the key above it and carries no such ambiguity: `diagnose`
 *  answers `refs.count`, `camera.count`, `offScreen.count` and `uiOverflow.count`, and none of them
 *  can be misread — the parent states the subject, and none is a returned-rows-vs-matched pair, so
 *  renaming them to `returnedCount` would imply a truncation that cannot happen. `ringTotal` stays
 *  for the same reason it always did: a third population (the whole ring, filter ignored) that
 *  neither name covers.
 *
 *  ⚠️ Two limits of that reasoning, both known and neither currently live:
 *  - "qualified by its parent" is WEAKER than it sounds for `watch`'s `series[].count`
 *    (`app/debug/watch.ts`), which counts samples beside a `samples` array that IS capped by
 *    `maxSamples`, inside a series list that IS capped by a read-side limit. That one is a genuine
 *    returned-vs-matched pair wearing a nested name; it is left alone here only because renaming a
 *    per-series field is a different change from this one, not because the parent excuses it.
 *  - the top-level check keys on `path === '$'`, so a reply whose ROOT is an array would put its
 *    elements at `$[0]` and slip past. No agent op returns an array root today, and this line is
 *    only defensible while that holds. */
export const RETIRED_TOP_LEVEL_COUNT_KEYS = new Set(['count', 'total']);

/** Every path in `reply` whose key is a retired count name. */
export function retiredCountKeys(reply: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((el, i) => visit(el, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, el] of Object.entries(v)) {
        if (RETIRED_COUNT_KEYS.has(k) || (path === '$' && RETIRED_TOP_LEVEL_COUNT_KEYS.has(k))) out.push(`${path}.${k}`);
        visit(el, `${path}.${k}`);
      }
    }
  };
  visit(JSON.parse(JSON.stringify(reply ?? null)), '$');
  return out;
}
