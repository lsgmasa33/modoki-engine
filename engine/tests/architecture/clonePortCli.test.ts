/** `clonePort.mjs` as a CLI — the seam the bash harnesses actually use.
 *
 *  The library functions are covered by e2eClonePort.test.ts, but `smoke-packaged.sh` and
 *  `assert-app-renders.sh` call this through `$(node clonePort.mjs …)`. A CLI that stops
 *  printing a bare number, or that exits 0 on bad input, breaks those harnesses in a way
 *  no library-level test can see: bash would capture the wrong string and pin a nonsense
 *  port, or capture an error message and pin nothing at all.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clonePort } from '../../scripts/clonePort.mjs';

const CLI = path.resolve(__dirname, '../../scripts/clonePort.mjs');

function run(args: string[]): { out: string; status: number } {
  try {
    return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }).trim(), status: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), status: err.status ?? -1 };
  }
}

describe('clonePort.mjs CLI (#69)', () => {
  it('prints a BARE integer on stdout — bash captures this into a port', () => {
    const { out, status } = run(['38600', '200', '/Users/dev/Projects/modoki']);
    expect(status).toBe(0);
    // Not "port: 38686", not trailing junk — `PORT=$(…)` would inherit it verbatim.
    expect(out).toMatch(/^\d+$/);
  });

  it('agrees with the library function it shares an implementation with', () => {
    const root = '/Users/dev/Projects/modoki-ai';
    const { out } = run(['38600', '200', root]);
    expect(Number(out)).toBe(clonePort(root, 38600, 200));
  });

  it('honours the repoRoot argument — different clones, different ports', () => {
    const a = run(['38600', '200', '/Users/dev/Projects/modoki']).out;
    const b = run(['38600', '200', '/Users/dev/Projects/modoki-ai2']).out;
    expect(a).not.toBe(b);
  });

  it('exits NON-ZERO on a bad base rather than printing something bash would pin', () => {
    for (const bad of [[], ['0'], ['99999'], ['not-a-port']]) {
      const { out, status } = run(bad);
      expect(status, `args ${JSON.stringify(bad)}`).not.toBe(0);
      expect(out, `args ${JSON.stringify(bad)}`).not.toMatch(/^\d+$/);
    }
  });

  it('exits NON-ZERO on a bad slot count', () => {
    for (const bad of [['38600', '0'], ['38600', '-1'], ['38600', 'x']]) {
      expect(run(bad).status, `args ${JSON.stringify(bad)}`).not.toBe(0);
    }
  });

  // REGRESSION (CI run 30695413747): the run-as-main guard compared import.meta.url to a
  // `file://${process.argv[1]}` template. argv[1] is a raw OS path and import.meta.url is a
  // URL, so the two only match when the path needs no percent-encoding and already starts
  // with `/`. On Windows (backslashes, `D:` drive letter) the guard was NEVER true: the CLI
  // printed nothing and exited 0, so `PORT=$(node clonePort.mjs …)` pinned an EMPTY port
  // with no error, and all five tests above failed at once.
  //
  // Running from a temp dir reproduces the identical defect HERE, on macOS/Linux — which is
  // the only reason this guard is worth having: the GitHub gate is manual (it caught the
  // Windows break only because the owner asked for a run), so a Windows-only regression test
  // would sit unread between runs.
  //
  // It reproduces for TWO independent reasons, and the test covers both at once:
  //   - the space in the dir name, which import.meta.url percent-encodes and argv[1] does not;
  //   - os.tmpdir() itself, which on macOS lives under the `/var` → `/private/var` SYMLINK,
  //     so import.meta.url is already resolved while argv[1] is not.
  // Verified by mutation: the naive template fails this, and so does a pathToFileURL-only
  // guard (which fixes the encoding but not the symlink). Copying the script is safe — it
  // imports nothing but `node:` builtins.
  const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone port ')); // NB: the space
  afterAll(() => fs.rmSync(spaceDir, { recursive: true, force: true }));

  it('still runs as a CLI from a path that needs URL-encoding (space in the repo path)', () => {
    expect(spaceDir).toContain(' '); // non-vacuity: mkdtemp really kept the space
    const copied = path.join(spaceDir, 'clonePort.mjs');
    fs.copyFileSync(CLI, copied);

    const out = execFileSync(process.execPath, [copied, '38600', '200', '/Users/dev/Projects/modoki'],
      { encoding: 'utf8' }).trim();

    // The pre-fix failure mode was empty stdout + exit 0 — assert on the VALUE, since
    // `toMatch(/^\d+$/)` alone would also be satisfied by a CLI that printed a wrong number.
    expect(out).toBe(String(clonePort('/Users/dev/Projects/modoki', 38600, 200)));
  });
});
