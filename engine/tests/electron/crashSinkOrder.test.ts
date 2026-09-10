// @vitest-environment node
// esbuild needs a native TextEncoder (its startup invariant) and jsdom's polyfill breaks it —
// same reason mainBundleExternals.test.ts and mcpBundle.test.ts run under node.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronOpts, electronDir } from '../../scripts/electronBuildOpts.mjs';

/**
 * #1043 — a crash during MODULE EVALUATION must still leave a file behind.
 *
 * ⚠️ **The bar this suite has to clear is stated in the issue itself: a test that only covers a
 * throw AFTER `initFileLog()` cannot fail on this bug.** The whole defect is that forty hoisted
 * imports evaluate before `initFileLog()` runs, so anything thrown there had no handler and no
 * open log to reach — no stdout either, since a Finder-launched .app and any Windows GUI launch
 * have no terminal. So the cases below drive REAL module evaluation in a REAL child process, and
 * the ordering case builds with the SHIPPED esbuild options rather than a private copy of them
 * (#945 B1: a verification that rebuilds its own idea of what ships cannot fail when the shipped
 * thing is wrong).
 */

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-crashsink-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('the sink is installed before anything else can throw (#1043)', () => {
  /** SOURCE case. Cheap, and it is the line a human actually edits. */
  it('`./crashSink` is the FIRST import in main.ts', () => {
    const src = fs.readFileSync(path.join(electronDir, 'main.ts'), 'utf8');
    const firstImport = /^import\s.*$/m.exec(src);
    expect(firstImport, 'main.ts has no imports at all — something is very wrong').not.toBeNull();
    expect(
      firstImport?.[0],
      'main.ts must import ./crashSink FIRST (#1043). Imports are hoisted and evaluated in source '
        + 'order, so any import above it evaluates with no crash handler installed — which is the '
        + 'window where a throw produces no stdout and no main.log at all.',
    ).toBe("import './crashSink';");
  });

  /**
   * BUNDLE case — the one that matters, because what ships is not ESM.
   *
   * ⚠️ ESM's evaluation-order guarantee does not automatically survive bundling to CJS, and this
   * repo ships `format: 'cjs'` + `packages: 'external'`. Measured here rather than assumed:
   * esbuild inlines bundled modules in SOURCE ORDER and leaves an external `require("electron")`
   * at its own source position rather than hoisting it above them.
   */
  it('survives bundling: the sink runs before require("electron") and before other modules', () => {
    const outdir = path.join(tmp, 'bundle');
    esbuild.buildSync({ ...electronOpts({ outdir, sourcemap: false, logLevel: 'silent' }) });
    const code = fs.readFileSync(path.join(outdir, 'main.cjs'), 'utf8');

    // ⚠️ Anchored on a string ONLY crashSink has. `'modoki-logs'` also appears in
    // `fileLog.ts`'s pre-app fallback, and it works today only because fileLog is emitted after
    // electron — if anything ever pulled fileLog into an early module, `indexOf` would find THAT
    // copy and this assertion would pass with the sink at the bottom of the bundle.
    const sink = code.indexOf('installEarlyCrashSink');
    const electron = code.indexOf('require("electron")');
    expect(sink, 'crashSink body not found in the bundle at all').toBeGreaterThan(-1);
    expect(electron, 'no external electron require in the bundle').toBeGreaterThan(-1);
    expect(
      sink,
      'the crash sink must be emitted BEFORE electron is required, or the window it exists to '
        + 'cover starts before it does (#1043).',
    ).toBeLessThan(electron);
  });
});

describe('a throw during module evaluation leaves a file (#1043)', () => {
  /** Build a miniature of main.ts's real shape — sink first, then a module that dies while being
   *  evaluated — with the SHIPPED bundler settings, and run it in a child process. */
  function buildAndRun(entrySrc: string, dir: string): { code: number | null; logDir: string } {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'boom.ts'), 'throw new Error("EXPLODED DURING MODULE EVAL");\nexport const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'entry.ts'), entrySrc);
    const outfile = path.join(dir, 'out.cjs');
    esbuild.buildSync({
      entryPoints: [path.join(dir, 'entry.ts')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node20',
      external: ['electron'], packages: 'external', outfile, logLevel: 'silent',
    });
    const logDir = path.join(dir, 'tmphome');
    fs.mkdirSync(logDir, { recursive: true });
    let code: number | null = 0;
    try {
      execFileSync(process.execPath, [outfile], {
        // ⚠️ ALL THREE. `os.tmpdir()` reads `TMPDIR` on POSIX but `TEMP || TMP` on win32 and
        // never `TMPDIR` — so a TMPDIR-only env sent the child's log to the runner's real temp
        // dir on Windows, where the positive cases fail and the falsification case passes
        // VACUOUSLY. This file ships in the OSS snapshot and public CI runs ubuntu + windows +
        // macos-14, so that is a red gate on the next push to main, not a hypothetical.
        env: { ...process.env, TMPDIR: logDir, TEMP: logDir, TMP: logDir }, stdio: 'pipe',
      });
    } catch (e) { code = (e as { status?: number }).status ?? null; }
    return { code, logDir };
  }

  const sinkPath = path.join(electronDir, 'crashSink.ts').replace(/\\/g, '/');

  it('records the stack when a LATER module throws while being evaluated', () => {
    const dir = path.join(tmp, 'eval-throw');
    const { code, logDir } = buildAndRun(`import '${sinkPath}';\nimport './boom';\nconsole.log('never');\n`, dir);
    // ⚠️ PINNED, because installing an `uncaughtException` listener SUPPRESSES Node's default
    // termination — under bare node this boot now exits 0 where it used to exit 1. Measured, and
    // accepted: nothing runs `main.cjs` under plain node, and under Electron the outcome is
    // unchanged either way (its own loader catches a module-eval throw and raises a native modal,
    // so the process hangs with or without this sink — which is #1035's documented shape). If
    // this number ever moves, the trade above has changed and needs re-deciding.
    expect(code).toBe(0);
    const log = path.join(logDir, 'modoki-logs', 'early-crash.log');
    expect(fs.existsSync(log), 'no early-crash.log was written for a module-eval throw').toBe(true);
    const body = fs.readFileSync(log, 'utf8');
    expect(body).toMatch(/uncaughtException/);
    expect(body).toMatch(/EXPLODED DURING MODULE EVAL/);
    expect(body, 'the stack, not just the message — that is the whole point').toMatch(/boom\.ts|at /);
  });

  /** ⚠️ The falsification. With the import order reversed the sink is installed AFTER the module
   *  that dies, so nothing is recorded — which is precisely #1043. If this case ever starts
   *  producing a file, the case above has stopped proving anything. */
  it('records NOTHING when the sink is imported after the throwing module (the bug, as a test)', () => {
    const dir = path.join(tmp, 'eval-throw-late');
    const { code, logDir } = buildAndRun(`import './boom';\nimport '${sinkPath}';\nconsole.log('never');\n`, dir);
    // ⚠️ EXACTLY 1 — Node's uncaught-exception exit — not merely "not 0". `code` is `null` when
    // execFileSync throws WITHOUT a status (spawn failure, ENOENT, killed by a signal), and
    // `expect(null).not.toBe(0)` passes for a child that never ran at all, which would also
    // satisfy the "no log file" assertion below. The loose form made this case vacuous in exactly
    // the scenario it is supposed to rule out.
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(logDir, 'modoki-logs', 'early-crash.log'))).toBe(false);
  });

  it('records an unhandled REJECTION too, not only a throw', () => {
    const dir = path.join(tmp, 'rejection');
    const { logDir } = buildAndRun(
      `import '${sinkPath}';\nPromise.reject(new Error('REJECTED EARLY'));\nsetTimeout(() => {}, 50);\n`, dir,
    );
    const log = path.join(logDir, 'modoki-logs', 'early-crash.log');
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toMatch(/unhandledRejection[\s\S]*REJECTED EARLY/);
  });
});

describe('recordEarlyCrash is safe to call while the process is dying', () => {
  let mod: typeof import('../../electron/crashSink');
  beforeEach(async () => { mod = await import('../../electron/crashSink'); });

  /** ⚠️ It runs INSIDE a crash handler. A throw here would replace the crash the user needs to
   *  see with one from the thing reporting it, so every failure is swallowed — deliberately. */
  it('does not throw when the log directory cannot be created', () => {
    const original = fs.mkdirSync;
    (fs as { mkdirSync: unknown }).mkdirSync = () => { throw new Error('EACCES'); };
    try {
      expect(() => mod.recordEarlyCrash('uncaughtException', new Error('x'))).not.toThrow();
    } finally { (fs as { mkdirSync: unknown }).mkdirSync = original; }
  });

  it('does not throw on a non-Error value', () => {
    expect(() => mod.recordEarlyCrash('uncaughtException', { weird: true })).not.toThrow();
    expect(() => mod.recordEarlyCrash('uncaughtException', undefined)).not.toThrow();
  });
});
