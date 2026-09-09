/** `isEntryPoint` — "was this module RUN, or merely imported?" (#910).
 *
 *  The defect this module was extracted for is SILENT by construction: declining is exactly what
 *  the check does when imported, so a false "no" looks identical to a correct one — exit 0, no
 *  output, nothing run. Two of the four hand-rolled copies compared an unresolved `argv[1]`
 *  against an `import.meta.url` Node had already resolved, so a repo reached through a symlink
 *  made them miss, and `smoke-packaged.sh` read the empty stdout that produced.
 *
 *  These drive the real thing through a real `node` process rather than calling the function with
 *  fabricated arguments: `argv[1]` and `import.meta.url` are both set BY Node, and the bug lives
 *  in the relationship between how it sets them. A unit call that supplies both by hand would be
 *  asserting the fixture. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { makeDirLink } from '../helpers/linkFixture';


const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The module under test, as an ESM specifier a generated file can import.
 *
 *  ⚠️ **`pathToFileURL`, never the raw path.** On POSIX `/Users/…` happens to be a valid
 *  specifier, so a raw `path.join` passes here and fails ONLY on Windows, where `D:\a\…` parses
 *  as scheme `d:` and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. The free public CI runs `npm test`
 *  on `windows-latest`, so the raw form would have reddened it on the next push to main and
 *  nothing on a Mac could see it. Same fix, same reason, as `cliNativeBuildHeals.test.ts`. */
const SPECIFIER = JSON.stringify(pathToFileURL(path.join(repoRoot, 'engine/scripts/entryPoint.mjs')).href);

/** A scratch module that prints its own verdict, plus a symlink to the repo it imports from.
 *
 *  ⚠️ `os.tmpdir()` is realpath'd FIRST. On macOS it is itself a symlink (`/var` → `/private/var`),
 *  which would make the control case exercise a symlink too and let a broken implementation pass
 *  for the wrong reason. */
let base = '';
let realDir = '';
let linkDir = '';

beforeAll(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'entrypoint-'));
  realDir = path.join(base, 'real');
  fs.mkdirSync(realDir);
  fs.writeFileSync(
    path.join(realDir, 'probe.mjs'),
    `import { isEntryPoint } from ${SPECIFIER};\n`
    + 'process.stdout.write(isEntryPoint(import.meta.url) ? "RAN" : "IMPORTED");\n',
  );
  linkDir = path.join(base, 'link');
  makeDirLink(realDir, linkDir);
});
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

const run = (dir: string) =>
  execFileSync(process.execPath, [path.join(dir, 'probe.mjs')], { encoding: 'utf8' });

describe('isEntryPoint (#910)', () => {
  it('says RAN when Node was told to run it', () => {
    expect(run(realDir)).toBe('RAN');
  });

  // THE regression. Pre-#910 this returned IMPORTED — the CLI block silently did not run.
  it('still says RAN through a SYMLINKED spelling of its own path', () => {
    expect(run(linkDir)).toBe('RAN');
  });

  it('says IMPORTED when another module imports it', () => {
    const importer = path.join(realDir, 'importer.mjs');
    fs.writeFileSync(importer, 'import "./probe.mjs";\n');
    expect(execFileSync(process.execPath, [importer], { encoding: 'utf8' })).toBe('IMPORTED');
  });

  // `node --input-type=module -e` sets no argv[1], and the answer must be a plain "no" rather
  // than a throw — this runs at module load, where throwing breaks the IMPORT rather than
  // declining CLI mode.
  //
  // ⚠️ **This pins the OUTCOME, not the `!process.argv[1]` guard, and it cannot pin that guard.**
  // Mutation-checked: deleting the guard leaves this green, because `path.resolve(undefined)`
  // throws a TypeError the catch converts into the same `false`. Two mechanisms, one observable
  // result — so no test can separate them, and claiming this one does would be the
  // unfalsifiable-test shape docs/falsifiable-tests.md exists for. It is not vacuous: returning
  // `true` unconditionally reddens it.
  it('says IMPORTED, without throwing, when there is no argv[1] at all', () => {
    const src = `import { isEntryPoint } from ${SPECIFIER};\n`
      + 'process.stdout.write(isEntryPoint(import.meta.url) ? "RAN" : "IMPORTED");\n';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
    expect(out).toBe('IMPORTED');
  });

  // The other load-bearing guard: a non-`file:` moduleUrl (a bundler shim, a custom loader) must
  // decline rather than throw, for the same reason.
  it('returns false rather than throwing on a non-file: moduleUrl', async () => {
    const { isEntryPoint } = await import('../../scripts/entryPoint.mjs');
    expect(() => isEntryPoint('data:text/javascript,0')).not.toThrow();
    expect(isEntryPoint('data:text/javascript,0')).toBe(false);
    expect(isEntryPoint('https://example.com/x.mjs')).toBe(false);
  });
});

/** ⚠️ `clonePort.mjs` is deliberately NOT migrated onto this module and must stay that way.
 *  `clonePortCli.test.ts` copies that file ALONE into a directory whose name contains a space, so
 *  an import of any sibling makes the copy unrunnable — measured, and #881's first attempt at
 *  exactly this reddened that test with ERR_MODULE_NOT_FOUND. I repeated that mistake here before
 *  reading clonePort's docblock.
 *
 *  ⚠️ **This adds a clearer MESSAGE, not new reach** (close-out review). `clonePortCli.test.ts`
 *  already copies and RUNS the file, so a real added import was always going to go red — that is
 *  how #881 found it. Do not cite this test as the thing standing between the repo and a broken
 *  CLI; the executable one is. It also only matches a static `import … from`, so an
 *  `export … from` or a dynamic `await import()` slips past it — the running copy would still
 *  catch those. */
describe('clonePort.mjs stays import-free (#910)', () => {
  it('imports nothing but node: builtins', () => {
    // Through the SHARED reader, not fs.readFileSync (#812): this file's own docblock quotes an
    // `import … from './entryPoint.mjs'` line to explain what must NOT be added, and a raw scan
    // would match that comment and redden on prose. `commentStripperIsShared.test.ts` catches
    // exactly this shape — it caught this test.
    const { code } = readScannedSource(path.join(repoRoot, 'engine/scripts/clonePort.mjs'));
    const specifiers = [...code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0); // non-vacuous: it does import something
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });
});
