/** Every committed editor-written JSON document ends in a trailing newline (#835, commit B).
 *
 *  #831 made the SERVER seam emit one (`assetJsonBytes`); #835's commit A made the CLIENT seam
 *  emit one too (`jsonFileBody`), so both writers now agree. This gate is the third leg: it pins
 *  the CORPUS, so the 537 files normalised in commit B cannot drift back one save at a time.
 *
 *  ## Why a corpus gate and not just the writer tests
 *
 *  The writer tests prove the two producers append `\n`. They cannot see a document that reaches
 *  disk some OTHER way — a hand-edit, a migration script, a generator nobody routed through the
 *  seam, a file authored on a branch that forked before commit A. That is exactly how the corpus
 *  accumulated 537 stragglers while `AtlasAssetView` was appending the byte correctly the whole
 *  time. A producer test answers "does this function behave"; only the corpus answers "is the
 *  repo actually in the state we claim".
 *
 *  ## ⚠️ Assert on the BYTES, never on a parse
 *
 *  `JSON.parse` succeeds identically with and without the trailing newline — which is precisely
 *  how this survived in the corpus for as long as it did. A round-trip test here would be green
 *  against the very defect it was written for. So this reads the last byte and nothing else.
 *
 *  ## ⚠️ This gate will go red on a WORKER BRANCH before it goes red on main
 *
 *  Five other clones run concurrent sessions. A branch that adds a scene or prefab written by a
 *  pre-commit-A editor lands a file with no trailing newline, and this gate fails there — not
 *  because that branch did anything wrong, but because it has not merged commit A's writer yet.
 *  That is the gate doing its job (the file genuinely is in the old shape), and the fix is to
 *  merge main in and re-save, NOT to add an exemption. Called out here so whoever hits it does
 *  not debug it from scratch.
 *
 *  ## Scope
 *
 *  The document kinds the editor's own writers produce. `.meta.json` is deliberately ABSENT: it
 *  is written by a different path entirely (`plugins/meta-sidecar.ts`, its own `writeJsonAtomic`),
 *  which has appended the newline all along — measured 391/391 correct at the time this landed —
 *  so including it would suggest a shared seam that does not exist (see #845).
 *
 *  ⚠️ `project.config.json` is absent, and NOT because nothing writes it — an earlier draft of this
 *  comment claimed that and was wrong. `/api/project-settings` writes it through
 *  `plugins/load-project-config.ts`'s `writeProjectConfig`, a THIRD independent serialisation seam
 *  that hardcodes its own `+ '\n'`. There is no byte drift today precisely because it hardcodes it,
 *  but the convergence story (`assetJsonBytes` server-side, `jsonFileBody` client-side) does not
 *  reach it, and a reader should know that rather than believe two seams is the whole picture.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** The kinds the editor's client seam (`jsonFileBody`) and server seam (`assetJsonBytes`) write.
 *
 *  ⚠️ Adding a document kind to the editor means adding it here. A kind absent from this list is
 *  not "allowed to lack a newline" — it is simply UNCHECKED, which is the quieter failure. */
const DOC_KINDS = [
  'scene', 'prefab', 'mesh', 'mat', 'anim', 'particle',
  'rig2d', 'animset', 'timeline', 'spriteanim', 'shader', 'atlas',
  // A GAME may define document kinds of its own and write them from its own editor panels
  // (`games/sling`'s Level and Wave editors, now routed through `jsonFileBody` — #835). These are
  // enumerated because they exist and are committed, NOT because this list can be complete for
  // games: a game added tomorrow brings kinds nothing here knows about. That is the same caveat as
  // the ⚠️ above, and it is why routing every writer through the one helper — not this list — is
  // what actually keeps the corpus correct.
  'level', 'wave',
] as const;

const DOC_RE = new RegExp(`\\.(${DOC_KINDS.join('|')})\\.json$`);

/** Floor, not an exact count: this suite also runs against the OSS snapshot, which is an
 *  INCLUDE-ONLY subset (`git ls-files -- engine build docs` plus named root files), so the corpus
 *  there is a fraction of this repo's ~640 documents. The floor's job is only to catch a filter
 *  that silently matched nothing — a gate over an empty set passes forever and proves nothing.
 *  Set well under the snapshot's own count rather than under this repo's. */
const FLOOR = 5;

describe('committed editor JSON documents end in a trailing newline (#835)', () => {
  // Tracked files only — `includeUntracked: false` on purpose. An untracked scratch file is not
  // part of the committed corpus this gate makes a claim about, and failing on one would make a
  // developer's own throwaway output break the gate.
  const docs = repoFiles({ match: DOC_RE, floor: FLOOR, includeUntracked: false });

  it(`enumerates a non-empty corpus (floor ${FLOOR})`, () => {
    // `repoFiles` already throws below its floor; this states the precondition so a reader knows
    // the assertion below is not vacuous, and names the count in the failure output.
    expect(docs.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it('every one of them ends in exactly one \\n', () => {
    const missing: string[] = [];
    const doubled: string[] = [];
    // `abs` comes from `repoFiles`, which builds it by joining git's verbatim POSIX `rel` to the
    // root ONCE. Re-deriving it here with `path.join(root, rel)` is the exact round-trip that
    // module's doc-block forbids, so the absolute path is taken as given and only `rel` is
    // reported — the readable half.
    for (const { rel, abs } of docs) {
      const buf = fs.readFileSync(abs);
      // An empty file has no last byte to read; it is not a well-formed document either way.
      if (buf.length === 0) { missing.push(rel); continue; }
      if (buf[buf.length - 1] !== 0x0a) { missing.push(rel); continue; }
      // Guard the opposite drift too: a writer that appends unconditionally to a body that
      // already ends in `\n` produces a growing tail of blank lines, one per save. That is a
      // different defect with the same cause, and it would otherwise pass this gate silently.
      if (buf.length >= 2 && buf[buf.length - 2] === 0x0a) doubled.push(rel);
    }
    expect({ missing, doubled }).toEqual({ missing: [], doubled: [] });
  });
});
