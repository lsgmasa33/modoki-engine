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
import { stripComments as stripJsComments, assertScanIsSane, readScannedSource, shellLogicalLines } from '@modoki/engine/testing';
import { calleeName, enclosingFunction, findNodes, flatText, lineOf, parseSource, readsOf, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const scriptsDir = path.resolve(__dirname, '../../scripts');

/** Every reap-relevant script under `engine/scripts`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 90 measured today. */
function scriptFiles(): string[] {
  return repoFiles({ under: scriptsDir, match: /\.(sh|mjs|js|ts)$/, floor: 60 }).map(({ abs }) => abs);
}

/** The units a reap rule reads, comments blanked so the many prose mentions of `pkill` in these files
 *  (they explain this very hazard) are not mistaken for code. Dual language:
 *  - shell: each COMMAND — a logical line, backslash continuations joined (#1179). The whole-line `#`
 *    filter this replaced kept a trailing `# pkill -f foo` note as code, and a `pkill -f \ ⏎ "$REPO/x"`
 *    wrapped before its pattern read the `\` as the pattern.
 *  - JS/TS: the whole file through the shared scanner (#419) — a pattern there is a string, not a line. */
function scanUnits(file: string): string[] {
  if (file.endsWith('.sh')) return shellLogicalLines(readScannedSource(file).code).map((l) => l.text);
  return [stripJsComments(fs.readFileSync(file, 'utf8'))];
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
    let patterns = 0;
    for (const file of scriptFiles()) {
      // pkill -f "<pattern>" | '<pattern>' | <bare-word>
      const re = /pkill\s+(?:-\w+\s+)*-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      for (const src of scanUnits(file)) for (let m = re.exec(src); m; m = re.exec(src)) {
        patterns++;
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
    // Non-vacuity floor (#1105): `scriptFiles()` floors FILES; this floors what the regex found.
    expect(patterns, 'no `pkill -f` patterns found in engine/scripts — the matcher is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(0);
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
    let namedVarLed = 0;
    for (const file of scriptFiles()) {
      if (!file.endsWith('.sh')) continue; // `${VAR:?}` is bash syntax; JS has no equivalent
      // expansion-time guard — the .mjs side is covered by killPackagedGuard.test.ts instead.
      const re = /pkill\s+(?:-\w+\s+)*-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      for (const src of scanUnits(file)) for (let m = re.exec(src); m; m = re.exec(src)) {
        const pattern = m[1] ?? m[2] ?? m[3] ?? '';
        if (!/^\$[A-Za-z_{]/.test(pattern)) continue; // not variable-led at all (covered by rule 1)
        if (/^\$\d/.test(pattern) || /^\$\{?[@*#]/.test(pattern)) continue; // positional/special param
        namedVarLed++;
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
    // Non-vacuity floor (#1105): counted after both skips, so a filter that drops every pattern
    // before the `${VAR:?}` check is caught too.
    expect(namedVarLed, 'no named-variable-led `pkill -f` patterns reached the check — a skip or the matcher is broken, or the last such reap (today only test-packaged.sh) was moved into the helper; fix the cause, do not delete this assertion')
      .toBeGreaterThan(0);
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
    let fragments = 0;
    for (const file of scriptFiles()) {
      if (!file.endsWith('.sh')) continue;
      // <leading named variable> <the rest of the pattern>
      const re = /pkill\s+(?:-\w+\s+)*-f\s+"\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::\?[^}]*)?\}?([^"]*)"/g;
      const byFragment = new Map<string, Set<string>>();
      for (const src of scanUnits(file)) for (let m = re.exec(src); m; m = re.exec(src)) {
        const [, varName, fragment] = m;
        if (!byFragment.has(fragment)) byFragment.set(fragment, new Set());
        byFragment.get(fragment)!.add(varName);
      }
      fragments += byFragment.size;
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
    // Non-vacuity floor (#1105): an empty grouping is also a clean pass.
    expect(fragments, 'no named-variable `pkill -f` fragments were grouped — the matcher is broken, or the last such reap (today only test-packaged.sh) was moved into the helper; fix the cause, do not delete this assertion')
      .toBeGreaterThan(0);
  });

  it('no reap pattern is built from a basename — that discards the clone identity', () => {
    // `basename(appDir)/Contents/MacOS` reads as scoped and is not: every clone's packaged
    // app has the same basename. The full appDir was already in hand (#69).
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      const rel = path.relative(scriptsDir, file);
      if (!file.endsWith('.sh')) {
        offenders.push(...jsReapsFromBasename(scanUnits(file)[0]!, rel));
        continue;
      }
      for (const line of scanUnits(file)) {
        if (buildsReapFromBasename(line)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'build the reap pattern from the full path, not its basename').toEqual([]);
  });

  it('the basename rule flags the shape it exists for, and not a full-path reap', () => {
    // A clean corpus has no instance, so the sweep above cannot tell a working predicate from one
    // that stopped matching (#1105). Pinned here against the shipped shape instead.
    const js = (src: string) => jsReapsFromBasename(src, 'fixture.mjs').length;
    expect(js('const pattern = `${path.basename(appDir)}/Contents/MacOS`;')).toBe(1);
    expect(buildsReapFromBasename('pkill -f "$(basename "$APP")/Contents/MacOS"')).toBe(true);
    expect(buildsReapFromBasename('pkill -f "${APP:?unset}/Contents/MacOS" || true')).toBe(false);
    expect(buildsReapFromBasename('BUILD="$TMPBASE/$(basename "$REPO")-smoke"')).toBe(false);
  });
});

describe('the shell reap readers take a COMMAND (#1179)', () => {
  it('a pkill wrapped before its pattern is read with its pattern, and a trailing comment is not code', () => {
    const dir = makeScratchDir('reap-units-');
    const f = path.join(dir, 'x.sh');
    fs.writeFileSync(f, 'pkill -f \\\n  "Modoki Editor"\necho ok # pkill -f "shared name"\n');
    const re = /pkill\s+(?:-\w+\s+)*-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    expect(scanUnits(f).flatMap((u) => [...u.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]))).toEqual(['Modoki Editor']);
  });
});

/** A line that builds a reap target (a `pkill`/`taskkill` or a `pattern`) out of a `basename`. */
function buildsReapFromBasename(line: string): boolean {
  return /basename/.test(line) && /pkill|pattern|taskkill/.test(line);
}

/** The JS half of the basename rule: every `basename(…)` call whose OWN expression builds a reap
 *  target — it flows, within its statement, into a name spelt `pattern`/`pkill`/`taskkill`, or sits in
 *  an expression naming `pkill`/`taskkill` in a string or a callee. A basename bound to a name first
 *  (`const base = basename(appDir)`) is followed to each read of that name.
 *
 *  ⚠️ **The call's own expression, not its line (#1179).** The line test wanted `basename` and
 *  `pkill|pattern|taskkill` on one line: `const pattern =\n  \`${path.basename(appDir)}/…\`` — a
 *  formatter's wrap — passed, a basename bound one statement earlier passed, and an unrelated
 *  `basename` sharing a line with a correct full-path `pattern` failed. */
function jsReapsFromBasename(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const REAP_NAME = /pattern|pkill|taskkill/i;
  const REAP_WORD = /\b(?:pkill|taskkill)\b/;
  /** The expression `n` is part of, up to (not across) its statement — climbing OUT of a function
   *  whose result it is (a concise body, or its `return`), since that function's value IS the
   *  expression: `const pattern = (d) => \`${basename(d)}/…\``, `[dir].map((d) => basename(d))[0]`,
   *  `{ get pattern() { return basename(d) } }` and `function pattern(d) { return basename(d) }` are
   *  the basename's own reap target (#1179 P3 review and re-review). */
  const ownExpression = (n: ts.Node): ts.Node => {
    let cur = n;
    for (let p = cur.parent; p; p = cur.parent) {
      const fn = ts.isReturnStatement(p) ? enclosingFunction(p) : p;
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && (fn.body === cur || fn !== p)) { cur = fn; continue; }
      // …and out of a method, getter or function declaration it is the `return` of: its NAME holds it.
      if (fn !== p && (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isFunctionDeclaration(fn))) { cur = fn; continue; }
      if (ts.isStatement(p) || ts.isVariableDeclarationList(p) || ts.isFunctionLike(p) || ts.isSourceFile(p)) break;
      cur = p;
    }
    return cur;
  };
  const buildsReap = (n: ts.Node): boolean => {
    const own = ownExpression(n);
    const holder = ts.isVariableDeclaration(own) || ts.isParameter(own) || ts.isPropertyDeclaration(own) || ts.isMethodDeclaration(own)
      || ts.isGetAccessorDeclaration(own) || ts.isFunctionDeclaration(own) ? own.name
      : ts.isBinaryExpression(own) ? own.left : undefined;
    if (holder && REAP_NAME.test(flatText(holder))) return true;
    return findNodes(own, (x): x is ts.Node => (ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x)
      || ts.isTemplateTail(x)) && REAP_WORD.test(x.text)
      || (ts.isCallExpression(x) && REAP_NAME.test(calleeName(x) ?? ''))
      || ((ts.isPropertyAssignment(x) || ts.isMethodDeclaration(x) || ts.isGetAccessorDeclaration(x)) && REAP_NAME.test(flatText(x.name)))).length > 0;
  };
  const out: string[] = [];
  // A SHELL `$(basename …)` spelt inside a JS string — `execSync(\`pkill -f "$(basename ${app})/…"\`)` — has
  // no call node; its own expression is read the same way. (The line test caught it by accident of text.)
  for (const text of findNodes(sf, (x): x is ts.Node => (ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x)
    || ts.isTemplateTail(x)) && /\bbasename\b/.test(x.text))) {
    if (buildsReap(text)) out.push(`${label}:${lineOf(text)}: ${flatText(ownExpression(text))}`);
  }
  for (const call of findNodes(sf, (x): x is ts.CallExpression => ts.isCallExpression(x) && calleeName(x) === 'basename')) {
    const own = ownExpression(call);
    const bound = ts.isVariableDeclaration(own) && ts.isIdentifier(own.name) && own.initializer
      && !REAP_NAME.test(own.name.text) ? own.name : undefined;
    const reaps = buildsReap(call) || (!!bound && readsOf(bound).some(buildsReap));
    if (reaps) out.push(`${label}:${lineOf(call)}: ${flatText(own)}`);
  }
  return out;
}

describe('the JS basename rule reads the call\'s own expression (#1179)', () => {
  const js = (src: string) => jsReapsFromBasename(stripJsComments(src), 'fixture.mjs').length;

  it.each([
    ['wrapped by a formatter', 'const pattern =\n  `${path.basename(appDir)}/Contents/MacOS`;'],
    ['bound to a name one statement earlier', 'const base = path.basename(appDir);\nconst pattern = `${base}/Contents/MacOS`;'],
    ['handed straight to pkill', "execFileSync('pkill', ['-f', `${basename(appDir)}/Contents/MacOS`]);"],
    ['assigned to an existing pattern', 'let pattern;\npattern = basename(appDir) + "/Contents/MacOS";'],
    ['a reap options object', 'reap({ pattern: basename(appDir) });'],
    ['handed to a reap helper named for the pattern', 'killByPattern(`${basename(appDir)}/Contents/MacOS`);'],
    ['returned by an arrow bound to a pattern name', 'const pattern = (dir) => `${path.basename(dir)}/Contents/MacOS`;'],
    ['returned from a block-bodied function held under a pattern key', 'const reap = { pattern: function () { return basename(appDir) + "/Contents/MacOS"; } };'],
    ['inside a .map() callback whose result is the pattern', 'const pattern = [appDir].map((d) => `${basename(d)}/Contents/MacOS`)[0];'],
    ['returned by a method shorthand named pattern', 'const reap = { pattern() { return basename(appDir) + "/Contents/MacOS"; } };'],
    ['returned by a getter named pattern', 'const reap = { get pattern() { return `${basename(appDir)}/Contents/MacOS`; } };'],
    ['in a class field arrow named pattern', 'class R { pattern = () => `${basename(appDir)}/Contents/MacOS`; }'],
    ['in a plain class field named pattern', 'class R { pattern = basename(appDir) + "/Contents/MacOS"; }'],
    ['as the default of a parameter named pattern', 'function kill(pattern = `${basename(appDir)}/Contents/MacOS`) { run(pattern); }'],
    ['returned by a function declaration named pattern', 'function pattern(dir) { return `${basename(dir)}/Contents/MacOS`; }'],
    ['spelt as SHELL inside a JS string handed to pkill', 'execSync(`pkill -f "$(basename ${APP})/Contents/MacOS"`);'],
  ])('flags a basename %s', (_why, src) => {
    expect(js(src)).toBe(1);
  });

  it.each([
    ['a full-path pattern', 'const pattern = `${appDir}/Contents/MacOS`;'],
    ['a basename SHARING A LINE with a full-path pattern', 'const pattern = `${appDir}/Contents/MacOS`; const label = path.basename(appDir);'],
    ['a basename for a build dir', 'const BUILD = `${TMPBASE}/${basename(REPO)}-smoke`;'],
    ['a basename returned by a helper not named for a reap', 'function label(d) { return basename(d); }\nconst pattern = `${appDir}/Contents/MacOS`;'],
    ['a basename in a class field not named for a reap', 'class R { label = basename(appDir); pattern = `${appDir}/Contents/MacOS`; }'],
    ['a shell basename in a string that builds no reap', 'execSync(`cp "$(basename ${F})" out/`);'],
    ['a basename in a comment beside a pkill', "// basename(appDir) was wrong\nexecFileSync('pkill', ['-f', `${appDir}/Contents`]);"],
  ])('does not flag %s', (_why, src) => {
    expect(js(src)).toBe(0);
  });
});
