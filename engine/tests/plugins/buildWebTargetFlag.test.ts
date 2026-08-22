/** engine/scripts/build-web.mjs's `--target` fail-fast (#40). Missing/invalid `--target` must
 *  exit non-zero with the usage message BEFORE writing tsconfig.app.scoped.json or running
 *  tsc/vite — a `web` build and a `native` build need OPPOSITE base paths from this same
 *  script, so there is no safe default either way. Runs the real script as a subprocess (same
 *  posture as otaCliScripts.test.ts) with no MODOKI_PROJECT — the guard must fire before any
 *  project is even needed, so this stays fast. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
  // non-firing guard means the script proceeds past them: no `node_modules/typescript` in an
  // empty scratch dir skips the typecheck branch (and with it the scoped-tsconfig write — see
  // build-web.mjs's `existsSync(tscBin)` comment), then it tries to spawn the absent
  // `<scratch>/node_modules/vite/bin/vite.js` and node fails fast with MODULE_NOT_FOUND. At the
  // repo root it instead ran the REAL build — a full `tsc -p tsconfig.app.scoped.json` (~6s
  // locally, >20s on a CI runner), which timed out the suite on GitHub Actions and burned minutes
  // to re-prove a guard that had already returned.
  it('VITE_PLAYABLE=0 with --target web: does NOT hit the contradiction guard', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'modoki-buildweb-'));
    const { status, stderr } = runBuildWeb(['--target', 'web'], { VITE_PLAYABLE: '0' }, scratch);
    expect(stderr).not.toContain('contradict');
    // Sanity: it really did get PAST the guards (failed later, spawning the absent vite.js)
    // rather than passing this test by exiting early for some other reason.
    expect(status).not.toBe(0);
    expect(stderr).toContain('Cannot find module');
  });
});

// QA bug vSlzfZLr7pIX5Yw0RSSe: a packaged install's `engine/` is the app's own install
// directory — writable only during an admin-elevated install (e.g. `C:\Program Files\...`
// on Windows), not by the running, unelevated app. build-web.mjs used to write
// tsconfig.app.scoped.json unconditionally, before checking whether tsc would even run —
// so every build from such an install crashed with EPERM before any target-specific work
// started. The fix defers the write into the `existsSync(tscBin)` branch, so a packaged
// build (which ships no typescript) never attempts it at all.
describe('build-web.mjs does not write into engine/ when typescript is absent', () => {
  it('skips tsconfig.app.scoped.json entirely — proves the write is SKIPPED, not just missing a parent dir', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'modoki-buildweb-notsc-'));
    // A real, normally-writable engine/ dir — the OLD code would have written into it
    // successfully here (this fixture does not depend on filesystem permissions), so a
    // present file after the run would mean the write was attempted, not just that it
    // failed on a missing directory.
    const engineDir = path.join(scratch, 'engine');
    mkdirSync(engineDir, { recursive: true });
    const scopedPath = path.join(engineDir, 'tsconfig.app.scoped.json');
    // No node_modules/typescript in this scratch tree, so `existsSync(tscBin)` is false —
    // a no-op vite.js stub lets the script run to a clean, fast exit past that branch.
    const viteBinDir = path.join(scratch, 'node_modules', 'vite', 'bin');
    mkdirSync(viteBinDir, { recursive: true });
    writeFileSync(path.join(viteBinDir, 'vite.js'), 'process.exit(0)\n');

    const { status } = runBuildWeb(['--target', 'web'], {}, scratch);
    expect(status).toBe(0);
    expect(existsSync(scopedPath)).toBe(false);
  });
});

// QA bug vSlzfZLr7pIX5Yw0RSSe's second half, and a REGRESSION GUARD against re-adding
// `--configLoader runner` to this call. It was tried (fixes the `.vite-temp` EPERM below,
// same class as the write above, on the same read-only packaged install) and reverted: its
// module runner is torn down once config-loading finishes, so any plugin hook doing a
// dynamic `import()` LATER in the build (writeBundle/generateBundle — exactly what
// rigged-model-optimize.ts's `@gltf-transform/*` imports and the SSR-postprocessor loader in
// vite-asset-scanner.ts both do) throws "Vite module runner has been closed". Proved with a
// two-line repro: a plugin doing `await import('node:fs/promises')` from `writeBundle` fails
// under `--configLoader runner` and succeeds under the default loader. So the `.vite-temp`
// EPERM on an admin-elevated (`Program Files`) install stays open — see docs/windows.md's
// "Packaged-app bugs" entry for the workaround — and this asserts the real CLI invocation
// stays on the DEFAULT loader, not just that some build eventually succeeds.
describe('build-web.mjs does NOT pass --configLoader to vite build', () => {
  it('invokes vite build with no --configLoader flag (default bundle loader)', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'modoki-buildweb-configloader-'));
    mkdirSync(path.join(scratch, 'engine'), { recursive: true });
    const viteBinDir = path.join(scratch, 'node_modules', 'vite', 'bin');
    mkdirSync(viteBinDir, { recursive: true });
    const argvCapture = path.join(scratch, 'vite-argv.json');
    // Records its own argv (skipping [node, scriptPath]) then exits clean — no real vite
    // build runs, so this stays fast and has nothing else to fail on.
    writeFileSync(
      path.join(viteBinDir, 'vite.js'),
      `require('fs').writeFileSync(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)));\n`,
    );

    const { status } = runBuildWeb(['--target', 'web'], {}, scratch);
    expect(status).toBe(0);
    const argv = JSON.parse(readFileSync(argvCapture, 'utf8'));
    expect(argv).toEqual(['build', '--config', 'engine/vite.config.ts']);
  });
});
