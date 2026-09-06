/** Guard: no git-tracked SOURCE file contains a literal NUL (U+0000) byte.
 *
 *  git decides binary-vs-text by sniffing for a NUL in the first 8000 bytes. One raw NUL
 *  anywhere in that window and the file loses its textual diff, its `git blame`, and its
 *  line-level merge — `git diff` reports `Bin 0 -> 3789 bytes` and nothing else. On a repo
 *  whose five clones integrate through a shared remote (CLAUDE.md § Clones), a source file
 *  that cannot merge textually resolves a future conflict as "take one whole side", with no
 *  visibility into the other. `file(1)` also calls it `data`, and some editors silently strip
 *  or mangle embedded NULs on save.
 *
 *  This is not theoretical: `authoredWrites.ts` used a raw NUL as a composite-map-key
 *  separator and went binary for two commits (#133). The separator itself was the right
 *  choice — a NUL cannot occur in an entity id, trait name or field name — so the fix was to
 *  spell it as a unicode escape, which produces the identical runtime character with none of
 *  the tooling cost. That is the rule this guard enforces: the CHARACTER is fine, the raw
 *  BYTE in source is not.
 *
 *  A one-off would not normally earn a guard. This one does because the failure is invisible
 *  by construction — the code is semantically perfect, so `verify` and `test:e2e` are both
 *  green, and #133 was caught only by a human eyeballing a merge diff at the hub.
 *
 *  WHY THE SCAN IS IN JS AND NOT grep: a NUL byte cannot be passed as a shell argument (the
 *  C-string terminates there), so `grep -P '\x00'`-style invocations degrade to an empty
 *  pattern that matches EVERY file — a false positive for the whole repo that looks like a
 *  catastrophic finding. Hold the byte in a language that can: read the buffer, use indexOf. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Text-authored kinds only. Deliberately an allow-list rather than a deny-list of known
 *  binaries: the tracked binaries here (gradle wrapper jars, `.ogg`, `.ktx2`, a binary
 *  `.gltf`, fonts, images) legitimately contain NULs, and enumerating them would rot every
 *  time an asset lands. Anything not listed is simply not this guard's business. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.md', '.css', '.html', '.svg',
  '.sh', '.yml', '.yaml', '.toml', '.swift', '.java', '.kt', '.gradle', '.podspec', '.wgsl', '.glsl',
]);

/** Floored well under BOTH corpora this file runs against — ~6600 here, and **2610** in the public
 *  OSS snapshot, measured by assembling a real stage.
 *
 *  ⚠️ The floor was 3000 for one commit, which is above the snapshot's real count and would have
 *  gone red on the free public `ci/main` and on the hub's `verify:publish`. The mistake was the
 *  MENTAL MODEL, not the arithmetic: `scripts/publish-engine-oss.sh` is INCLUDE-ONLY
 *  (`git ls-files -- engine build docs` plus ~10 named root files and any `--with-demos`), so the
 *  snapshot is not "this repo minus `games/`" — it is a much smaller, explicitly-listed subset.
 *  Any floor added to a file under `engine/tests/**` has to clear the SNAPSHOT's count, not this
 *  clone's, because `engine/tests/**` ships.
 *
 *  Deliberately NOT gated on `hasInternalGames()`: this guard is about source hygiene everywhere,
 *  the snapshot is the only corpus the public gate has, and a gate that switches itself off there
 *  checks nothing on the one run nobody is watching. */
function trackedSourceFiles() {
  return repoFiles({
    // Includes untracked-but-not-ignored files (the `includeUntracked` default), which is wider
    // than the name "tracked" suggests and is the behaviour we want: a NUL byte is worth catching
    // in a file you just wrote, before it is staged, not only after.
    match: (rel: string) => SOURCE_EXT.has(path.extname(rel).toLowerCase()),
    floor: 1500,
  });
}

describe('no literal NUL bytes in repo source — tracked or newly written (#133)', () => {
  it('every text-authored file is text as far as git is concerned', () => {
    const offenders: string[] = [];
    for (const { rel, abs } of trackedSourceFiles()) {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue; // tracked but absent (a sparse/partial checkout) — nothing to inspect
      }
      const at = buf.indexOf(0);
      if (at !== -1) {
        // Report the line, not the byte offset — that is what a human has to go edit.
        const line = buf.subarray(0, at).toString('utf8').split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      'a literal NUL byte makes git classify the file as BINARY — no diff, no blame, no '
        + 'line-level merge. If the NUL character is intentional (e.g. a composite-key '
        + 'separator), write it as a unicode escape instead; the runtime value is identical.',
    ).toEqual([]);
  });
});
