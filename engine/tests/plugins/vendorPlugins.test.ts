/** vendorEnginePlugins — vendors engine Capacitor plugins into a game project as
 *  content-addressed tarball COPIES (never symlinks). Exercised against temp
 *  project + engine dirs with `npm pack` / `npm run build` mocked so the suite is
 *  hermetic (no real npm, no network). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock npm: `npm pack` writes a deterministic tarball into --pack-destination;
// `npm run build` materializes a dist/ dir. Lets us assert pack invocations.
const execFileSyncMock = vi.fn((_cmd: string, args: string[], opts: { cwd?: string } = {}) => {
  if (args[0] === 'pack') {
    const destIdx = args.indexOf('--pack-destination');
    const dest = args[destIdx + 1];
    fs.writeFileSync(path.join(dest, 'pkg-0.0.0.tgz'), 'TARBALL-BYTES');
  } else if (args[0] === 'run' && args[1] === 'build' && opts.cwd) {
    fs.mkdirSync(path.join(opts.cwd, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(opts.cwd, 'dist', 'index.js'), '// built');
  }
  return Buffer.from('');
});
const execFileSyncExport = (...a: unknown[]) => execFileSyncMock(...(a as [string, string[], object]));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncExport, default: { execFileSync: execFileSyncExport } }));

// Import AFTER the mock is registered.
const { vendorEnginePlugins } = await import('../../plugins/vendorPlugins');

let projectRoot: string;
let engineRoot: string;
const PLUGIN = 'capacitor-game-debug';

/** Create an engine plugin under engineRoot/engine/packages/<name>. */
function writeEnginePlugin(name = PLUGIN, version = '1.0.0', withDist = true) {
  const dir = path.join(engineRoot, 'engine', 'packages', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, capacitor: { android: {}, ios: {} } }));
  fs.writeFileSync(path.join(dir, 'src.swift'), 'plugin source v1');
  if (withDist) {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '// built');
  }
  return dir;
}

function writeProjectPkg(deps: Record<string, string> = {}) {
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'g', dependencies: deps }, null, 2) + '\n');
}
function readDeps(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).dependencies;
}
function listTarballs(): string[] {
  const p = path.join(projectRoot, 'plugins');
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.tgz')).sort() : [];
}
/** Mark the plugin as already-installed (real dir) AND write the install marker
 *  the editor writes post-install, so a follow-up vendor pass sees it as current. */
function installRealCopy(name = PLUGIN) {
  const nm = path.join(projectRoot, 'node_modules', name);
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'), '{}');
  const markerPath = path.join(projectRoot, 'node_modules', '.modoki-vendored.json');
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : {};
  marker[name] = readDeps()[name]; // current file:plugins/<…>.tgz spec
  fs.writeFileSync(markerPath, JSON.stringify(marker));
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor-proj-'));
  engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor-eng-'));
  execFileSyncMock.mockClear();
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(engineRoot, { recursive: true, force: true });
});

describe('vendorEnginePlugins', () => {
  it('packs the plugin and rewrites the dep spec to the content-addressed tarball', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });

    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    expect(r.vendored).toEqual([PLUGIN]);
    const tgz = listTarballs();
    expect(tgz).toHaveLength(1);
    expect(tgz[0]).toMatch(/^capacitor-game-debug-1\.0\.0-[0-9a-f]{8}\.tgz$/);
    expect(readDeps()[PLUGIN]).toBe(`file:plugins/${tgz[0]}`);
    // not installed yet → caller must reinstall
    expect(r.needsInstall).toBe(true);
  });

  /** Regression: a clone whose dist/ predates a source change used to pack that
   *  STALE dist. Because the content hash was taken FROM the stale dist, the name
   *  matched the already-committed tarball, so nothing re-packed and
   *  ensurePluginBuilt (reached only via packInto) never ran — a permanent no-op
   *  that shipped a plugin missing its newest API. Real instance: the committed
   *  capacitor-game-debug tarball lacked getDeviceIp in dist AND native. */
  describe('stale dist detection', () => {
    /** A plugin with REAL sources (a src/ dir), so the build stamp applies.
     *  writeEnginePlugin's `src.swift` is a file, not a source dir. */
    function writeSourcedPlugin(srcBody: string) {
      const dir = writeEnginePlugin();
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), srcBody);
      return dir;
    }
    const buildCalls = () =>
      execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'run' && c[1][1] === 'build').length;

    it('REBUILDS when sources changed since dist was built (stale dist)', () => {
      const dir = writeSourcedPlugin('export const v = 1');
      writeProjectPkg({ [PLUGIN]: '*' });
      vendorEnginePlugins(projectRoot, engineRoot); // builds + stamps
      installRealCopy();
      execFileSyncMock.mockClear();

      // Source moves on; dist on disk is now stale.
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const v = 2');
      vendorEnginePlugins(projectRoot, engineRoot);

      expect(buildCalls()).toBe(1);
    });

    it('does NOT rebuild when sources are unchanged (stamp hit)', () => {
      writeSourcedPlugin('export const v = 1');
      writeProjectPkg({ [PLUGIN]: '*' });
      vendorEnginePlugins(projectRoot, engineRoot);
      installRealCopy();
      execFileSyncMock.mockClear();

      vendorEnginePlugins(projectRoot, engineRoot);

      expect(buildCalls()).toBe(0);
    });

    it('the build stamp is NOT part of the shipped fileset (no spurious re-pack)', () => {
      writeSourcedPlugin('export const v = 1');
      writeProjectPkg({ [PLUGIN]: '*' });
      vendorEnginePlugins(projectRoot, engineRoot);
      installRealCopy();
      const before = listTarballs();

      const r = vendorEnginePlugins(projectRoot, engineRoot);

      expect(r.changed).toBe(false);
      expect(listTarballs()).toEqual(before);
    });
  });

  it('migrates an old file:../../engine directory-symlink spec to the tarball copy', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: 'file:../../engine/packages/capacitor-game-debug' });

    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    expect(readDeps()[PLUGIN]).toMatch(/^file:plugins\/capacitor-game-debug-1\.0\.0-[0-9a-f]{8}\.tgz$/);
  });

  it('is idempotent — second pass does NOT re-pack or rewrite, and reports no work', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot); // first pass packs
    installRealCopy(); // pretend the install happened
    const packCallsAfterFirst = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;
    const pkgBefore = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');

    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);
    expect(r.needsInstall).toBe(false);
    expect(r.vendored).toEqual([]);
    // no new pack invocation (tarball already content-addressed on disk)
    const packCallsAfterSecond = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;
    expect(packCallsAfterSecond).toBe(packCallsAfterFirst);
    // package.json untouched
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(pkgBefore);
  });

  it('re-packs under a NEW hash when the plugin content changes, and drops the stale tarball', () => {
    const dir = writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const first = listTarballs();
    expect(first).toHaveLength(1);

    // change plugin content → new content hash → new tarball name
    fs.writeFileSync(path.join(dir, 'src.swift'), 'plugin source v2 CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    const after = listTarballs();
    expect(after).toHaveLength(1); // stale one dropped
    expect(after[0]).not.toBe(first[0]); // different hash
    expect(readDeps()[PLUGIN]).toBe(`file:plugins/${after[0]}`);
  });

  it('does NOT re-pack when the content-addressed tarball already exists on disk (committed-tarball fast path)', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot); // creates the committed tarball
    const tgz = listTarballs()[0];
    // simulate a fresh clone: blow away node_modules but KEEP the committed tarball + spec
    const packsBefore = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;

    const r = vendorEnginePlugins(projectRoot, engineRoot);

    const packsAfter = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;
    expect(packsAfter).toBe(packsBefore); // committed tarball reused, no re-pack
    expect(listTarballs()).toEqual([tgz]);
    // spec already correct, but copy missing from node_modules → reinstall flagged
    expect(r.needsInstall).toBe(true);
  });

  it('flags needsInstall when node_modules was extracted from an OLDER tarball (D3)', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    installRealCopy(); // real dir + marker matching the current spec
    // Simulate a `git pull` that brought a new committed tarball + package.json
    // spec but did NOT touch node_modules: the marker now points at an old spec.
    const markerPath = path.join(projectRoot, 'node_modules', '.modoki-vendored.json');
    fs.writeFileSync(markerPath, JSON.stringify({ [PLUGIN]: 'file:plugins/capacitor-game-debug-1.0.0-deadbeef.tgz' }));

    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r.changed).toBe(false); // spec + tarball already current
    expect(r.needsInstall).toBe(true); // but the installed copy is stale
  });

  // Skipped on Windows: this test SETS UP the "old symlink form" via fs.symlinkSync, which
  // needs elevation / Developer Mode on Windows. The detection logic is OS-agnostic and
  // exercised on macOS/Linux CI.
  it.skipIf(process.platform === 'win32')('flags needsInstall when the installed copy is still the OLD symlink form', () => {
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    // install as a symlink (the pre-migration form)
    const nm = path.join(projectRoot, 'node_modules', PLUGIN);
    fs.mkdirSync(path.dirname(nm), { recursive: true });
    fs.symlinkSync(path.join(engineRoot, 'engine', 'packages', PLUGIN), nm, 'dir');

    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r.needsInstall).toBe(true);
  });

  it('does NOT delete the existing tarball when npm pack fails (D4)', () => {
    const dir = writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot); // creates the initial tarball
    const before = listTarballs();
    expect(before).toHaveLength(1);

    // Change content → a re-pack is attempted under a new hash, but make it throw.
    fs.writeFileSync(path.join(dir, 'src.swift'), 'changed-v2');
    execFileSyncMock.mockImplementationOnce((_c: string, args: string[]) => {
      if (args[0] === 'pack') throw new Error('npm pack boom');
      return Buffer.from('');
    });
    expect(() => vendorEnginePlugins(projectRoot, engineRoot)).toThrow(/boom/);
    // The pre-existing tarball must survive (deletion happens only AFTER a good pack).
    expect(listTarballs()).toEqual(before);
  });

  it('ignores engine plugins the project does not depend on', () => {
    writeEnginePlugin();
    writeProjectPkg({ 'some-other-dep': '^1.0.0' }); // does NOT depend on the plugin

    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r.changed).toBe(false);
    expect(r.vendored).toEqual([]);
    expect(listTarballs()).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('builds the plugin dist on demand when missing before packing', () => {
    writeEnginePlugin(PLUGIN, '1.0.0', /*withDist*/ false);
    writeProjectPkg({ [PLUGIN]: '*' });

    vendorEnginePlugins(projectRoot, engineRoot);

    const built = execFileSyncMock.mock.calls.some((c) => c[1][0] === 'run' && c[1][1] === 'build');
    expect(built).toBe(true);
  });

  it('returns a no-op result when the project has no package.json', () => {
    writeEnginePlugin();
    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r).toEqual({ changed: false, needsInstall: false, vendored: [], expectedVendor: {} });
  });

  it('returns a no-op result when package.json has no dependencies', () => {
    writeEnginePlugin();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'g' }) + '\n');
    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r.changed).toBe(false);
    expect(r.vendored).toEqual([]);
  });

  it('content hash is stable across machines — same bytes in different fs order yield the same tarball', () => {
    // Two engine roots with identical plugin content but files created in a
    // different order; the content-addressed name must be identical.
    writeEnginePlugin();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const nameA = listTarballs()[0];

    const engineRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor-eng2-'));
    const projectRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-vendor-proj2-'));
    try {
      const dir2 = path.join(engineRoot2, 'engine', 'packages', PLUGIN);
      fs.mkdirSync(path.join(dir2, 'dist'), { recursive: true });
      // create files in reverse order
      fs.writeFileSync(path.join(dir2, 'dist', 'index.js'), '// built');
      fs.writeFileSync(path.join(dir2, 'src.swift'), 'plugin source v1');
      fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0', capacitor: { android: {}, ios: {} } }));
      fs.writeFileSync(path.join(projectRoot2, 'package.json'), JSON.stringify({ name: 'g', dependencies: { [PLUGIN]: '*' } }, null, 2) + '\n');

      vendorEnginePlugins(projectRoot2, engineRoot2);
      const nameB = fs.readdirSync(path.join(projectRoot2, 'plugins')).find((f) => f.endsWith('.tgz'));
      expect(nameB).toBe(nameA);
    } finally {
      fs.rmSync(engineRoot2, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });
});

// The content hash is scoped to (the SHIPPED fileset − dist/) ∪ (dist BUILD INPUTS:
// src/ + build config). So a shipped or build-input change (src/, ios/Sources,
// manifest, README) DOES rename the content-addressed tarball, while the volatile
// dist/ and NON-shipped, NON-build-input dev files (the plugin's own unit tests,
// test-vectors, lockfiles) do NOT. This kills two churn vectors: a toolchain-only
// dist/ drift, and — the one this scoping adds — editing plugin test files renaming
// every vendoring game's committed tarball though the shipped bytes never changed.
describe('vendorEnginePlugins — hash scoped to (shipped ∪ dist-build-inputs)', () => {
  /** A plugin with a built `dist/` (derived output) alongside its source inputs
   *  (src/, native ios/, manifest) and a lockfile npm always excludes. */
  function writePluginWithFiles(name = PLUGIN, version = '1.0.0') {
    const dir = path.join(engineRoot, 'engine', 'packages', name);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ios', 'Sources'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version, capacitor: { android: {}, ios: {} },
      files: ['dist/', 'ios/Sources/', 'Package.swift'],
    }));
    fs.writeFileSync(path.join(dir, 'dist', 'plugin.js'), '// built runtime');
    fs.writeFileSync(path.join(dir, 'ios', 'Sources', 'Plugin.swift'), 'source swift');
    fs.writeFileSync(path.join(dir, 'Package.swift'), 'source manifest');
    fs.writeFileSync(path.join(dir, 'README.md'), 'source readme');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'source v1');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":1}');
    return dir;
  }

  it('does NOT re-pack when ONLY the built dist/ changes (toolchain-drift churn killer)', () => {
    // The whole point: dist/ is a build artifact that drifts with tsc/rollup
    // versions across clones + over time. A dist-only delta must NOT rename the
    // tarball, or every `npm install` re-vendors and commits a "sync tgz" churn.
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    expect(before).toHaveLength(1);
    installRealCopy();
    const packsBefore = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;

    // Simulate a toolchain-drift rebuild: dist/ bytes change, source is untouched.
    fs.writeFileSync(path.join(dir, 'dist', 'plugin.js'), '// built runtime (different tsc/rollup)');
    fs.writeFileSync(path.join(dir, 'dist', 'plugin.cjs.js'), '// new file the newer build emits');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);            // no spurious re-pack
    expect(listTarballs()).toEqual(before);   // same content-addressed name
    const packsAfter = execFileSyncMock.mock.calls.filter((c) => c[1][0] === 'pack').length;
    expect(packsAfter).toBe(packsBefore);
  });

  it('does NOT re-pack when native build output/cache appears (android/build, .gradle)', () => {
    // Gradle emits android/build + android/.gradle on a native build — derived,
    // gitignored, machine-specific. Hashing them would make the tarball name
    // depend on whether Android was built locally (a second churn vector).
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    installRealCopy();

    fs.mkdirSync(path.join(dir, 'android', 'build', 'intermediates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', 'build', 'intermediates', 'App.class'), 'BYTECODE');
    fs.mkdirSync(path.join(dir, 'android', '.gradle', '9.2.0'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', '.gradle', '9.2.0', 'fileHashes.bin'), 'GRADLE CACHE');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);
    expect(listTarballs()).toEqual(before);
  });

  it('DOES re-pack under a new hash when a SOURCE input changes (src/)', () => {
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'source v2 CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    const after = listTarballs();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before); // new content hash
  });

  it('DOES re-pack when a native source input changes (ios/Sources)', () => {
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    fs.writeFileSync(path.join(dir, 'ios', 'Sources', 'Plugin.swift'), 'source swift CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    expect(listTarballs()[0]).not.toBe(before);
  });

  it('does NOT re-pack when only the lockfile changes (npm-always-excluded)', () => {
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    installRealCopy();

    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":2}');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);
    expect(listTarballs()).toEqual(before);
  });

  it('a machine-local junk file (.DS_Store) inside a source dir does not affect the hash', () => {
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    installRealCopy();

    fs.writeFileSync(path.join(dir, 'ios', 'Sources', '.DS_Store'), 'FINDER JUNK');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);
    expect(listTarballs()).toEqual(before);
  });

  it('does NOT re-pack when a NON-shipped plugin TEST file changes (the spurious re-pin this fixes)', () => {
    // android/src/test, ios/Tests, test-vectors are in NEITHER the `files` allowlist
    // nor the dist build inputs — so editing them must not rename the vendored tarball.
    // This is the exact churn that dirtied games/<id>/plugins on every editor bootstrap
    // after the device-lease work added the plugin's unit tests.
    const dir = writePluginWithFiles();
    fs.mkdirSync(path.join(dir, 'ios', 'Tests', 'PluginTests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ios', 'Tests', 'PluginTests', 'PluginTests.swift'), 'test v1');
    fs.mkdirSync(path.join(dir, 'test-vectors'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-vectors', 'golden.json'), '{"v":1}');
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    expect(before).toHaveLength(1);
    installRealCopy();

    fs.writeFileSync(path.join(dir, 'ios', 'Tests', 'PluginTests', 'PluginTests.swift'), 'test v2 CHANGED');
    fs.writeFileSync(path.join(dir, 'test-vectors', 'golden.json'), '{"v":2}');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);            // not shipped, not a build input → no re-pack
    expect(listTarballs()).toEqual(before);   // same content-addressed name
  });

  it('DOES re-pack when a SHIPPED README changes (npm ships it regardless of `files`)', () => {
    // README is outside `files` but npm always packs it, so it's part of the shipped
    // bytes — the never-under-hash-a-shipped-file guard.
    const dir = writePluginWithFiles();
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    fs.writeFileSync(path.join(dir, 'README.md'), 'source readme CHANGED — ships anyway');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    expect(listTarballs()[0]).not.toBe(before); // new content hash
  });

  it('a NON-shipped sibling sharing a files-entry PREFIX does not enter the hash (boundary)', () => {
    // Guards the `e + '/'` boundary in matchesFilesEntry: `ios/Sources2/` must NOT be
    // treated as under the `ios/Sources/` allowlist entry. A regression to startsWith(e)
    // (no slash) would hash it and spuriously re-pin on every edit.
    const dir = writePluginWithFiles(); // files includes 'ios/Sources/'
    fs.mkdirSync(path.join(dir, 'ios', 'Sources2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ios', 'Sources2', 'Decoy.swift'), 'decoy v1');
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs();
    installRealCopy();

    fs.writeFileSync(path.join(dir, 'ios', 'Sources2', 'Decoy.swift'), 'decoy v2 CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(false);            // ios/Sources2 is NOT under ios/Sources/
    expect(listTarballs()).toEqual(before);
  });

  it('an empty `files` array falls back to hashing ALL source inputs (not an empty allowlist)', () => {
    // readPackageFiles returns null for files:[] → the fallback path, same as a missing
    // field. A regression treating [] as an active empty allowlist would drop native src.
    const dir = writePluginWithFiles();
    const pj = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); pkg.files = []; fs.writeFileSync(pj, JSON.stringify(pkg));
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    // ios/Sources is native (not src/, not always-shipped): only the all-inputs fallback
    // hashes it, so editing it MUST re-pack when files:[] falls back.
    fs.writeFileSync(path.join(dir, 'ios', 'Sources', 'Plugin.swift'), 'native CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);
    expect(listTarballs()[0]).not.toBe(before);
  });

  it('a GLOB `files` entry falls back to all inputs, so a globbed shipped file is not under-hashed', () => {
    // matchesFilesEntry is a literal prefix matcher; 'assets/**' would never match
    // assets/logo.png. Rather than silently drop a shipped file (stale-tarball risk), a
    // glob entry forces the safe wide scope → editing the asset re-packs.
    const dir = writePluginWithFiles();
    const pj = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); pkg.files = ['dist/**', 'assets/**']; fs.writeFileSync(pj, JSON.stringify(pkg));
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), 'SVG v1');
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), 'SVG v2 CHANGED');
    const r = vendorEnginePlugins(projectRoot, engineRoot);

    expect(r.changed).toBe(true);              // glob → all-inputs fallback catches the shipped asset
    expect(listTarballs()[0]).not.toBe(before);
  });

  it('hashes source inputs even when there is no `files` field', () => {
    const dir = writeEnginePlugin(); // helper writes NO files field
    writeProjectPkg({ [PLUGIN]: '*' });
    vendorEnginePlugins(projectRoot, engineRoot);
    const before = listTarballs()[0];

    fs.writeFileSync(path.join(dir, 'src.swift'), 'changed');
    const r = vendorEnginePlugins(projectRoot, engineRoot);
    expect(r.changed).toBe(true);
    expect(listTarballs()[0]).not.toBe(before);
  });
});
