/**
 * #1537 — no engine code hands a command LINE to a shell. Program + argv only.
 *
 * The defect class: a path, project name or config string interpolated into a command line that
 * cmd.exe or bash then parses. cmd expands `%VAR%` even inside double quotes and runs an unquoted
 * `&` as a second command (observed on the win clone: `C:\proj\%OS%\a.glb` arrived as
 * `C:\proj\Windows_NT\a.glb`); bash evaluates `$(…)` inside double quotes (#649). Quoting cannot
 * close it — cmd has no escape for `%` inside quotes — so the rule is structural:
 *
 *   - no `shell:` option other than the literal `false` — spawn through `toSpawn`
 *     (engine/scripts/winSpawn.mjs), which runs a `.cmd`/`.bat` via an escaped cmd.exe line;
 *   - no `exec`/`execSync` of anything but a CONSTANT string — those always run a shell.
 *
 * Build steps are covered one level up: a `shell` step's text can only be built by `sh`, whose
 * slots reject a raw string at the type level (buildStepShell.ts).
 *
 *   - no `-c`/`-lc`/`/c` in an argv array followed by a non-constant command line.
 *
 * ⚠️ What this does NOT see: a helper that wraps `spawn(…, { shell: true })` in ANOTHER package
 * (it reads engine sources only); an options object built by spreading a variable whose `shell` key
 * is set elsewhere (it would still need to write `shell:` somewhere this reads); a `-c` argv
 * assembled by `push`/spread rather than written as one array literal; combined flag spellings
 * (`-lic`, `-ec`) or a flag held in a variable; and PowerShell `-Command <script>` (three live sites
 * single-quote-escape their data: toolchain/index.ts, packagedAppPaths.mjs, livePackagedEditor.mjs).
 * The ledger is keyed per FILE with a count, so swapping one reviewed hand-off in buildStepShell.ts
 * for a new data-built one keeps the count and stays green — review that file's diffs by eye.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { calleeName, findNodes, importBindings, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** The directories whose code spawns processes: the build pipeline, the toolchain, the scripts, the
 *  Electron main process and the MCP servers. */
const SCANNED = ['engine/plugins', 'engine/toolchain', 'engine/scripts', 'engine/electron', 'engine/tools'];

/** Reviewed exceptions, SPENT per occurrence (assertExemptionLedger) — each a claim a reader can
 *  check that nothing variable reaches the shell text. */
const EXEMPT: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'engine/scripts/verify.mjs',
    reason: "runCommand runs verify's OWN command table (`npm run typecheck`, …) — constant text, no path or config value in it",
  },
  {
    item: 'engine/plugins/buildStepShell.ts', count: 2,
    reason: "planBuildStep's `shell` branch — bash -c / cmd /c of a ShellScript, whose text only `sh` (refs in env) or " +
      'the author-owned `authoredShell` can build. The ONE place a build step reaches a shell, by design.',
  },
  {
    item: 'engine/scripts/winSpawn.mjs',
    reason: "toSpawn's own cmd.exe line for a .cmd/.bat — every arg MSVCRT-quoted and caret-escaped (winBatchCommandLine). " +
      'It IS the escaper this guard sends everyone else to.',
  },
];

const SHELL_ALWAYS = new Set(['exec', 'execSync']);
/** The flag a shell reads its whole command line from: `bash -c`, `sh -lc`, `cmd /c`. */
const SHELL_FLAG = new Set(['-c', '-lc', '/c', '/C']);

/** Every shell hand-off in `code`, as `line: what`. Pure, so the probes below drive the same reader. */
export function shellHandOffs(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const out: string[] = [];
  for (const p of findNodes(sf, (n): n is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
    (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && !!n.name && ts.isIdentifier(n.name) && n.name.text === 'shell')) {
    const value = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    if (value && value.kind === ts.SyntaxKind.FalseKeyword) continue;
    out.push(`${lineOf(p)}: shell: ${value ? value.getText(sf) : '(shorthand)'}`);
  }
  // Only child_process's own `exec`/`execSync`, by the binding this file imports them under. The
  // first run matched by NAME and hit 48 sites, every one a false positive: 43 `RegExp.prototype.exec`
  // and an injected argv function in asset-fs-ops.ts that merely shares the name.
  const cp = importBindings(sf, /^(node:)?child_process$/).filter((b) => !b.typeOnly);
  const direct = new Set(cp.filter((b) => SHELL_ALWAYS.has(b.imported)).map((b) => b.local));
  const namespaces = new Set(cp.filter((b) => b.imported === '*' || b.imported === 'default').map((b) => b.local));
  for (const call of findNodes(sf, ts.isCallExpression)) {
    const e = call.expression;
    const isShellCall = (ts.isIdentifier(e) && direct.has(e.text))
      || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && namespaces.has(e.expression.text) && SHELL_ALWAYS.has(e.name.text));
    if (!isShellCall) continue;
    const name = calleeName(call);
    const cmd = call.arguments[0];
    if (cmd && (ts.isStringLiteral(cmd) || ts.isNoSubstitutionTemplateLiteral(cmd))) continue;
    out.push(`${lineOf(call)}: ${name}(${cmd ? cmd.getText(sf).slice(0, 60) : ''})`);
  }
  // The same hand-off spelled as an explicit argv: `spawn('bash', ['-c', \`cp ${p} x\`])` — no `shell:`
  // key, no exec, and exactly as live (found by the #1537 review). A CONSTANT command after the flag
  // is fine; anything else is a command line built from data.
  for (const arr of findNodes(sf, ts.isArrayLiteralExpression)) {
    arr.elements.forEach((el, i) => {
      if (!(ts.isStringLiteral(el) && SHELL_FLAG.has(el.text))) return;
      const next = arr.elements[i + 1];
      if (!next || ts.isStringLiteral(next) || ts.isNoSubstitutionTemplateLiteral(next)) return;
      out.push(`${lineOf(el)}: ${el.text} ${next.getText(sf).slice(0, 60)}`);
    });
  }
  return out;
}

const SOURCE = /\.(ts|tsx|mjs|cjs|js)$/;
const scanned = () => repoFiles({ under: SCANNED.map((d) => path.join(REPO, d)), match: SOURCE, floor: 150 })
  .filter(({ rel }) => !/(^|\/)(node_modules|dist|dist-electron)\//.test(rel) && !rel.endsWith('.d.ts') && !rel.endsWith('.d.mts'));

describe('no engine code hands a command line to a shell (#1537)', () => {
  it('every spawn is program + argv: no `shell:` but `false`, no exec/execSync of a non-constant string', () => {
    const files = scanned();
    const population = files.flatMap(({ abs, rel }) => {
      const posix = rel.split(path.sep).join('/');
      return shellHandOffs(readScannedSource(abs).code, posix).map((hit) => ({ item: posix, site: `${posix}:${hit}` }));
    });
    // Spent per occurrence and staleness-checked: a row blessing more hand-offs than exist fails too.
    assertExemptionLedger({
      label: 'EXEMPT in noShellSpawn', population, exempt: EXEMPT, floor: 150, scanned: files.length,
      fix: 'Spawn through toSpawn (engine/scripts/winSpawn.mjs) with an argv — never a shell. A build step ' +
        'is an execStep; a genuinely compound one is a `shell` step built with `sh` + ref(). ' +
        'docs/windows.md § "Never hand a shell a command line"',
    });
  });

  it('flags every hand-off shape, and passes the no-shell forms (accept AND reject side)', () => {
    const probe = [
      "import { exec, execSync, spawn, spawnSync } from 'node:child_process'; import * as cp from 'child_process';",
      "spawn(cmd, { cwd, shell: true });",                 // 2 flagged
      "spawnSync('npx', args, { shell: isWindows });",      // 3 flagged — the old bootstrap shape
      "const shell = x; spawn(a, b, { shell });",           // 4 flagged — shorthand
      "execSync(`gcloud storage cat ${p}`);",               // 5 flagged — the old ota-publish shape
      'exec(cmdLine, cb);',                                 // 6 flagged — a variable command line
      "cp.execSync(`codesign -dvv \"${p}\" 2>&1`);",        // 7 flagged — through the namespace
      "spawn(s.command, s.args, { ...s.options, cwd });",   // not flagged — toSpawn's shape
      "spawn(cmd, args, { shell: false });",                // not flagged
      "execSync('git rev-parse HEAD');",                    // not flagged — constant
      "execSync(`git status --porcelain`);",                // not flagged — constant template
      "const target = { kind: 'shell' }; f({ bundleName: shell });", // not flagged — a VALUE named shell
      're.exec(line); /x/.exec(s);',                        // not flagged — RegExp.prototype.exec
      "spawn('bash', ['-c', `cp ${p} x`]);",              // 14 flagged — an explicit shell argv
      "execFile('cmd', ['/c', line]);",                      // 15 flagged
      "spawn('bash', ['-lc', 'command -v gcloud']);",        // not flagged — constant after the flag
      "spawn('ls', ['-c', '-l']);",                          // not flagged — a constant that merely looks like one
    ].join('\n');
    expect(shellHandOffs(probe, 'probe.ts').map((h) => Number(h.split(':')[0]))).toEqual([2, 3, 4, 5, 6, 7, 14, 15]);
    // A function that is merely NAMED exec — asset-fs-ops.ts injects one taking argv — is not the shell one.
    expect(shellHandOffs('function f(exec) { exec(command, args, input); }', 'p.ts')).toEqual([]);
  });
});
