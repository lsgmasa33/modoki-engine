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
 *  NOT covered, deliberately: `mkdtempSync` / `mktemp` callers (unique by construction) and
 *  `~/.modoki/**` (machine-wide ON PURPOSE — device claims and the launch log exist to answer
 *  cross-clone questions, and per-cloning them would defeat them).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptsDir = path.resolve(__dirname, '../../scripts');
const devServerPath = path.resolve(__dirname, '../../electron/devServer.ts');

/** Recursive, like reapScoping's walker — `scripts/lib/` holds shared shell too, and a guard
 *  that only reads the top level vouches for less than it appears to. */
function shellScripts(dir = scriptsDir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...shellScripts(p));
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out;
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

/** Drop whole-line comments: these scripts discuss `/tmp` paths in prose constantly (they
 *  document this very hazard), and a doc mention is not a write. */
function codeLines(src: string): { line: string; n: number }[] {
  return src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line));
}

describe('temp paths in engine/scripts are clone-scoped', () => {
  it('every literal /tmp path carries a per-clone discriminator', () => {
    const offenders: string[] = [];
    for (const file of shellScripts()) {
      for (const { line, n } of codeLines(fs.readFileSync(file, 'utf8'))) {
        // `mktemp`/`mkdtemp` mint a unique name themselves — the `${TMPDIR:-/tmp}` prefix in
        // those calls is a portability idiom, not a shared name.
        if (/mk(d?)temp/.test(line)) continue;
        // The token following `/tmp/` up to the next quote/space/redirect.
        const re = /\/tmp\/([^\s"'`;|)>]*)/g;
        for (let m = re.exec(line); m; m = re.exec(line)) {
          const tail = m[1];
          // A `$` anywhere in the tail means the name is keyed on something (the backend port,
          // the pid, the clone basename). That is the whole requirement — WHICH discriminator
          // is a judgement call per script, and each one documents its own.
          if (!tail.includes('$')) {
            offenders.push(`${path.basename(file)}:${n}: /tmp/${tail}`);
          }
        }
      }
    }
    expect(
      offenders,
      'a fixed /tmp name is shared by every clone on this machine — key it on the backend port, '
        + 'the pid, or $(basename "$REPO"), or mint it with mktemp',
    ).toEqual([]);
  });

  it('every native-temp-dir path carries a per-clone discriminator too', () => {
    // The rule above only sees a LITERAL `/tmp`. The packaged loops build under
    // `$(node "$PATHS" tmpdir)/…` instead — which is where the damage is, since those dirs get
    // `rm -rf`'d and rebuilt. Both `smoke-packaged.sh` and `repro-cold-boot.sh` shipped a bare
    // shared name here while their PORTS and profiles were already per clone.
    const offenders: string[] = [];
    for (const file of shellScripts()) {
      for (const name of tempDirBasenames(fs.readFileSync(file, 'utf8'))) {
        if (!name.includes('$')) offenders.push(`${path.basename(file)}: ${name}`);
      }
    }
    expect(
      offenders,
      'a fixed name under the machine-wide temp dir is shared by every clone — add $(basename "$REPO")',
    ).toEqual([]);
  });

  it('repro-cold-boot.sh reuses the SMOKE build dir, byte for byte', () => {
    // An invisible coupling, and the reason it needs a test: repro-cold-boot's whole job is to
    // relaunch the app the smoke gate just built. When the two names drift, nothing fails —
    // the script finds a DIFFERENT, older app (or none) and reports on it. Its own header says
    // a naive default once did exactly that and "reported it green". Renaming one side while
    // per-cloning it is precisely how that recurs, so pin them to each other.
    const smoke = fs.readFileSync(path.join(scriptsDir, 'smoke-packaged.sh'), 'utf8');
    const repro = fs.readFileSync(path.join(scriptsDir, 'repro-cold-boot.sh'), 'utf8');
    const outOf = (src: string) => /^OUT=.*$/m.exec(codeLines(src).map((l) => l.line).join('\n'))?.[0] ?? '';
    // Compare the BASENAME expression, normalised for the two spellings of "this clone"
    // ($CLONE vs an inline $(basename "$REPO")) — the paths must resolve to one directory.
    const norm = (s: string) =>
      (tempDirBasenames(s)[0] ?? '').replace(/\$\{?CLONE\}?/g, 'CLONE').replace(/\$\(basename\s+"\$REPO"\)/g, 'CLONE');
    expect(norm(outOf(repro)), `repro-cold-boot OUT (${outOf(repro)}) must resolve to smoke-packaged OUT (${outOf(smoke)})`)
      .toBe(norm(outOf(smoke)));
  });

  it('launch-editor.sh EXPORTS the per-clone Vite log, not just computes it', () => {
    const src = fs.readFileSync(path.join(scriptsDir, 'launch-editor.sh'), 'utf8');
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
      const s = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      for (const { line, n } of codeLines(s)) {
        if (line.includes('MODOKI_VITE_LOG') && /\/tmp\//.test(line)) offenders.push(`${name}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders, 'MODOKI_VITE_LOG must be a native path (packagedAppPaths.mjs tmpdir), never a literal /tmp')
      .toEqual([]);
  });

  it('devServer.ts falls back to a per-editor Vite log name', () => {
    const src = fs.readFileSync(devServerPath, 'utf8');
    const line = src.split('\n').find((l) => l.includes("MODOKI_VITE_LOG") && l.includes('tmpdir')) ?? '';
    expect(line, 'devServer.ts should read MODOKI_VITE_LOG with an os.tmpdir() fallback').not.toBe('');
    expect(
      line,
      "the fallback must be tagged (a template literal keyed on the backend port/pid) — a bare "
        + "'modoki-vite.log' is written by every clone's editor at once",
    ).not.toMatch(/['"]modoki-vite\.log['"]/);
  });
});
