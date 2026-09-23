/** Every authored prefab row carries a minted `nodeGuid` — the corpus half of #1468's finding B.
 *
 *  ## What this pins, and why it is a CORPUS gate rather than a writer test
 *
 *  A scene's member row exists only where the TEMPLATE minted a `nodeGuid` (prefab v5). So an
 *  instance of a prefab that has none has no member rows at all, and is addressable only through
 *  the `localId` key space that Phase 3 and Phase 4 of
 *  `docs/plans/prefab-member-identity-plan.md` delete. The plan's finding B is the ruling: the
 *  corpus migrates to v5 first (`engine/scripts/migrate-prefabs-v5.mjs`), and this gate is what
 *  keeps it there.
 *
 *  `serializePrefab` mints one for every row it writes, and `createPrefabMemberIdentity.test.ts`
 *  proves that. What a writer test cannot see is a document reaching the repo some OTHER way — a
 *  hand-authored file (10 of the 105 are hand-written), a prefab copied in from a branch that
 *  forked before v5, a generator nobody routed through the serializer. That is the same gap
 *  `committedJsonTrailingNewline.test.ts` exists for, one field over: a producer test answers
 *  "does this function behave", only the corpus answers "is the repo in the state we claim".
 *
 *  ## ⚠️ It pins the GUID, not the `version`
 *
 *  Deliberately. `version` is a writer-only stamp with no migration ladder behind it
 *  (`runtime/core/version.ts`), and prefabs are expected to sit below the current number until
 *  something saves them — `{2: 102, 3: 3}` was the corpus the day before this landed, against a
 *  constant of 5. A gate on the number would demand a fresh corpus rewrite on every bump, which
 *  is the opposite of the repo's actual practice. The identity is what Phase 4 depends on, so the
 *  identity is what is pinned.
 *
 *  ## The non-vacuity pin is gated; the RULE is not
 *
 *  `scripts/publish-engine-oss.sh` is INCLUDE-ONLY and its release path ships no `games/` and no
 *  demos, so the floor below is unsatisfiable there — the same reason `showRefsCorpus.test.ts`
 *  gates its own. The rule itself runs everywhere and is meaningful over however many prefabs the
 *  layout actually has, including none. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

/** Well under the real count (105 files / 1811 rows as of the v5 migration), so ordinary churn
 *  stays green while a walk that silently stops finding prefabs goes red. */
const FILE_FLOOR = 50;
const ROW_FLOOR = 500;

const PROJECT_PATTERN = new RegExp(`^(${PROJECT_ROOT_DIRS.join('|')})/[^/]+/runtime/assets/`, 'i');

// Enumerated through the ONE shared corpus producer — a hand-rolled walk here is the violation
// `corpusProducerIsShared.test.ts` polices, and this file would be scanning its own private idea
// of the corpus rather than the repo's.
const prefabs = repoFiles({ match: /\.prefab\.json$/i, floor: 0 })
  .filter((f) => PROJECT_PATTERN.test(f.rel));

type Row = { localId?: number; nodeGuid?: string; name?: string };
const docs = prefabs.map(({ rel, abs }) => ({
  rel,
  rows: (JSON.parse(fs.readFileSync(abs, 'utf8')).entities ?? []) as Row[],
}));

describe('prefab corpus — minted node identity (#1468 finding B)', () => {
  it('gives every entity row a guid-shaped nodeGuid', () => {
    // ⚠️ Reports the OFFENDING ROWS, not a count. The fix is per-file
    // (`node engine/scripts/migrate-prefabs-v5.mjs --write`) and a reader who is handed "17 rows
    // are missing one" has to go and find them before they can act on it.
    const missing = docs.flatMap(({ rel, rows }) => rows
      .filter((r) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.nodeGuid ?? ''))
      .map((r) => `${rel}#${r.localId} ("${r.name ?? ''}") nodeGuid=${JSON.stringify(r.nodeGuid)}`));
    expect(missing, 'run `node engine/scripts/migrate-prefabs-v5.mjs --write`').toEqual([]);
  });

  it('never gives two rows of one document the same node identity', () => {
    // The whole point of the field is that a key naming a row can only ever DANGLE, never repoint
    // at a different node. Two rows sharing one guid gives a scene key two answers, which is
    // precisely the positional-`localId` failure v5 exists to end.
    const dupes = docs.flatMap(({ rel, rows }) => {
      const seen = new Set<string>();
      return rows.filter((r) => r.nodeGuid && (seen.has(r.nodeGuid) || (seen.add(r.nodeGuid), false)))
        .map((r) => `${rel}#${r.localId} → ${r.nodeGuid}`);
    });
    expect(dupes).toEqual([]);
  });

  it.skipIf(!hasInternalGames())('actually reached the corpus — the non-vacuity pin', () => {
    // Without this the two assertions above pass over an EMPTY list, which is how a broken
    // enumeration presents: green, silent, and vouching for nothing.
    expect(docs.length).toBeGreaterThan(FILE_FLOOR);
    expect(docs.reduce((n, d) => n + d.rows.length, 0)).toBeGreaterThan(ROW_FLOOR);
  });
});
