import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { boundIdentifier, calleeName, findNodes, flatText, lineOf, parseSource, readsOf, ts, unwrapValue, valueCarrier } from '@modoki/engine/testing/sourceAst';

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

  /** Every `.ts` (not `.test.ts`) under `dir`, via the shared corpus producer
   *  (#799/#771/#805 Phase 4). Floored well under the 7 measured today under the smaller of
   *  the two ROOTS (engine/toolchain; engine/electron measures 23). */
  function tsFiles(dir: string): string[] {
    if (!fs.existsSync(path.join(repoRoot, dir))) return [];
    return repoFiles({
      under: dir, match: (rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts'),
      exclude: ['dist', 'node_modules'], floor: 3,
    }).map(({ rel }) => rel);
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

  it('the comment scan is sane over every scanned file', () => {
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assertScanIsSane(raw, stripComments(raw), rel);
    }
  });

  for (const rel of files) {
    it(`${rel} uses os.tmpdir()/app.getPath, not a literal /tmp`, () => {
      const src = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => BAD.test(line));
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

  /** Every `.test.ts`/`.test.tsx` under `dir`, via the shared corpus producer
   *  (#799/#771/#805 Phase 4). `floor: 0` deliberately — a per-project `tests/` root can
   *  legitimately hold as few as 1 matching file (`games/chess` did, before #1191), so the real
   *  non-vacuity pin lives in the two `it()`s below instead (`files.length > 100` and a
   *  per-root coverage check), not in this producer's own floor. */
  function testFiles(dir: string): string[] {
    if (!fs.existsSync(path.join(repoRoot, dir))) return [];
    return repoFiles({ under: dir, match: /\.test\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 0 })
      .map(({ rel }) => rel);
  }

  // POSIX roots that genuinely do not exist on Windows. `/tmp` and `/var/tmp` are the ones with a
  // trivial correct replacement (`os.tmpdir()`); the others are matched because a test that WRITES
  // to them is wrong on every platform, Windows or not. POSIX_TEXT and POSIX_START below carry the list.
  // The `fs` surface a test actually touches. Deliberately includes reads: a test that reads a
  // literal `/tmp/...` is just as broken here, it merely fails differently.
  const FS_CALLS =
    'writeFileSync|appendFileSync|mkdirSync|rmSync|rmdirSync|unlinkSync|openSync|createWriteStream'
    + '|createReadStream|readFileSync|readdirSync|existsSync|copyFileSync|cpSync|statSync|renameSync'
    + '|writeFile|readFile|mkdir|appendFile';

  /** A quoted POSIX root anywhere in the text — the cheap pre-filter before a parse. */
  const POSIX_TEXT = new RegExp(String.raw`['"\`]\/(?:tmp|var|usr|home|Users|opt|etc|private)(?:\/|['"\`]|\$\{)`);
  const FS_CALL_NAMES = new Set(FS_CALLS.split('|'));

  /** A string or template whose text STARTS with a POSIX root (`/tmp`, `/tmp/…`, a template's head `/private/`). */
  const POSIX_START = /^\/(?:tmp|var|usr|home|Users|opt|etc|private)(?:\/|$)/;
  function isPosixLiteral(e: ts.Expression | undefined): boolean {
    const u = e && unwrapValue(e);
    if (!u) return false;
    const text = ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : ts.isTemplateExpression(u) ? u.head.text : undefined;
    return text !== undefined && POSIX_START.test(text);
  }

  /** `e` is the FIRST argument of an fs call, directly or as the first segment of `join(…)`/`resolve(…)` that is. */
  function fsCallTaking(e: ts.Expression): ts.CallExpression | undefined {
    let cur = valueCarrier(e);
    const p = cur.parent;
    if (p && ts.isCallExpression(p) && p.arguments[0] === cur && ['join', 'resolve'].includes(calleeName(p) ?? '')) cur = valueCarrier(p);
    const call = cur.parent;
    return call && ts.isCallExpression(call) && call.arguments[0] === cur && FS_CALL_NAMES.has(calleeName(call) ?? '') ? call : undefined;
  }

  /** Every POSIX-absolute literal in `sf` that reaches an fs call's path argument — the literal itself as the
   *  argument (`<line>  <call>`), or a `const`/`let` it initialises whose READS (resolved by scope) reach one
   *  (`<line>  <name> = <POSIX literal> → fs call`).
   *
   *  From the parser (#1195). The bound case used to search a TEXT window: file-wide for a column-0 binding,
   *  and for an indented one only up to the next sibling `it`/`test`/`describe` at no deeper indent — so a
   *  name reused in another block was blamed for that block's legitimate call whenever the window guessed
   *  wrong, and a read after a nested `describe` was missed. The checker resolves which binding a read is. */
  function posixFsReaches(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    const literals = findNodes(sf, (n): n is ts.Expression => ts.isExpression(n) && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && isPosixLiteral(n));
    for (const found of literals) {
      // The literal may only START the path: `'/tmp/' + name` is the same path, so read the `+` chain it heads
      // (#1195 close-out review — the text regexes needed only the argument to START with a quoted root).
      let lit: ts.Expression = valueCarrier(found);
      while (lit.parent && ts.isBinaryExpression(lit.parent) && lit.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
        && lit.parent.left === lit) lit = valueCarrier(lit.parent);
      const direct = fsCallTaking(lit);
      if (direct) { out.push(`${lineOf(direct)}  ${flatText(direct)}`); continue; }
      const bound = boundIdentifier(lit);
      if (bound && readsOf(bound).some((r) => fsCallTaking(r))) out.push(`${lineOf(bound)}  ${bound.text} = <POSIX literal> → fs call`);
    }
    return out;
  }

  // Comment stripping is the shared scanner (@modoki/engine/testing, #419) — imported above.

  const files = testRoots().flatMap((r) => testFiles(r));

  it('the comment scan is sane over every scanned test file', () => {
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assertScanIsSane(raw, stripComments(raw), rel);
    }
  });

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
      // Parsed only when the text holds a quoted POSIX root at all — every literal the reader below can
      // find starts with one.
      if (!POSIX_TEXT.test(src)) continue;
      offenders.push(...posixFsReaches(parseSource(src, rel)).map((o) => `${rel}:${o}`));
    }
    expect(
      offenders,
      'a POSIX-absolute path literal used for real file I/O — on Windows "/tmp" is drive-relative '
        + '(E:\\tmp) and does not exist, so this fails only on the win clone. Use '
        + "path.join(os.tmpdir(), …):\n" + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('reads a literal into an fs call directly, through join/resolve, or through the binding it is read by (#1195)', () => {
    const probe = (src: string) => posixFsReaches(parseSource(src, 'probe.test.ts'));
    expect(probe([
      "fs.writeFileSync('/tmp/a.txt', 'x');",
      'readFileSync(path.join(`/private/${x}`, "b"));',
      "mkdirSync(resolve('/usr'), { recursive: true });",
      "fs.writeFileSync(path.join(os.tmpdir(), '/tmp'), 'x');",
    ].join('\n'))).toEqual([
      "1  fs.writeFileSync('/tmp/a.txt', 'x')",
      '2  readFileSync(path.join(`/private/${x}`, "b"))',
      "3  mkdirSync(resolve('/usr'), { recursive: true })",
    ]);
    // Bound first — at module scope and used inside an `it`, the shape that shipped.
    expect(probe("const REPORT = '/tmp/report.txt';\ndescribe('d', () => {\n  it('w', () => {\n    fs.writeFileSync(REPORT, 'x');\n  });\n});"))
      .toEqual(['1  REPORT = <POSIX literal> → fs call']);
    // The same NAME rebound in a sibling block is a different binding: the fixture is never written.
    expect(probe([
      "it('a', () => { const tc = '/tmp/tc'; expect(norm(tc)).toBe('x'); });",
      "it('b', () => { const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'tc')); fs.rmSync(tc, { recursive: true }); });",
    ].join('\n'))).toEqual([]);
    // A bound literal read through join, and one only compared.
    expect(probe("function f() {\n    const dir = '/Users/dev';\n    return existsSync(path.join(dir, 'x')) && dir === '/Users/dev';\n}"))
      .toEqual(['2  dir = <POSIX literal> → fs call']);
    // A literal that STARTS a concatenation, directly and bound (the #108 report path with a suffix).
    expect(probe("fs.writeFileSync('/tmp/' + name, 'x');\nconst REPORT = '/tmp/report-' + String(pid) + '.txt';\nfs.writeFileSync(REPORT, 'x');"))
      .toEqual(["1  fs.writeFileSync('/tmp/' + name, 'x')", '2  REPORT = <POSIX literal> → fs call']);
    // …but not a literal that merely ends one.
    expect(probe("fs.writeFileSync(base + '/tmp/x', 'x');")).toEqual([]);
    // A drive-relative-safe literal, a POSIX literal as a second argument, and a non-fs call.
    expect(probe("fs.writeFileSync(file, '/tmp/content');\nnormalize('/tmp/x');\nconst p = 'tmp/x'; fs.readFileSync(p);")).toEqual([]);
    // The pre-filter keeps every root the reader looks for, in every quote.
    for (const lit of ["'/tmp/a'", '"/var/x"', "`/usr`", "'/home/x'", "'/Users/x'", "'/opt/x'", "'/etc/x'", "'/private/x'", '`/tmp${s}`']) {
      expect(POSIX_TEXT.test(`readFileSync(${lit})`), lit).toBe(true);
    }
  });
});
