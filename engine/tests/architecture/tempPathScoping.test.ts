/** Guard: shared-machine temp paths are scoped per clone.
 *
 *  The sibling of `reapScoping.test.ts`, for state rather than processes. Several clones of
 *  this repo run side by side on one machine (CLAUDE.md § Clones) and they all resolve the
 *  SAME `os.tmpdir()`. So a fixed temp name is shared by every clone — and the failure is
 *  quiet: the file is written, the script succeeds, and you read a sibling's output while
 *  diagnosing your own run.
 *
 *  Two concrete cases this locks down, both found on 2026-08-13:
 *
 *  1. `launch-editor.sh` COMPUTED a per-clone `VITE_LOG=/tmp/modoki-vite-<port>.log` and then
 *     never exported it. `MODOKI_VITE_LOG` therefore stayed unset, `devServer.ts` fell back to
 *     a bare `modoki-vite.log`, and every clone's Vite appended into that one file — while
 *     `dev server exited unexpectedly … see <path>` pointed all of them at it. A dead variable
 *     is invisible to review precisely because the code around it looks right; hence a test.
 *
 *  2. `resave-scenes.sh` / `resave-prefabs.sh` / `smoke-packaged.sh` wrote bare shared names.
 *     `smoke-packaged.sh` also `rm -rf`s its build dir, so two clones running
 *     `verify:packaged` at once deleted each other's app mid-build.
 *
 *  NOT covered, deliberately: `mkdtempSync`, and a `mktemp` TEMPLATE it fills (unique by construction —
 *  see `literalTmpPaths`; their LIFETIME is a different guard, `scratchDirOwnership.test.ts`, #1117), and
 *  `~/.modoki/**` (machine-wide ON PURPOSE — device claims and the launch log exist to answer
 *  cross-clone questions, and per-cloning them would defeat them).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource, shellLogicalLines } from '@modoki/engine/testing';
import { callsToPath, findNodes, lineOf, parseSource, referencesToPath, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const scriptsDir = path.resolve(__dirname, '../../scripts');
const devServerPath = path.resolve(__dirname, '../../electron/devServer.ts');

/** Every shell script under `engine/scripts`, recursive — `scripts/lib/` holds shared shell
 *  too, and a guard that only reads the top level vouches for less than it appears to. Via the
 *  shared corpus producer (#799/#771/#805 Phase 4). Floored well under the 13 measured today. */
function shellScripts(dir = scriptsDir): string[] {
  return repoFiles({ under: dir, match: /\.sh$/, floor: 8 }).map(({ abs }) => abs);
}

/** The basename a script builds under the NATIVE temp dir: `$(node "$PATHS" tmpdir)/<name>`
 *  or `$TMPBASE/<name>`. These carry no literal `/tmp`, so the rule below cannot see them —
 *  and they are where the expensive collisions live (a build dir that gets `rm -rf`'d). */
function tempDirBasenames(src: string): string[] {
  const out: string[] = [];
  for (const { line } of codeLines(src)) {
    // `$(…)` and `${…}` spans are part of the name and may contain spaces/parens —
    // `$(basename "$REPO")` is the canonical one here — so consume them whole rather than
    // stopping at the first space.
    const re = /(?:tmpdir\)|\$TMPBASE|\$\{TMPBASE\})\/((?:\$\([^)]*\)|\$\{[^}]*\}|[^\s"'`;|)>}])*)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1]);
  }
  return out;
}

/**
 * The COMMANDS of ALREADY-STRIPPED shell source, each with the line it starts on. These scripts discuss
 * `/tmp` paths in prose constantly (they document this very hazard), and a doc mention is not a write.
 *
 * The private version before #812 dropped only WHOLE-LINE `#` comments, so a trailing
 * `cmd  # writes to /tmp/x` was still read as a write; callers hand in `readScannedSource(file).code`,
 * which blanks both. Since #1179 a backslash-continued command is ONE entry: per physical line,
 * `export MODOKI_VITE_LOG=\ ⏎ "/tmp/x.log"` put the variable and the path on different lines and the
 * native-path rule below read neither.
 */
function codeLines(code: string): { line: string; n: number }[] {
  return shellLogicalLines(code).map(({ text, line }) => ({ line: text, n: line }));
}

/**
 * Every literal `/tmp/<tail>` in stripped shell, and whether it is excused as a `mktemp` TEMPLATE: the
 * tail ENDS in the `XXX` run `mktemp` replaces with a unique suffix, and the path is `mktemp`'s own
 * ARGUMENT — directly after `mktemp`/`mkdtemp` and its flags. Before #1179 any line MENTIONING mktemp
 * skipped every `/tmp` path on it — `X="$(mktemp)"; cp log /tmp/shared.log` passed — and a template with
 * no `XXX` is not unique at all. (The P7 review: "after a mktemp in the same command" still excused
 * `cp "$(mktemp)" /tmp/c.XXXXXX` and a redirect target `mktemp /tmp/a.XXXXXX > /tmp/b.XXXXXX`.)
 */
function literalTmpPaths(code: string): Array<{ n: number; tail: string; excused: boolean }> {
  return codeLines(code).flatMap(({ line, n }) => [...line.matchAll(/\/tmp\/([^\s"'`;|)>]*)/g)].map((m) => ({
    n,
    tail: m[1]!,
    // The X run must END the name: BSD mktemp fills only a trailing run, so `x.XXXXXX.log` is a literal,
    // shared file (measured, #1179 P7 re-review), and `XXXXXX/shared.log` is a fixed name under a dir.
    excused: /X{3,}$/.test(m[1]!) && /\bmk(d?)temp(?:\s+-[A-Za-z]+)*\s+["']?$/.test(line.slice(0, m.index)),
  })));
}

describe('temp paths in engine/scripts are clone-scoped', () => {
  it('every literal /tmp path carries a per-clone discriminator', () => {
    const offenders: string[] = [];
    let tails = 0;
    for (const file of shellScripts()) {
      // `mktemp` mints a unique name itself — a template it fills is not a shared name (see literalTmpPaths).
      for (const { n, tail, excused } of literalTmpPaths(readScannedSource(file).code)) {
        tails++;
        // A `$` anywhere in the tail means the name is keyed on something (the backend port,
        // the pid, the clone basename). That is the whole requirement — WHICH discriminator
        // is a judgement call per script, and each one documents its own.
        if (!excused && !tail.includes('$')) offenders.push(`${path.basename(file)}:${n}: /tmp/${tail}`);
      }
    }
    expect(
      offenders,
      'a fixed /tmp name is shared by every clone on this machine — key it on the backend port, '
        + 'the pid, or $(basename "$REPO"), or mint it with mktemp',
    ).toEqual([]);
    // Non-vacuity floor (#1105): `shellScripts()` floors FILES; this floors the `/tmp/` paths found.
    expect(tails, 'no literal /tmp paths found in engine/scripts — the matcher is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(0);
  });

  it('every native-temp-dir path carries a per-clone discriminator too', () => {
    // The rule above only sees a LITERAL `/tmp`. The packaged loops build under
    // `$(node "$PATHS" tmpdir)/…` instead — which is where the damage is, since those dirs get
    // `rm -rf`'d and rebuilt. Both `smoke-packaged.sh` and `repro-cold-boot.sh` shipped a bare
    // shared name here while their PORTS and profiles were already per clone.
    const offenders: string[] = [];
    let names = 0;
    for (const file of shellScripts()) {
      for (const name of tempDirBasenames(readScannedSource(file).code)) {
        names++;
        if (!name.includes('$')) offenders.push(`${path.basename(file)}: ${name}`);
      }
    }
    expect(
      offenders,
      'a fixed name under the machine-wide temp dir is shared by every clone — add $(basename "$REPO")',
    ).toEqual([]);
    // Non-vacuity floor (#1105): the two scripts named above build under the native temp dir, so a
    // `tempDirBasenames` that stopped matching must not read as "every name is scoped".
    expect(names, 'no native-temp-dir paths found in engine/scripts — tempDirBasenames() is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(0);
  });

  it('repro-cold-boot.sh reuses the SMOKE build dir, byte for byte', () => {
    // An invisible coupling, and the reason it needs a test: repro-cold-boot's whole job is to
    // relaunch the app the smoke gate just built. When the two names drift, nothing fails —
    // the script finds a DIFFERENT, older app (or none) and reports on it. Its own header says
    // a naive default once did exactly that and "reported it green". Renaming one side while
    // per-cloning it is precisely how that recurs, so pin them to each other.
    const smoke = readScannedSource(path.join(scriptsDir, 'smoke-packaged.sh')).code;
    const repro = readScannedSource(path.join(scriptsDir, 'repro-cold-boot.sh')).code;
    const outOf = (src: string) => codeLines(src).map((l) => l.line.trim()).find((l) => l.startsWith('OUT=')) ?? '';
    // Compare the BASENAME expression, normalised for the two spellings of "this clone"
    // ($CLONE vs an inline $(basename "$REPO")) — the paths must resolve to one directory.
    const norm = (s: string) =>
      (tempDirBasenames(s)[0] ?? '').replace(/\$\{?CLONE\}?/g, 'CLONE').replace(/\$\(basename\s+"\$REPO"\)/g, 'CLONE');
    expect(norm(outOf(repro)), `repro-cold-boot OUT (${outOf(repro)}) must resolve to smoke-packaged OUT (${outOf(smoke)})`)
      .toBe(norm(outOf(smoke)));
  });

  it('launch-editor.sh EXPORTS the per-clone Vite log, not just computes it', () => {
    const src = readScannedSource(path.join(scriptsDir, 'launch-editor.sh')).code;
    const code = codeLines(src).map((l) => l.line).join('\n');
    // The regression was a computed-but-unexported variable, so asserting the assignment
    // exists proves nothing — the export is the whole point.
    expect(code, 'launch-editor.sh must export MODOKI_VITE_LOG; devServer.ts only reads it from the env')
      .toMatch(/export\s+MODOKI_VITE_LOG=/);
    // And it must be a NATIVE path: MSYS rewrites POSIX-looking arguments to a native program
    // but never env vars, and this one crosses into the Electron process as an env var. A
    // literal "/tmp/..." here is meaningless to that process on Windows. Check EVERY line that
    // mentions the variable, in every script that sets it — checking only the first match lets
    // a later, wronger assignment through, which is the same "looked right where I looked"
    // failure that produced the dead variable in the first place.
    const setters = ['launch-editor.sh', 'test-packaged.sh'];
    const offenders: string[] = [];
    for (const name of setters) {
      const s = readScannedSource(path.join(scriptsDir, name)).code;
      for (const { line, n } of codeLines(s)) {
        if (line.includes('MODOKI_VITE_LOG') && /\/tmp\//.test(line)) offenders.push(`${name}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders, 'MODOKI_VITE_LOG must be a native path (packagedAppPaths.mjs tmpdir), never a literal /tmp')
      .toEqual([]);
  });

  it('devServer.ts falls back to a per-editor Vite log name', () => {
    const fallbacks = viteLogFallbacks(readScannedSource(devServerPath).code, 'devServer.ts');
    expect(fallbacks.length, 'devServer.ts should read MODOKI_VITE_LOG with an os.tmpdir() fallback').toBeGreaterThanOrEqual(1);
    expect(
      fallbacks.filter((f) => !f.underTmpdir || f.untagged).map((f) => `devServer.ts:${f.line}`),
      "every fallback must build under os.tmpdir() and be tagged (a template literal keyed on the backend "
        + "port/pid) — a bare 'modoki-vite.log' is written by every clone's editor at once",
    ).toEqual([]);
  });

  it('the fallback detector judges the fallback EXPRESSION, not the line it starts on (#1179)', () => {
    const src = [
      'const a = process.env.MODOKI_VITE_LOG || path.join(',
      '  os.tmpdir(),',
      "  'modoki-vite.log',",
      ');',
      'const b = process.env.MODOKI_VITE_LOG ?? path.join(os.tmpdir(), `modoki-vite-${tag}.log`);',
      "const c = process.env.MODOKI_VITE_LOG || '/tmp/modoki-vite.log'; const d = os.tmpdir();",
    ].join('\n');
    expect(viteLogFallbacks(src, 'd.ts')).toEqual([
      { line: 1, underTmpdir: true, untagged: true },
      { line: 5, underTmpdir: true, untagged: false },
      { line: 6, underTmpdir: false, untagged: true },
    ]);
  });
});

/** Every `…MODOKI_VITE_LOG || <fallback>` / `?? <fallback>` in one file, from the parse (#1179): does
 *  the FALLBACK expression itself call `tmpdir()`, and does it carry the bare shared name anywhere
 *  inside it. The line-based check it replaces took the first line naming both tokens, so a wrapped
 *  `path.join(os.tmpdir(),\n 'modoki-vite.log')` put the banned literal on a line nobody read, and a
 *  `tmpdir()` elsewhere on the line vouched for a fallback that had none. */
function viteLogFallbacks(code: string, label: string): Array<{ line: number; underTmpdir: boolean; untagged: boolean }> {
  const sf = parseSource(code, label);
  return findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n)
    && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    && referencesToPath(n.left, 'env.MODOKI_VITE_LOG').length > 0)
    .map((b) => ({
      line: lineOf(b),
      underTmpdir: callsToPath(b.right, 'tmpdir').length > 0,
      untagged: findNodes(b.right, (n): n is ts.StringLiteralLike => ts.isStringLiteralLike(n)).some((s) => /(^|\/)modoki-vite\.log$/.test(s.text)),
    }));
}

describe('the shell temp-path readers take a COMMAND, not a line (#1179)', () => {
  it('a mktemp template is excused only as the argument of that mktemp — not a neighbour on its line', () => {
    const code = [
      'A="$(mktemp /tmp/modoki-a.XXXXXX)"',
      'B="$(mktemp)"; cp log /tmp/shared.log',
      'mktemp /tmp/no-template',
      'C=$(mktemp -d /tmp/x.XXXXXX) && D=/tmp/also-shared',
      'E="$(mktemp)"; cp log /tmp/cache.XXXXXX',
      'cp /tmp/before.XXXXXX b; F=$(mktemp)',
      'cp "$(mktemp)" /tmp/c.XXXXXX',
      'mktemp "/tmp/q.XXXXXX" > /tmp/redirect.XXXXXX',
      'LOG="$(mktemp /tmp/modoki-smoke.XXXXXX.log)"',
    ].join('\n');
    expect(literalTmpPaths(code).map((p) => `${p.n}:${p.tail}:${p.excused ? 'ok' : 'SHARED'}`))
      .toEqual(['1:modoki-a.XXXXXX:ok', '2:shared.log:SHARED', '3:no-template:SHARED', '4:x.XXXXXX:ok', '4:also-shared:SHARED',
        '5:cache.XXXXXX:SHARED', '6:before.XXXXXX:SHARED', '7:c.XXXXXX:SHARED', '8:q.XXXXXX:ok', '8:redirect.XXXXXX:SHARED', '9:modoki-smoke.XXXXXX.log:SHARED']);
  });

  it('a backslash-wrapped command is one entry, cited at the line it starts on', () => {
    expect(codeLines('export MODOKI_VITE_LOG=\\\n  "/tmp/x.log"\nnext').map((l) => `${l.n}: ${l.line.trim()}`))
      .toEqual(['1: export MODOKI_VITE_LOG=  "/tmp/x.log"', '3: next']);
    expect(tempDirBasenames('BUILD="$TMPBASE/\\\nmodoki-build"')).toEqual(['modoki-build']);
  });
});

