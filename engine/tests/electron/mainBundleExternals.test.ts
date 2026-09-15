// @vitest-environment node
// esbuild relies on a native TextEncoder (its startup invariant); the default jsdom environment
// polyfills it and breaks esbuild, so this suite runs under node — same as mcpBundle.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { findNodes, importsIn, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { electronOpts, electronMainOutfile, repoRoot } from '../../scripts/electronBuildOpts.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

/**
 * PACKAGING GUARD — nothing the Electron MAIN bundle keeps external may resolve to TypeScript.
 *
 * `build-electron.mjs` sets `packages: 'external'`, so every **bare** specifier reachable from
 * `main.ts` survives into `dist/main.cjs` as a runtime `require` that plain Node must resolve
 * inside the packaged app. `@modoki/engine` cannot be resolved that way: it has no `main` and no
 * `module`, only `exports` entries pointing at `.ts` source. That is CORRECT — every other
 * consumer reaches it through Vite, which compiles it — and it is why nothing the main bundle
 * inlines may reach the package by a bare specifier.
 *
 * ⚠️ **The failure this prevents is silent everywhere `verify` can see** (#1035). One such import
 * (`editorBackendRouter.ts`, landed 2026-09-09 in `7cc24653a`) made packaged Node throw
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — it refuses to strip types under `node_modules` —
 * during `main.cjs` module evaluation. An uncaught main-process exception raises ELECTRON'S OWN
 * error dialog, so the app sat alive with no visible window, no children, no stdout, an empty
 * `--user-data-dir` and `exitCode=null`, before `main.ts`'s top-level `initFileLog()` could run. Every
 * diagnostic the repo has was empty at once, and `verify` stayed green throughout: it never loads
 * the packaged bundle. `verify:packaged` was unsatisfiable by anyone for a day.
 *
 * ## The corpus is DERIVED from the build, never listed
 *
 * ⚠️ The first version of this suite listed `['engine/electron', 'engine/plugins']` and scanned
 * those trees. Measured, that is **91 of the bundle's 154 non-`node_modules` inputs** — it misses
 * `engine/app/**`, `engine/toolchain/**`, `engine/packages/modoki/src/**`, `engine/scripts/*.mjs`,
 * `engine/tools/shared/**` and `engine/project-config.ts`. `engine/electron/inputRoutes.ts` value-
 * imports `engine/app/debug/domPointContract.ts`, and **19 of that file's siblings use the banned
 * bare specifier as their local convention** — so appending one bare `@modoki` import there
 * reproduces #1035 byte-for-byte while both cases stayed GREEN (driven, close-out review). A
 * hand-listed corpus is a guard with a hole shaped exactly like the bug.
 *
 * So this builds ONCE with the SHIPPED options (imported, never restated — #945 B1) and asks the
 * **metafile** what the bundle actually contains. A new tree, a new entry point or a new import
 * edge is covered the moment it exists.
 *
 * ⚠️ **Scope the artifact cases do NOT cover:** they read `main.cjs` only, though the build also
 * emits `preload.cjs`, which runs in the packaged app too. The SOURCE case covers both — metafile
 * inputs are the union across entry points — so the gap is the artifact layer for preload alone.
 * Left as it is because preload's inputs are a small subset of main's; stated so it is a known
 * scope rather than an oversight.
 */
const BUNDLE_ROOT_FLOOR = 100;

/**
 * Every bare import/require of the engine package (or any `@modoki/*` sibling) in one source file, with
 * its line — read from the parse (#1193): static, re-exported, dynamic, type-position, and a CommonJS
 * `require('…')` call. An `import(…)` / `require(…)` whose argument is a TEMPLATE with substitutions
 * counts by its head (`` import(`@modoki/engine/${n}`) `` reads as `@modoki/engine/…`), as the regex
 * before it did.
 *
 * ⚠️ **This is why the source case exists alongside the built-artifact case.** Measured: a dynamic
 * `import('@modoki/…')` added to an UNUSED export is tree-shaken out, so the built bundle is clean
 * and the artifact case stays green — the source case is the one that reds. That is the right
 * split, not a redundancy: an unreachable import today is a reachable one after the next edit, and
 * the edit that makes it reachable does not touch the import line.
 *
 * ⚠️ `import type { X } from '@modoki/…'` is banned deliberately, even though esbuild erases it and it
 * could never reach the bundle. A type-only import is one edit away from being a value import, and that
 * edit does not look dangerous. Reach for the relative path from the start. The same holds for
 * `import('@modoki/…').T`, which the regex this replaced could not tell from a call and now reads on
 * purpose.
 *
 * The regex it replaced took `from` / `require(` / `import` with an optional paren / `export * from`,
 * each followed by a quote (`\s*` crossed newlines, so a wrap was fine). What it could not see: a comment
 * between the keyword and the quote — which the stripper happened to blank — and a string that only
 * LOOKS like an import read as one.
 */
function bareModokiSpecifiers(abs: string, code: string): Array<{ spec: string; line: number }> {
  const sf = parseSource(code, abs);
  const edges = importsIn(sf, { typePositions: true }).map((e) => ({ spec: e.spec, line: lineOf(e.node) }));
  // `require('…')`, and either call with a substituted template — which `importsIn` skips, since it
  // names no single module.
  const calls = findNodes(sf, (n): n is ts.CallExpression => ts.isCallExpression(n)
    && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword));
  const other = calls.flatMap((c) => {
    const arg = c.arguments[0];
    const isRequire = c.expression.kind !== ts.SyntaxKind.ImportKeyword;
    if (arg && isRequire && ts.isStringLiteralLike(arg)) return [{ spec: arg.text, line: lineOf(c) }];
    if (arg && ts.isTemplateExpression(arg)) return [{ spec: `${arg.head.text}…`, line: lineOf(c) }];
    return [];
  });
  return [...edges, ...other].filter(({ spec }) => spec.startsWith('@modoki/'));
}

/**
 * A bare `@modoki` specifier that SURVIVED into a built bundle — the thing that actually breaks.
 *
 * ⚠️ **Deliberately NOT keyed on the call form.** The first version of this matched
 * `require(…)`/`import(…)` and had a green path through the very mechanism it guards: a
 * `createRequire(...)('@modoki/…')` is neither, esbuild does not transform it at all, and it is
 * already the local convention in four of this bundle's own inputs (`model-convert.ts`,
 * `font-instance.ts`, `native-dynamic-import.ts`, `nodeProvision.ts`). Driven in the §2d review:
 * one such line put `req("@modoki/engine/runtime/core/docKeys")` into `main.cjs` verbatim with all
 * three cases GREEN. `require.resolve` and `module.require` fail the same way.
 *
 * So this matches a QUOTED `@modoki/…` specifier anywhere in the built output, whatever calls it —
 * the same argument the corpus makes on the other axis. It runs against comment-stripped output,
 * because the bundle carries `@modoki/engine` in prose; the one remaining benign shape, the Vite
 * alias template `` `^@modoki/engine${sub}$` ``, cannot match because the character after its
 * backtick is `^`, not `@`.
 */
const BUILT_MODOKI_SPECIFIER = /["'`](@modoki\/[^"'`\s]+)["'`]/g;

/** Extensions `readScannedSource` can strip comments from. Anything else fails the suite loudly
 *  rather than being skipped — a silently unscanned input is the hole this guard just closed. */
const SCANNABLE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']);

let tmpDir: string;
let builtMain: string;
/** Non-`node_modules` inputs of the real bundle, repo-relative — the corpus, straight from esbuild. */
let inputs: string[];

beforeAll(async () => {
  tmpDir = makeScratchDir('modoki-main-externals-');
  // The SHIPPED options with exactly the three overrides isolation requires. They are parameters
  // of `electronOpts` rather than a spread here, so this suite cannot accidentally override the
  // fields that make the defect possible (`packages`, `platform`, `format`, the entry points).
  const result = await esbuild.build(
    electronOpts({ outdir: tmpDir, metafile: true, sourcemap: false, logLevel: 'silent' }),
  );
  // Comment-stripped, so the bundle's own prose about `@modoki/engine` is not a false red.
  builtMain = readScannedSource(path.join(tmpDir, 'main.cjs')).code;
  // ⚠️ metafile keys are relative to `process.cwd()`, NOT to the repo root — vitest's root is
  // `engine/`, so running this suite from there made the old `path.join(repoRoot, rel)` open
  // `<repo>/electron/fileLog.ts` and die on a bare ENOENT naming nothing (driven, §2d review).
  // `mcpBundle.test.ts` carries the same ⚠️ about esbuild output being cwd-dependent.
  //
  // The `node_modules` filter is belt-and-braces and currently a NO-OP — measured, 0 of 154 inputs
  // sit there, because `packages: 'external'` means nothing from node_modules is ever an input. It
  // stays for the day a future option bundles one.
  inputs = Object.keys(result.metafile!.inputs)
    .filter((p) => !p.includes('node_modules'))
    .map((rel) => path.resolve(process.cwd(), rel));
}, 120_000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('electron main bundle — no externalised TypeScript (#1035)', () => {
  it('a freshly built main.cjs contains no @modoki require at all', () => {
    // The load-bearing case: it asks the ARTIFACT, so it holds for every tree the bundle reaches,
    // every import form, and anything a future bundler option changes — no corpus to get wrong.
    const found = [...new Set([...builtMain.matchAll(BUILT_MODOKI_SPECIFIER)].map((m) => m[1]))].sort();
    expect(
      found,
      '@modoki survived as a runtime require in the main bundle. `packages: \'external\'` leaves it '
      + 'for plain Node, and the package resolves only to .ts — the packaged editor will hang before '
      + 'it can log (#1035). Import it by RELATIVE path into engine/packages/modoki/src/… instead.',
    ).toEqual([]);
  });

  it('no source the bundle inlines imports @modoki/* by bare specifier', () => {
    // Same defect as the case above, caught one layer earlier so the failure NAMES the file.
    // The corpus is esbuild's own input list, so it cannot drift from what ships.
    expect(inputs.length).toBeGreaterThan(BUNDLE_ROOT_FLOOR);

    const unscannable = inputs
      .filter((p) => !SCANNABLE.has(path.extname(p).toLowerCase()))
      .map((p) => path.relative(repoRoot, p));
    expect(
      unscannable,
      'the bundle inlines a file type this guard cannot strip comments from — add it to SCANNABLE '
      + 'once you have checked readScannedSource has a stripper, rather than letting it go unscanned',
    ).toEqual([]);

    const offenders: string[] = [];
    for (const abs of inputs) {
      // Comments BLANKED — the repo's ONE source-reading entry point (#812), which
      // `commentStripperIsShared.test.ts` enforces rather than leaving to memory.
      // ⚠️ Honest scope, per layer: over the SOURCE corpus the strip is a precaution — measured
      // 2026-09-10, scanning raw text yields the same result. Over the BUILT output it is
      // load-bearing (see the shipped case below). Either way it is the mandated entry point.
      const { code } = readScannedSource(abs);
      if (path.extname(abs).toLowerCase() === '.json') continue; // data: names no module
      for (const { spec, line } of bareModokiSpecifiers(abs, code)) {
        offenders.push(`${path.relative(repoRoot, abs)}:${line} — ${spec}`);
      }
    }

    expect(offenders, `Bare @modoki/* specifiers in code the main bundle inlines (#1035).
Use a RELATIVE path into engine/packages/modoki/src/… — the local convention across
engine/plugins/** and engine/electron/** — so esbuild inlines it.
Offenders:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('the source reader finds every spelling of a bare @modoki specifier, and nothing that only looks like one (#1193)', () => {
    // The real corpus holds NO offender, so without this nothing proves the reader can fire.
    const code = [
      "import { a } from '@modoki/engine/a';",
      "import '@modoki/engine/side-effect';",
      "import b = require('@modoki/engine/import-equals');",
      "setup(); export { c } from '@modoki/engine/mid-line';",
      "import type { D } from '@modoki/engine/type-only';",
      "type E = import('@modoki/engine/type-position').E;",
      "const f = await import('@modoki/engine/dynamic');",
      'const g = require(`@modoki/engine/required`);',
      "const h = require('./relative');",
      "const s = \"import { x } from '@modoki/engine/in-a-string'\";",
      "const t = obj.require('@modoki/engine/not-require');",
      'const u = await import(`@modoki/engine/${name}`);',
      'const v = require(`@modoki/${pkg}/x`);',
    ].join('\n');
    expect(bareModokiSpecifiers('fixture.ts', code).map(({ spec, line }) => `${line} ${spec}`).sort()).toEqual([
      '1 @modoki/engine/a',
      '12 @modoki/engine/…',
      '13 @modoki/…',
      '2 @modoki/engine/side-effect',
      '3 @modoki/engine/import-equals',
      '4 @modoki/engine/mid-line',
      '5 @modoki/engine/type-only',
      '6 @modoki/engine/type-position',
      '7 @modoki/engine/dynamic',
      '8 @modoki/engine/required',
    ]);
  });

  it.skipIf(!fs.existsSync(electronMainOutfile))(
    'the SHIPPED dist/main.cjs contains no @modoki require either',
    () => {
      // ⚠️ SKIPPED, not failed, when `dist/` has never been built. `dist/main.cjs` is gitignored and
      // NO gate builds it: not `verify`, and not the free public CI, which runs `npm test` over the
      // OSS snapshot on three OSes. Requiring it here would redden all three on a file nothing has
      // built — the same reasoning `mcpBundle.test.ts` carries for the same reason. The two cases
      // above make the real claim on every run; this one adds the artifact on disk when there is one.
      //
      // No mtime comparison, deliberately: the bundle has 154 inputs, so `touch`ing any of the other
      // 153 leaves an mtime check green against a genuinely stale artifact, and a `git merge` that
      // rewrites an input's mtime without changing its content gives a false red. Content is the
      // only sound question, and the fresh build above is where it gets asked.
      // Comment-stripped, exactly as the fresh build is. ⚠️ This strip is LOAD-BEARING here, not a
      // precaution: the bundle inlines prose that names `@modoki/engine` in markdown BACKTICKS, which
      // is indistinguishable from a template-literal specifier to any regex. Measured — without the
      // strip this case reds on two comments in `vite-asset-scanner.ts` and `ssrLoader.ts`.
      const shipped = readScannedSource(electronMainOutfile).code;
      const found = [...new Set([...shipped.matchAll(BUILT_MODOKI_SPECIFIER)].map((m) => m[1]))].sort();
      expect(found, `run \`npm run build:electron\` if this is stale — see the header (#1035)`).toEqual([]);
    },
  );
});
