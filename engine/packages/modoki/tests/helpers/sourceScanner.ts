/**
 * ⚠️ **ONE comment scanner, shared by every source-scanning guard (#419).**
 *
 * Before this file there were **twelve** private comment strippers across `engine/**` and
 * `games/court/**`, seven of them behaviourally distinct, and every one of them built the same
 * way: strip block comments with a lazy regex, then line comments.
 *
 *     src.replace(BLOCK, '').replace(LINE, '')     <- the defect, where BLOCK is the LAZY
 *                                                     /* ... *[/] pair and LINE is //...
 *
 * (spelled in words because writing the block-comment terminator literally would end THIS comment —
 * a small demonstration of the very ambiguity the scanner below exists to handle.)
 *
 * A block-comment OPENER sitting inside a LINE comment opens a phantom block that runs to the
 * next real terminator, and everything between is DELETED. That is not hypothetical: it was found
 * live in `games/court/runtime/systems.ts` (#411, fixed in `90d1dfc5d`/`2ef648a2d`) and never swept
 * out of the engine, where `runtime/rendering/Scene3D.tsx:28` writes the glob `runtime/**` in a
 * line comment and blinds `determinismGuard.test.ts` to **82 lines including 22 import
 * statements**. Mutation-proved both directions: a `performance.now()` planted inside that window
 * left the guard green; the same line outside it failed. The comment explaining the determinism
 * rule was what hid code from the determinism guard.
 *
 * ⚠️ **Every failure mode of a comment stripper LOWERS what the scan can see, and these guards are
 * FORBIDDEN-pattern guards — so a lower count is a PASS.** They fail silent and green, which is the
 * only direction that matters. Hence two rules for anyone using this module:
 *
 * 1. **Do not write a thirteenth private stripper.** That multiplicity is the root cause — one
 *    scanner was fixed twice (#411, #418) while eleven copies of the original bug carried on.
 * 2. **Call `assertScanIsSane` before you trust a count.** A guard whose own instrument can delete
 *    the code it inspects is not a guard.
 *
 * The scanner itself is a five-state machine lifted from `games/court/tests/sharedPredicates.test.ts`,
 * which reached that shape by being wrong twice; the reasoning behind each state is kept with the
 * state it explains. Its regression cover is `sourceScanner.test.ts` — the crafted snippets there
 * are the ONLY thing that can tell a fixed scanner from a broken one, because real fixture files
 * strip byte-identically under most of the mutations (measured, #411 close-out).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import ts from 'typescript';

export interface ScanOptions {
  /**
   * Model JS/TS regex literals (default `true`). Set `false` for source that is not JavaScript —
   * WGSL/GLSL shader text, where every `/` is division and the regex heuristic can only misfire.
   */
  regexLiterals?: boolean;
}

/**
 * A `/` here opens a REGEX rather than dividing, decided by what came before it (#418).
 *
 * The classic ambiguity, and the reason this is a heuristic and not a parser: `/` after a value is
 * division, `/` after an operator or an opening bracket starts a literal. `)` is genuinely
 * ambiguous (`(a + b) / c` against `if (x) /re/.test(s)`) and is deliberately read as DIVISION —
 * see `stripComments` for why that direction is the safe one to be wrong in.
 */
const REGEX_PRECEDERS = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'],
);
/**
 * The other half of the same question: a `/` right after one of these is a literal, not division.
 *
 * ⚠️ **Asked against the last COMPLETED word, not the word being accumulated.** An earlier version
 * asked against the running `word`, which is reset by every non-word character — so by the time the
 * `/` in `return /re/` was reached it was asking `has('')`, and the whole keyword half of the
 * heuristic was dead code. `return /\/prefabs\//.test(p)` then fell through to division and blanked
 * the rest of its line: #418 unfixed, in the one position where it is most likely to appear.
 */
const REGEX_KEYWORDS = new Set(
  ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'yield', 'await', 'do', 'else'],
);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

/**
 * Source with comment CONTENT blanked out, so a scan sees code only.
 *
 * One left-to-right pass with five states — code, line comment, block comment, string (quote,
 * apostrophe and backtick, escapes honoured) and regex literal. Comment characters become spaces
 * and **newlines are always preserved**, so the result has the same LENGTH and the same line
 * structure as the input: a `stripped.slice(0, i)` line count is the real file's line number, and
 * a parser's token offsets over the RAW source address the stripped string directly. A `//` inside
 * a string (`https://…`) and a `/*` inside a line comment (`runtime/**`) are both just characters
 * here, which is the whole point — and it is why this needs no `[^:]` hack to survive a URL, the
 * way two of the regex strippers it replaces did.
 *
 * ⚠️ **The regex state is the fifth because four was not enough (#418).** With code / line / block
 * / string alone, a regex ending in an escaped slash closes itself into a line comment — the `\/`
 * and the literal's own `/` read as `//` — and the rest of that line is blanked:
 *
 * ```
 * IN : const u = s.replace(/https:\/\//g, ''); isTilePlayable(x);
 * OUT: const u = s.replace(/https:\/\
 * ```
 *
 * That is the SAME failure the four-state scanner was written to end, one construct over: silent,
 * and in the direction that LOWERS a count, which for a forbidden-pattern guard is a pass.
 *
 * ⚠️ **Which way this fails when the heuristic is wrong is biased, not proven.** The regex state
 * pushes characters VERBATIM rather than blanking them, so a misread usually just leaves a stretch
 * of comments unstripped — a count going UP, which fails loudly. But a misread `/` closes at the
 * next `/` it meets, which can be the `//` of a real comment, and the scanner is then in CODE state
 * inside comment prose where an apostrophe opens a string and a `/*` opens a genuine block comment.
 * That chain measurably deleted a declaration and lowered a count to zero with the line count
 * unchanged. Both of its doors are shut — a keyword used as a property name is not a keyword, and a
 * quoted string ends at its newline — and each is pinned by its own snippet in the test.
 * **The residue: a desync can still reach a `/*` on the SAME line, and a block comment is
 * multi-line by nature, so "bounded to its own line" holds for the regex and string states and NOT
 * for that one.**
 */
export function stripComments(src: string, opts: ScanOptions = {}): string {
  const modelRegex = opts.regexLiterals !== false;
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'string' | 'regex' = 'code';
  let quote = '';
  // The last non-whitespace character and the trailing word seen in CODE — the two things
  // `REGEX_PRECEDERS`/`REGEX_KEYWORDS` are asked about. Tracked as we go rather than by looking
  // back over `out`, which would make this quadratic over a 17k-line file.
  let prev = '';
  let word = '';
  // The last word that ENDED, which is what `REGEX_KEYWORDS` must be asked about — `word` itself is
  // always `''` at a `/`, because the space before it reset it. See that Set's banner.
  let lastWord = '';
  // Was the word currently being accumulated introduced by a `.`? A keyword used as a PROPERTY name
  // is not a keyword — `stats.in / stats.total` is division, and treating it as a regex opener is
  // how a review got a declaration deleted again. See `REGEX_KEYWORDS`.
  let wordFollowsDot = false;
  let inClass = false;
  // Brace depth inside each open `${...}` back to its enclosing template literal. A template
  // expression is CODE — `` `${a /* c */}` `` holds a real comment, and `stripCommentsAndStrings`
  // must leave a value written inside one alone while blanking the prose around it.
  const tplExprDepth: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') {
      out.push('\n');
      if (state === 'line') state = 'code';
      // A regex literal cannot span a line, so reaching one means this was a division we misread.
      // Dropping back to code bounds that mistake to the line it happened on.
      if (state === 'regex') { state = 'code'; inClass = false; }
      // ⚠️ **And the same for a QUOTED string, which is what actually made a misread unbounded.**
      // `'` and `"` cannot hold a raw newline — a real line continuation escapes it, and that is
      // consumed by the escape branch below, so arriving here in string state means the opening
      // quote was an apostrophe in prose the scanner had desynced into. Left running it closed on
      // the next quote anywhere in the file, and a `/*` inside THAT literal opened a real block
      // comment that blanked to the next `*/`. A backtick is exempt: a template literal spans
      // lines by design.
      if (state === 'string' && quote !== '`') { state = 'code'; quote = ''; }
      continue;
    }
    if (state === 'line' || state === 'block') {
      if (state === 'block' && c === '*' && next === '/') { out.push('  '); i++; state = 'code'; continue; }
      out.push(' ');
      continue;
    }
    if (state === 'string') {
      // `${` re-enters CODE. Only inside a template literal — in a quoted string it is two
      // ordinary characters.
      if (quote === '`' && c === '$' && next === '{') {
        out.push('${');
        i++;
        state = 'code';
        tplExprDepth.push(0);
        prev = '{';
        word = '';
        lastWord = '';
        continue;
      }
      if (c === '\\') {
        out.push(c);
        if (next !== undefined) { out.push(next); i++; }
        continue;
      }
      if (c === quote) { state = 'code'; out.push(c); prev = c; continue; }
      out.push(c);
      continue;
    }
    if (state === 'regex') {
      out.push(c);
      // `\/` is a slash IN the pattern, and `[/]` is one too — neither closes the literal.
      // ⚠️ A backslash must NOT swallow a newline here. Consuming it skips the top-of-loop reset,
      // so a misclassified division ending in `\` carries regex state into the following lines and
      // leaves their comments unstripped — the "bounded to its own line" promise, broken by the one
      // branch that runs before the newline is ever seen. A regex literal cannot contain a raw
      // newline, so there is nothing to escape. (The string branch above deliberately DOES consume
      // it: there a `\`-newline is a real line continuation.)
      if (c === '\\') { if (next !== undefined && next !== '\n') { out.push(next); i++; } continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { state = 'code'; prev = '/'; word = ''; lastWord = ''; }
      continue;
    }
    if (c === '/' && next === '/') { out.push('  '); i++; state = 'line'; continue; }
    if (c === '/' && next === '*') { out.push('  '); i++; state = 'block'; continue; }
    if (modelRegex && c === '/' && (prev === '' || REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.has(lastWord))) {
      out.push(c);
      state = 'regex';
      inClass = false;
      word = '';
      lastWord = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      state = 'string';
      out.push(c);
      prev = c;
      word = '';
      lastWord = '';
      continue;
    }
    // Closing a `${...}` returns to the template literal it interrupted.
    if (c === '}' && tplExprDepth.length > 0) {
      const depth = tplExprDepth[tplExprDepth.length - 1];
      if (depth === 0) {
        tplExprDepth.pop();
        state = 'string';
        quote = '`';
        out.push('}');
        continue;
      }
      tplExprDepth[tplExprDepth.length - 1] = depth - 1;
    } else if (c === '{' && tplExprDepth.length > 0) {
      tplExprDepth[tplExprDepth.length - 1]++;
    }
    out.push(c);
    if (isWordChar(c)) { if (word === '') wordFollowsDot = prev === '.'; word += c; }
    // A property access is not a keyword — `.in`, `.of`, `.case`, `.new`, `.delete`, `.else` are all
    // ordinary member names, and every one of them precedes a division sooner or later.
    else { if (word !== '') lastWord = wordFollowsDot ? '' : word; word = ''; }
    if (c !== ' ' && c !== '\t' && c !== '\r') prev = c;
  }
  return out.join('');
}

/**
 * ⚠️ **Prove the strip did not eat code, before trusting a single count.**
 *
 * Cheap, and called at every site. The output must have the same LENGTH and the same line count as
 * the input, and any sentinels handed in must survive. Length and line parity are true by
 * construction for `stripComments` — every branch pushes as many characters as it consumed — so
 * what these actually catch is a **regression to a regex-based stripper**, which is the thing #419
 * was about: against the deleting version they fail loudly, by thousands of characters.
 *
 * They cannot catch a scanner that is merely WRONG. For that, either pass sentinels that sit inside
 * the window a plausible misread would swallow, or use `assertEveryCodeTokenSurvives`.
 */
export function assertScanIsSane(
  raw: string,
  stripped: string,
  label: string,
  sentinels: readonly string[] = [],
): void {
  expect(stripped.length, `${label}: the strip changed the file LENGTH — it is eating source, and `
    + 'every count taken from it is meaningless (a regex stripper does exactly this)').toBe(raw.length);
  expect(stripped.split('\n').length, `${label}: the strip dropped or added lines — reported line `
    + 'numbers no longer address the real file').toBe(raw.split('\n').length);
  for (const s of sentinels) {
    expect(stripped.includes(s), `${label}: sentinel \`${s}\` did not survive the strip`).toBe(true);
  }
}

/**
 * ⚠️ **Comments AND string/template literal content blanked — for a guard hunting a value that can
 * hide in prose either way** (`palette.test.ts`'s bare-hex sweep is the caller this exists for).
 *
 * ⚠️ **This is PARSER-driven, deliberately, and the char scanner's `/`-heuristic is not good
 * enough for it.** An earlier version of this ran a `blankStrings` mode inside `stripComments` and
 * had a measured hole: a lone backtick or a quote in **JSX text** — `<span>press ` to open</span>`,
 * or `A preview retires after ~9s; "Use for win" writes...` in `games/court/runtime/debugTab.tsx`
 * — is not a string literal, but a character scanner cannot know that without knowing it is inside
 * JSX. A backtick is exempt from the newline reset (a template spans lines by design), so one
 * stray backtick in prose blanked six following lines of real code **including a `0xff0000`
 * constant**, and the bare-hex guard reported nothing. Silent, and in the direction that turns a
 * forbidden-value guard into a pass — this module's whole subject.
 *
 * TypeScript decides instead. `stripComments` blanks the comments (it is proven clean across every
 * tree the guards scan), then the parser's own string and template tokens are blanked on top.
 * Both passes are length-preserving, so they compose exactly; `JsxText` is not a string token and
 * survives, which is the entire point. Being exact by construction, this needs no token oracle —
 * `assertScanIsSane` still applies.
 *
 * ⚠️ The trade-off: it REQUIRES source TypeScript can parse, and throws when it cannot. The char
 * scanner is the one to reach for on anything else (shader text, a sliced function body).
 */
export function stripCommentsAndStrings(src: string, label: string): string {
  const sf = ts.createSourceFile(
    label,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    label.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parsed = sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if ((parsed.parseDiagnostics?.length ?? 0) > 0) {
    throw new Error(`${label}: did not parse, so its string literals cannot be located — `
      + 'blanking them with a character scanner is what this function exists to avoid');
  }
  const out = stripComments(src).split('');
  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(sf);
    if (kids.length > 0) { for (const k of kids) visit(k); return; }
    if (!STRING_TOKEN_KINDS.has(node.kind)) return;
    // `getStart` skips leading trivia; the span is the literal including its own delimiters.
    for (let i = node.getStart(sf); i < node.getEnd(); i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  visit(sf);
  return out.join('');
}

/** The literal tokens `stripCommentsAndStrings` blanks. Deliberately NOT the whole
 *  `FirstLiteralToken..LastTemplateToken` range — that starts at `NumericLiteral`, and a bare-hex
 *  sweep is exactly the caller this exists for. `JsxText` is absent for the same reason. */
const STRING_TOKEN_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** One damaged token, as `<label>:<line>  <raw> became <stripped>`. */
export type DamagedToken = string;

/**
 * ⚠️ **The instrument check with actual teeth: a PARSER decides what is code, and every token has
 * to still be there.**
 *
 * TypeScript parses the RAW source, and for every leaf token that is not a comment the stripped
 * output must be byte-identical over that token's exact span. It works because `stripComments` is
 * length-preserving by construction, so raw offsets address the stripped string directly.
 *
 * ⚠️ **This is a FORWARD guard, not a regression pin, and the difference was measured.** Against a
 * real fixture it is silent for most scanner mutations — a given file usually contains no construct
 * that separates them. What it buys is that it needs nobody to have THOUGHT of the hazard: it
 * checks every token rather than a few hand-picked strings, so the day a scanned file grows a
 * construct this scanner mishandles, it fails and names the line. Both of this scanner's bugs were
 * found by READING it rather than by a red test; this is what changes that for the next one.
 *
 * Returns the damaged tokens (capped) rather than asserting, so a caller sweeping a whole tree can
 * report every file at once.
 */
export function findDamagedCodeTokens(
  raw: string,
  stripped: string,
  label: string,
  cap = 5,
): { damaged: DamagedToken[]; tokens: number; parseErrors: number } {
  if (stripped.length !== raw.length) {
    return { damaged: [`${label}: the strip changed the file LENGTH (${raw.length} -> `
      + `${stripped.length}), so offsets no longer line up`], tokens: 0, parseErrors: 0 };
  }
  // ⚠️ A real PARSE, not `ts.createScanner`. The bare scanner has no parser to tell it when a `}`
  // resumes a template literal, so a `` `…${a} … ${b}` `` makes it start a phantom template at the
  // closing backtick that runs to the next backtick — possibly inside a doc comment — and it then
  // reports that comment's words as eaten code. Which is the same phantom-region bug as #411, in
  // the ORACLE, and a fine reminder that an instrument checking an instrument is still an
  // instrument. Leaf nodes of a parsed tree are the tokens, and `getStart(sf)` skips leading
  // trivia, so comments are excluded by construction.
  const sf = ts.createSourceFile(
    label,
    raw,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    label.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const damaged: DamagedToken[] = [];
  let tokens = 0;
  const visit = (node: ts.Node): void => {
    if (damaged.length >= cap) return;
    // A JSDoc block is a COMMENT, and TypeScript hangs it in the tree as real nodes — descend into
    // one and the oracle starts demanding that comment prose survive the comment stripper.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = node.getChildren(sf);
    if (kids.length > 0) { for (const k of kids) visit(k); return; }
    tokens++;
    const start = node.getStart(sf);
    const end = node.getEnd();
    if (raw.slice(start, end) === stripped.slice(start, end)) return;
    const line = raw.slice(0, start).split('\n').length;
    damaged.push(`  ${label}:${line}  ${JSON.stringify(raw.slice(start, end).slice(0, 60))}`
      + ` became ${JSON.stringify(stripped.slice(start, end).slice(0, 60))}`);
  };
  visit(sf);
  // ⚠️ **The floor, so a pass means it LOOKED.** `createSourceFile` never throws — hand it garbage
  // and it returns a tiny tree, whose walk finds nothing damaged and reports success.
  // `parseDiagnostics` is real but not in TypeScript's PUBLIC types, hence the narrow widening
  // rather than a bare `any` — and the `?? []` so a future TS that drops it degrades to the token
  // count the caller checks instead of throwing.
  const parsed = sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  return { damaged, tokens, parseErrors: parsed.parseDiagnostics?.length ?? 0 };
}

/** `findDamagedCodeTokens` as an assertion, for a single file. `minTokens` is the floor that makes
 *  a pass mean the walk actually reached the tree. */
export function assertEveryCodeTokenSurvives(
  raw: string,
  stripped: string,
  label: string,
  opts: { minTokens?: number } = {},
): void {
  const { damaged, tokens, parseErrors } = findDamagedCodeTokens(raw, stripped, label);
  expect(parseErrors, `${label}: it did not PARSE, so the token walk is measuring a stump — this `
    + 'check would pass while inspecting nothing').toBe(0);
  expect(tokens, `${label}: only ${tokens} tokens were inspected — the walk is not reaching the tree`)
    .toBeGreaterThan(opts.minTokens ?? 10);
  expect(damaged, `${label}: the stripper ate CODE, not comments — a count taken over this is `
    + `meaningless, and it lowers silently.\n${damaged.join('\n')}`).toEqual([]);
}

/**
 * ⚠️ **Swift block comments NEST, so the depth counter is real rather than defensive.**
 *
 * Lifted here from `capacitorPlatformDeclarations.test.ts` (#812), which reached this shape the
 * hard way — the header there records the three regex attempts it replaced, each of which lost a
 * different construct (`https://host//path` under an `[^:]` guard, a `/*` inside a line comment
 * eating forward to the next terminator anywhere in the file). It was already the best stripper in
 * the repo; what it lacked was a way for anything else to reach it.
 *
 * ⚠️ **Changed in one way while moving: comment characters are BLANKED, not dropped.** The
 * original preserved lines but not length, which put it outside `assertScanIsSane`'s contract —
 * the one instrument check every other stripper here answers to. Blanking makes it compose with
 * the rest of this module; `missingSpmDeps`, its only caller, matches with `includes` and cannot
 * tell the difference.
 */
export function stripSwiftComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let inLine = false;
  let blockDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; } else { out += ' '; }
      i += 1;
    } else if (blockDepth > 0) {
      if (c === '/' && d === '*') { blockDepth += 1; out += '  '; i += 2; }
      else if (c === '*' && d === '/') { blockDepth -= 1; out += '  '; i += 2; }
      else { out += c === '\n' ? c : ' '; i += 1; }
    } else if (inString) {
      if (c === '\\') { out += c + (d ?? ''); i += 2; }     // an escape cannot close the literal
      else { if (c === '"') inString = false; out += c; i += 1; }
    } else if (c === '"') { inString = true; out += c; i += 1; }
    else if (c === '/' && d === '/') { inLine = true; out += '  '; i += 2; }
    else if (c === '/' && d === '*') { blockDepth = 1; out += '  '; i += 2; }
    else { out += c; i += 1; }
  }
  return out;
}

/**
 * Shell/`#`-comment source with comment CONTENT blanked. Length- and line-preserving, like the rest.
 *
 * ⚠️ **`#` opens a comment only at line start or after WHITESPACE**, which is the shell's own rule
 * and the conservative direction: it leaves `${var#prefix}` and `a#b` alone rather than blanking
 * real code. Single and double quotes are tracked so a `#` inside a string survives.
 *
 * ⚠️ **The `#!` shebang is KEPT, although the shell does treat it as a comment.** It is
 * load-bearing metadata that a guard may reasonably assert on ("every script declares
 * `env bash`"), and keeping it errs toward leaving more text rather than less.
 *
 * ⚠️ **Known limit — a HEREDOC body is treated as ordinary code**, so a `#`-comment-looking line
 * inside one is blanked. That direction LOWERS what a scan sees, which for a forbidden-pattern
 * guard is the silent-pass direction this whole module exists to close. It is left this way
 * because tracking heredoc delimiters properly needs a real shell parser; a guard scanning a
 * heredoc-heavy script should pass `sentinels` to `readScannedSource` so the blanking cannot go
 * unnoticed.
 */
export function stripHashComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  let inComment = false;
  while (i < src.length) {
    const c = src[i];
    if (inComment) {
      if (c === '\n') { inComment = false; out += c; } else { out += ' '; }
      i += 1;
      continue;
    }
    if (quote) {
      // ⚠️ **A quote does not survive a newline — a deliberate TRADE, not parity with
      // `stripComments`.** There the reset is sound: a JS string literal cannot span a newline
      // unescaped. Here it is not — a POSIX single-quoted string and a YAML quoted scalar both
      // legally span lines — so this buys the common case and pays for the rare one.
      //
      // What it buys: without it, `name: Don't push` opens a string that closes on the next quote
      // ANYWHERE in the file, leaving every `#` comment in between unblanked. That is the
      // silent-green direction for a forbidden-pattern guard, and `assertScanIsSane` is blind to it
      // because length and line parity both still hold.
      // What it costs: a `#` INSIDE a genuinely multi-line quoted string is now blanked. Measured
      // across all 35 tracked .sh/.yml files, exactly one such case exists today —
      // `scripts/publish-engine-oss.sh:351`, inside a multi-line `node -e '…'` — and no guard
      // scans that file. All 13 `engine/scripts/**.sh` strip byte-identically old vs new.
      // Getting both right needs a real shell/YAML parser, which this is not.
      if (c === '\n') { quote = null; out += c; i += 1; continue; }
      // Backslash escapes are honoured inside "…" but are literal inside '…' (POSIX).
      if (quote === '"' && c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue; }
    if (c === '#' && !(i === 0 && src[1] === '!')) {
      const prev = i === 0 ? '\n' : src[i - 1];
      if (prev === '\n' || prev === ' ' || prev === '\t') { inComment = true; out += ' '; i += 1; continue; }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The comment syntaxes `readScannedSource` knows how to blank. */
export type ScanLanguage = 'js' | 'braces' | 'swift' | 'shell' | 'jsonc' | 'yaml';

/** Extension → language. Absent means `readScannedSource` REFUSES rather than guessing — see there. */
const LANGUAGE_BY_EXT: ReadonlyMap<string, ScanLanguage> = new Map<string, ScanLanguage>([
  ...(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const)
    .map((e) => [e, 'js'] as const),
  // C-family comment syntax with no regex literals, so a bare `/` is always division.
  ...(['.java', '.kt', '.kts', '.gradle', '.m', '.mm', '.h', '.c', '.cc', '.cpp',
    '.wgsl', '.glsl', '.css', '.scss'] as const).map((e) => [e, 'braces'] as const),
  ...(['.swift'] as const).map((e) => [e, 'swift'] as const),
  ...(['.sh', '.bash', '.zsh'] as const).map((e) => [e, 'shell'] as const),
  // YAML comments are `#`, same rule as shell — a workflow guard is defeatable by one exactly as
  // a script guard is, so this is not a formality.
  ...(['.yml', '.yaml'] as const).map((e) => [e, 'yaml'] as const),
  // Strict JSON has no comments, so the strip is a no-op there and JSONC is handled for free.
  ...(['.json', '.jsonc'] as const).map((e) => [e, 'jsonc'] as const),
]);

export interface ReadScannedOptions {
  /**
   * `'strip'` (default) blanks comment content before the guard matches.
   *
   * `'include'` is the DECLARED opt-out for a guard that scans comments **on purpose** —
   * `docCitations` (a citation living in a docblock is exactly what it exists to catch) and
   * `editorStoreActionsReachable` (any textual reference counts). It returns `code === raw`, and
   * it requires `reason`, so the exemption is a sentence someone wrote rather than the silent
   * default it used to be.
   */
  comments?: 'strip' | 'include';
  /** Why this read scans comments. Required with `comments: 'include'`; ignored otherwise. */
  reason?: string;
  /** Override the extension mapping — for an extensionless script, or a file whose suffix lies. */
  language?: ScanLanguage;
  /** Strings that must survive the strip, forwarded to `assertScanIsSane`. */
  sentinels?: readonly string[];
}

export interface ScannedSource {
  /** The file exactly as on disk. For line numbers, and for a guard that must quote prose. */
  raw: string;
  /** What the guard MATCHES against: same length and same line count as `raw`, comments blanked. */
  code: string;
  /** The path as handed in, so a failure message can name the file. */
  path: string;
}

/**
 * ⚠️ **The one way a source-scanning guard reads a file (#812).** Read here, match on `.code`.
 *
 * `#419` gave this repo one comment scanner and twelve guards adopted it; sixteen more went on
 * matching `fs.readFileSync(…, 'utf8')` output directly, and that is a fail-OPEN defect in both
 * directions at once. A **forbidden**-pattern guard goes green because a comment hid the offender;
 * a **required**-pattern guard goes green because a comment SATISFIED the match, so the real call
 * site can be deleted and nothing notices. Measured instances of each: a `/*`-in-a-line-comment
 * hid 82 lines of `Scene3D.tsx` including 22 imports from the determinism guard, and
 * `stopDevServer.mjs`'s own explanatory comment satisfies `devStopEditorCarveOut`'s
 * `--configLoader runner` assertion today.
 *
 * The point of routing the READ rather than fixing sixteen matches is that remembering to strip is
 * exactly what nobody does. `commentStripperIsShared.test.ts` enforces this entry point, so the
 * seventeenth guard cannot quietly skip it.
 *
 * ⚠️ **It REFUSES an extension it has no stripper for**, rather than falling back to raw text.
 * Falling back is precisely the defect; a guard scanning Markdown or a storyboard must say so with
 * `comments: 'include'` and a reason.
 *
 * ⚠️ **`.pbxproj` is deliberately NOT registered, and the reason generalises.** It was, briefly,
 * routed to `braces` — an Xcode project file is C-family and carries block-comment spans
 * naming each file (the `AppDelegate.swift` annotation Xcode writes beside every id),
 * annotations denser than anything else the guards scan. But those spans are **generated NAMING
 * that is part of the file's syntax**, not commentary hiding code, and `pbxprojObjectIds` matches
 * them as such — its DEFINITION regex has an OPTIONAL group for the annotation, spelled with
 * escaped delimiters. Blanking the annotation broke the adjacency that
 * regex needs and cut the ids it inspected from **43 to 1**, under a `> 0` floor that could not
 * tell the difference. The lesson is not about pbxproj: **before registering a language, read the
 * consumer's pattern — a "comment" that the guard's own regex MATCHES is data, not noise.**
 */
export function readScannedSource(absPath: string, opts: ReadScannedOptions = {}): ScannedSource {
  const raw = fs.readFileSync(absPath, 'utf8');
  const label = path.basename(absPath);

  if (opts.comments === 'include') {
    if (!opts.reason?.trim()) {
      throw new Error(`${label}: comments:'include' needs a reason — it turns off the strip, and an `
        + 'undeclared exemption is the fail-open default this exists to remove');
    }
    return { raw, code: raw, path: absPath };
  }

  const ext = path.extname(absPath).toLowerCase();
  const language = opts.language ?? LANGUAGE_BY_EXT.get(ext);
  if (!language) {
    throw new Error(`${label}: no comment stripper for \`${ext || '(no extension)'}\` — pass `
      + '`language`, or declare `comments: \'include\'` with a reason if this guard means to scan '
      + 'prose. Guessing here is the fail-open bug (#812).');
  }

  const code = language === 'swift' ? stripSwiftComments(raw)
    : (language === 'shell' || language === 'yaml') ? stripHashComments(raw)
      : stripComments(raw, { regexLiterals: language === 'js' });
  assertScanIsSane(raw, code, label, opts.sentinels);
  return { raw, code, path: absPath };
}
