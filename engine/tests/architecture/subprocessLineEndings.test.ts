/** A `$`-anchored capture applied to a line that still carries a `\r` fails on EVERY line, and
 *  returns `null`/`[]` rather than throwing (#1118).
 *
 *  That is how `parseLogcatLine` made `device_crash_reports` answer *"no crashes"* about a phone
 *  that had just crashed (fixed in `5fb7f3b1`). Three `ps` parsers in `engine/scripts/**` carried
 *  the same shape and were safe only because a `win32` branch returned before them — an invariant
 *  living in another part of the control flow, written down nowhere. One function
 *  (`livePackagedEditor.mjs`) disagreed with itself about it: Windows half `/\r?\n/`, POSIX half
 *  `'\n'`.
 *
 *  Two halves here:
 *  1. **Unit** — `outputLines` / `parsePidRows` / `joinPidColumns` on CRLF, a lone CR, and LF, so
 *     the parses that were previously unreachable by any test have one.
 *  2. **A corpus guard** — the SHAPE cannot come back in a new call site. It is deliberately
 *     narrow: see the docblock on `crFragileLineParses` for what it can and cannot see.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import {
  boundIdentifier, callsTo, declarationOf, parseSource, readsOf, unwrapValue, valueCarrier,
} from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { outputLines, parsePidRows } from '../../scripts/subprocessText.mjs';
import { joinPidColumns } from '../../scripts/livePackagedEditor.mjs';

/** This file spells the offending shapes as fixtures, in literals that survive the comment strip. */
const SELF = 'engine/tests/architecture/subprocessLineEndings.test.ts';

/**
 * Find `\r`-fragile line parses: a line taken from a BARE `'\n'` split and then matched against an
 * end-anchored pattern whose `$` is reached directly by a capture.
 *
 * ⚠️ **Deliberately narrow, and heuristic — here is exactly what it does NOT see.** Whether a
 * string came from a subprocess is a data-flow question no regex can answer, and the file-level
 * approximations were measured before choosing this one: `spawn + bare split + any $-anchor`
 * matches **14** files in this corpus, 11 of them false positives (an end-anchored regex on a FILE
 * PATH, e.g. `/\.json$/`), which would force an 11-entry allowlist — and an allowlisted guard rots
 * (this repo has a whole `family/derived-corpus` for that). So this one keys on the SHAPE instead:
 * the split's own element meeting a `)$`-style capture, read from the AST (#1144): the loop or callback
 * that iterates the lines bounds where the match may sit, never a character count. It follows ONE
 * `const lines = x.split('\n')` binding and a same-elements chain (`.filter(…)`), and resolves a
 * `const RE = /…/` by scope; it cannot see lines passed to another function, a parse that joins and
 * re-splits, `RE.test(line)`, an index loop, or `.entries()`. ⚠️ It also no longer follows lines
 * through `.map(…)` — the windowed version happened to catch `.map((s) => s.replace(…))` loops —
 * because a `.map((l) => l.trim())` is exactly the remedy, and a map's result is not the lines.
 *
 * ACCEPTED on purpose (all three are correct, and all three appear in this corpus):
 * `\s*$` before the anchor — `\s` matches `\r`, so the anchor is reached either way;
 * a `.trim()`/`.trimEnd()` on the line before the match; and splitting on `/\r?\n/` or through
 * `outputLines`, which is the fix this guard is pointing at.
 */
// ⚠️ THE REJECTED ALTERNATIVE, WITH THE EXACT QUERY. Recorded as line comments (not in the JSDoc
// above) because one of these regexes ends in `[a-z]*` followed by a slash, which closes a block
// comment — the first version of this note did exactly that and would not parse.
//
// A reviewer could not reproduce the prose version's count from six plausible spellings, so here is
// the query. On the PRE-FIX tree, over `git ls-files engine/scripts engine/tools engine/plugins
// engine/electron scripts` filtered to /\.(mjs|cjs|js|ts|tsx)$/ and minus /dist/, a FILE-LEVEL
// conjunction of all three of:
//     SPAWN   = /\b(execFileSync|execSync|spawnSync|execFile|spawn|exec)\s*\(/
//     SPLIT_N = /\.split\(\s*['"]\\n['"]\s*\)/
//     ENDANCH = /\/[^/\n]*\$\/(?![a-z]*m)[a-z]*/
// matched 14 files, of which 2 carried an unprotected defect (livePackagedEditor.mjs,
// stopDevServer.mjs) and 12 did not — end-anchored regexes on FILE PATHS, or parses already
// protected by a trimEnd() (deviceAndroidDiag.ts). Re-run on the FIXED tree it matches 12, all
// false, because the two real ones no longer split on a bare newline. Quote the figure with the
// tree it was taken on; it moves when the fix lands.
export function crFragileLineParses(code: string, label = 'source.ts'): string[] {
  const sf = parseSource(code, label);
  const out: string[] = [];
  for (const split of callsTo(sf, 'split')) {
    const [sep] = split.arguments;
    if (split.arguments.length !== 1 || !ts.isStringLiteralLike(sep) || sep.text !== '\n') continue;
    for (const { line, body } of lineIterations(split)) out.push(...fragileMatchesIn(body, line));
  }
  return out;
}

/** Array methods whose callback's first parameter is one ELEMENT, i.e. one line. */
const PER_ELEMENT = new Set(['map', 'filter', 'forEach', 'flatMap', 'some', 'every', 'find', 'findIndex']);
/** Methods that hand the SAME lines on, so a chain through them still iterates lines. */
const SAME_ELEMENTS = new Set(['filter', 'slice', 'reverse', 'toReversed', 'sort', 'toSorted']);

/**
 * Every place `split`'s lines are iterated, each as the line's own binding and the node that bounds
 * it — the loop statement or the callback's body. ⚠️ **That node is the whole point (#1144):** the
 * windowed version searched 900 chars after the split and then ±90 around each regex, so the NEXT
 * loop's `line.trim()` excused this loop's bare `line.match(/…)$/)`.
 *
 * Follows the lines through a same-elements chain (`.filter(Boolean).map(…)`) and through ONE
 * `const lines = x.split('\n')` binding into the loops that read it.
 */
function lineIterations(split: ts.CallExpression): Array<{ line: string; body: ts.Node }> {
  const out: Array<{ line: string; body: ts.Node }> = [];
  const fromValue = (value: ts.Expression, followBinding: boolean): void => {
    let cur = valueCarrier(value);
    for (;;) {
      const access = cur.parent;
      const call = access?.parent;
      if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== cur
        || !call || !ts.isCallExpression(call) || call.expression !== access) break;
      const method = access.name.text;
      const fn = call.arguments[0];
      if (PER_ELEMENT.has(method) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const param = fn.parameters[0]?.name;
        if (param && ts.isIdentifier(param)) out.push({ line: param.text, body: fn.body });
      }
      if (!SAME_ELEMENTS.has(method)) return;
      cur = valueCarrier(call);
    }
    const loop = cur.parent;
    if (loop && ts.isForOfStatement(loop) && loop.expression === cur && ts.isVariableDeclarationList(loop.initializer)) {
      const name = loop.initializer.declarations[0]?.name;
      if (name && ts.isIdentifier(name)) out.push({ line: name.text, body: loop.statement });
      return;
    }
    const bound = followBinding ? boundIdentifier(cur) : undefined;
    if (bound) for (const read of readsOf(bound)) fromValue(read, false);
  };
  fromValue(split, true);
  return out;
}

/** The end-anchored pattern text of a regex literal whose `$` is reached directly by a capture
 *  close and that has no `m` flag — or `undefined`. */
function endAnchoredCapture(re: ts.Node | undefined): string | undefined {
  if (!re || re.kind !== ts.SyntaxKind.RegularExpressionLiteral) return undefined;
  const text = re.getText(re.getSourceFile());
  const close = text.lastIndexOf('/');
  const [pattern, flags] = [text.slice(1, close), text.slice(close + 1)];
  return pattern.endsWith(')$') && !flags.includes('m') ? text : undefined;
}

/** A regex argument as its literal: the literal itself, or the `const RE = /…/` its name RESOLVES
 *  to (by scope — a same-named const in another function is a different regex). */
function regexLiteralOf(arg: ts.Expression | undefined): ts.Node | undefined {
  if (!arg) return undefined;
  const e = unwrapValue(arg);
  if (e.kind === ts.SyntaxKind.RegularExpressionLiteral) return e;
  if (!ts.isIdentifier(e)) return undefined;
  const decl = declarationOf(e);
  const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrapValue(decl.initializer) : undefined;
  return init?.kind === ts.SyntaxKind.RegularExpressionLiteral ? init : undefined;
}

/**
 * Inside `body` only: EVERY `line.match(RE)` or `RE.exec(line)` with `RE` an end-anchored capture,
 * where `line` is the bare binding. `line.trimEnd().match(RE)` has a call for its receiver, not the
 * binding, so it is not reported — that is the "trim first" remedy, read structurally.
 *
 * ⚠️ **Every match, one entry each (#1144 close-out).** The first version returned the first hit
 * per body, so a ledger row for one match pardoned the whole loop: a second fragile match planted
 * beside the pardoned one in `gen-memory-index.mjs` left the corpus guard green.
 */
function fragileMatchesIn(body: ts.Node, line: string): string[] {
  const hits: string[] = [];
  const isLine = (e: ts.Expression | undefined): boolean => !!e && ts.isIdentifier(unwrapValue(e))
    && (unwrapValue(e) as ts.Identifier).text === line;
  for (const call of callsTo(body, 'match', 'exec')) {
    const access = call.expression;
    if (!ts.isPropertyAccessExpression(access)) continue;
    const hit = access.name.text === 'match'
      ? isLine(access.expression) && endAnchoredCapture(regexLiteralOf(call.arguments[0]))
      : isLine(call.arguments[0]) && endAnchoredCapture(regexLiteralOf(access.expression));
    if (hit) hits.push(hit);
  }
  return hits;
}

describe('outputLines — no line it returns can contain a \\r (#1118)', () => {
  it('strips CRLF, and the trailing terminator produces no empty tail entry', () => {
    expect(outputLines('  1 a\r\n 22 b\r\n')).toEqual(['  1 a', ' 22 b']);
    expect(outputLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('treats a LONE \\r as a terminator too — that is what makes the postcondition hold', () => {
    // `ps` prints a process's own argv, so a CR can arrive MID-line. Splitting only on /\r?\n/
    // would leave it in place and an end-anchored capture would drop the whole row, pid included.
    expect(outputLines('a\rb')).toEqual(['a', 'b']);
    expect(outputLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
    for (const line of outputLines('x\ry\r\nz')) expect(line).not.toContain('\r');
  });

  it('keeps a blank line in the MIDDLE — only the trailing empty is dropped', () => {
    expect(outputLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('trims trailing WHITESPACE too, not only the \\r — the `endsWith` hazard is the same class', () => {
    // The split alone already removes every `\r`, so this assertion is what makes `trimEnd()`
    // load-bearing rather than decoration: a trailing SPACE or TAB breaks a shape-sensitive
    // consumer exactly the way a `\r` does. That is not hypothetical — the sibling this sweep found
    // in `games/court/tests/changedLevels.ts` fails on `.endsWith('.court.json')`, which a trailing
    // space defeats just as thoroughly. Written after a mutation deleting `trimEnd()` left all 11
    // cases green.
    expect(outputLines('a/b.json   \n')).toEqual(['a/b.json']);
    expect(outputLines('x\t\r\ny  ')).toEqual(['x', 'y']);
    for (const line of outputLines('p.json \r\nq.json\t\n')) expect(line.endsWith('.json')).toBe(true);
  });

  it('nullish and empty are [], and a lone terminator is ONE empty line', () => {
    expect(outputLines(undefined)).toEqual([]);
    expect(outputLines(null)).toEqual([]);
    expect(outputLines('')).toEqual([]);
    // `'\r\n'` is an empty line FOLLOWED by a terminator, so one entry survives: only the
    // terminator's own empty tail is dropped, never a line that was really there. Asserted
    // because I first wrote `[]` here and the code was right — a caller reading `.length` as
    // "did we get anything" needs to know 1 is possible for output that is all terminator.
    expect(outputLines('\r\n')).toEqual(['']);
    expect(outputLines('\n\n')).toEqual(['', '']);
  });
});

describe('parsePidRows — the ps row shape, parsed in one place (#1118)', () => {
  it('parses CRLF rows identically to LF rows — this is what returned [] before', () => {
    const lf = parsePidRows('  10 /bin/vite --x\n  22 node foo\n');
    expect(parsePidRows('  10 /bin/vite --x\r\n  22 node foo\r\n')).toEqual(lf);
    expect(lf).toEqual([{ pid: 10, rest: '/bin/vite --x' }, { pid: 22, rest: 'node foo' }]);
  });

  it('keeps a command containing SPACES intact — the macOS `ps -Ao comm=` case', () => {
    expect(parsePidRows('  7 /Applications/My App.app/Contents/MacOS/My App\r\n'))
      .toEqual([{ pid: 7, rest: '/Applications/My App.app/Contents/MacOS/My App' }]);
  });

  it('drops unparsable rows rather than throwing — a header or blank tail is not an error', () => {
    expect(parsePidRows('  PID COMMAND\r\n  9 x\r\n\r\n')).toEqual([{ pid: 9, rest: 'x' }]);
  });

  it('KEEPS a row whose second column is empty — the caller deletes things on an empty list', () => {
    // `livePackagedEditor.mjs` states this policy for its win32 twin: a row with no value is
    // "unknown, not 'not an editor'", kept so it "still counts toward 'we enumerated something'",
    // because its caller DELETES editor state and an empty list read as "nothing is live" wipes a
    // live app's data. A `\s+(.*)` capture dropped such a row on POSIX while win32 kept it — the
    // `trimEnd()` takes the separating space away, so `\s+` stops matching. Found in review.
    expect(parsePidRows('  10 \n  11 x\n')).toEqual([{ pid: 10, rest: '' }, { pid: 11, rest: 'x' }]);
    expect(parsePidRows('  10\n')).toEqual([{ pid: 10, rest: '' }]);
  });
});

describe('joinPidColumns — two ps captures joined by pid (#1118)', () => {
  it('joins across CRLF, and a pid missing from the second capture keeps an empty command', () => {
    // Two separate `ps` invocations, so churn between them is normal: the pid must survive.
    expect(joinPidColumns('  7 /a/b\r\n  8 /c/d\r\n', '  7 /a/b --flag\r\n')).toEqual([
      { pid: 7, exe: '/a/b', command: '/a/b --flag' },
      { pid: 8, exe: '/c/d', command: '' },
    ]);
  });
});

/**
 * Bare splits that ARE safe, because CRLF cannot reach the match — each for a reason stated at the
 * site, spent one row per occurrence.
 *
 * ⚠️ **Found by #1144, and the old guard was green on it for a FALSE reason.** The windowed detector
 * excused `parseFrontmatter`'s `line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)` because
 * `if (!line.trim()) continue;` sat within 90 chars — a `trim()` whose result is discarded, which
 * protects nothing. The site is safe for a different reason entirely, and it says so in its own
 * comment: the function throws on a file that does not start `'---\n'`, so a CRLF file never
 * reaches the split. Pardoned for THAT, by name.
 */
const CR_SAFE_UPSTREAM: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'scripts/gen-memory-index.mjs::/^([A-Za-z0-9_-]+):\\s*(.*)$/',
    reason: 'parseFrontmatter throws on a file not starting \'---\\n\' before it splits, so no CRLF line reaches the match (the site\'s own comment; #1118 briefly made it CRLF-tolerant downstream of that rejection, which was dead code).',
  },
  {
    item: 'scripts/gen-memory-index.mjs::/^\\s+([A-Za-z0-9_-]+):\\s*(.*)$/',
    reason: 'the indented metadata line in the same parseFrontmatter loop — same upstream CRLF rejection. Uncounted until matches were collected per occurrence rather than first-per-loop.',
  },
];

describe('the SHAPE cannot come back — corpus guard (#1118)', () => {
  it('flags the three forms that actually shipped', () => {
    // The exact text of the three sites this issue fixed.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toHaveLength(1);
    expect(crFragileLineParses(`out.split('\\n').map((line) => {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n})`)).toHaveLength(1);
    expect(crFragileLineParses(`for (const l of x.split("\\n")) {\n  const kv = /^([a-z]+):\\s*(.*)$/.exec(l);\n}`)).toHaveLength(1);
  });

  it('classifies inside the LOOP\'s own body — a neighbour\'s trim() does not vouch (#1144)', () => {
    // Observed on the windowed version: this pair returned [] because the SECOND loop's
    // `line.trim()` sat within its ±90-char segment.
    const bare = "for (const line of a.split('\\n')) { const m = line.match(/(\\d+)$/); use(m); }";
    const neighbour = "for (const line of b.split('\\n')) { const t = line.trim(); use(t); }";
    expect(crFragileLineParses(bare)).toEqual(['/(\\d+)$/']);
    expect(crFragileLineParses(`${bare}\n${neighbour}`)).toEqual(['/(\\d+)$/']);
    expect(crFragileLineParses(`${neighbour}\n${bare}`)).toEqual(['/(\\d+)$/']);
    // The live instance: a trim whose RESULT is discarded protects nothing (gen-memory-index.mjs).
    expect(crFragileLineParses(
      "for (const line of a.split('\\n')) {\n  if (!line.trim()) continue;\n  const m = line.match(/^(\\w+):\\s*(.*)$/);\n}",
    )).toEqual(['/^(\\w+):\\s*(.*)$/']);
  });

  it('follows the lines through a same-elements chain, a binding, and a named regex', () => {
    expect(crFragileLineParses("x.split('\\n').filter(Boolean).forEach((l) => { l.match(/(\\d+)$/); });")).toHaveLength(1);
    expect(crFragileLineParses("const lines = x.split('\\n');\nfor (const l of lines) { l.match(/(\\d+)$/); }")).toHaveLength(1);
    expect(crFragileLineParses("const ROW = /^(\\d+)\\s+(.*)$/;\nfor (const l of x.split('\\n')) { const m = ROW.exec(l); }")).toHaveLength(1);
    // EVERY match in a body is its own entry — a ledger row for one must not pardon its neighbour.
    expect(crFragileLineParses("for (const l of x.split('\\n')) { l.match(/^(a)$/); l.match(/^(b)$/); }"))
      .toEqual(['/^(a)$/', '/^(b)$/']);
    // A regex NAME resolves by scope: another function's same-named const is a different value.
    expect(crFragileLineParses("function a() { const RE = /(\\d+)$/; }\nfunction b(s: string) { const RE = /x/; for (const l of s.split('\\n')) RE.exec(l); }")).toEqual([]);
    expect(crFragileLineParses("function a() { const RE = 'x'; }\nfunction b(s: string) { const RE = /(\\d+)$/; for (const l of s.split('\\n')) RE.exec(l); }")).toHaveLength(1);
    // ...and a regex on a DIFFERENT value in the same body is not this line's match.
    expect(crFragileLineParses("for (const l of x.split('\\n')) { name.match(/(\\d+)$/); }")).toEqual([]);
    // `.map` changes the elements, so a chain past it is no longer iterating lines.
    expect(crFragileLineParses("x.split('\\n').map((l) => l.length).forEach((n) => { n.match(/(\\d+)$/); });")).toEqual([]);
  });

  it('ACCEPTS the three correct forms — this guard must not read as "no $ anchors anywhere"', () => {
    // `\s*` absorbs the CR, so the anchor is reached either way.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.match(/^##\\s+(.+?)\\s*$/);\n}`)).toEqual([]);
    // trimmed before the match.
    expect(crFragileLineParses(`for (const line of out.split('\\n')) {\n  const m = line.trimEnd().match(/^(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
    // split on /\r?\n/ — no bare-'\n' split to key on at all.
    expect(crFragileLineParses(`for (const line of out.split(/\\r?\\n/)) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
    // and the fix this guard points at.
    expect(crFragileLineParses(`for (const line of outputLines(out)) {\n  const m = line.match(/^\\s*(\\d+)\\s+(.*)$/);\n}`)).toEqual([]);
  });

  it('no file in the tooling corpus carries the shape', () => {
    const files = repoFiles({
      under: ['engine/scripts', 'engine/tests', 'engine/tools', 'engine/plugins', 'engine/electron', 'scripts', 'games', 'demos'],
      match: /\.(mjs|cjs|js|ts|tsx)$/,
      exclude: ['node_modules', 'dist'],
      floor: 200,
    });
    expect(files.length, 'corpus collapsed — the scan below would pass vacuously').toBeGreaterThan(200);

    const population: Array<{ item: string; site: string }> = [];
    for (const { rel, abs } of files) {
      if (rel === SELF) continue;
      const { code } = readScannedSource(abs);
      for (const pat of crFragileLineParses(code, rel)) population.push({ item: `${rel}::${pat}`, site: rel });
    }
    const scanned = new Set(files.map((f) => f.rel));
    assertExemptionLedger({
      label: 'CR_SAFE_UPSTREAM in subprocessLineEndings',
      population,
      // A row counts only where its file is in the corpus — `scripts/gen-memory-index.mjs` is not in
      // the OSS snapshot, and a row for an absent file would read as over-blessed there.
      exempt: CR_SAFE_UPSTREAM.filter((row) => scanned.has(row.item.split('::')[0])),
      scanned: files.length,
      floor: 200,
      fix: 'a line from a bare `\'\\n\'` split must not meet an end-anchored capture: '
        + 'split through `outputLines` (engine/scripts/subprocessText.mjs), or on /\\r?\\n/, or trim '
        + 'the line first. `\\r` is a JS line terminator, so the capture fails on EVERY line and '
        + 'returns null — silently. ⚠️ BUT NOT IF THE FILE ROUND-TRIPS THE TEXT: where lines are '
        + 'split, edited and rejoined back to disk (healNativeConfig.ts does this to a pbxproj, and '
        + '*.pbxproj is not eol-pinned), a bare split is LOAD-BEARING — it preserves the file\'s CRLF '
        + 'on a Windows clone, and every remedy above would rewrite the whole file\'s line endings. '
        + 'Normalise a COPY for the comparison there, and keep writing the original lines.',
    });
  });
});
