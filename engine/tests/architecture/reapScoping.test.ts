/** Guard: every process reap in `engine/scripts/**` is scoped to an ABSOLUTE path.
 *
 *  Several clones of this repo share one machine (CLAUDE.md § Clones), and they all run
 *  binaries with identical names from identically-shaped relative paths. So a reap that
 *  matches a product name ("Modoki Editor.app/Contents/MacOS") or a relative fragment
 *  ("engine/electron/dist/main.cjs") kills EVERY clone's editor, not just this one.
 *
 *  This is not hypothetical and not a one-off: `launch-editor.sh` fixed exactly this in
 *  its own cleanup and documented it, then `test-packaged.sh` and
 *  `packagedAppPaths.killPackaged` were found doing it anyway (#69). CLAUDE.md has stated
 *  the rule the whole time — "never a bare pkill … use the repo-scoped launcher" — which
 *  is the point: an unenforced convention held for the file that was audited and not for
 *  the one next to it. Hence a test.
 *
 *  The rule: a `pkill -f` pattern must start with `/` (a literal absolute path) or `$`
 *  (a variable holding one — `$REPO/...`, `$APP/...`). Anything starting with a bare word
 *  is a shared name and fails.
 *
 *  KNOWN GAP, accepted: the Windows branch of `killPackaged` uses
 *  `taskkill /F /IM <productName>.exe`, which matches by image name and so is
 *  clone-agnostic by construction — `taskkill` has no command-line matching to scope it
 *  with. It is tolerated because the Windows setup is one clone per machine (CLAUDE.md
 *  § Clones); if that ever stops being true, this needs a PID-based reap, not a wider
 *  regex here. Stated so the guard is not mistaken for covering it. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments as stripJsComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const scriptsDir = path.resolve(__dirname, '../../scripts');

/** Every reap-relevant script under `engine/scripts`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 90 measured today. */
function scriptFiles(): string[] {
  return repoFiles({ under: scriptsDir, match: /\.(sh|mjs|js|ts)$/, floor: 60 }).map(({ abs }) => abs);
}

/** Strip comments so the many prose mentions of `pkill` in these files (they explain this
 *  very hazard) are not mistaken for code. Dual language: `#` comments for shell, the shared
 *  scanner (#419) for JS/TS. */
function stripComments(src: string, isShell: boolean): string {
  if (isShell) {
    return src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  }
  return stripJsComments(src);
}

describe('process reaps in engine/scripts are clone-scoped (#69)', () => {
  it('the comment scan is sane over every JS/TS script file', () => {
    for (const file of scriptFiles()) {
      if (file.endsWith('.sh')) continue;
      const raw = fs.readFileSync(file, 'utf8');
      assertScanIsSane(raw, stripJsComments(raw), path.relative(scriptsDir, file));
    }
  });

  it('every `pkill -f` pattern is anchored to an absolute path', () => {
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      const isShell = file.endsWith('.sh');
      const src = stripComments(fs.readFileSync(file, 'utf8'), isShell);
      // pkill -f "<pattern>" | '<pattern>' | <bare-word>
      const re = /pkill\s+(?:-\w+\s+)*-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const pattern = m[1] ?? m[2] ?? m[3] ?? '';
        if (!/^[/$]/.test(pattern)) {
          offenders.push(`${path.relative(scriptsDir, file)}: pkill -f ${JSON.stringify(pattern)}`);
        }
      }
    }
    expect(
      offenders,
      'a reap pattern that does not start with "/" or "$" matches every clone on this machine — '
        + 'scope it to an absolute path ($REPO/..., $APP/...)',
    ).toEqual([]);
  });

  it('a `pkill -f` pattern led by a variable uses the fail-if-empty expansion form', () => {
    // The rule above only checks that a pattern STARTS with "/" or "$" — it cannot see what a
    // "$"-led pattern expands to, because that's runtime state, not source text. That gap is
    // exactly what let `test-packaged.sh` and `assert-app-renders.sh` pass the first rule while
    // still being able to reap the whole machine: `pkill -f "$APP/Contents/MacOS"` LOOKS scoped
    // (it starts with "$"), but if `$APP` is ever empty — unset ≠ empty, so `set -u` does not
    // catch this — the pattern silently collapses to "/Contents/MacOS", which matches every
    // clone's Electron process. Bash's `${VAR:?msg}` form aborts the expansion (and therefore
    // the whole command) unconditionally when the variable is empty OR unset, independent of
    // `set -e` — so it is the one construct that actually closes the gap. Require it wherever a
    // `pkill -f` pattern starts with a NAMED variable reference (`$APP`, `${REPO}`, …).
    //
    // Deliberately excludes a leading POSITIONAL parameter (`$1`, `$2`, …, `$@`): that is
    // `launch-editor.sh`'s `pkill -f "$1"` inside its `kill_pattern` helper, which this task's
    // brief calls out by name as "already repo-scoped and correct" and explicitly out of
    // scope to touch. A positional parameter is a function ARGUMENT, not a script-level
    // variable that this repo's own bugs have shown can go quietly empty — every call site
    // passes it an absolute path literal, so `${1:?msg}` would harden a call site that was
    // never the failure mode this guard exists for.
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      if (!file.endsWith('.sh')) continue; // `${VAR:?}` is bash syntax; JS has no equivalent
      // expansion-time guard — the .mjs side is covered by killPackagedGuard.test.ts instead.
      const src = stripComments(fs.readFileSync(file, 'utf8'), true);
      const re = /pkill\s+(?:-\w+\s+)*-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const pattern = m[1] ?? m[2] ?? m[3] ?? '';
        if (!/^\$[A-Za-z_{]/.test(pattern)) continue; // not variable-led at all (covered by rule 1)
        if (/^\$\d/.test(pattern) || /^\$\{?[@*#]/.test(pattern)) continue; // positional/special param
        if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*:\?/.test(pattern)) {
          offenders.push(`${path.relative(scriptsDir, file)}: pkill -f ${JSON.stringify(pattern)}`);
        }
      }
    }
    expect(
      offenders,
      'a `pkill -f` pattern led by a bare $VAR/${VAR} looks scoped in source but is not — use '
        + '${VAR:?message} so an empty variable aborts loudly instead of silently reaping every clone',
    ).toEqual([]);
  });

  it('no reap pattern is built from a basename — that discards the clone identity', () => {
    // `basename(appDir)/Contents/MacOS` reads as scoped and is not: every clone's packaged
    // app has the same basename. The full appDir was already in hand (#69).
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      const src = stripComments(fs.readFileSync(file, 'utf8'), file.endsWith('.sh'));
      for (const line of src.split('\n')) {
        if (/basename/.test(line) && /pkill|pattern|taskkill/.test(line)) {
          offenders.push(`${path.relative(scriptsDir, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'build the reap pattern from the full path, not its basename').toEqual([]);
  });
});
