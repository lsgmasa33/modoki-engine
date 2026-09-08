/** ⚠️ **A guard that DERIVES the roots it scans must derive its EXPECTATION the same way (#830).**
 *
 *  `abandonmentIsShared` and `livenessTokenIsShared` both carry the same shape: a `SCAN_DIRS` list
 *  they police, a derived complement of roots they do NOT police, and a hand-written ledger of the
 *  ad-hoc instances known to live out there. The complement is computed from what is on disk; the
 *  ledger is absolute. That asymmetry is a defect, and it fired: the public engine snapshot
 *  (`scripts/publish-engine-oss.sh` ships `engine build docs` and no `games/`) has no root for
 *  seven of liveness's eight rows, so the detector correctly returned one hit and the exact-set
 *  assertion went RED over content that was never supposed to be there. Caught by `verify:publish`
 *  at the hub — the only place that runs these guards inside the snapshot; `npm run verify` cannot
 *  see this class at all.
 *
 *  ## Why this is shared rather than copied
 *
 *  The fix needs to know what counts as a "root", and that rule was already written twice — once
 *  in each guard's own complement IIFE — before the fix added a third copy beside them. Three
 *  transcriptions of one rule, and **the two that must agree are the scan's and the filter's**: if
 *  they disagree about whether `site/foo.ts` is rooted at `site` or `site/foo.ts`, the filter
 *  silently over- or under-filters and the assertion still looks exact. Nothing would report it.
 *  So `repoRootOf` is the single definition both `deriveUnscannedRoots` and `expectedLedgerRows`
 *  read, and a guard cannot use one without the other.
 *
 *  ⚠️ **This is NOT a licence to leave a ledger row unbacked in THIS repo.** Every root is present
 *  in a developer clone, so a stale row still fails at authorship, which is where it should. The
 *  filter only ever removes a row whose ROOT is absent — never one whose root is there and whose
 *  token has gone.
 *
 *  ⚠️ **A guard's OTHER hand-written path lists are in this class too, and using this helper for
 *  the ledger does not cover them.** `notifyIsShared`'s `EXEMPT` list went red in the snapshot for
 *  exactly the #830 reason while its ledger passed, because only the ledger was filtered — caught
 *  at the hub's `verify:publish` on a merge, again the only place that can see it. It could not
 *  just call this helper: some of its rows live INSIDE `SCAN_DIRS`, where the throw above fires by
 *  design. So it filters on file existence with its own non-vacuity floor. If a THIRD guard needs
 *  the same, that is the point to generalise this into a "rows this checkout can validate" pass
 *  rather than transcribe the rule a third time. */

import fs from 'node:fs';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** The repo-relative ROOT a source file belongs to.
 *
 *  Depth 2 for the multi-project roots (`games/<id>`, `demos/<id>`, `engine/<area>`), depth 1 for
 *  a flat one like `site/`. Both forms are what `SCAN_DIRS` entries are written as, so the result
 *  is directly comparable to them. */
export function repoRootOf(rel: string): string {
  const parts = rel.split('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every top-level source root in the repo that `scanDirs` does NOT already cover.
 *
 *  Derived, not hand-written: a new root joins the remainder the day it is created, without anyone
 *  remembering to add it. Both guards previously hand-listed four roots under a test titled "the
 *  roots this guard does NOT scan" — a universal claim vouching for a subset. */
/** Every MAXIMAL directory that `scanDirs` does not reach into — the honest complement.
 *
 *  ⚠️ **This used to bucket files by a fixed depth and drop any root a scanDir descended into,
 *  which left a PARTIALLY covered root in neither set.** Measured on this checkout: `engine` and
 *  `engine/packages` were neither scanned nor censused, so 26 non-test files —
 *  `packages/modoki/src/three/traits/{Light,Fog,Environment}.ts`, five capacitor-plugin sources,
 *  `engine/project-config.ts`, `engine/vite.config.ts` — were covered by nothing while the test
 *  title said "exactly". That is the universal-claim-vouching-for-a-subset defect this whole
 *  change exists to remove, surviving inside the fix for it. Found by review, not by the gate.
 *
 *  Now: for each file outside `scanDirs`, walk down from the top until no scanDir descends any
 *  further, and take THAT directory. `engine/plugins/x.ts` yields `engine/plugins`;
 *  `engine/packages/modoki/src/three/traits/Light.ts` yields `engine/packages/modoki/src/three`,
 *  because a scanDir reaches `.../src/runtime` but not `.../src/three`. Nothing is dropped.
 *
 *  ⚠️ **The walk can EXHAUST, and keeping `dir` then returns a root that CONTAINS the scanDirs**
 *  (#950). For a file sitting directly under a partially-scanned root — `engine/vite.config.ts` —
 *  there is one iteration, every scanDir still starts with `engine/`, the `break` never fires, and
 *  the loop ends having proved the OPPOSITE of what keeping `dir` assumes. Measured on this
 *  checkout: that yielded `engine` AND `engine/packages/modoki`, which between them contain all
 *  three `SCAN_DIRS`. A guard's "the roots I do NOT scan" pass then re-scanned everything it had
 *  already policed and reported each offender TWICE — the second time under a message telling the
 *  reader the instance was somewhere the guard does not look.
 *
 *  ⚠️ Both consumers were GREEN throughout, purely because neither has an offender inside its own
 *  `SCAN_DIRS` — which is what those guards exist to ensure. Green by being SATISFIED, not by the
 *  derivation being right. Observed only when a third guard's mutation check put one there.
 *
 *  When the walk exhausts, no directory is an honest answer, and dropping the file reopens the
 *  "covered by nothing" hole above — so the maximal path is the FILE itself. `repoFiles({under})`
 *  matches `rel === under`, so a file path is a legal root to hand back. Measured: 5 such files,
 *  both containing roots gone, and the "a returned root contains a scanDir" set now empty. */
export function deriveUnscannedRoots(scanDirs: readonly string[]): string[] {
  const inside = (rel: string) => scanDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
  const out = new Set<string>();
  for (const { rel } of repoFiles({ match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 500 })) {
    if (inside(rel)) continue;
    const parts = rel.split('/');
    let dir = parts[0];
    let bounded = false;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = parts.slice(0, i + 1).join('/');
      if (!scanDirs.some((d) => d.startsWith(`${dir}/`))) { bounded = true; break; }
    }
    // Exhausted ⇒ every ancestor of this file still has a scanDir beneath it, so the file is its
    // own maximal unscanned path. See the ⚠️ in the docblock — keeping `dir` here is #950.
    out.add(bounded ? dir : rel);
  }
  return [...out].sort();
}

/** The ledger rows whose ROOT this checkout actually has — the expectation, filtered by the same
 *  root list the scan used, so the two can only ever disagree about TOKENS.
 *
 *  Each row is `<repo-relative path> :: <what it is>`; only the path half is examined.
 *
 *  ⚠️ **A row is dropped ONLY when its root is absent from the checkout entirely.** Sharing
 *  `repoRootOf` between the scan and the filter is necessary and NOT sufficient: if that one rule
 *  is wrong, BOTH sides are wrong in the same direction — the roots stop matching `SCAN_DIRS`, the
 *  scan quietly stops covering them, every ledger row is filtered away, and the assertion passes
 *  comparing `[]` to `[]`. Measured, not hypothesised: collapsing `repoRootOf` to `parts[0]`
 *  during a mutation check left both guards GREEN over all three of their known sites.
 *
 *  So the drop is justified against what is on DISK, never against `unscannedRoots`. A ledger row
 *  is by construction outside `SCAN_DIRS`, so if its root exists here it MUST be in the unscanned
 *  complement; a root that is present and yet missing from that complement is a broken derivation,
 *  and throwing is the only outcome that cannot be mistaken for a clean run. */
export function expectedLedgerRows(
  ledger: readonly string[],
  unscannedRoots: readonly string[],
): string[] {
  const kept: string[] = [];
  for (const row of ledger) {
    const rel = row.split(' :: ')[0];
    if (unscannedRoots.some((r) => rel === r || rel.startsWith(`${r}/`))) { kept.push(row); continue; }
    if (fs.existsSync(path.join(REPO, rel))) {
      throw new Error(
        `unscannedRoots: ledger row "${row}" names a file that EXISTS in this checkout but is `
        + 'under none of the unscanned directories. A ledger row is by definition outside '
        + 'SCAN_DIRS, so this cannot both be true — the derivation or SCAN_DIRS is wrong. '
        + 'Filtering the row out here would leave the guard comparing two empty sets and passing.',
      );
    }
  }
  return kept.slice().sort();
}

