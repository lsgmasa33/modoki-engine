/** `editorPorts.mjs` as a CLI — the seam the bash launchers actually use (#349).
 *
 *  `editorPorts.test.ts` covers the library functions, but nothing a human types calls those.
 *  `launch-editor.sh`, `relaunch-editor.sh`, `test-packaged.sh` and both `resave-*.sh` reach
 *  this module ONLY through `$(node engine/scripts/editorPorts.mjs backend "$REPO")`, and the
 *  properties that seam depends on are invisible from the library side:
 *
 *    - stdout must be a BARE integer. `BACKEND_PORT=$(…)` inherits the string verbatim, so a
 *      "port: 5180" or a trailing newline-plus-warning pins a nonsense port that main.ts then
 *      refuses, and the launch dies with a modal instead of an editor.
 *    - the warning must go to STDERR. On stdout it would be captured INTO the port.
 *    - an unknown clone must print NOTHING and still exit 0. Every caller runs under
 *      `set -euo pipefail`, where a non-zero exit inside a command substitution kills the
 *      whole launcher — a worse outcome than the auto-port degrade the empty string produces.
 *      This is the shape `clonePort.mjs`'s own CLI test was written for after the inverse bug:
 *      there, printing nothing on BAD input silently pinned an empty port.
 *
 *  Every assertion here is one a library-level test cannot make, which is the point. */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { hasPrivateTooling } from '../helpers/repoLayout';
import {
  backendPortForClone,
  vitePortForBackend,
  cdpPortForBackend,
} from '../../scripts/editorPorts.mjs';

const CLI = path.resolve(__dirname, '../../scripts/editorPorts.mjs');
// Skipped where the CLONE TABLE has no meaning — NOT because the CLI is missing. `engine/scripts/**`
// DOES ship in the public snapshot (`git ls-files -- engine`, publish-engine-oss.sh:127, with no
// exclusion), and it must: this file's top-level import of `../../scripts/editorPorts.mjs` would
// throw before any `skipIf` could run. An earlier draft of this comment claimed the opposite, copied
// from the same premise in editorPorts.test.ts — worth stating plainly, because that false reason is
// what would mislead whoever next decides to un-skip.
//
// The real reason: the OSS publish gate STAGES the snapshot into `$(mktemp -d …/modoki-oss-XXXXXX)`
// and runs `engine/tests/architecture/` from inside it (publish-engine-oss.sh:102,635). That
// directory is not one of the five clones, so every assertion of the form "the repo I am running in
// has a pinned port" is false there. `hasPrivateTooling()` is `.mcp.json exists`, which the snapshot
// lacks — a PROXY that happens to coincide, so the tests below are ALSO written to hold when the
// port is null, rather than resting on the proxy alone.
const skip = !hasPrivateTooling();
const KNOWN = '/Users/dev/Projects/modoki-ai3';
const UNKNOWN = '/Users/dev/Projects/some-scratch-clone';

/** Every spawn in this file runs with MODOKI_BACKEND_PORT explicitly EMPTY.
 *
 *  Not hygiene — correctness. Child processes inherit `process.env`, and four of the five real
 *  launcher lines lifted below are `VAR="${MODOKI_BACKEND_PORT:-$(node …)}"`. If that variable
 *  is set in the environment running the suite — and `relaunch-editor.sh` EXPORTS it, so it
 *  routinely is — the substitution never runs and the guard asserts nothing. Measured: with
 *  `MODOKI_BACKEND_PORT=5180`, re-introducing the historic `|| true`-outside-the-substitution
 *  regression left these tests GREEN. The mirror case is a false red: `MODOKI_BACKEND_PORT=5999`
 *  failed them on a correct tree. Empty is what `:-` treats as unset, so this forces the
 *  derivation path unconditionally, whatever the developer has exported. */
const NO_PIN = { ...process.env, MODOKI_BACKEND_PORT: '' };

/** stdout, stderr and status separately — the split IS what most of these tests assert. */
function run(args: string[]): { out: string; err: string; status: number } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: NO_PIN });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status ?? -1 };
}

describe.skipIf(skip)('editorPorts.mjs CLI — the bash seam (#349)', () => {
  it('prints a BARE integer on stdout for a known clone', () => {
    const { out, err, status } = run(['backend', KNOWN]);
    expect(status).toBe(0);
    // No label, no newline-wrapped extras: `BACKEND_PORT=$(…)` takes this literally.
    expect(out).toMatch(/^\d+$/);
    expect(out).toBe('5182');
    expect(err).toBe('');
  });

  it('agrees with the library function it shares an implementation with', () => {
    for (const [cmd, expected] of [
      ['backend', backendPortForClone(KNOWN)],
      ['vite', vitePortForBackend(backendPortForClone(KNOWN)!)],
      ['cdp', cdpPortForBackend(backendPortForClone(KNOWN)!)],
    ] as const) {
      expect(Number(run([cmd, KNOWN]).out)).toBe(expected);
    }
    expect(run(['url', KNOWN]).out).toBe('http://127.0.0.1:5182');
  });

  it('an UNKNOWN clone prints nothing on stdout, warns on stderr, and exits 0', () => {
    const { out, err, status } = run(['backend', UNKNOWN]);
    // All three matter and they fail independently:
    //  - a non-empty stdout would pin a wrong port
    //  - a silent stderr would leave the human with no idea why the port went auto
    //  - a non-zero status would abort the calling launcher outright under `set -e`
    expect(out).toBe('');
    expect(err).toMatch(/not a known clone directory/);
    expect(err).toMatch(/some-scratch-clone/);
    expect(status).toBe(0);
  });

  it('`cdp-unpinned` answers for an UNKNOWN clone — the only case it exists for', () => {
    // This is the whole point of the command and it was first written UNREACHABLE: the arm sat
    // inside the `else if` chain that only runs when the clone IS known, so an unknown clone
    // fell into the warn-and-print-nothing branch and the launcher read "" → CDP off, exactly
    // the regression the command was added to prevent. It depends on no clone at all.
    const { out, status } = run(['cdp-unpinned', UNKNOWN]);
    expect(status).toBe(0);
    expect(out).toMatch(/^\d+$/);

    // It must land in the hashed scratch block and NEVER in the human lane. The first version
    // returned a fixed 9222 — the hub's CDP port — so a scratch clone launched beside a live
    // hub printed `CDP: …9222` in its banner while that port belonged to the hub's renderer.
    // An agent aiming there drives the wrong clone: #349 relocated from backend to CDP.
    const port = Number(out);
    expect(port).toBeGreaterThanOrEqual(9240);
    expect(port).toBeLessThan(9280);
    for (const humanLane of [9222, 9223, 9224, 9225, 9226]) expect(port).not.toBe(humanLane);

    // Stable for one path, distinct across paths — the property that makes it collision-free.
    expect(run(['cdp-unpinned', UNKNOWN]).out).toBe(out);
    expect(run(['cdp-unpinned', '/Users/dev/Projects/another-scratch']).out).not.toBe(out);

    // …unlike `cdp`, which IS the per-clone authored lane and must stay that way.
    expect(run(['cdp', KNOWN]).out).toBe('9225');
  });

  it('an unknown command warns and prints nothing rather than emitting a wrong port', () => {
    const { out, err, status } = run(['nonsense', KNOWN]);
    expect(out).toBe('');
    expect(err).toMatch(/unknown command/);
    expect(status).toBe(0);
  });

  it('survives a repo path containing spaces and non-ASCII', () => {
    // The launchers pass "$REPO" quoted, and this Mac really does have unicode in paths.
    // A basename comparison must not be disturbed by either.
    const spaced = '/Users/dev/My Projects/modoki-qa';
    expect(run(['backend', spaced]).out).toBe('5183');
    expect(run(['backend', '/Users/dev/Проекты/modoki-ai2']).out).toBe('5181');
  });

  it('a trailing separator still resolves — callers build paths by concatenation', () => {
    expect(run(['backend', '/Users/dev/Projects/modoki-ai/']).out).toBe('5180');
  });

  it('the bash idiom the launchers use captures exactly the port, warning excluded', () => {
    // The real thing, not a paraphrase: `${VAR:-$(…)}` under `set -euo pipefail`, which is
    // what launch-editor.sh line ~80 does. Two properties at once — the substitution yields
    // the bare port, and a failing/warning CLI does not abort the shell.
    const script = `set -euo pipefail; PORT="\${MODOKI_BACKEND_PORT:-$(node '${CLI}' backend '${KNOWN}')}"; echo "[$PORT]"`;
    expect(execFileSync('bash', ['-c', script], { encoding: 'utf8', env: NO_PIN }).trim()).toBe('[5182]');
  });

  it('the SAME bash idiom degrades to an empty port for an unknown clone, without aborting', () => {
    // The regression that would hurt most: `set -e` killing the launcher outright, which
    // looks like "the editor silently failed to start" rather than "you have no pinned lane".
    const script = `set -euo pipefail; PORT="\${MODOKI_BACKEND_PORT:-$(node '${CLI}' backend '${UNKNOWN}')}"; echo "[$PORT]"; echo SURVIVED`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: NO_PIN });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['[]', 'SURVIVED']);
  });

  it('an explicit MODOKI_BACKEND_PORT still wins over the derivation', () => {
    // The override has to keep working: it is how a scratch clone pins a lane, and how the
    // `editor-*` shell functions and CI target a specific editor.
    const script = `set -euo pipefail; MODOKI_BACKEND_PORT=5999; PORT="\${MODOKI_BACKEND_PORT:-$(node '${CLI}' backend '${KNOWN}')}"; echo "[$PORT]"`;
    expect(execFileSync('bash', ['-c', script], { encoding: 'utf8', env: NO_PIN }).trim()).toBe('[5999]');
  });

  describe('the REAL assignment line in each launcher, not a paraphrase of it', () => {
    // Why this exists: the tests above assert an idiom written out by hand in this file, and
    // an idiom that is correct here can still be wrong in the script. It happened — a `|| true`
    // was added to guard a missing `node` and landed OUTSIDE the substitution:
    //     "${VAR:-$(node … "$REPO") || true}"
    // where ` || true` is not a shell operator at all but plain TEXT appended to the expansion,
    // so BACKEND_PORT became the literal `5180 || true`. Every hand-written idiom test still
    // passed. So: lift the actual line out of the actual file and run THAT.
    const SCRIPTS = [
      { rel: 'engine/scripts/launch-editor.sh', varName: 'BACKEND_PORT', rootVar: 'REPO' },
      { rel: 'engine/scripts/test-packaged.sh', varName: 'BACKEND_PORT', rootVar: 'REPO' },
      { rel: 'engine/scripts/relaunch-editor.sh', varName: 'PORT', rootVar: 'REPO' },
      { rel: 'engine/scripts/resave-scenes.sh', varName: 'PORT', rootVar: 'ROOT' },
      { rel: 'engine/scripts/resave-prefabs.sh', varName: 'PORT', rootVar: 'ROOT' },
    ];
    const REPO_ROOT = path.resolve(__dirname, '../../..');

    for (const { rel, varName, rootVar } of SCRIPTS) {
      it(`${rel} assigns a BARE port`, () => {
        const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        const line = src
          .split('\n')
          .find((l) => l.includes('editorPorts.mjs') && l.trimStart().startsWith(`${varName}=`));
        expect(line, `no ${varName}= assignment reading editorPorts.mjs in ${rel}`).toBeDefined();

        // Run the line verbatim under the same shell options the scripts use, with only the
        // root variable injected. A known clone → the bare port and nothing else.
        const known = `set -euo pipefail; ${rootVar}='${REPO_ROOT}'; ${line}; printf '%s' "$${varName}"`;
        const got = execFileSync('bash', ['-c', known], { encoding: 'utf8', env: NO_PIN });
        // Tolerate a checkout that is NOT one of the five clones — a scratch clone, a copy, a
        // review worktree. `hasPrivateTooling()` does not cover that case (it only asks whether
        // `.mcp.json` exists, which such a checkout has), and asserting a bare integer there
        // would turn a correct tree red. The sibling no-arg test was written null-tolerant in
        // the same commit; these five were not, which is the same omission twice.
        const expected = backendPortForClone(REPO_ROOT);
        if (expected === null) {
          expect(got).toBe('');
        } else {
          expect(got).toMatch(/^\d+$/);
          expect(Number(got)).toBe(expected);
        }
      });
    }
  });

  it('defaults to THIS repo when no root argument is passed', () => {
    // launch-editor.sh passes "$REPO" explicitly, but the documented ad-hoc form
    // (`node engine/scripts/editorPorts.mjs backend`) omits it — so the no-arg path must
    // resolve the repo root from the module's own location, not from process.cwd().
    const fromElsewhere = spawnSync('node', [CLI, 'backend'], { encoding: 'utf8', cwd: '/', env: NO_PIN });
    // Written to hold wherever this runs, including a repo checked out under a name that is
    // NOT a known clone. `String(null)` is the string "null", which the CLI never prints —
    // asserting it directly would turn any such checkout into a red gate for a passing CLI.
    const expected = backendPortForClone(path.resolve(__dirname, '../../..'));
    expect(fromElsewhere.stdout).toBe(expected === null ? '' : String(expected));
  });
});
