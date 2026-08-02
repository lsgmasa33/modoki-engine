/** engine/scripts/build-web.mjs's `--target` fail-fast (#40). Missing/invalid `--target` must
 *  exit non-zero with the usage message BEFORE writing tsconfig.app.scoped.json or running
 *  tsc/vite — a `web` build and a `native` build need OPPOSITE base paths from this same
 *  script, so there is no safe default either way. Runs the real script as a subprocess (same
 *  posture as otaCliScripts.test.ts) with no MODOKI_PROJECT — the guard must fire before any
 *  project is even needed, so this stays fast. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');

function runBuildWeb(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd = repoRoot,
): { status: number; stderr: string } {
  try {
    execFileSync('node', [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? 1, stderr: err.stderr ?? '' };
  }
}

describe('build-web.mjs --target fail-fast', () => {
  it('no --target and no MODOKI_BUILD_TARGET: exits non-zero with the usage message', () => {
    const { status, stderr } = runBuildWeb([], { MODOKI_BUILD_TARGET: undefined });
    expect(status).not.toBe(0);
    expect(stderr).toContain('--target is required');
    expect(stderr).toContain('web       honors build.webBasePath');
    expect(stderr).toContain('native    base "/"');
    expect(stderr).toContain('playable  single self-contained HTML');
  });

  it('--target bogus: exits non-zero with the usage message', () => {
    const { status, stderr } = runBuildWeb(['--target', 'bogus']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--target is required');
  });

  it('VITE_PLAYABLE=1 but --target web: exits non-zero (contradiction guard)', () => {
    const { status, stderr } = runBuildWeb(['--target', 'web'], { VITE_PLAYABLE: '1' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('VITE_PLAYABLE');
  });

  // F1 regression guard (see buildTargetParse.test.ts for the unit-level coverage): vite.config.ts
  // treats VITE_PLAYABLE=0 as OFF, so the contradiction guard must not fire for it either. This
  // does not assert success — only that the contradiction message specifically is absent.
  //
  // Run from an EMPTY temp cwd, not the repo root. The guards run before anything else, so a
  // non-firing guard means the script proceeds to `writeFileSync(<cwd>/engine/tsconfig.app.scoped.json)`
  // and dies on ENOENT in milliseconds. At the repo root it instead ran the REAL build — a full
  // `tsc -p tsconfig.app.scoped.json` (~6s locally, >20s on a CI runner), which timed out the
  // suite on GitHub Actions and burned minutes to re-prove a guard that had already returned.
  it('VITE_PLAYABLE=0 with --target web: does NOT hit the contradiction guard', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'modoki-buildweb-'));
    const { status, stderr } = runBuildWeb(['--target', 'web'], { VITE_PLAYABLE: '0' }, scratch);
    expect(stderr).not.toContain('contradict');
    // Sanity: it really did get PAST the guards (failed later, on the absent engine/ dir)
    // rather than passing this test by exiting early for some other reason.
    expect(status).not.toBe(0);
    expect(stderr).toContain('ENOENT');
  });
});
