/**
 * ⚠️ **The instrument, tested directly — not through whatever a fixture happens to contain (#419).**
 *
 * The crafted snippets below are the ONLY regression cover for the scanner. Measured on the #411
 * close-out: reverting the regex state, reverting the `lastWord` fix, deleting `inClass` tracking,
 * reading `)` as a regex opener and letting an escape eat a newline **all produce byte-identical
 * output** over a real 17k-line fixture — the file simply contains no construct that separates the
 * broken scanners from the fixed one. So nothing derived from real source can tell them apart, and
 * a corpus sweep (the last describe here) is a FORWARD guard rather than a regression pin.
 *
 * Every snippet keeps a `probe(` call the assertion counts, and most end in a LINE COMMENT holding
 * a second one: if the strip eats the call the count goes DOWN (the direction that turns a
 * forbidden-pattern guard into a pass), and if the scanner gets lost inside a literal it fails to
 * strip that comment and the count goes UP. Both directions are assertable; a bare literal is
 * neither, which is why the trailing comments are not decoration.
 *
 * ⚠️ **Which snippet catches which mutation — MEASURED, not asserted in prose.** Each scanner
 * defect was reintroduced in turn and the whole table re-run; a cell is ticked where that
 * snippet's `probe(` count or line count moved off 1.
 *
 * | snippet | no regex state | `word` not `lastWord` | no `inClass` | `)` opens a regex | escape eats `\n` | no dot guard | no string newline reset | no `${}` re-entry |
 * |---|---|---|---|---|---|---|---|---|
 * | escaped-slash regex | ✅ | | | | | | | |
 * | regex holding a quote | ✅ | | | | | | | |
 * | slash in a char class | ✅ | | ✅ | | | | | |
 * | regex in keyword position | ✅ | ✅ | | | | | | |
 * | `/` after a grouping `)` | | | | ✅ | | | | |
 * | keyword as a property name | | | | | | ✅ | | |
 * | apostrophe then a glob in a string | | | | | | | ✅ | |
 * | backslash ending a division | | | | | ✅ | | | |
 * | comment inside a template expression | | | | | | | | ✅ |
 *
 * ⚠️ **Seven of the snippets tick nothing** — the `/*`-in-a-line-comment glob, the apostrophe in a
 * comment, the plain division, the URL string, the multi-line template, the bare template
 * expression and the nested brace. They are kept deliberately: they are the constructs the guards' real inputs are FULL
 * of, so they document what the scanner must not break, and the first two are what the *regex
 * stripper* fails (pinned in "the sanity assertions can actually fail" below, which is where that
 * mutation is measured). Do not read an empty row as a useless case — read it as a case whose
 * mutation is covered elsewhere.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertEveryCodeTokenSurvives,
  assertScanIsSane,
  findDamagedCodeTokens,
  readScannedSource,
  stripComments,
  stripCommentsAndStrings,
  stripHashComments,
  stripSwiftComments,
} from './sourceScanner';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, '../../src/runtime');
// This file lives at engine/packages/modoki/tests/helpers — five levels down from the repo root.
// `engine/tests/helpers/repoLayout.ts`'s `REPO_ROOT` is not reachable from inside the package
// (nothing here relative-imports out of `engine/packages/modoki`), so it is derived the same way
// `inputSourceGuard.test.ts` (a sibling in this same package) already does.
const REPO_ROOT = join(HERE, '../../../../..');

/** The regex stripper this module exists to end — every one of the twelve guards had a copy. */
const brokenRegexStrip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the scanner survives the constructs that broke its predecessors (#411, #418, #419)', () => {
  const cases: ReadonlyArray<{ what: string; src: string; ticket: string }> = [
    // ── #411: a block-comment opener inside a LINE comment ──────────────────────────────────────
    // The defect this module was extracted for. `Scene3D.tsx:28` writes this exact glob in prose
    // and it deleted 82 lines — 22 of them imports — from the determinism guard's view.
    { ticket: '#411', what: 'a `/*` glob written inside a line comment',
      src: '// a direct performance.now() in runtime/** fails the guard\nprobe(x);\n/* later */' },
    { ticket: '#411', what: 'an apostrophe inside a comment',
      src: "// the tray's tint\nprobe(x);" },
    // ── #418: the regex-literal state ───────────────────────────────────────────────────────────
    { ticket: '#418', what: 'a regex literal ending in an escaped slash',
      src: "const u = s.replace(/https:\\/\\//g, ''); probe(x);" },
    { ticket: '#418', what: 'a regex literal holding a quote',
      src: "const q = /['\"]/; probe(x); // probe(y)" },
    // The char class holds a QUOTE as well as a slash, deliberately: with `inClass` deleted the
    // regex closes early at that slash and the `"` then opens a phantom STRING that runs to EOF,
    // so the trailing comment is never stripped. `/[//]/` alone did not discriminate.
    { ticket: '#418', what: 'a slash inside a regex character class',
      src: 'const q = /[/"]/; probe(x); // probe(y)' },
    // The `)` decision, pinned on a GROUPING paren — where division is the right answer and
    // TypeScript agrees. One slash only: with two, the second closes the misread literal before
    // the comment and the mutation escapes.
    { ticket: '#418', what: 'a `/` after a grouping `)`, which is division',
      src: 'const r = (a + b) / c; probe(x); // probe(y)' },
    { ticket: '#418', what: 'a division that is not a regex',
      src: 'const r = (a + b) / c / d; probe(x); // probe(y)' },
    // ⚠️ The probe sits INSIDE the same statement on purpose (measured). With it on the next line
    // the misread's damage — a `\/` + `/` read as `//`, blanking the rest of the line — lands
    // where nothing is counting, and this snippet caught the `lastWord` mutation not at all.
    { ticket: '#418', what: 'a regex in keyword position',
      src: 'function f(s) { return /\\/re\\//.test(s) && probe(x); } // probe(y)' },
    // Two probes, not one, and that is the point: the measured chain needed BOTH defects at once —
    // a keyword-as-property misread to desync the scanner, and an unbounded string state to carry
    // the damage across lines — so a single snippet reproducing the whole chain caught NEITHER fix.
    { ticket: '#418', what: 'a keyword used as a PROPERTY name, before a division',
      src: 'const r = stats.in / stats.total; probe(x); // probe(y)' },
    // The unbounded half: a misread division desyncs into the comment, an apostrophe there opens a
    // phantom string, and the `/*` inside the NEXT line's string literal opens a real block comment
    // that blanks to the following `*/`. Silent, with the line count unchanged.
    { ticket: '#418', what: 'an apostrophe in a comment, then a glob inside a string',
      src: "const half = i++ / 2; // it's a halving\n"
        + "const GLOB = 'runtime/*';\nconst KEEP = 0x445566;\nprobe(x);\n/* later */" },
    { ticket: '#418', what: 'a backslash ending a misclassified division',
      src: 'const a = i++ / 2 \\\nconst b = 3; // probe(y)\nprobe(x);' },
    // ── strings and templates ───────────────────────────────────────────────────────────────────
    { ticket: '#419', what: 'a `//` inside a URL string, which is not a comment',
      src: "const u = 'https://example.com/x'; probe(x);" },
    { ticket: '#419', what: 'a template literal spanning lines',
      src: 'const t = `line one\nline two`; probe(x);' },
    { ticket: '#419', what: 'a template expression, which is CODE',
      src: 'const t = `a ${probe(x)} b`;' },
    // ⚠️ A COMMENT inside the expression, because that is the only thing the re-entry changes when
    // string content is kept: without it the `/* probe(y) */` is template TEXT and survives, and
    // the count goes UP. A bare `${probe(x)}` discriminates nothing (measured).
    { ticket: '#419', what: 'a comment inside a template EXPRESSION',
      src: 'const t = `a ${ /* probe(y) */ 1 } b`; probe(x);' },
    { ticket: '#419', what: 'a nested brace inside a template expression',
      src: 'const t = `a ${ { k: 1 }.k } b`; probe(x); // probe(y)' },
  ];

  it.each(cases)('$ticket: $what', ({ what, src, ticket }) => {
    const stripped = stripComments(src);
    expect((stripped.match(/probe\(/g) ?? []).length,
      `${ticket}: the strip ate the call after ${what} — a count taken over this lowers silently, `
      + `and a lower count is a PASS for a forbidden-pattern guard.\n  in:  ${src}\n  out: ${stripped}`,
    ).toBe(1);
    assertScanIsSane(src, stripped, what);
  });

  it('a comment must still GO — the heuristic is allowed to be wrong only in the loud direction', () => {
    // The trade-off, stated once so it is not lost: being wrong leaves comments IN (a count goes
    // UP, loudly) rather than taking code OUT.
    expect(stripComments('probe(x); // probe(y)').match(/probe\(/g)).toHaveLength(1);
    expect(stripComments('probe(x); /* probe(y) */').match(/probe\(/g)).toHaveLength(1);
    expect(stripComments('/* probe(y)\n   probe(z) */ probe(x);').match(/probe\(/g)).toHaveLength(1);
  });

  it('the regex state can be turned off for source that is not JavaScript', () => {
    // WGSL/GLSL has no regex literals and every `/` is division. Modelling one there can only
    // misfire — `mtsdfShaderLiterals` scans shader text, not TS.
    const shader = 'let a = b / c; // note\nlet d = e / f;';
    const stripped = stripComments(shader, { regexLiterals: false });
    assertScanIsSane(shader, stripped, 'shader');
    expect(stripped, 'both divisions survive, the comment goes, and nothing between them is eaten')
      .toBe(shader.replace('// note', '       '));
  });

  it('`stripCommentsAndStrings` blanks literal CONTENT but not a template EXPRESSION', () => {
    const src = "const a = '0xff0000'; const b = `${0x00ff00}`; // 0x0000ff";
    const stripped = stripCommentsAndStrings(src, 'blank.ts');
    assertScanIsSane(src, stripped, 'blank.ts');
    expect(stripped.match(/0x[0-9a-fA-F]{6}/g), 'the hex inside the quoted string and the one in '
      + 'the comment are prose; the one inside `${}` is a real value').toEqual(['0x00ff00']);
  });

  it('⚠️ `stripCommentsAndStrings` does not mistake JSX TEXT for a string literal', () => {
    // The measured hole in the character-scanner version this replaced. A backtick is exempt from
    // the newline reset (a template spans lines by design), so one stray backtick in JSX prose
    // blanked every following line to the next backtick — including a real hex constant — and
    // `palette.test.ts`'s bare-hex sweep reported nothing. Silent, and in the pass direction.
    const src = 'export const T = () => (\n'
      + '  <span>press ` to open the console, then "go"</span>\n'
      + ');\n'
      + 'export const BAD = 0xff0000;\n';
    const stripped = stripCommentsAndStrings(src, 'jsx.tsx');
    assertScanIsSane(src, stripped, 'jsx.tsx');
    expect(stripped, 'the hex below the JSX must still be visible to a bare-hex guard')
      .toContain('0xff0000');
    expect(stripped, 'the JSX text itself is not a string literal and is left alone')
      .toContain('press ` to open the console, then "go"');
  });
});

describe('the sanity assertions can actually fail', () => {
  // ⚠️ Without this, `assertScanIsSane` is three expects nobody has ever seen go red. Length and
  // line parity are true BY CONSTRUCTION for the scanner, so the only thing they can catch is a
  // regression to a regex stripper — which is precisely what is checked here.
  const src = '// runtime/**\nconst KEEP = 1;\n/* later */\nprobe(x);';

  it('the regex stripper this replaces deletes code, and `assertScanIsSane` says so', () => {
    const bad = brokenRegexStrip(src);
    expect(bad, 'the premise: the old stripper really does swallow the declaration').not.toContain('KEEP');
    expect(() => assertScanIsSane(src, bad, 'regex-stripper')).toThrow();
  });

  it('the scanner keeps it', () => {
    const good = stripComments(src);
    expect(good).toContain('const KEEP = 1;');
    assertScanIsSane(src, good, 'scanner', ['const KEEP = 1;']);
  });

  it('a missing sentinel fails', () => {
    expect(() => assertScanIsSane(src, stripComments(src), 'scanner', ['not present'])).toThrow();
  });

  it('the token oracle reports damage rather than passing over a stump', () => {
    const bad = brokenRegexStrip(src);
    const { damaged } = findDamagedCodeTokens(src, bad, 'regex-stripper.ts');
    expect(damaged.length, 'a length change is itself the report').toBeGreaterThan(0);
  });
});

describe('⚠️ the FORWARD guard: no file the engine guards scan is damaged by the scanner', () => {
  const tsFiles = (dir: string): string[] => repoFiles({
    under: dir,
    match: /\.tsx?$/,
    floor: 400,
  }).map(({ abs }) => abs);

  /** Files under `dir` matching `extRe`, skipping build output. `dir` missing entirely (a public
   *  checkout's `games/`/`demos/`) degrades to an empty list rather than throwing — the repo
   *  convention for a glob over an optional tree. */
  // Via the shared corpus producer (#814) — `extRe` is matched against the BASENAME, as the
  // hand-rolled walker did, so every caller's regex keeps its original meaning. `floor: 0` because
  // several roots are legitimately absent in a partial checkout and every caller below carries its
  // own `minFiles` non-vacuity assertion.
  const collectFiles = (dir: string, extRe: RegExp): string[] => {
    if (!existsSync(dir)) return [];
    return repoFiles({
      under: dir,
      match: (rel) => extRe.test(basename(rel)),
      exclude: ['node_modules', 'dist'],
      floor: 0,
    }).map(({ abs }) => abs);
  };

  // `<root>/<project>/<sub>` across every project dir (each `games/<id>` or `demos/<id>`) — same
  // missing-root-degrades-to-empty behaviour as `collectFiles`.
  const collectAcrossProjects = (root: string, sub: string, extRe: RegExp): string[] => {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const proj of readdirSync(root)) out.push(...collectFiles(join(root, proj, sub), extRe));
    return out;
  };

  const gamesDir = join(REPO_ROOT, 'games');

  // Each set is the tree an actual migrated guard reads from (#419's Task 2) — a failure names
  // WHICH tree, rather than one sweep covering `src/runtime` and leaving every other guarded tree
  // with no forward oracle at all. `minFiles` is a non-vacuity floor: `games/`/`demos/` are absent
  // in a public checkout, where 0 is the correct (not missing) result, so those two floors are 0;
  // every tree that ships in every checkout keeps a real floor.
  const SWEEP_SETS: ReadonlyArray<{ label: string; files: string[]; minFiles: number }> = [
    { label: 'packages/modoki/src/runtime', files: tsFiles(RUNTIME), minFiles: 100 },
    { label: 'engine/scripts (.mjs/.js/.ts — not .sh, shell is not JS)',
      files: collectFiles(join(REPO_ROOT, 'engine/scripts'), /\.(mjs|js|ts)$/), minFiles: 10 },
    { label: 'engine/electron + engine/toolchain',
      files: [
        ...collectFiles(join(REPO_ROOT, 'engine/electron'), /\.ts$/),
        ...collectFiles(join(REPO_ROOT, 'engine/toolchain'), /\.ts$/),
      ], minFiles: 5 },
    { label: 'packages/modoki/src/editor',
      files: collectFiles(join(REPO_ROOT, 'engine/packages/modoki/src/editor'), /\.tsx?$/), minFiles: 20 },
    { label: 'engine/plugins',
      files: collectFiles(join(REPO_ROOT, 'engine/plugins'), /\.(ts|js|mjs)$/), minFiles: 3 },
    // ⚠️ Added in #812's close-out: routing the READ pulled these two trees under the scanner for
    // the FIRST time (`registerTraits.ts`, `setup.ts`, `main.tsx`, `debug/agentBridge.ts`, the MCP
    // `contracts.ts`), and `assertScanIsSane` cannot vouch for them — its length/line parity is
    // true by construction for `stripComments`, so a misread that deletes a declaration is silent.
    // Only this token oracle can see that. Swept clean when added: 103 files, 0 damaged.
    { label: 'engine/app (newly scanned via readScannedSource)',
      files: collectFiles(join(REPO_ROOT, 'engine/app'), /\.tsx?$/), minFiles: 20 },
    { label: 'engine/tools (newly scanned via readScannedSource)',
      files: collectFiles(join(REPO_ROOT, 'engine/tools'), /\.ts$/), minFiles: 5 },
    // ⚠️ The same standard, applied to what the gate's own widening newly routed: the two non-test
    // HELPERS in engine/tests/architecture, and the two engine-root configs that `ssrLoaderDefines`
    // and `buildTargetFloor` scan. The "test files" set is `.test.tsx?`-only, so none of these was
    // reached — the identical omission this pair of rows was added to fix.
    { label: 'architecture helpers + engine-root configs (newly scanned)',
      files: [
        join(REPO_ROOT, 'engine/tests/architecture/moduleGraph.ts'),
        join(REPO_ROOT, 'engine/tests/architecture/rendererConstructionCensus.ts'),
        join(REPO_ROOT, 'engine/vite.config.ts'),
        join(REPO_ROOT, 'engine/project-config.ts'),
      ].filter((f) => existsSync(f)),
      minFiles: 4 },
    { label: 'test files (engine/tests + games/*/tests + demos/*/tests)',
      files: [
        ...collectFiles(join(REPO_ROOT, 'engine/tests'), /\.test\.tsx?$/),
        ...collectAcrossProjects(gamesDir, 'tests', /\.test\.tsx?$/),
        ...collectAcrossProjects(join(REPO_ROOT, 'demos'), 'tests', /\.test\.tsx?$/),
      ], minFiles: 50 },
    { label: 'games/*/runtime',
      files: collectAcrossProjects(gamesDir, 'runtime', /\.tsx?$/),
      minFiles: existsSync(gamesDir) ? 5 : 0 },
  ];

  it.each(SWEEP_SETS)('$label', ({ label, files, minFiles }) => {
    // ⚠️ This is what the per-call-site `assertScanIsSane` cannot do. It needs nobody to have
    // THOUGHT of the hazard first: the day a scanned file grows a construct this scanner
    // mishandles, this fails and names the line. Measured at ~3.5s for the whole table.
    expect(files.length, `${label}: the walk found ${files.length} files — this would pass while `
      + 'inspecting nothing').toBeGreaterThanOrEqual(minFiles);
    if (files.length === 0) return; // an absent tree in a public checkout — nothing to sweep

    // A file TypeScript cannot parse cleanly makes the token walk meaningless (garbage-in tree),
    // so it is SKIPPED and counted rather than silently treated as "no damage found" — a large
    // skip count would hide exactly the files this sweep exists to check.
    const damaged: string[] = [];
    const skipped: string[] = [];
    let totalTokens = 0;
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
      const raw = readFileSync(file, 'utf8');
      const scanLabel = file.endsWith('.tsx') ? `${rel}.tsx` : rel;
      const res = findDamagedCodeTokens(raw, stripComments(raw), scanLabel, 2);
      if (res.parseErrors > 0) { skipped.push(rel); continue; }
      totalTokens += res.tokens;
      damaged.push(...res.damaged);
      if (damaged.length > 20) break;
    }
    expect(skipped.length, `${label}: ${skipped.length}/${files.length} files did not parse, so the `
      + `token walk skipped them (not swept, not counted as damage): ${skipped.join(', ')}`)
      .toBeLessThan(Math.max(5, Math.ceil(files.length * 0.1)));
    expect(totalTokens, `${label}: the walk is not reaching the trees`).toBeGreaterThan(0);
    expect(damaged, `${label}: the scanner ate CODE in these files — every guard that scans them is `
      + `now blind to it, silently.\n${damaged.join('\n')}`).toEqual([]);
  });

  it('the file that proved the old stripper defeats the determinism guard is intact', () => {
    // ⚠️ The measured #419 case, pinned by name. `Scene3D.tsx:28`'s line comment writes the glob
    // `runtime/**`; under the regex stripper that opened a phantom block running to the next `*/`
    // and deleted 82 lines including 22 `import` statements, so a `performance.now()` planted
    // anywhere in that window left `determinismGuard.test.ts` green.
    const raw = readFileSync(join(RUNTIME, 'rendering/Scene3D.tsx'), 'utf8');
    const imports = (src: string): number => (src.match(/^import /gm) ?? []).length;
    expect(imports(brokenRegexStrip(raw)), 'the premise — if this ever equals the real count the '
      + 'comment moved and this test stopped testing anything').toBeLessThan(imports(raw));
    const stripped = stripComments(raw);
    expect(imports(stripped)).toBe(imports(raw));
    assertEveryCodeTokenSurvives(raw, stripped, 'Scene3D.tsx', { minTokens: 4_000 });
  });
});

describe('the non-JS strippers hold the same length/line contract (#812)', () => {
  it('Swift: nested block comments close at the right depth, and the strip is length-preserving', () => {
    // ⚠️ The nesting is the whole reason Swift has its own tokenizer: a depth-blind stripper closes
    // at the FIRST `*/` and leaves the outer comment's tail as apparent code.
    const raw = 'let a = 1\n/* outer /* inner */ still comment */\nlet keep = 2\n';
    const code = stripSwiftComments(raw);
    expect(code.length, 'length parity is what puts it inside assertScanIsSane').toBe(raw.length);
    expect(code.split('\n').length).toBe(raw.split('\n').length);
    expect(code).toContain('let keep = 2');
    expect(code, 'the outer comment\'s tail leaked out as code — the depth counter is not counting')
      .not.toContain('still comment');
  });

  it('Swift: a `//` inside a string literal is not a comment', () => {
    const raw = 'let u = "https://host//path"\nlet keep = 1\n';
    const code = stripSwiftComments(raw);
    expect(code).toContain('https://host//path');
    expect(code).toContain('let keep = 1');
  });

  it('shell: `#` blanks a comment but not `${v#prefix}`, `a#b`, or the shebang', () => {
    const raw = '#!/usr/bin/env bash\necho "${v#pre}" # trailing note\nid=a#b\n';
    const code = stripHashComments(raw);
    expect(code.length).toBe(raw.length);
    expect(code, 'the shebang is load-bearing metadata a guard may assert on').toContain('#!/usr/bin/env bash');
    expect(code, 'parameter expansion is code, not a comment').toContain('${v#pre}');
    expect(code, 'a `#` with no preceding whitespace does not open a comment').toContain('id=a#b');
    expect(code, 'the trailing comment survived — a comment can then satisfy a required match')
      .not.toContain('trailing note');
  });

  it('shell/yaml: an apostrophe in prose does not eat the NEXT line\'s comment', () => {
    // ⚠️ The measured review finding. Without a newline reset the `'` in `Don't` opens a string
    // that runs to the next quote anywhere in the file, and every `#` comment in between survives
    // unblanked — a required-pattern guard can then be satisfied by prose. `assertScanIsSane` is
    // blind to it: length and line parity both still hold.
    const raw = "name: Don't push\nfoo: bar # a real comment\n";
    const code = stripHashComments(raw);
    expect(code.length).toBe(raw.length);
    expect(code, 'the following line\'s comment survived the strip').not.toContain('a real comment');
    expect(code).toContain('foo: bar');
  });

  it('shell: a `#` inside quotes survives', () => {
    const raw = 'msg="issue #812 is the one"\nkeep=1\n';
    const code = stripHashComments(raw);
    expect(code).toContain('issue #812 is the one');
    expect(code).toContain('keep=1');
  });
});

describe('readScannedSource is the one read, and REFUSES rather than falling back (#812)', () => {
  let dir: string;
  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    return p;
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scanned-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('strips by extension and hands back a code view aligned with raw', () => {
    const p = write('guard.ts', 'const a = 1; // performance.now()\nconst b = 2;\n');
    const { raw, code } = readScannedSource(p);
    expect(code.length).toBe(raw.length);
    expect(code, 'the offender was in a COMMENT — a forbidden-pattern guard must not see it')
      .not.toContain('performance.now()');
    expect(code).toContain('const b = 2;');
  });

  it('picks the SWIFT stripper for .swift, not the JS one', () => {
    // The discriminator: JS has no nested block comments, so the JS scanner would close early and
    // leak `MediaPipeTasksGenAI` — the exact false-declaration case #812 cites.
    const p = write('Package.swift', '/* a /* b */ .package(name: "MediaPipeTasksGenAI") */\nlet x = 1\n');
    const { code } = readScannedSource(p);
    expect(code).not.toContain('MediaPipeTasksGenAI');
    expect(code).toContain('let x = 1');
  });

  it('.pbxproj stays UNREGISTERED — the invariant is a test, not a comment', () => {
    // ⚠️ This exists because the claim "re-registering pbxproj fails loudly" was FALSE when first
    // written. `comments: 'include'` returns before the extension lookup and `pbxprojObjectIds`
    // reads `.raw`, so registration is inert for the only caller — re-adding the row left all 754
    // architecture tests green. The invariant was held by prose, one plausible edit from restoring
    // a guard that inspected 1 of 43 object ids.
    const p = write('project.pbxproj', '\t\t504EC2FB1FED79650016851F = {\n');
    expect(() => readScannedSource(p), 'a pbxproj annotation is generated NAMING that '
      + "pbxprojObjectIds' regex matches as syntax — blanking it cut its ids from 43 to 1")
      .toThrow(/no comment stripper/);
  });

  it('refuses an extension it has no stripper for, instead of returning raw text', () => {
    const p = write('notes.md', 'a doc that mentions performance.now()\n');
    expect(() => readScannedSource(p), 'falling back to raw IS the bug — it must refuse')
      .toThrow(/no comment stripper/);
  });

  it("refuses comments:'include' with no reason", () => {
    const p = write('guard.ts', 'const a = 1;\n');
    expect(() => readScannedSource(p, { comments: 'include' })).toThrow(/needs a reason/);
  });

  it("comments:'include' with a reason returns raw, for the guards that scan prose ON PURPOSE", () => {
    // ⚠️ `docCitations` and `editorStoreActionsReachable` are the real callers. Stripping there
    // DEFEATS them — a citation in a docblock is exactly what the first exists to catch.
    const p = write('guard.ts', 'const a = 1; // docs/rendering.md\n');
    const { raw, code } = readScannedSource(p, { comments: 'include', reason: 'cites live in docblocks' });
    expect(code).toBe(raw);
    expect(code).toContain('docs/rendering.md');
  });

  it('a sentinel that does not survive the strip fails the read', () => {
    const p = write('guard.ts', 'const a = 1; // only-in-a-comment\n');
    expect(() => readScannedSource(p, { sentinels: ['only-in-a-comment'] }))
      .toThrow(/sentinel/);
  });

  it('an explicit `language` overrides a suffix that lies', () => {
    const p = write('hook', '#!/usr/bin/env bash\nrun # note\n');
    const { code } = readScannedSource(p, { language: 'shell' });
    expect(code).toContain('run');
    expect(code).not.toContain('note');
  });
});
