import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PACKAGING GUARD — no hardcoded POSIX-only paths in packaged-app code.
 *
 * The Electron main process + toolchain run VERBATIM inside the packaged editor on
 * every OS, including Windows. A literal like `'/tmp/foo'` works on macOS/Linux but
 * is absent on Windows, so `fs.openSync('/tmp/...')` throws ENOENT synchronously —
 * and the open flow turns that throw into `app.quit()`, so the packaged editor
 * silently "crashes" on launch. `npm run dev` (macOS) never sees it.
 *
 * Concrete regression this guards: devServer.ts once logged Vite to a hardcoded
 * `/tmp/modoki-vite.log`, crashing the Windows installer on the first project open
 * (which the first-run "new folder" scaffold triggers). Fix: `os.tmpdir()`.
 *
 * The `.sh` launch/smoke scripts legitimately use `/tmp` — they only ever run on the
 * macOS dev box, never inside the packaged app — so this scans .ts sources only.
 */
describe('packaged-app code has no hardcoded POSIX-only paths', () => {
  // Dirs whose .ts runs unchanged inside the packaged main process on Windows.
  const ROOTS = ['engine/electron', 'engine/toolchain'];
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  function tsFiles(dir: string, out: string[] = []): string[] {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'dist' || e.name === 'node_modules') continue; // built/vendored
        tsFiles(rel, out);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push(rel);
      }
    }
    return out;
  }

  // Hardcoded `/tmp` — used UNCONDITIONALLY (a temp/log path on every launch) with a
  // trivial cross-platform replacement (`os.tmpdir()`), so it's always wrong in
  // packaged code. (Other absolute paths like `/usr/libexec/java_home` or the Android
  // SDK dir are macOS-only *provisioning* paths, correctly platform-gated to darwin —
  // not this footgun — so they're deliberately NOT matched here.)
  const BAD = /(['"`])\/(tmp|var\/tmp)\//;

  const files = ROOTS.flatMap((r) => tsFiles(r));

  it('scans a non-empty set of source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    it(`${rel} uses os.tmpdir()/app.getPath, not a literal /tmp`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => BAD.test(line) && !/^\s*(\*|\/\/)/.test(line)); // skip comments
      expect(
        offenders,
        `hardcoded POSIX path (crashes on Windows) — use os.tmpdir() / app.getPath('temp'):\n` +
          offenders.map((o) => `  ${rel}:${o.n}  ${o.line.trim()}`).join('\n'),
      ).toHaveLength(0);
    });
  }
});
