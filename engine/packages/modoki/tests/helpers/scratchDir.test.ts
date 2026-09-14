import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { makeScratchDir, pendingScratchDirs, removeScratchDirs } from './scratchDir';

const PKG_ROOT = path.resolve(__dirname, '../..');

describe('makeScratchDir', () => {
  it('creates a fresh dir named by the prefix under os.tmpdir(), and tracks it until removed', () => {
    const dir = makeScratchDir('modoki-scratch-unit-');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(path.dirname(dir)).toBe(os.tmpdir());
    expect(path.basename(dir)).toMatch(/^modoki-scratch-unit-.{6}$/);
    expect(pendingScratchDirs()).toContain(dir);

    removeScratchDirs();
    expect(fs.existsSync(dir)).toBe(false);
    expect(pendingScratchDirs()).not.toContain(dir);
  });

  it('honours base and canonical', () => {
    const parent = makeScratchDir('modoki-scratch-parent-');
    const child = makeScratchDir('c-', { base: parent });
    expect(path.dirname(child)).toBe(parent);
    const canon = makeScratchDir('modoki-scratch-canon-', { canonical: true });
    expect(path.dirname(canon)).toBe(fs.realpathSync.native(os.tmpdir()));
    removeScratchDirs();
    expect([parent, child, canon].filter((d) => fs.existsSync(d))).toEqual([]);
  });

  it('does not fail on a dir the test already removed itself', () => {
    const dir = makeScratchDir('modoki-scratch-gone-');
    fs.rmSync(dir, { recursive: true });
    expect(() => removeScratchDirs()).not.toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'attempts every dir, then warns about the ones it could not remove, without throwing (POSIX, non-root: a read-only dir refuses the unlink)',
    () => {
      const parent = makeScratchDir('modoki-scratch-locked-');
      removeScratchDirs(); // take parent off the list; it is removed by hand below
      fs.mkdirSync(parent);
      const stuck = makeScratchDir('stuck-', { base: parent });
      fs.writeFileSync(path.join(stuck, 'f'), 'x');
      const free = makeScratchDir('modoki-scratch-free-');
      fs.chmodSync(stuck, 0o555);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const failed = removeScratchDirs();
        expect(failed).toEqual([expect.stringContaining(stuck)]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 scratch dir\(s\) could not be removed[\s\S]*stuck-/));
        expect(fs.existsSync(free)).toBe(false);
        expect(pendingScratchDirs()).toEqual([]);
      } finally {
        warn.mockRestore();
        fs.chmodSync(stuck, 0o755);
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it('installScratchDirCleanup registers an afterAll that removes what was created', async () => {
    vi.resetModules();
    const fresh = await import('./scratchDir');
    const hooks: Array<() => void> = [];
    fresh.installScratchDirCleanup((fn) => { hooks.push(fn); });
    expect(hooks).toHaveLength(1);
    const dir = fresh.makeScratchDir('modoki-scratch-hook-');
    hooks[0]();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses to create a dir in a module instance whose cleanup was never installed', async () => {
    vi.resetModules();
    const fresh = await import('./scratchDir');
    expect(() => fresh.makeScratchDir('modoki-scratch-uninstalled-')).toThrow(/cleanup is not installed/);
    expect(fresh.pendingScratchDirs()).toEqual([]);
  });
});

describe('makeScratchDir lifetime in a real vitest run', () => {
  const runFixture = (extraEnv: Record<string, string>) => {
    const work = makeScratchDir('modoki-scratch-child-');
    const reportFile = path.join(work, 'report.tsv');
    fs.writeFileSync(reportFile, '');
    // The package's real setup file, so this also proves that file installs the cleanup.
    const config = path.join(work, 'vitest.config.mjs');
    fs.writeFileSync(config, `export default ${JSON.stringify({
      root: PKG_ROOT,
      test: {
        include: ['tests/helpers/fixtures/scratchDirLifetime.fixture.ts'],
        setupFiles: ['./tests/setup.ts'],
        watch: false,
      },
    })};\n`);
    const vitestBin = path.resolve(PKG_ROOT, '../../../node_modules/vitest/vitest.mjs');
    // A child vitest that inherits this worker's VITEST_* variables believes it is already inside one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
    const run = spawnSync(process.execPath, [vitestBin, 'run', '--config', config], {
      cwd: PKG_ROOT,
      env: { ...env, SCRATCH_REPORT: reportFile, ...extraEnv },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    // The fixture's deliberate failure must actually have happened, or "removed after a failing
    // test" was never exercised.
    expect(run.status, output).toBe(1);
    expect(output).toContain('deliberate failure');

    const rows = fs.readFileSync(reportFile, 'utf8').trim().split('\n').map((l) => l.split('\t'));
    expect(rows.map(([where]) => where).sort()).toEqual(
      ['beforeAll', 'beforeEach', 'beforeEach', 'failing', 'module', 'passing'],
    );
    // Every one was created (a relative or empty path would make "does not exist" vacuous) ...
    for (const [, dir] of rows) expect(path.isAbsolute(dir) && path.basename(dir).startsWith('modoki-scratch-fixture-'), dir).toBe(true);
    return rows.map(([, dir]) => dir);
  };

  it('removes dirs from module scope, beforeAll, beforeEach, a passing test and a FAILING test once the file ends', () => {
    expect(runFixture({}).filter((dir) => fs.existsSync(dir))).toEqual([]);
  });

  it("KNOWN GAP: a file whose OWN afterAll throws skips the cleanup, and its dirs leak (the helper docblock says why)", () => {
    // Pinned so the documented gap stays true. If this starts removing them, move it to the case
    // above and update the helper docblock and docs/verify-and-ci.md § Scratch dirs.
    const dirs = runFixture({ SCRATCH_FIXTURE_THROW_AFTERALL: '1' });
    try {
      expect(dirs.filter((dir) => fs.existsSync(dir))).toHaveLength(dirs.length);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
