// @vitest-environment node
/** `engine/scripts/assertBundleUnchanged.mjs` — the smoke guard that fails when a packaged app
 *  writes into its OWN signed bundle (#326).
 *
 *  The semantics worth pinning are the two counter-intuitive ones, both of which were decided by
 *  measurement rather than taste: an added EMPTY DIRECTORY is not a violation (codesign does not
 *  seal one, and reporting it points at the wrong writer — that mistake cost a day chasing
 *  `.vite-temp` when the real writers were elsewhere), while a single added FILE is. Run as a
 *  subprocess, the way the smoke script runs it, so the exit code is what is asserted. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'engine', 'scripts', 'assertBundleUnchanged.mjs');

function run(mode: string, appDir: string, listFile: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [script, mode, appDir, listFile], { encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function fixture(): { dir: string; list: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'modoki-bundleguard-'));
  mkdirSync(path.join(dir, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(dir, 'Contents', 'Resources', 'app.asar'), 'x');
  writeFileSync(path.join(dir, 'Contents', 'Info.plist'), 'x');
  return { dir, list: path.join(dir, '..', `${path.basename(dir)}.txt`), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('assertBundleUnchanged', () => {
  it('passes when nothing changed', () => {
    const f = fixture();
    try {
      expect(run('snapshot', f.dir, f.list).status).toBe(0);
      const r = run('assert', f.dir, f.list);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/wrote nothing into its own bundle \(2 files\)/);
    } finally { f.cleanup(); rmSync(f.list, { force: true }); }
  });

  it('FAILS on an added file, and names it', () => {
    const f = fixture();
    try {
      run('snapshot', f.dir, f.list);
      mkdirSync(path.join(f.dir, 'Contents', 'Resources', 'node_modules', '.vite-temp'), { recursive: true });
      writeFileSync(path.join(f.dir, 'Contents', 'Resources', 'node_modules', '.vite-temp', 'x.mjs'), 'x');
      const r = run('assert', f.dir, f.list);
      expect(r.status).toBe(1);
      expect(r.out).toContain('+ Contents/Resources/node_modules/.vite-temp/x.mjs');
    } finally { f.cleanup(); rmSync(f.list, { force: true }); }
  });

  it('does NOT fail on an added EMPTY directory — codesign does not seal one', () => {
    // The whole reason listFiles() lists files and not directories. A completed Vite build leaves
    // exactly this: `.vite-temp` created, its temp file unlinked. Reporting it as a violation is
    // how the wrong writer gets blamed.
    const f = fixture();
    try {
      run('snapshot', f.dir, f.list);
      mkdirSync(path.join(f.dir, 'Contents', 'Resources', 'node_modules', '.vite-temp'), { recursive: true });
      expect(run('assert', f.dir, f.list).status).toBe(0);
    } finally { f.cleanup(); rmSync(f.list, { force: true }); }
  });

  it('FAILS on a REMOVED file — a deletion breaks the seal too', () => {
    const f = fixture();
    try {
      run('snapshot', f.dir, f.list);
      rmSync(path.join(f.dir, 'Contents', 'Info.plist'));
      const r = run('assert', f.dir, f.list);
      expect(r.status).toBe(1);
      expect(r.out).toContain('- Contents/Info.plist');
    } finally { f.cleanup(); rmSync(f.list, { force: true }); }
  });

  it('FAILS rather than passing vacuously on an empty snapshot', () => {
    const f = fixture();
    try {
      writeFileSync(f.list, '');
      const r = run('assert', f.dir, f.list);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/pass vacuously/);
    } finally { f.cleanup(); rmSync(f.list, { force: true }); }
  });
});
