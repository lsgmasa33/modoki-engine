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
 *  ⚠️ **A KNOWN GAP recorded here is now CLOSED — do not reinstate it.** This header used to
 *  accept that the Windows branch of `killPackaged` was `taskkill /F /IM <productName>.exe`,
 *  clone-agnostic by construction. That branch is now PowerShell + `Win32_Process` filtered on
 *  `ExecutablePath`, scoped to the app dir as a directory prefix, and `packagedAppPaths.test.ts`
 *  asserts `taskkill /IM` never comes back. The note is kept in this form rather than deleted
 *  because a stale "accepted gap" reads as licence, and someone re-reading it would conclude the
 *  Windows reap is still unscoped.
 *
 *  What this guard STILL does not cover on either platform is the SECOND SPELLING (#913/#959) —
 *  a pattern can be perfectly absolute and still miss, because the clone was reached by a
 *  symlink and the process's argv carries the other spelling. Rule 4 below covers the bash side;
 *  `killPackagedGuard.test.ts` covers the JS side by driving a manufactured symlink. */
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
    // the `pkill -f "$1"` inside `lib/repo-reap.sh`'s workers, which this guard cannot resolve
    // because the value arrives from a caller.
    //
    // ⚠️ **The original justification for this exemption is NO LONGER TRUE, and the exemption is
    // kept anyway — read why before trusting it** (#913). It used to say "every call site passes
    // it an absolute path literal", which made the parameter as safe as an inline string. Since
    // #913 that is false: `reap_repo_process`/`_alive`/`_force` also pass `$alt`, COMPUTED by
    // `reap_alt_pattern` from two shell globals an external `reap_repo_register_roots` sets.
    //
    // What keeps that computed value absolute and non-empty is now four preconditions inside
    // `reap_alt_pattern` — both roots set, roots differing, the physical root absolute, and the
    // pattern genuinely under the logical root — and they live in a DIFFERENT FILE from this
    // comment. Delete the empty/absolute pair and the helper emits
    // `/engine/electron/dist/main.cjs`, which `pkill -f` matches against EVERY clone's editor on
    // this machine — and rule 3 here would still be green, because the pattern is still `"$1"`.
    //
    // So this guard no longer covers that path at all. `repoReapSpellings.test.ts` does, by
    // driving the helper and asserting each precondition yields NOTHING rather than something
    // broader. If that file is ever deleted or weakened, this exemption is uncovered — the two
    // are load-bearing together, which is the sort of coupling that goes stale silently.
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

  it('a `pkill -f` fragment reaped under a clone root is reaped under BOTH spellings (#959)', () => {
    // Rules 1-3 make a pattern ABSOLUTE and non-empty. None of them makes it HIT. A clone (or a
    // temp dir — on macOS `/var` is itself a symlink to `/private/var`) reached through a symlink
    // puts the LOGICAL spelling in `pwd` while a process launched another way carries the
    // PHYSICAL one in its argv, so a reap holding one spelling matches nothing and the `|| true`
    // swallows it. `dev:stop` shipped exactly that for months (#908), and `test-packaged.sh` kept
    // it after #913 fixed the shared helper (#959).
    //
    // The check: group every named-variable `pkill -f` pattern in a file by the fragment that
    // follows the variable. Each fragment must be reaped under at least TWO distinct root
    // variables — `${REPO:?…}/x` alongside `${REPO_PHYS:?…}/x`. Two sequential invocations,
    // never an ERE alternation: `pkill -f "$A|$B"` with either side empty matches every process
    // on this machine (#69), so the shape has to be incapable of it.
    //
    // ⚠️ **This deliberately does NOT accept a computed alternate** (`ALT="$(reap_alt_pattern …)"`,
    // then `pkill -f "$ALT"`). That is the obvious move and rule 3 above rejects it — a
    // variable-led pattern must use `${VAR:?}`, while `${ALT:?}` is WRONG here because an empty
    // alternate is the NORMAL case (no symlink in the path) and would abort the script on every
    // ordinary run. The two spellings are spelled out. The cost is a little duplication against
    // `lib/repo-reap.sh`; the alternative is a pattern this guard cannot see.
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      if (!file.endsWith('.sh')) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'), true);
      // <leading named variable> <the rest of the pattern>
      const re = /pkill\s+(?:-\w+\s+)*-f\s+"\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::\?[^}]*)?\}?([^"]*)"/g;
      const byFragment = new Map<string, Set<string>>();
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const [, varName, fragment] = m;
        if (!byFragment.has(fragment)) byFragment.set(fragment, new Set());
        byFragment.get(fragment)!.add(varName);
      }
      for (const [fragment, vars] of byFragment) {
        if (vars.size < 2) {
          offenders.push(
            `${path.relative(scriptsDir, file)}: "${fragment}" is reaped only under `
              + `\${${[...vars][0]}} — no second spelling`,
          );
        }
      }
    }
    expect(
      offenders,
      'a reap holding ONE spelling of the clone root silently matches nothing when the clone is '
        + 'reached through a symlink (#913/#959) — derive the physical root too (`pwd -P`) and '
        + 'reap the same fragment under both, as two separate pkill calls (never "$A|$B", #69)',
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
