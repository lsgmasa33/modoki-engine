/**
 * Integration guards for the vendored-plugin identity hash + the manual re-vendor
 * CLI. These use the REAL git/node/esbuild + the REAL committed engine plugins, so
 * they live apart from vendorPlugins.test.ts (which mocks child_process — that mock
 * would swallow the git/node spawns here). They skip cleanly where those tools or
 * the games/engine layout are absent (e.g. a packaged/external checkout).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginHashInputs } from '../../plugins/vendorPlugins';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const enginePkgs = path.join(repoRoot, 'engine', 'packages');
const vendorScript = path.join(repoRoot, 'engine', 'scripts', 'vendor-plugins.mjs');

function gitOk(): boolean {
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
}
function esbuildOk(): boolean {
  try { createRequire(import.meta.url).resolve('esbuild'); return true; }
  catch { return false; }
}
/** The real engine capacitor plugins (the ones vendorEnginePlugins packs). */
function enginePluginDirs(): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(enginePkgs); } catch { return []; }
  return names
    .filter((n) => n.startsWith('capacitor-'))
    .map((n) => path.join(enginePkgs, n))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')));
}

// ── The reproducibility invariant — the property that actually bit us ─────────
// A hash computed over any file that ISN'T committed source (local build litter,
// e.g. android/build or .gradle from a native build) is machine-dependent → the
// tarball name drifts across clones → the churn returns. So: every file feeding
// the hash MUST be git-tracked. Catches a future plugin whose build tool emits to
// a dir name not in BUILD_OUTPUT_DIRS (out/, lib/, .kotlin/, …) far better than
// the hand-listed synthetic cases in vendorPlugins.test.ts.
describe.skipIf(!(gitOk() && enginePluginDirs().length > 0))(
  'plugin identity hash is reproducible — hashed set is exactly committed source',
  () => {
    for (const dir of enginePluginDirs()) {
      const name = path.basename(dir);
      it(`${name}: every hashed input is git-tracked (no untracked/ignored litter leaks in)`, () => {
        const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
        const tracked = new Set(
          execFileSync('git', ['ls-files', '-z', '--', rel], { cwd: repoRoot, encoding: 'utf8' })
            .split('\0').filter(Boolean)
            .map((p) => p.slice(rel.length + 1)), // repo-relative → plugin-relative
        );
        const inputs = pluginHashInputs(dir);
        expect(inputs.length).toBeGreaterThan(0);
        const leaks = inputs.filter((p) => !tracked.has(p));
        expect(
          leaks,
          `these hashed files are NOT git-tracked (local litter → non-reproducible hash). ` +
          `Add their dir to BUILD_OUTPUT_DIRS in vendorPlugins.ts, or ignore/remove them:\n  ${leaks.join('\n  ')}`,
        ).toEqual([]);
      });
    }
  },
);

// ── The excluded-vs-included partition on the REAL plugin ─────────────────────
// The reproducibility test above only checks hashed ⊆ git-tracked — it is BLIND to a
// regression that re-includes NON-shipped dev files (the plugin's own unit tests /
// test-vectors), because those are git-tracked too. This pins the actual partition on the
// real capacitor-game-debug plugin: its test files must NOT feed the identity hash (the
// churn this scoping fixed), while its shipped native + src build inputs MUST. Reverting
// pluginHashInputs to "all non-dist inputs" fails this; over-narrowing (dropping src or
// native) fails it too.
describe.skipIf(!(gitOk() && enginePluginDirs().some((d) => path.basename(d) === 'capacitor-game-debug')))(
  'plugin identity hash EXCLUDES non-shipped dev files, INCLUDES shipped + build inputs (real plugin)',
  () => {
    const dir = enginePluginDirs().find((d) => path.basename(d) === 'capacitor-game-debug')!;
    const inputs = new Set(pluginHashInputs(dir));
    const under = (prefix: string) => [...inputs].filter((p) => p === prefix || p.startsWith(prefix + '/'));
    const onDisk = (rel: string) => fs.existsSync(path.join(dir, rel));

    // Non-shipped, non-build-input dev files → must be EXCLUDED (only assert for the ones
    // that actually exist, so a future plugin reshuffle can't falsely pass/fail).
    for (const excluded of ['android/src/test', 'ios/Tests', 'test-vectors']) {
      it.skipIf(!onDisk(excluded))(`excludes ${excluded}/** (not shipped, not a dist input)`, () => {
        expect(under(excluded), `${excluded}/** must not feed the identity hash`).toEqual([]);
      });
    }

    // Shipped native + src build inputs → must be INCLUDED (guards against over-narrowing).
    for (const included of ['src', 'android/src/main', 'ios/Sources']) {
      it.skipIf(!onDisk(included))(`includes ${included}/** (shipped and/or a dist build input)`, () => {
        expect(under(included).length, `${included}/** must feed the identity hash`).toBeGreaterThan(0);
      });
    }
  },
);

// ── The manual re-vendor CLI runs under the current Node ──────────────────────
// vendor-plugins.mjs imports the single TS impl, which pulls in the toolchain via
// a bundler-style directory specifier Node's native type-stripping rejects
// (ERR_UNSUPPORTED_DIR_IMPORT). It works only because the script bundles with
// esbuild first. This locks that: a regression to a direct .ts import would exit
// non-zero here. Vendors into a THROWAWAY temp project — never mutates the repo.
describe.skipIf(!esbuildOk())('vendor-plugins.mjs CLI runs (esbuild-bundled, no dir-import crash)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor-cli-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('bundles + vendors an engine plugin into a temp project, exit 0', () => {
    const plugin = enginePluginDirs().find((d) => path.basename(d) === 'capacitor-game-debug')
      ?? enginePluginDirs()[0];
    if (!plugin) { expect(true).toBe(true); return; } // no engine plugins → nothing to vendor
    const pluginName = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')).name as string;

    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'vendor-cli-smoke', version: '0.0.0', dependencies: { [pluginName]: '*' },
    }));

    const r = spawnSync('node', [vendorScript, tmp], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });

    expect(r.error, `spawn error: ${r.error?.message}`).toBeUndefined();
    // The exact failure this test exists to catch — a module-resolution crash.
    expect(r.stderr ?? '').not.toMatch(/ERR_UNSUPPORTED_DIR_IMPORT|Cannot find|ERR_MODULE_NOT_FOUND/);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(new RegExp(pluginName));

    // It actually vendored: a content-addressed tarball + a rewritten file: spec.
    const tgz = fs.readdirSync(path.join(tmp, 'plugins')).filter((f) => f.endsWith('.tgz'));
    expect(tgz.length).toBe(1);
    const dep = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).dependencies[pluginName];
    expect(dep).toBe(`file:plugins/${tgz[0]}`);
  }, 130_000);
});
