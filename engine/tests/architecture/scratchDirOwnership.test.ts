/**
 * Guard: the test corpus creates scratch dirs only through `makeScratchDir` (#1117).
 *
 * A bare `fs.mkdtempSync` in a test leaves removal to the test, and three shapes of "the test
 * forgot" had accumulated 131,158 `modoki-*` entries in one Mac's `os.tmpdir()` (8,551 on the win
 * clone): a `beforeEach` with no teardown, a removal on the success path only, and a removal of the
 * child path the test kept instead of the dir it made. `@modoki/engine/testing/scratchDir` owns the
 * lifetime instead. Every dir it makes is removed after the test file, pass or fail.
 *
 * What is refused: any IDENTIFIER named `mkdtemp` or `mkdtempSync` in a test file. That covers
 * `fs.mkdtempSync(…)`, a named import, `fs.promises.mkdtemp`, a `realFs.` alias, and a destructured
 * or renamed binding, because each of those spells the name as an identifier somewhere. Refusing
 * the name rather than only the call is deliberate. A rule keyed on the call shape misses
 * `const { mkdtempSync: mk } = fs`. Strings and comments are not identifiers, so a guard that
 * quotes the source shape in a fixture string (commentStripperIsShared) is untouched.
 *
 * Deliberately NOT covered (pinned as KNOWN GAPS below): a computed key (`fs['mkdtemp' + 'Sync']`),
 * a shell `mktemp -d` in a spawned command or script string, and production code a test drives
 * (engine/plugins, engine/scripts). That last one is how the claims store leaked, which is why
 * engine/tests/setup.ts removes its per-worker dir by hand. A Playwright spec cannot use the
 * helper, because no vitest setup installs its cleanup. No spec needs a scratch dir today.
 *
 * Why and the shapes: docs/verify-and-ci.md § Scratch dirs.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { findNodes, lineOf, parseSource } from '@modoki/engine/testing/sourceAst';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const RAW_NAMES = new Set(['mkdtemp', 'mkdtempSync']);
/** The one place that may call it: the helper this guard routes everything to. */
const HELPER = 'engine/packages/modoki/tests/helpers/scratchDir.ts';

export function rawMkdtempLines(code: string, label: string): number[] {
  const sf = parseSource(code, label);
  return findNodes(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && RAW_NAMES.has(n.text)).map(lineOf);
}

const lines = (src: string[]): number[] => rawMkdtempLines(src.join('\n'), 'fixture.ts');

describe('scratchDirOwnership detector', () => {
  it('refuses every spelling of the name', () => {
    expect(lines([
      "const a = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));",  // 1 the common form
      "import { mkdtempSync, rmSync } from 'node:fs';",           // 2 a named import
      "const b = mkdtempSync(join(tmpdir(), 'x-'));",             // 3 the imported call
      "const c = await fs.promises.mkdtemp('/tmp/x-');",          // 4 promises
      "const d = await fsp.mkdtemp(p);",                          // 5 fs/promises alias
      "const { mkdtempSync: mk } = fs;",                          // 6 a renamed destructure
      "import { mkdtemp as mkd } from 'node:fs/promises';",       // 7 a renamed import
      "const e = realFs.mkdtempSync(p);",                         // 8 an importActual alias
    ])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('accepts the helper, strings and comments', () => {
    expect(lines([
      "const a = makeScratchDir('x-');",
      "const b = makeScratchDir('x-', { canonical: true });",
      '// fs.mkdtempSync(path.join(os.tmpdir(), "x-")) is what this replaced',
      "const src = \"const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'));\";",
      "vi.spyOn(fs, 'mkdtempSync');",
      'const t = `mkdtempSync(${p})`;',
    ])).toEqual([]);
  });

  it('KNOWN GAPS: raw scratch creation the detector does not see (the docblock lists them)', () => {
    // Each of these makes a dir nothing removes. They are pinned as undetected so the documented list
    // stays true. A detector that learns one should move it to the refused rows.
    expect(lines([
      "const a = fs['mkdtemp' + 'Sync'](p);",
      "execSync('mktemp -d');",
    ])).toEqual([]);
  });
});

describe('scratchDirOwnership on the real tree', () => {
  it('has no raw mkdtemp in any test file outside the helper', () => {
    const files = repoFiles({
      under: ['engine', 'games', 'demos'],
      match: /\/(tests|e2e|__tests__)\/.*\.(tsx?|[cm]?js)$|\.(test|spec)\.(tsx?|[cm]?js)$/,
      exclude: ['node_modules', 'dist'],
      floor: 300,
    });
    const population: Array<{ item: string; site: string }> = [];
    for (const { rel, abs } of files) {
      const { code } = readScannedSource(abs);
      for (const line of rawMkdtempLines(code, rel)) population.push({ item: rel, site: `${rel}:${line}` });
    }
    assertExemptionLedger({
      label: 'scratchDirOwnership',
      population,
      sanctioned: [HELPER],
      scanned: files.length,
      floor: 300,
      fix: 'raw mkdtemp in a test file. Nothing removes that dir unless the test remembers to. Use '
        + "makeScratchDir(prefix) from @modoki/engine/testing/scratchDir, which removes it after the "
        + "file, pass or fail. { base } and { canonical: true } cover the other shapes. docs/verify-and-ci.md § Scratch dirs.",
    });
  });
});
