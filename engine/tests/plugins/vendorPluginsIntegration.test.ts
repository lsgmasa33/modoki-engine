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
import * as tar from 'tar';
import { pluginHashInputs, compareTarballToSource, stampPluginBuild, vendorEnginePlugins, pluginContentHash, readPackedVersion, verifyInstalledMatchesTarball } from '../../plugins/vendorPlugins';
import { buildPluginsWorkspaces, plannedStampDirs } from '../../scripts/stamp-plugin-builds.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

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
  let names: string[];
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
        // The one migrated call site that keeps a `path.relative` round-trip, deliberately: `rel`
        // is not merely feeding `under` (which accepts an absolute `dir` and would need no
        // normalisation) — it is also the PREFIX LENGTH the slice below uses to turn a
        // repo-relative path into a plugin-relative one. Passing `dir` to `under` and keeping
        // `rel` for the slice would split one derivation into two that can disagree, which is a
        // worse shape than the round-trip. The `.split(path.sep).join('/')` is load-bearing on
        // Windows and must stay.
        const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
        // `includeUntracked: false` is not a style choice here — the whole point of this test is
        // "is this file TRACKED", so pulling in untracked files would defeat its purpose.
        const tracked = new Set(
          repoFiles({ under: rel, floor: 0, includeUntracked: false })
            .map((f) => f.rel.slice(rel.length + 1)), // repo-relative → plugin-relative
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

// ── The tarball's BYTES, not its name (#375) ──────────────────────────────────
// `vendoredPluginFreshness` now opens each committed .tgz and compares it to the plugin source.
// That guard is green on a healthy repo — which is exactly what a guard that checks NOTHING also
// looks like, and this repo's recurring defect. So this drives compareTarballToSource with
// deliberately drifted tarballs and asserts each kind of drift is actually reported. Real tar, real
// gzip, a throwaway plugin dir — never the repo's own.
describe('compareTarballToSource detects a tarball whose NAME is fine and whose BYTES are not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tgz-drift-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pluginDir = path.join(tmp, 'plugin');
  const tarball = path.join(tmp, 'fixture.tgz');

  /** A minimal plugin whose shipped set is `ios/Sources/` + `dist/` (plus npm's always-shipped
   *  package.json). No `src/`, so the dist is authoritative and its bytes ARE compared. */
  function writePlugin(native: string, dist: string) {
    fs.mkdirSync(path.join(pluginDir, 'ios', 'Sources'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name: 'capacitor-fixture', version: '1.0.0', files: ['ios/Sources/', 'dist/'],
    }, null, 2));
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Sources', 'Plugin.swift'), native);
    fs.writeFileSync(path.join(pluginDir, 'dist', 'plugin.js'), dist);
    // Not shipped (not in `files`) — a change here must never read as drift.
    fs.mkdirSync(path.join(pluginDir, 'ios', 'Tests'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Tests', 'PluginTests.swift'), '// tests\n');
  }

  /** Pack the plugin's shipped set the way npm pack lays it out: everything under `package/`. */
  function pack() {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tgz-stage-'));
    fs.cpSync(pluginDir, path.join(stage, 'package'), { recursive: true });
    fs.rmSync(path.join(stage, 'package', 'ios', 'Tests'), { recursive: true, force: true });
    tar.create({ file: tarball, sync: true, gzip: true, cwd: stage }, ['package']);
    fs.rmSync(stage, { recursive: true, force: true });
  }

  it('reports NOTHING when the tarball matches (the baseline this rests on)', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    const r = compareTarballToSource(tarball, pluginDir);
    expect(r.drift).toEqual([]);
    // The fileset really was walked — an empty drift from an unread tarball looks identical.
    expect(r.skipped.map((s) => s.path)).toContain('dist/plugin.js');
  });

  it('reports bytes-differ when the SOURCE moved on and the tarball did not — the #375 case', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Sources', 'Plugin.swift'), '// v2 native — the fix\n');
    expect(compareTarballToSource(tarball, pluginDir).drift)
      .toEqual([{ path: 'ios/Sources/Plugin.swift', kind: 'bytes-differ' }]);
  });

  it('stays SILENT on a changed dist — the toolchain-drift decision the vendorer already made', () => {
    // dist/ is gitignored and rebuilt per clone; a tsc/rollup patch bump changes its bytes with no
    // source change and no tarball rename (vendorPlugins.test.ts pins that: "does NOT re-pack when
    // ONLY the built dist/ changes"). A guard that failed here would demand a re-vendor of all 21
    // tarballs plus 21 lockfiles — the churn the vendorer exists to refuse.
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    fs.writeFileSync(path.join(pluginDir, 'dist', 'plugin.js'), '// built by a newer rollup\n');
    fs.writeFileSync(path.join(pluginDir, 'dist', 'plugin.cjs.js'), '// a file the newer build emits\n');
    expect(compareTarballToSource(tarball, pluginDir).drift).toEqual([]);
  });

  it('reports missing-from-tarball for a shipped file the tarball never got', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Sources', 'Extra.swift'), '// added after packing\n');
    expect(compareTarballToSource(tarball, pluginDir).drift)
      .toEqual([{ path: 'ios/Sources/Extra.swift', kind: 'missing-from-tarball' }]);
  });

  it('reports not-in-source for a tarball entry the plugin no longer has', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Sources', 'Doomed.swift'), '// deleted after packing\n');
    pack();
    fs.rmSync(path.join(pluginDir, 'ios', 'Sources', 'Doomed.swift'));
    expect(compareTarballToSource(tarball, pluginDir).drift)
      .toEqual([{ path: 'ios/Sources/Doomed.swift', kind: 'not-in-source' }]);
  });

  it('a NON-dist file differing only by CRLF IS drift — the exactness dist does not get', () => {
    // The scoping half of the previous test. `.gitattributes` pins eol=lf for every extension the
    // plugins ship, so a newline difference in shipped source is real drift, not a Windows
    // checkout — and nothing measured that until this test.
    writePlugin('// line one\n// line two\n', '// v1 js\n');
    pack();
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Sources', 'Plugin.swift'), '// line one\r\n// line two\r\n');
    expect(compareTarballToSource(tarball, pluginDir).drift)
      .toEqual([{ path: 'ios/Sources/Plugin.swift', kind: 'bytes-differ' }]);
  });

  it('needs no local dist at all — the state of every CI machine before build:plugins', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });
    // The old stamp-gated version compared nothing here; the version after it reported all 12
    // dist entries as `not-in-source`. Neither is right: dist is simply not this check's business.
    expect(compareTarballToSource(tarball, pluginDir).drift).toEqual([]);
  });

  it('stays silent on a NON-shipped file — the scoping that keeps this from crying wolf', () => {
    writePlugin('// v1 native\n', '// v1 js\n');
    pack();
    fs.writeFileSync(path.join(pluginDir, 'ios', 'Tests', 'PluginTests.swift'), '// edited tests\n');
    expect(compareTarballToSource(tarball, pluginDir).drift).toEqual([]);
  });
});

// ── #685: node_modules holding a PREVIOUS tarball's bytes while every OTHER signal (the `file:`
// spec, the lockfiles, the install marker) agrees the current one is installed — the state
// compareTarballToSource cannot see because it never opens node_modules. This drives
// verifyInstalledMatchesTarball with a hand-built project: a real gzip tarball under
// `<projectRoot>/plugins/`, and a real EXTRACTED copy under `<projectRoot>/node_modules/<plugin>`
// (via `tar.extract`, the same shape npm itself produces) that a test then mutates in place to
// simulate the poisoned state — never the tarball, only the installed copy, since that is exactly
// what #685 found: the tarball and every book-keeping signal were already correct.
describe('verifyInstalledMatchesTarball detects node_modules holding stale bytes (#685)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-installed-drift-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const PLUGIN = 'capacitor-installed-fixture';
  const REL_TGZ = `plugins/${PLUGIN}-1.0.0-deadbeef.tgz`;

  /** A throwaway project dir depending on PLUGIN via the exact `file:plugins/...` spec shape
   *  vendorEnginePlugins writes — the one verifyInstalledMatchesTarball recognizes. */
  function freshProjectRoot(): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'proj-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'installed-drift-fixture',
      dependencies: { [PLUGIN]: `file:${REL_TGZ}`, 'not-a-vendored-plugin': '^1.0.0' },
    }, null, 2));
    return dir;
  }

  /** Pack a real two-entry plugin (package.json + one native source file) to REL_TGZ, npm-pack
   *  layout (`package/...`), the same way the fixture above this block does. */
  function packTarball(projectRoot: string, nativeBody: string) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-installed-drift-stage-'));
    fs.mkdirSync(path.join(stage, 'package', 'ios', 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(stage, 'package', 'ios', 'Sources', 'Plugin.swift'), nativeBody);
    const tgzPath = path.join(projectRoot, REL_TGZ);
    fs.mkdirSync(path.dirname(tgzPath), { recursive: true });
    tar.create({ file: tgzPath, sync: true, gzip: true, cwd: stage }, ['package']);
    fs.rmSync(stage, { recursive: true, force: true });
  }

  /** Extract REL_TGZ into node_modules/<PLUGIN>, stripping the `package/` prefix — the same real
   *  npm-install shape verifyInstalledMatchesTarball's readTarball-based comparison expects. */
  function installFromTarball(projectRoot: string) {
    const dest = path.join(projectRoot, 'node_modules', PLUGIN);
    fs.mkdirSync(dest, { recursive: true });
    tar.extract({ file: path.join(projectRoot, REL_TGZ), cwd: dest, sync: true, strip: 1 });
  }

  it('reports NOTHING when the installed copy matches the tarball (the baseline this rests on)', () => {
    const projectRoot = freshProjectRoot();
    packTarball(projectRoot, '// v1\n');
    installFromTarball(projectRoot);
    expect(verifyInstalledMatchesTarball(projectRoot)).toEqual([]);
  });

  it('reports the plugin and names the differing file when the INSTALLED copy alone drifts (the #685 shape)', () => {
    const projectRoot = freshProjectRoot();
    packTarball(projectRoot, '// v1\n');
    installFromTarball(projectRoot);
    // The tarball and package.json never change — only node_modules does, exactly what #685 found.
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', PLUGIN, 'ios', 'Sources', 'Plugin.swift'),
      '// STALE — bytes from a previous tarball\n',
    );
    const problems = verifyInstalledMatchesTarball(projectRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PLUGIN);
    expect(problems[0]).toContain('ios/Sources/Plugin.swift');
  });

  it('does NOT flag node_modules/<plugin> being absent — the project may simply not be installed yet', () => {
    const projectRoot = freshProjectRoot();
    packTarball(projectRoot, '// v1\n');
    // Deliberately no installFromTarball() — node_modules/<PLUGIN> does not exist at all.
    expect(verifyInstalledMatchesTarball(projectRoot)).toEqual([]);
  });

  it('reports a missing vendored tarball', () => {
    const projectRoot = freshProjectRoot();
    // Deliberately no packTarball() — plugins/ (and the tarball it would contain) don't exist.
    const problems = verifyInstalledMatchesTarball(projectRoot);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PLUGIN);
    expect(problems[0]).toContain(REL_TGZ);
  });

  it('ignores a dependency that is not a vendored engine plugin (not a `file:plugins/*.tgz` spec)', () => {
    // A project depending ONLY on a normal registry dep — no `PLUGIN`, no plugins/, no
    // node_modules/ at all. If the non-vendored dep were mis-recognized as a vendored plugin, it
    // would report a missing tarball for it (there is no `plugins/` dir to find one in).
    const projectRoot = fs.mkdtempSync(path.join(tmp, 'proj-'));
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'no-vendored-plugins-fixture',
      dependencies: { 'not-a-vendored-plugin': '^1.0.0' },
    }, null, 2));
    expect(verifyInstalledMatchesTarball(projectRoot)).toEqual([]);
  });
});

// ── #685: a re-vendored tarball's FILENAME hash changes but its packed VERSION didn't, so npm's
// `file:` resolver saw "already satisfied" and skipped extraction — an APK/IPA silently shipped
// the PREVIOUS plugin. The fix: packInto writes `<base>-<hash>` into the PACKED package.json
// (never the committed source) for the duration of `npm pack`. These two blocks cover the two
// halves: compareTarballToSource must tolerate exactly that version diff (below, using the same
// hand-rolled real-tar fixture as the block above), and packInto's actual `npm pack` output must
// really carry it (further below, via a real, unmocked vendorEnginePlugins). ───────────────────
describe('compareTarballToSource tolerates the #685 packed-version suffix, nothing else', () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tgz-verdrift-'));
  afterAll(() => fs.rmSync(tmp2, { recursive: true, force: true }));

  const pluginDir2 = path.join(tmp2, 'plugin');
  const tarball2 = path.join(tmp2, 'fixture.tgz');

  function writePlugin2(native: string) {
    fs.rmSync(pluginDir2, { recursive: true, force: true });
    fs.mkdirSync(path.join(pluginDir2, 'ios', 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir2, 'package.json'), JSON.stringify({
      name: 'capacitor-fixture2', version: '1.0.0', files: ['ios/Sources/'],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(pluginDir2, 'ios', 'Sources', 'Plugin.swift'), native);
  }

  /** Pack the plugin the way packInto does (#685): a HASH-SUFFIXED version (`h`-prefixed, per
   *  packedVersion) in the PACKED package.json, with the source's own package.json restored to
   *  its original bytes immediately after — so this fixture exercises the exact shape
   *  compareTarballToSource must tolerate, without going through a real `npm pack`. */
  function packWithHashSuffixedVersion(hash: string) {
    const pj = path.join(pluginDir2, 'package.json');
    const original = fs.readFileSync(pj);
    const pkg = JSON.parse(original.toString('utf8'));
    pkg.version = `1.0.0-h${hash}`;
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n');
    try {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tgz-stage2-'));
      fs.cpSync(pluginDir2, path.join(stage, 'package'), { recursive: true });
      tar.create({ file: tarball2, sync: true, gzip: true, cwd: stage }, ['package']);
      fs.rmSync(stage, { recursive: true, force: true });
    } finally {
      fs.writeFileSync(pj, original);
    }
  }

  it('a tarball packed with the hash-suffixed version matches — the version diff alone is not drift', () => {
    writePlugin2('// v1 native\n');
    packWithHashSuffixedVersion('9ff1f461');
    expect(compareTarballToSource(tarball2, pluginDir2).drift).toEqual([]);
  });

  it('still reports drift when a DIFFERENT file is stale, even though the tarball IS hash-suffixed', () => {
    writePlugin2('// v1 native\n');
    packWithHashSuffixedVersion('9ff1f461');
    fs.writeFileSync(path.join(pluginDir2, 'ios', 'Sources', 'Plugin.swift'), '// v2 native — changed after pack\n');
    expect(compareTarballToSource(tarball2, pluginDir2).drift)
      .toEqual([{ path: 'ios/Sources/Plugin.swift', kind: 'bytes-differ' }]);
  });

  it('still reports drift on package.json itself when a NON-version field is stale', () => {
    writePlugin2('// v1 native\n');
    packWithHashSuffixedVersion('9ff1f461');
    const pj = path.join(pluginDir2, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
    pkg.name = 'capacitor-fixture2-renamed';
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n');
    expect(compareTarballToSource(tarball2, pluginDir2).drift)
      .toEqual([{ path: 'package.json', kind: 'bytes-differ' }]);
  });
});

/** A throwaway engine root + project, vendoring a minimal plugin with no `src/` (so no build is
 *  ever attempted — `canBuild:false` stays honest) through the REAL, unmocked
 *  vendorEnginePlugins — real `npm pack`, real gzip tarball, exactly what a clone runs. Shared
 *  by the two #685 describe blocks below. */
function makeFixture685() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor685-proj-'));
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor685-eng-'));
  const pluginDir = path.join(engineRoot, 'engine', 'packages', 'capacitor-fixture685');
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'capacitor-fixture685', version: '1.0.0', capacitor: { android: {}, ios: {} },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(pluginDir, 'dist', 'index.js'), '// built\n');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'vendor685-smoke', version: '0.0.0', dependencies: { 'capacitor-fixture685': '*' },
  }, null, 2) + '\n');
  return { projectRoot, engineRoot, pluginDir };
}

describe('packInto (#685): the REAL npm-packed tarball carries the hash-suffixed version', () => {

  it('the packed package.json version is <base>-h<hash>, and the PUBLISHED filename carries no h', () => {
    const { projectRoot, engineRoot, pluginDir } = makeFixture685();
    try {
      const r = vendorEnginePlugins(projectRoot, engineRoot, { canBuild: false });
      expect(r.changed).toBe(true);

      const pluginsDir = path.join(projectRoot, 'plugins');
      const tgzName = fs.readdirSync(pluginsDir).find((f) => f.endsWith('.tgz'));
      expect(tgzName).toBeTruthy();
      const hash = tgzName!.match(/-([0-9a-f]{8})\.tgz$/)?.[1];
      expect(hash).toBeTruthy();
      // The PUBLISHED filename (tarballName/destName) never carries the `h` — confirms
      // packInto's "find whatever .tgz npm produced, then copy it to destName" path actually
      // runs and renames npm's own `<name>-1.0.0-h<hash>.tgz` output to the un-prefixed name.
      expect(tgzName).toBe(`capacitor-fixture685-1.0.0-${hash}.tgz`);

      const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor685-extract-'));
      try {
        tar.extract({ file: path.join(pluginsDir, tgzName!), cwd: extractDir, sync: true });
        const packedPkg = JSON.parse(fs.readFileSync(path.join(extractDir, 'package', 'package.json'), 'utf8'));
        // The PACKED version, by contrast, DOES carry the `h` (#685 semver fix).
        expect(packedPkg.version).toBe(`1.0.0-h${hash}`);
      } finally {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
      // The COMMITTED source stays on its bare base version — only the packed copy carries
      // the suffix.
      expect(JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('packInto restores the plugin source package.json byte-identical after a REAL npm pack', () => {
    const { projectRoot, engineRoot, pluginDir } = makeFixture685();
    const originalBytes = fs.readFileSync(path.join(pluginDir, 'package.json'));
    try {
      const r = vendorEnginePlugins(projectRoot, engineRoot, { canBuild: false });
      expect(r.changed).toBe(true);
      expect(fs.readFileSync(path.join(pluginDir, 'package.json')).equals(originalBytes)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── #685 follow-up: the re-pack trigger fires on NAME-correct/VERSION-stale, and is idempotent ──
// A same-NAMED committed tarball (hash already matches current content — the `!fs.existsSync`
// fast path alone would call this "up to date") can still carry a bare/wrong PACKED version —
// exactly the state every one of the 22 real projects committed before packInto started writing
// packedVersion. This is the mutation check the owner asked for: build that exact bare-version
// state by hand (no re-vendor of any real project involved), confirm the vendorer heals it IN
// PLACE under the same filename, and confirm a second run does not re-pack again (no churn loop).
describe('vendorEnginePlugins: the #685 packed-version staleness trigger', () => {
  it('re-packs a same-named tarball whose PACKED version is still bare, then is idempotent', () => {
    const { projectRoot, engineRoot } = makeFixture685();
    try {
      const pluginDir = path.join(engineRoot, 'engine', 'packages', 'capacitor-fixture685');
      const hash = pluginContentHash(pluginDir);
      const destName = `capacitor-fixture685-1.0.0-${hash}.tgz`;
      const pluginsDir = path.join(projectRoot, 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });

      // Hand-build the exact pre-migration state: the tarball's NAME is already current (this
      // IS the plugin's real content hash), but its packed package.json is a bare `1.0.0` — no
      // `npm pack` / packInto involved, so this in no way depends on the fix under test.
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor685-bare-'));
      fs.mkdirSync(path.join(stage, 'package'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({
        name: 'capacitor-fixture685', version: '1.0.0', capacitor: { android: {}, ios: {} },
      }, null, 2) + '\n');
      tar.create({ file: path.join(pluginsDir, destName), sync: true, gzip: true, cwd: stage }, ['package']);
      fs.rmSync(stage, { recursive: true, force: true });
      expect(readPackedVersion(path.join(pluginsDir, destName))).toBe('1.0.0'); // precondition

      const first = vendorEnginePlugins(projectRoot, engineRoot, { canBuild: false });
      expect(first.changed).toBe(true); // must re-pack despite the already-correct filename

      // Healed IN PLACE — same filename, packed version now carries the hash (#685 + h-prefix).
      expect(fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.tgz'))).toEqual([destName]);
      expect(readPackedVersion(path.join(pluginsDir, destName))).toBe(`1.0.0-h${hash}`);

      // Idempotent: a second immediate run must NOT re-pack again (no churn loop).
      const second = vendorEnginePlugins(projectRoot, engineRoot, { canBuild: false });
      expect(second.changed).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── stampPluginBuild: the postinstall's stamp must mean what ensurePluginBuilt means (#395) ──
// `build:plugins` builds every plugin dist directly and used to write no stamp, so the next
// ensurePluginBuilt call judged a CURRENT dist stale and rebuilt it — deleting and recreating
// dist/ in the repo while the app lane was importing it, which failed `npm run verify` with a
// module-resolution error that never reproduced on a re-run. These pin the properties that make
// the stamp trustworthy; a stamp that is merely PRESENT would "fix" the flake while vouching for
// a stale dist, which is the quiet wrong build this must not become.
describe('stampPluginBuild marks a built dist current (#395)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-stamp-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A plugin dir with sources and (optionally) a built dist. */
  function makePlugin(name: string, opts: { dist?: boolean; src?: string } = {}): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), opts.src ?? 'export const a = 1;\n');
    if (opts.dist !== false) {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'plugin.js'), '// built\n');
    }
    return dir;
  }
  const stampOf = (dir: string) =>
    fs.readFileSync(path.join(dir, 'node_modules', '.modoki-buildstamp'), 'utf8').trim();

  it('writes a stamp when a built dist exists', () => {
    const dir = makePlugin('with-dist');
    expect(stampPluginBuild(dir)).toBe(true);
    expect(stampOf(dir)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses to vouch for a dist that does not exist', () => {
    const dir = makePlugin('no-dist', { dist: false });
    expect(stampPluginBuild(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules', '.modoki-buildstamp'))).toBe(false);
  });

  it('is SOURCE-derived, not a mere presence marker — editing src/ alone changes the stamp', () => {
    // ONE plugin dir, perturbed in place. An earlier version of this test compared two DIFFERENT
    // fixture dirs and was worthless: makePlugin writes the plugin NAME into package.json, and
    // package.json is itself in DIST_BUILD_CONFIG_FILES, so the two stamps differed because of the
    // name and the assertion could not attribute anything to src/. Nulling pluginSourceHash's src/
    // walk — the mutant that makes a source edit invisible to staleness detection, i.e. exactly the
    // silent-stale-build this guards — left that version GREEN.
    const dir = makePlugin('src-perturbed', { src: 'export const a = 1;\n' });
    expect(stampPluginBuild(dir)).toBe(true);
    const before = stampOf(dir);

    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 2;\n');
    expect(stampPluginBuild(dir)).toBe(true);
    expect(stampOf(dir)).not.toBe(before);
  });

  it('a NEW file under src/ changes the stamp too — not just an edit to a known one', () => {
    const dir = makePlugin('src-added');
    stampPluginBuild(dir);
    const before = stampOf(dir);
    fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export const b = 2;\n');
    stampPluginBuild(dir);
    expect(stampOf(dir)).not.toBe(before);
  });

  it('refuses to vouch when there are no sources to hash (a packaged editor ships a prebuilt dist)', () => {
    // pluginSourceHash returns null with no src/, and ensurePluginBuilt treats that shipped dist as
    // authoritative — so there is nothing for this to vouch for and it must not write a stamp.
    const dir = makePlugin('no-src');
    fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
    expect(stampPluginBuild(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules', '.modoki-buildstamp'))).toBe(false);
  });

  it('returns FALSE when the stamp could not actually be written', () => {
    // writeBuildStamp is best-effort and swallows its errors (read-only node_modules, ENOSPC), so
    // a `true` that only means "a write was attempted" makes the postinstall report work it did
    // not do — and that log is the only signal anyone has that #395 is fixed. Forced portably by
    // occupying the stamp path with a DIRECTORY, so writeFileSync fails with EISDIR.
    const dir = makePlugin('unwritable-stamp');
    fs.mkdirSync(path.join(dir, 'node_modules', '.modoki-buildstamp'), { recursive: true });
    expect(stampPluginBuild(dir)).toBe(false);
  });

  it('returns FALSE when a STALE stamp survives a failed write — not merely when none exists', () => {
    // Distinguishes `readBuildStamp(dir) === srcHash` from the weaker `readBuildStamp(dir) !== null`,
    // which passes every other case here. A stale stamp left behind by a failed write is exactly the
    // state that must not be reported as success: ensurePluginBuilt would compare it, disagree, and
    // rebuild — fine — but the postinstall would have claimed the plugin was stamped when it is not.
    const dir = makePlugin('stale-stamp-unwritable');
    const stampPath = path.join(dir, 'node_modules', '.modoki-buildstamp');
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, 'staleaaaaaaaaaaa');
    fs.chmodSync(stampPath, 0o444); // read-only: writeFileSync throws EPERM, content survives
    try {
      expect(stampPluginBuild(dir)).toBe(false);
      expect(fs.readFileSync(stampPath, 'utf8')).toBe('staleaaaaaaaaaaa'); // the write really did fail
    } finally {
      fs.chmodSync(stampPath, 0o666); // else afterAll's rmSync cannot remove it on Windows
    }
  });

  it('is deterministic — restamping identical sources yields the same value', () => {
    const dir = makePlugin('stable');
    stampPluginBuild(dir);
    const first = stampOf(dir);
    stampPluginBuild(dir);
    expect(stampOf(dir)).toBe(first);
  });
});

// ── The stamper may only vouch for what `build:plugins` actually built (#395) ─────────────
// listEnginePlugins DISCOVERS every engine/packages/* declaring a `capacitor` field, while
// build:plugins is a hand-written --workspace list, and the two are ALLOWED to diverge:
// pluginBuildCoverage.test.ts states that scope deliberately ("a plugin used solely by a game
// … is deliberately not required here"). Stamping the discovered set would vouch for a plugin
// this install never built — and if such a plugin has a stale dist/ from an earlier build, the
// stamp is computed from its CURRENT sources, ensurePluginBuilt short-circuits forever, and
// packInto ships a tarball whose name is current and whose bytes are stale. That is the #90
// failure the stamp machinery exists to prevent, so the derivation is the safety property.
describe('stamp-plugin-builds derives its set from build:plugins, not from discovery (#395)', () => {
  it('parses every --workspace out of the real build:plugins script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const script: string = pkg.scripts['build:plugins'];
    const occurrences = (script.match(/--workspace/g) ?? []).length;
    const parsed = buildPluginsWorkspaces(pkg);
    expect(parsed.length).toBe(occurrences);
    expect(occurrences).toBeGreaterThan(0);
    for (const rel of parsed) {
      expect(fs.existsSync(path.join(repoRoot, rel, 'package.json')), `${rel} should exist`).toBe(true);
    }
  });

  it('yields nothing when build:plugins is absent or reshaped — stamping nothing beats stamping wrongly', () => {
    expect(buildPluginsWorkspaces({ scripts: {} })).toEqual([]);
    expect(buildPluginsWorkspaces({})).toEqual([]);
    expect(buildPluginsWorkspaces({ scripts: { 'build:plugins': 'npm run build' } })).toEqual([]);
  });

  it('accepts both --workspace=x and --workspace x', () => {
    expect(buildPluginsWorkspaces({ scripts: { 'build:plugins': 'npm run build --workspace=a --workspace b' } }))
      .toEqual(['a', 'b']);
  });

  it('plans from build:plugins, NOT from the wider discovered set', () => {
    // THE distinguishing assertion for #395's safety property. listEnginePlugins discovers 4 cap
    // plugins under engine/packages; a stamper consulting discovery would return all 4 regardless
    // of the script. Handing it a package.json naming ONE workspace must yield exactly ONE dir —
    // a result the discovery-based stamper cannot produce. Today the two sets happen to be
    // identical, so nothing else in the suite can tell them apart.
    const discovered = fs.readdirSync(enginePkgs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(enginePkgs, e.name, 'package.json')))
      .filter((e) => {
        try { return !!JSON.parse(fs.readFileSync(path.join(enginePkgs, e.name, 'package.json'), 'utf8')).capacitor; }
        catch { return false; }
      });
    expect(discovered.length).toBeGreaterThan(1); // otherwise this test proves nothing

    const planned = plannedStampDirs(repoRoot, {
      scripts: { 'build:plugins': 'npm run build --workspace engine/packages/capacitor-game-debug' },
    });
    expect(planned.map((p) => p.rel)).toEqual(['engine/packages/capacitor-game-debug']);
    expect(planned[0].dir).toBe(path.resolve(repoRoot, 'engine/packages/capacitor-game-debug'));
  });

  it('postinstall still runs the stamper — deleting the link reinstates #395 with every gate green', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const postinstall: string = pkg.scripts.postinstall;
    expect(postinstall).toContain('stamp-plugin-builds.mjs');
    // Order is the correctness argument: a failed build must never reach the stamper.
    expect(postinstall.indexOf('build:plugins')).toBeLessThan(postinstall.indexOf('stamp-plugin-builds.mjs'));
    expect(postinstall.slice(postinstall.indexOf('build:plugins'), postinstall.indexOf('stamp-plugin-builds.mjs'))).toContain('&&');
  });
});
