/** #840 — no hand-written UNIT FALLBACK for a UI length in any script under engine/, games/ or demos/.
 *
 *  A `UIElement`/`UIAnchor` length is a number plus a unit, and a scene/prefab save strips a unit equal
 *  to its default — so an absent unit is the ordinary on-disk shape, and what it MEANS is per field:
 *  `%` for `width`/`height`/`padding*`/`margin*`, `px` for `gap`, `min*`/`max*`, `minTapSize`,
 *  `fontSize`, `letterSpacing` and every `UIAnchor` offset. Every reader that wrote its own fallback
 *  (a `|| 'px'` or a `?? '%'` after the unit) was therefore right for some fields and wrong for the
 *  rest — 36 such literals across 8 files when this landed, two of them Court guards computing a `%`
 *  padding as pixels.
 *
 *  The table that holds the defaults is `runtime/traits/uiLength.ts`, and the traits take their schema
 *  defaults FROM it. Engine code reads a pair through `readUILength` / `readUIAnchorLength`; game code
 *  through the public `traitFieldOrDefault`. Neither needs a literal fallback, so this guard bans the
 *  shape outright rather than keeping an allowlist of "fallbacks that happen to be right" — a copy is
 *  exactly what the next reader of a different field reuses.
 *
 *  ⚠️ **Why the pattern does not look at the left-hand side.** The first version required it to be a
 *  name ending in `unit`. A mutation check wrote `(bag[key] as string | undefined) ?? 'px'` and it
 *  walked straight past — and dropping the requirement found one more live instance the first census
 *  had missed: the Inspector's generic unit read, `(data[unitKey] as string) || 'px'`. A `??`/`||`
 *  whose right side is a bare length unit is a unit fallback whatever it is attached to; the repo has
 *  no other use of that shape.
 *
 *  ⚠️ **What it still CANNOT see**, so a green run is not read as more than it is:
 *  - the ternary form (`typeof unit === 'string' && unit ? unit : '%'`) and a `switch` `default:` arm;
 *  - a fallback through a named constant or a helper (`unit ?? PX`, `unit ?? defaultUnit()`);
 *  - reading a length's NUMBER and ignoring its unit altogether, which is the defect's other half and
 *    which no grep can see (Court's `tapZoneClearance` read `minTapSize` that way).
 *
 *  Seen since #1179's P2 review: `unit ??= 'px'` / `unit ||= 'px'` (the regex never matched them), and
 *  a fallback quoted inside a STRING or template (generated code — the per-line regex caught it by
 *  accident of matching raw text, and the first parse dropped it).
 *
 *  Comments are scanned too, deliberately: a comment quoting the old fallback is the copy a reader
 *  pastes. Describe one in words.
 *
 *  ⚠️ **CODE is read from the parse, COMMENTS by text (#1179).** The per-line regex over raw text
 *  missed `unit ??\n  'px'`, the shape a formatter produces for a long left side. Code is now a
 *  `??`/`||` NODE whose right operand is a bare unit literal, wrapped or not; comments have no AST, so
 *  the comment characters alone keep the text pattern. Measured on migrating: 0 / 0, unchanged. */

import { describe, it, expect } from 'vitest';
import { readScannedSource, stripComments } from '@modoki/engine/testing';
import { findNodes, flatText, lineOf, parseSource, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
import fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';

/** `??` or `||`, then a quoted bare length unit — whatever is on the left. The TEXT form, applied to
 *  comments only. */
const UNIT_FALLBACK = /(\?\?=?|\|\|=?)\s*['"`](px|%|vw|vh|vmin|vmax)['"`]/;
const UNITS = new Set(['px', '%', 'vw', 'vh', 'vmin', 'vmax']);

/** Every unit fallback in one file: `??`/`||` nodes in the code, plus comment lines quoting one.
 *  `raw` is the file; `code` is the same length with comments blanked (`readScannedSource`). */
function unitFallbacks(raw: string, code: string, label: string): string[] {
  // ⚠️ Parse only a file whose CODE holds a quoted unit literal at all — a fallback cannot exist
  // without one, and parsing all ~3,000 corpus files blew this test's 20 s budget under the gate's
  // load (#1179 close-out). The prefilter decides nothing; the node below does.
  const sf = QUOTED_UNIT.test(code) ? parseSource(code, label) : undefined;
  const inCode = !sf ? [] : findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n) && FALLBACK_OPERATORS.has(n.operatorToken.kind))
    .filter((b) => { const r = unwrapValue(b.right); return ts.isStringLiteralLike(r) && UNITS.has(r.text); })
    .map((b) => `${label}:${lineOf(b)}: ${flatText(b)}`);
  // A fallback QUOTED inside a string or template is code someone will paste or generate.
  const inStrings = !sf ? [] : findNodes(sf, (n): n is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
    ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
    .filter((n) => UNIT_FALLBACK.test(n.text))
    .map((n) => `${label}:${lineOf(n)}: (string) ${n.text.trim().replace(/\s+/g, ' ')}`);
  // Comment characters are the positions the scanner blanked; only lines that differ carry any.
  const codeLines = code.split('\n');
  const inComments = raw.split('\n').flatMap((rawLine, i) => {
    const codeLine = codeLines[i] ?? '';
    if (rawLine === codeLine) return [];
    let comment = '';
    for (let c = 0; c < rawLine.length; c++) comment += rawLine[c] === codeLine[c] ? ' ' : rawLine[c];
    return UNIT_FALLBACK.test(comment) ? [`${label}:${i + 1}: (comment) ${comment.trim()}`] : [];
  });
  return [...inCode, ...inStrings, ...inComments];
}
const FALLBACK_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken]);
// `\\?` before each quote: a fallback QUOTED inside a string is spelt `\'px\'` in the source, and the
// string channel matches the unescaped VALUE — the prefilter must not be stricter than that.
const QUOTED_UNIT = /\\?['"`](?:px|%|vw|vh|vmin|vmax)\\?['"`]/;
const flags = (line: string): boolean => unitFallbacks(line, line, 'row.ts').length > 0;
/** A row written as an object-literal member (`widthUnit: …,`) parses only inside a literal. */
const asSource = (line: string): string => (/^[a-zA-Z]+:/.test(line) ? `({ ${line} })` : line);

/** This file quotes the shape in its own fixtures below. */
const SELF = 'engine/tests/architecture/uiLengthFallback.test.ts';

describe('the unit-fallback pattern itself (#840)', () => {
  it.each([
    "widthUnit: ui.widthUnit || 'px',",
    "const unit = sizeUnit ?? '%';",
    "const cUnit = c.unit ?? 'px';",
    'topUnit: anc.topUnit||"vh"',
    'switch (unit ?? `vmin`) {}',
    // The two shapes the first version of this guard could not see:
    "const unit = (data[unitKey] as string) || 'px';",
    "const unit = (bag[`${field}Unit`] as string | undefined) ?? 'px';",
    "function f() { const u = ui.widthUnit; return u || 'vw'; }",
    // #1179: wrapped after the operator, and a parenthesised literal.
    "const unit = someLongReceiver.widthUnit ??\n  'px';",
    "const unit = u || ('%');",
  ])('flags %s', (line) => {
    expect(flags(asSource(line))).toBe(true);
  });

  it('each occurrence is reported ONCE, by the channel it lives in — code, string, or comment (#1179)', () => {
    const raw = [
      "const u = x ?? 'px';",
      "let v = y; v ??= '%'; v ||= 'vw';",
      "const snippet = `const w = z ?? 'px';`;",
      "const esc = 'const q = r ||= \\'vh\\';';",
      "// was: u ??= 'px'",
      "const e = readUILength(ui, 'width'); // was: ui.widthUnit || 'px'",
    ].join('\n');
    expect(unitFallbacks(raw, stripComments(raw), 'row.ts')).toEqual([
      "row.ts:1: x ?? 'px'", "row.ts:2: v ??= '%'", "row.ts:2: v ||= 'vw'",
      "row.ts:3: (string) const w = z ?? 'px';", "row.ts:4: (string) const q = r ||= 'vh';", "row.ts:5: (comment) // was: u ??= 'px'",
      "row.ts:6: (comment) // was: ui.widthUnit || 'px'",
    ]);
  });

  it('the per-file prefilter does not skip a file whose only unit literal is ESCAPED inside a string (#1179)', () => {
    const only = "const esc = 'const q = r || \\'vh\\';';";
    expect(unitFallbacks(only, stripComments(only), 'row.ts')).toEqual(["row.ts:1: (string) const q = r || 'vh';"]);
  });

  it('a comment quoting the fallback is flagged, on its own (comments are scanned deliberately)', () => {
    const raw = "const w = readUILength(ui, 'width');\n// was: ui.widthUnit || 'px'\n";
    const code = stripComments(raw);
    expect(unitFallbacks(raw, code, 'row.ts')).toEqual(["row.ts:2: (comment) // was: ui.widthUnit || 'px'"]);
  });

  it.each([
    'scale: ui.scale ?? 1,',
    'marginTop: ui.marginTop || 0,',
    "if (unit === 'px') return v;",
    "widthUnit: readUILength(ui, 'width').unit,",
    'fontSize: ui.fontSize || 16,',
    "const g = gapUnit === '%' ? a : b;",
    "traitFieldOrDefault<string>(UIElement, bag, 'paddingLeftUnit')",
    "const label = name ?? 'px-wide';",
    // #1179: a unit literal that is not the fallback's right operand.
    "const s = (unit || 'x') + 'px';",
  ])('does not flag %s', (line) => {
    expect(flags(asSource(line))).toBe(false);
  });
});

describe('no hand-written UI length unit fallback in the repo (#840)', () => {
  // Tracked AND untracked-but-not-ignored: a fallback written a minute ago is exactly the one worth
  // catching before it is committed. `games`/`demos` come from the one authored list of project roots.
  const corpus = repoFiles({
    under: ['engine', ...PROJECT_ROOT_DIRS],
    // Scripts of every flavour, not only TypeScript: engine/scripts, engine/tools and engine/plugins are .mjs/.js.
    match: /\.(ts|tsx|mts|cts|js|mjs|cjs)$/,
    exclude: ['node_modules', 'dist', 'ios', 'android'],
    floor: 500,
  });

  it('enumerates the real corpus — including the files this family was found in', () => {
    const rels = new Set(corpus.map((f) => f.rel));
    expect(rels.has('engine/packages/modoki/src/runtime/ui/uiTreeStore.ts'), 'the largest former offender').toBe(true);
    expect(rels.has('engine/packages/modoki/src/editor/panels/Inspector.tsx'), 'the one only the wider pattern found').toBe(true);
    expect(rels.has('engine/packages/modoki/src/runtime/traits/uiLength.ts'), 'the table itself is scanned too').toBe(true);
    expect(rels.has(SELF), 'the self-exclusion below must be excluding something real').toBe(true);
  });

  it('finds no unit fallback literal outside this file', () => {
    const hits = corpus.filter(({ rel }) => rel !== SELF)
      .flatMap(({ rel, abs }) => unitFallbacks(fs.readFileSync(abs, 'utf8'), readScannedSource(abs).code, rel));
    expect(hits, 'read the pair through readUILength/readUIAnchorLength (engine) or traitFieldOrDefault (games) — see runtime/traits/uiLength.ts').toEqual([]);
  });
});
