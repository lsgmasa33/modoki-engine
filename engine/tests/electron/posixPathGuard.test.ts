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

/**
 * THE SAME FOOTGUN, IN TEST FILES — the half the block above cannot see (#108).
 *
 * The guard above scopes to `engine/electron` + `engine/toolchain` and skips `.test.ts` on
 * purpose: its subject is code that ships inside the packaged app. That left the identical
 * bug free to land in a TEST, which is what happened — `games/court/tests/hintPlaythrough.test.ts`
 * wrote its diagnostic report to a literal `/tmp/court-hint-playthrough.txt`. On Windows `/tmp`
 * is DRIVE-RELATIVE (it resolves to `E:\tmp`), the write is unconditional and runs before any
 * assertion, so the whole file died with ENOENT and `npm run verify` could not go green on the
 * `win` clone at all. CLAUDE.md makes the local gate the only gate, so that is a gate outage,
 * not an inconvenience — and it is invisible from a Mac clone, like every bug in this class.
 *
 * WHY THIS RULE IS NARROWER THAN "no /tmp literal in a test". Tests are full of POSIX-absolute
 * strings used as pure FIXTURES — synthetic paths fed to pure functions that only ever compare
 * or format them (`killPackagedGuard` builds a pkill pattern from '/tmp/modoki-pkg…';
 * `toolchainResolve` sets MODOKI_TOOLCHAIN_DIR to '/tmp/modoki-tc-stale' and asserts on version
 * strings; `clonePortCli` hashes '/Users/dev/Projects/modoki'). None of those touch the disk, and
 * on Windows they are still perfectly good fixtures. A blanket literal scan would flag ~40 such
 * lines, and a guard that noisy gets an allowlist bolted on until it means nothing.
 *
 * So the rule is about REACHING THE FILESYSTEM: a POSIX-absolute literal passed to an `fs` call,
 * either directly or through a `const` in the same file. That is exactly the shape that broke,
 * and it leaves honest fixtures alone.
 */
describe('test files reach the filesystem through os.tmpdir(), not a literal POSIX path (#108)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  /** Every root that holds test files — the engine suites, the package suites, and each
   *  project's own `tests/` under `games/` and `demos/`. Projects are enumerated rather than
   *  hardcoded: a new game must inherit the guard without anyone remembering to add it. */
  function testRoots(): string[] {
    const roots = ['engine/tests', 'engine/packages/modoki/tests'];
    for (const projects of ['games', 'demos']) {
      const abs = path.join(repoRoot, projects);
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(abs, e.name, 'tests'))) {
          roots.push(`${projects}/${e.name}/tests`);
        }
      }
    }
    return roots;
  }

  function testFiles(dir: string, out: string[] = []): string[] {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        testFiles(rel, out);
      } else if (/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
  }

  // POSIX roots that genuinely do not exist on Windows. `/tmp` and `/var/tmp` are the ones with a
  // trivial correct replacement (`os.tmpdir()`); the others are matched because a test that WRITES
  // to them is wrong on every platform, Windows or not.
  const POSIX_ROOT = String.raw`\/(?:tmp|var|usr|home|Users|opt|etc|private)(?:\/|(?=['"\`]))`;
  // The `fs` surface a test actually touches. Deliberately includes reads: a test that reads a
  // literal `/tmp/...` is just as broken here, it merely fails differently.
  const FS_CALLS =
    'writeFileSync|appendFileSync|mkdirSync|rmSync|rmdirSync|unlinkSync|openSync|createWriteStream'
    + '|createReadStream|readFileSync|readdirSync|existsSync|copyFileSync|cpSync|statSync|renameSync'
    + '|writeFile|readFile|mkdir|appendFile';

  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .map((l) => (/^\s*(\*|\/\/)/.test(l) ? '' : l)).join('\n');

  const files = testRoots().flatMap((r) => testFiles(r));

  it('scans a non-empty set of test files, across engine AND project suites', () => {
    // A root that silently stops matching turns this whole block into a cheerful no-op — the
    // failure mode `testTypecheckCoverage.test.ts` exists to catch for tsconfig programs.
    expect(files.length).toBeGreaterThan(100);
    // Every root `testRoots()` DISCOVERED must contribute a file. This used to demand a `games/`
    // one specifically, which reads as the same guarantee but is really an assumption about the
    // tree: the OSS CI snapshot ships engine + two demos and no `games/` at all, so it failed
    // there for months on a scan that was working perfectly. Pinning to the discovered roots is
    // also strictly stronger — it catches a root that stops matching, which is the actual fear,
    // and it catches it for `demos/` and the engine suites too, not just `games/`.
    for (const root of testRoots()) {
      expect(files.some((f) => f.startsWith(`${root}/`)), `no test files under ${root}`).toBe(true);
    }
  });

  it('no POSIX-absolute path literal reaches an fs call', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      const lineOf = (idx: number): number => src.slice(0, idx).split('\n').length;

      // (1) The literal sits straight in the call: `writeFileSync('/tmp/x', …)`, and the same
      //     through `join(...)`/`resolve(...)` as the first segment.
      const direct = new RegExp(
        String.raw`(?:${FS_CALLS})\s*\(\s*(?:(?:path\.)?(?:join|resolve)\s*\(\s*)?['"\`]${POSIX_ROOT}`,
        'g',
      );
      for (let m = direct.exec(src); m; m = direct.exec(src)) {
        offenders.push(`${rel}:${lineOf(m.index)}  ${m[0].trim()}`);
      }

      // (2) The literal is bound to a const first — the shape that actually shipped — and that
      //     identifier is then handed to an fs call.
      //
      //     SCOPE MATTERS, and getting it wrong makes this guard lie. A file-wide search for the
      //     identifier produced two false positives on the first run: `toolchainResolve.test.ts`
      //     reuses the name `tc` in a dozen separate `it` blocks, most of them binding it
      //     correctly via `mkdtempSync(os.tmpdir())` and calling `fs.rmSync(tc)` — so a fixture
      //     `const tc = '/tc'` in one block was blamed for a DIFFERENT block's legitimate fs call.
      //     But narrowing to the enclosing block for everything would miss the real bug, because
      //     the shape that broke binds at MODULE scope (`const REPORT = …` at the top) and uses it
      //     inside an `it`. So: a top-level binding is searched file-wide, an indented one only
      //     until the next sibling `it`/`test`/`describe`.
      const bind = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"\`]${POSIX_ROOT}`, 'g');
      for (let m = bind.exec(src); m; m = bind.exec(src)) {
        const name = m[1];
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const indent = src.slice(lineStart, m.index).length;
        let window = src;
        if (indent > 0) {
          const rest = src.slice(m.index);
          const next = rest.slice(1).search(new RegExp(String.raw`\n\s{0,${indent}}(?:it|test|describe)\s*[.(]`));
          window = next === -1 ? rest : rest.slice(0, next + 1);
        }
        const used = new RegExp(
          String.raw`(?:${FS_CALLS})\s*\(\s*(?:(?:path\.)?(?:join|resolve)\s*\(\s*)?${name}\b`,
        );
        if (used.test(window)) offenders.push(`${rel}:${lineOf(m.index)}  ${name} = <POSIX literal> → fs call`);
      }
    }
    expect(
      offenders,
      'a POSIX-absolute path literal used for real file I/O — on Windows "/tmp" is drive-relative '
        + '(E:\\tmp) and does not exist, so this fails only on the win clone. Use '
        + "path.join(os.tmpdir(), …):\n" + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });
});
