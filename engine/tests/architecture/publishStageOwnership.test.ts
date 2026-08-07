/** Guard: `publish-engine-oss.sh` never deletes a `.git` it did not create.
 *
 *  The in-stage guard run (step 4b) needs the staging dir to be a real git checkout, because the
 *  public runner checks the snapshot OUT and shipped guards ask git about it — `cliToolchainRecipes`
 *  enumerates via `git ls-files`. So the step does `git init` → `add -Af` → `commit`, runs the
 *  guards, then removes the `.git` again.
 *
 *  That is safe ONLY while the staging dir belongs to the script. It usually does — `mktemp -d` —
 *  but `--out DIR` makes `$STAGE` whatever the caller named, and it is not validated. A
 *  pre-existing `.git` there survives the `rm -rf "$STAGE"/*` wipe near the top, because that glob
 *  skips dotfiles. So the first version of step 4b would init over a caller's repository, commit
 *  into it, and then delete its `.git`.
 *
 *  Measured, not theorised: staging into a throwaway repo with `--out` destroyed its `.git` and the
 *  script still exited 0. Losing the working tree to the wipe is recoverable from `.git`; deleting
 *  `.git` is not — that is the whole history, and `--out <a local clone of the public repo>` is a
 *  plausible thing for someone to type.
 *
 *  The rule: every `.git` removal under `$STAGE` must be dominated by the refusal branch that
 *  bails when one already exists. Asserted structurally (order in the file) rather than by running
 *  the script, which would mean assembling a whole snapshot per test. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasPublishScripts } from '../helpers/repoLayout';

const SCRIPT = path.resolve(__dirname, '../../../scripts/publish-engine-oss.sh');

// THIS FILE SHIPS; THE SCRIPT IT READS DOES NOT. `publish-engine-oss.sh`'s manifest ships
// `engine build docs` + root configs, so root `scripts/` is absent from the public snapshot —
// and step 4b now runs the shipped guards INSIDE that snapshot, where the unconditional
// readFileSync above was an ENOENT before a single assertion ran. Read lazily and skip, rather
// than assert on a file the snapshot is never supposed to contain.
// The private-repo tripwire (`repoLayoutGuard.test.ts`) is what stops this skip going silent here.
const SRC = hasPublishScripts() ? fs.readFileSync(SCRIPT, 'utf8') : '';

describe.skipIf(!hasPublishScripts())('publish-engine-oss.sh owns the .git it deletes', () => {
  const src = SRC;

  it('refuses to touch a staging dir that already contains a .git', () => {
    // The branch itself must exist. Without it the script has no way to tell "my temp dir" from
    // "the caller's repo", and every other assertion here is vacuous.
    expect(src, 'the pre-existing-.git refusal branch is gone').toMatch(
      /elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/,
    );
  });

  it('never removes $STAGE/.git before that refusal', () => {
    const guardAt = src.search(/elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/);
    expect(guardAt, 'refusal branch not found').toBeGreaterThan(-1);

    // Every `rm -rf …/.git` aimed at the stage must come AFTER the refusal — i.e. inside the
    // else-branch the refusal protects. One appearing earlier would run unconditionally.
    const removals = [...src.matchAll(/rm\s+-rf\s+"\$\{STAGE\}\/\.git"/g)].map((m) => m.index ?? -1);
    expect(removals.length, 'no $STAGE/.git removal found — did step 4b change shape?')
      .toBeGreaterThan(0);
    for (const at of removals) {
      expect(at, `a $STAGE/.git removal at offset ${at} is not protected by the refusal`)
        .toBeGreaterThan(guardAt);
    }
  });

  it('creates the throwaway repo only inside the guarded branch', () => {
    const guardAt = src.search(/elif\s+\[\s+-e\s+"\$\{STAGE\}\/\.git"\s+\]\s*;\s*then/);
    // Same argument in the other direction: an unguarded `git init` would reinitialise a caller's
    // repo and stage a commit into it even if the deletion were somehow avoided.
    for (const m of src.matchAll(/git\s+-C\s+"\$STAGE"\s+init/g)) {
      expect(m.index ?? -1, 'git init on $STAGE runs before the pre-existing-.git refusal')
        .toBeGreaterThan(guardAt);
    }
  });
});
