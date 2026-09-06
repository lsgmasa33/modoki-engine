/** `.rig2d.json` has never had a format-version field — see `rig2dNoVersion.test.ts` for the
 *  schema-level half of this guard (the `RIG2D_FIELDS` `version` row and `defaultRig2DFile()`
 *  both stay version-free). What actually selects v1 vs v2 is the SHAPE (`parts[]` present or
 *  not), not a stamped number; the schema row that advertised a `version` field was an unread
 *  authoring surface removed in #784 phase C1.
 *
 *  This is the CORPUS half: every tracked `.rig2d.json` in the repo, not just the two files
 *  #784 touched, must never carry a `version` key — otherwise a future authoring surface (or a
 *  hand-edit) could reintroduce the dead field on a document nobody is watching. It replaces a
 *  prior version of this file that hardcoded the exact top-level key set of two specific rigs
 *  (`bar.rig2d.json`, `fish.rig2d.json`) — a frozen baseline that would go red the moment either
 *  rig was legitimately edited (e.g. the Skin Editor converting it to a v2 shape by adding
 *  `parts[]`), on whichever clone happened to touch it, not the one that wrote the freeze.
 *
 *  Enumerates via `git ls-files`, not a filesystem walk and not a hardcoded list, so an
 *  untracked scratch rig can't fail the gate and a newly-added tracked rig is picked up for
 *  free. */
import { describe, it, expect } from 'vitest';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hasInternalGames } from '../helpers/repoLayout';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Merge note: this file landed on `main` in the same window the `win` branch made
 *  `engine/scripts/repoCorpus.mjs` the ONE corpus producer (#799/#771/#805), so it arrived
 *  spawning `git ls-files` itself and was the first thing `corpusProducerIsShared.test.ts` caught
 *  after the merge. The intent above is unchanged and correct — git enumeration, no filesystem
 *  walk, no hardcoded list; it just goes through the shared producer now, which additionally
 *  handles the hazards a direct spawn has to remember (C-quoted non-ASCII paths without `-z`,
 *  unmerged-stage duplicates, a nested checkout reported as a bare directory).
 *
 *  `includeUntracked: false` preserves this guard's stated premise exactly: an untracked scratch
 *  rig must not fail the gate. `floor: 0` because every tracked rig lives under `games/`, which
 *  the public OSS snapshot strips entirely — the real premise check is the `hasInternalGames()`
 *  gate below, where it can skip rather than throw at module scope. */
function listTrackedRigFiles(): string[] {
  return repoFiles({ match: /\.rig2d\.json$/, floor: 0, includeUntracked: false })
    .map(({ rel }) => rel);
}

describe('every tracked .rig2d.json carries no format-version key (#784)', () => {
  const files = listTrackedRigFiles();

  // Every tracked rig lives under games/, which the public OSS snapshot strips entirely (it
  // ships two demos, no games) — so this premise only holds in a checkout with an internal
  // games root. Gated on hasInternalGames(), not hasAnyProject(): the snapshot's two demos
  // would make hasAnyProject() true there too, defeating the gate.
  it.skipIf(!hasInternalGames())('the enumeration is non-empty (an empty result must not pass vacuously)', () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  for (const file of files) {
    it(`${file} parses and has no "version" key`, () => {
      const abs = path.join(REPO_ROOT, file);
      const data = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
      expect('version' in data, `${file} carries a "version" key — .rig2d.json has never had one`).toBe(false);
    });
  }
});
