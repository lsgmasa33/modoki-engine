/** Guard: every harness that launches the PACKAGED editor isolates its Chromium profile.
 *
 *  `resolveUserDataDir` (engine/electron/userDataDir.ts) scopes the profile by clone ONLY
 *  on the dev branch; packaged deliberately returns the single `<appData>/Modoki Editor`,
 *  on the sound premise that a shipped app is installed once. Our HARNESSES break that
 *  premise — four clones share this machine (CLAUDE.md § Clones) and each builds and runs
 *  its OWN packaged app, so they all landed in one profile.
 *
 *  What that costs: `modoki-last-scene:<project name>` is keyed by the project NAME while
 *  its value is a clone-ABSOLUTE path, and `games/3d-test` is "Tropical Island" in every
 *  clone. Measured 2026-08-02 — `smoke:packaged` on the hub restored modoki-ai2's
 *  remembered scene, `/@fs` (scoped to the serving clone's root) correctly 403'd it, and
 *  the gate reported FAILED. The boot was fine (loadFirstScene self-heals to
 *  config.scenePath, 136 entities); the console error was RECOVERY RESIDUE, and both these
 *  scripts treat any console error as fatal. So the gate failed for a reason unrelated to
 *  the commit under test — the mirror image of #89, where it PASSED while provisioning was
 *  wholly broken. Either way the gate did not control what it measured.
 *
 *  Why a test rather than a comment: `assert-app-csp.mjs` got this right from the start
 *  and `shouldOverrideUserData()` exists specifically to let a harness do it — yet the two
 *  sibling scripts beside it both launched with the shared profile anyway. That is the same
 *  shape as reapScoping.test.ts (#69): an unenforced convention held for the file that was
 *  audited and not for the one next to it. `assert-app-renders.sh` is the RELEASE gate for
 *  the signed artifact, so the one left unfixed was the higher-stakes one.
 *
 *  ⚠️ **Since #1036 the packaged profile is no longer ONE directory** — `resolveUserDataDir` keys it
 *  per INSTALL (`<appData>/Modoki Editor/<install-id>`), and every clone builds its own install, so
 *  two clones no longer land in one profile. The rule still holds for a GATE: each run of a gate must
 *  measure a boot, not the residue its own previous run left in that install's profile, which is the
 *  failure measured above one layer down.
 *
 *  The rule: a script that launches a packaged Electron binary must pass --user-data-dir ON THAT
 *  LAUNCH. Scoped to launches, so a script that merely resolves or reaps a path is not implicated. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { insideShellSubstitution, readScannedSource, shellLogicalLines } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { callsTo, findNodes, flatText, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';

const scriptsDir = path.resolve(__dirname, '../../scripts');

/** Scripts that launch the packaged app WITH their own profile. Declared, and pinned both ways to the
 *  set `packagedLaunches` DERIVES (a script with at least one isolated launch) — so a listed launcher the
 *  detector stops recognising fails, and so does a new isolated launcher nobody listed. A launch WITHOUT
 *  the flag is the ledger's business, in any script, listed or not. */
const LAUNCHERS = [
  'smoke-packaged.sh',
  'assert-app-renders.sh',
  'assert-app-csp.mjs',
  // #21's cold-boot loop. Isolation is not incidental here — it is the MECHANISM: a fresh
  // profile is what makes the boot cold (vite-cache lives under userData), so this script
  // could not do its job with the shared one even if the rule allowed it.
  'repro-cold-boot.sh',
] as const;

/** Every command that reads as a launch WITHOUT its own profile, keyed `script::command`, each with the
 *  reason — counted, so a row whose command gains the flag or goes away fails as stale. A launch the
 *  detector cannot rule out is a launch (see `packagedLaunches`), so a command that only LOOKS like one
 *  is excused here, with its proof, rather than by a syntax the detector skips (#1179). */
const NOT_ISOLATED: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'test-packaged.sh::exec "$BIN"', reason: 'the INTERACTIVE packaged loop (`npm run test:packaged`), not a gate — it measures '
    + 'nothing across runs, and since #1036 the profile it opens is its own install\'s (per clone build dir), never another clone\'s' },
  { item: `repro-cold-boot.sh::' "$BIN" "$REPO/engine/electron/dist/main.cjs" 2>/dev/null`, reason: 'NOT A LAUNCH — the closing '
    + 'line of a multi-line `node -e \'…\'` that receives "$BIN" as argv to compare its mtime with dist/main.cjs (the stale-build warning); the single-quoted script body is '
    + 'not joined (shellLogicalLines), so this line\'s command word cannot be read and the detector counts it' },
];

/** Comment-blanked source — `#` for shell, the shared scanner for `.mjs` (#812): a raw read with a
 *  "drop lines starting with #" filter kept a trailing `# --user-data-dir` note and a `/* … *\/` body line. */
function read(name: string): string {
  return readScannedSource(path.join(scriptsDir, name)).code;
}

const SCRIPTS = (): string[] => fs.readdirSync(scriptsDir, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(sh|mjs)$/.test(e.name)).map((e) => e.name);

describe('packaged-app launches isolate their Chromium profile', () => {
  it('every launch passes --user-data-dir ON THAT LAUNCH, or is a counted row', () => {
    // On the launch itself: a flag anywhere in the file vouched for a launch without it — a second
    // launch, or the flag on a different command (#1179). Every script is scanned, listed or not.
    const launches = SCRIPTS().flatMap((name) => packagedLaunches(read(name), name).map((l) => ({ ...l, name })));
    assertExemptionLedger({
      label: 'packaged-app launches without --user-data-dir in engine/scripts',
      population: launches.filter((l) => !l.isolated).map((l) => ({ item: `${l.name}::${l.text}`, site: `${l.name}:${l.line}` })),
      exempt: NOT_ISOLATED,
      scanned: launches.length,
      floor: LAUNCHERS.length,
      fix: 'A packaged-app launch without its own profile. Pass --user-data-dir on the launch command itself.',
    });
  });

  it('LAUNCHERS is exactly the set of scripts with an isolated launch', () => {
    // Both directions: a listed launcher the detector no longer recognises (the positive control, #1105),
    // and a new isolated launcher nobody listed.
    const isolated = SCRIPTS().filter((name) => packagedLaunches(read(name), name).some((l) => l.isolated));
    expect(isolated.sort(), 'fix packagedLaunches() if a listed launcher vanished; list a new one').toEqual([...LAUNCHERS].sort());
  });

  it('no launcher reaches into the real shared profile by hardcoded path', () => {
    // `assert-app-renders.sh` used to `rm -rf "$HOME/Library/Application Support/Modoki
    // Editor/vite-cache"`. A fresh profile makes that unnecessary (it cannot hold a stale
    // cache), and the hardcoded reach mutated the human's real editor state.
    for (const name of LAUNCHERS) {
      expect(read(name), `${name} still touches the shared packaged profile`).not.toMatch(
        /Application Support\/Modoki Editor/,
      );
    }
  });

});

/** Commands proven NOT to launch what they mention: a test, or text. Anything else that mentions the
 *  binary is a launch — `nohup`, `env`, `timeout`, `caffeinate`, a `then` or `!` in front, a prefix the
 *  tokenizer cannot read. */
const NON_LAUNCH_COMMANDS = new Set(['[', '[[', 'test', 'echo', 'printf']);
const SHELL_SEPARATOR = /\|\||&&|;|\||(?<![<>&])&(?![>&])/;
const LEADING_KEYWORDS = new Set(['!', '{', '(', 'then', 'else', 'do', 'if', 'while', 'until', 'elif']);

/** Every launch of the resolved packaged binary in a script, each judged on its own command (#1179):
 *  - shell: every COMMAND (a logical line, cut at separators) that mentions `$BIN` — `"$BIN"`, `${BIN}`,
 *    unquoted — unless it is PROVEN not to launch: its command word is a test or `echo`/`printf`, or the
 *    command is nothing but `NAME=value` assignments. Isolated when THAT command carries `--user-data-dir`.
 *    ⚠️ Inverted after the P7 review: the first cut listed launch SHAPES (`exec`, `VAR=` prefixes, then
 *    `"$BIN"`), so `nohup "$BIN" &`, `env X=1 "$BIN" &` and `then "$BIN" &` — all caught by the older
 *    `"$BIN" … &` regex — silently stopped being launches. An unknown form is a launch.
 *  - JS: a `spawn`/`spawnSync`/`execFile`/`execFileSync` call whose first argument is `bin`; isolated when
 *    a string or template in its ARGUMENT list carries the flag.
 *  `packagedAppPaths.mjs` RESOLVES and REAPS a path without launching it, which is why JS matches the
 *  execution form rather than the variable. */
function packagedLaunches(code: string, label: string): Array<{ line: number; isolated: boolean; text: string }> {
  if (label.endsWith('.sh')) {
    return shellLogicalLines(code).flatMap(({ text, line }) => {
      let cursor = 0;
      return text.split(SHELL_SEPARATOR).map((cmd) => {
        const offset = text.indexOf(cmd, cursor);
        cursor = offset + cmd.length;
        return { cmd, offset };
      }).filter(({ cmd }) => /\$\{?BIN\}?(?![A-Za-z0-9_])/.test(cmd))
      .filter(({ cmd, offset }) => {
        // Run INSIDE a substitution, the binary launches whatever the outer command is — `echo "v:
        // $("$BIN" --version)"`, `X=$("$BIN")` (#1179 P7 re-review). The position is found in the whole
        // line, so a separator inside the substitution cannot hide its `$(`.
        const mention = /\$\{?BIN\}?(?![A-Za-z0-9_])/g;
        for (let m = mention.exec(cmd); m; m = mention.exec(cmd)) if (insideShellSubstitution(text, offset + m.index)) return true;
        const words = cmd.trim().split(/\s+/);
        while (words.length && LEADING_KEYWORDS.has(words[0]!)) words.shift();
        if (words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) return false;
        const command = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '';
        return !NON_LAUNCH_COMMANDS.has(command);
      })
      .map(({ cmd }) => ({ line, isolated: cmd.includes('--user-data-dir'), text: cmd.trim() }));
    });
  }
  return callsTo(parseSource(code, label), 'spawn', 'spawnSync', 'execFile', 'execFileSync')
    .filter((c) => { const a = c.arguments[0] && unwrapValue(c.arguments[0]); return !!a && ts.isIdentifier(a) && a.text === 'bin'; })
    .map((c) => ({
      line: lineOf(c),
      isolated: !!c.arguments[1] && findNodes(c.arguments[1], (n): n is ts.StringLiteralLike | ts.TemplateLiteralLikeNode => (ts.isStringLiteralLike(n)
        || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes('--user-data-dir')).length > 0,
      text: flatText(c).slice(0, 120),
    }));
}

describe('packagedLaunches judges each launch by its own command (#1179)', () => {
  const launches = (src: string, label = 'x.sh') => packagedLaunches(src, label).map((l) => `${l.line}:${l.isolated ? 'iso' : 'SHARED'}`);

  it('a wrapped background launch is one launch, isolated by the flag on its continuation', () => {
    expect(launches('MODOKI_PROJECT="$P" \\\n  "$BIN" "--user-data-dir=$UD" >"$LOG" 2>&1 &')).toEqual(['1:iso']);
  });

  it('an UNKNOWN form is a launch — nohup, env, timeout, then, !, a prefix the tokenizer cannot read', () => {
    expect(launches([
      'nohup "$BIN" >"$LOG" 2>&1 &', 'env X=1 "$BIN" &', 'timeout 30 "$BIN" --x &', 'if [ -n "$X" ]; then "$BIN" &',
      '! "$BIN" &', 'X="$(dirname "$P")" "$BIN" &', 'exec "$BIN"', '${BIN} --flag &', '$BIN &',
    ].join('\n'))).toEqual(['1:SHARED', '2:SHARED', '3:SHARED', '4:SHARED', '5:SHARED', '6:SHARED', '7:SHARED', '8:SHARED', '9:SHARED']);
  });

  it('the binary run inside a substitution is a launch, whatever command holds the substitution', () => {
    expect(launches('echo "v: $("$BIN" --version)"\nprintf "%s" "$("$BIN" --x)"\n[ "$("$BIN" --check)" = ok ]\nX=$("$BIN")\nX=`$BIN`\nR="$(cd x && "$BIN" --v || true)"\necho "$BIN"; X=$(echo "$BIN")\nX=$(true; echo $BIN ); echo $BIN )'))
      // Line 8: the same command text twice — only the copy inside the substitution is judged inside it.
      .toEqual(['1:SHARED', '2:SHARED', '3:SHARED', '4:SHARED', '5:SHARED', '6:SHARED', '7:SHARED', '8:SHARED']);
    // An apostrophe inside the double-quoted message does not hide the substitution after it.
    expect(launches(`echo "[smoke] can't start: $("$BIN" --version)"`)).toEqual(['1:SHARED']);
  });

  it('a test, a message and an assignment are not launches; a different variable is not the binary', () => {
    expect(launches('[ -x "$BIN" ] || { echo "no app at $BIN"; exit 1; }\n[[ -f $BIN ]]\ntest -f "$BIN"\nprintf "%s" "$BIN"\nBIN="$(node x)"\nSAVED="$BIN"\n"$BIN_PATH" &'))
      .toEqual([]);
  });

  it('one isolated launch does not vouch for a second, and the flag on a NEIGHBOUR command does not count', () => {
    expect(launches('"$BIN" "--user-data-dir=$UD" &\n"$BIN" &\nUD_FLAG=--user-data-dir; "$BIN" "$UD_FLAG" &')).toEqual(['1:iso', '2:SHARED', '3:SHARED']);
  });

  it('JS: a spawn of bin is judged by its own argument list', () => {
    const js = "const a = spawn(bin, [`--user-data-dir=${ud}`], {});\nconst b = spawn(\n  bin,\n  ['--inspect'],\n  { env: { NOTE: '--user-data-dir' } },\n);\nconst c = spawn(other, ['--user-data-dir=x']);";
    expect(launches(js, 'x.mjs')).toEqual(['1:iso', '2:SHARED']);
  });
});
