/** A GAME's own agent tools obey §11's first-sentence rule too (#1218).
 *
 *  #1208 landed three description guards, and all three are blind to `games/**` by construction:
 *  their population comes from `loadSurface()` + `loadDeviceSurface()`, while a game tool is
 *  registered at RUNTIME by `registerAgentTool` from whichever project is open. So the rule held on
 *  the ~106 engine tools and nowhere else — and five game tools had drifted, every one of them
 *  opening with an issue number (`court_place_piece` "…could not do before #339: …",
 *  `wordweave_crossword_view` "…pan/zoom view directly (#444) — …").
 *
 *  That matters more for a game tool than for an engine one. `#339` is the LEAST useful thing that
 *  sentence could carry, because under schema deferral it is often the only text read before a tool
 *  is chosen, and a game tool has no catalog entry to fall back on — `docs/debug-tools-mcp.md`'s
 *  generated table lists engine tools only, so the description IS the documentation.
 *
 *  ── Why a SOURCE SCAN rather than the registry ──────────────────────────────────────────────
 *  Reading the real registry would mean booting a project, which no unit test does. So this reads
 *  the `registerAgentTool({...})` call sites out of the corpus instead. The population is therefore
 *  "what the source says", and the extractor is the part that can lie — so `extractGameTools` is
 *  tested against its own fixtures below, including the concatenated-literal form both games use
 *  and the shapes it must REFUSE to guess at. A scanner that silently found nothing would make this
 *  guard vacuous, which is why the live scan also asserts a floor.
 */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '../../packages/modoki/tests/helpers/sourceScanner';
import { firstSentenceDefect } from './firstSentence';
import { callsTo, parseSource, propertyValue, unwrapValue, ts } from '../../packages/modoki/tests/helpers/sourceAst';
import { assertExemptionLedger } from '../../packages/modoki/tests/helpers/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';


export interface GameTool { name: string; description: string; file: string }

/** How many times a file CALLS `registerAgentTool`, counted independently of the extractor.
 *
 *  The extractor only matches an inline object literal (`registerAgentTool({ … })`). A call made
 *  through a variable or a loop — `registerAgentTool(def)` — matches nothing and yields NO row, so
 *  it would vanish with no unreadable marker and no failure, unlike a template-literal description
 *  (which yields `''` and reddens the readability check). Comparing the two counts is what turns a
 *  silent miss into a red gate, and it is the same independent-counter trick the sibling guard uses. */
export function countRegisterCalls(src: string): number {
  return (src.match(/(?<![A-Za-z0-9_$])registerAgentTool\s*\(/g) ?? []).length;
}

/** Pull `{name, description}` out of every `registerAgentTool({ … })` in one source file.
 *
 *  Deliberately narrow: it reads a `name:` string literal and a `description:` that is one string
 *  literal or several joined by `+` — the only two forms the corpus uses. Anything else (a
 *  template literal, an interpolated name, a description built by a helper) is NOT guessed at; it
 *  is returned with `description: ''`, which the live test treats as unreadable and fails on,
 *  because a description this cannot read is one the guard cannot police and silence would be the
 *  wrong answer. */
export function extractGameTools(src: string, file: string): GameTool[] {
  const out: GameTool[] = [];
  for (const call of callsTo(parseSource(src, file), 'registerAgentTool')) {
    const arg = call.arguments[0] && unwrapValue(call.arguments[0]);
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    const name = propertyValue(arg, 'name');
    if (name === undefined) continue;
    const description = propertyValue(arg, 'description');
    out.push({ name: concatenatedString(name) ?? '', description: (description && concatenatedString(description)) ?? '', file });
  }
  return out;
}

/**
 * A value that is one plain string literal or several joined by `+`, as its text; '' for anything
 * else (a template literal with a substitution, an identifier, a call).
 *
 * ⚠️ **The call's OWN object literal, read by member (#1241).** This was a hand-written walk that
 * counted braces, skipped string bodies and considered a key only at depth 1 — correct only because
 * it was a tokenizer, and a `${…}` holding a brace or a regex literal still moved its edge. The depth
 * rule it enforced is `propertyValue`'s: a param's own `description` is a member of the PARAM, never
 * of the call's literal, whatever order the two are written in.
 */
function concatenatedString(v: ts.Node): string | undefined {
  const u = ts.isExpression(v) ? unwrapValue(v) : v;
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = concatenatedString(u.left);
    const right = concatenatedString(u.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined;
}

/** ⚠️ **`floor: 0`, and `describe.skipIf` is NOT what protects this.** A `skipIf` skips the `it`s;
 *  Vitest still RUNS the describe body to collect, so `liveGameTools()` executes on every checkout
 *  — including the OSS snapshot, which ships `demos/` and no `games/`. `repoFiles` THROWS below its
 *  floor, and a throw at collection fails the file rather than skipping it, so a non-zero floor
 *  here reddens the free public CI on every `main` push for the ABSENCE of private content. Caught
 *  in review, not by any local gate: this clone always has `games/`, so nothing here can see it.
 *  `repoCorpus.mjs`'s own docblock states the rule, and the sibling guard over this exact corpus
 *  (`architecture/gameAgentToolNames.test.ts`) already follows it. The real non-vacuity pin lives
 *  in the `skipIf`-gated `it` below, which is where a floor belongs.
 *
 *  Gated on `hasInternalGames()` rather than `hasAnyProject()`: every game tool is under `games/`,
 *  and the loose predicate reads true on a demos-only snapshot. */
function liveGameTools(): GameTool[] {
  const files = repoFiles({
    under: ['games', 'demos'],
    match: /\.tsx?$/,
    exclude: ['node_modules', 'dist', 'ios', 'android'],
    floor: 0,
  }) as Array<{ rel: string; abs: string }>;
  return files.flatMap(({ rel, abs }) => {
    // ⚠️ `readScannedSource().code` (#812's one read), NOT raw text: it blanks COMMENT content
    // length-preservingly, so a `registerAgentTool` someone commented out while chasing a bug is
    // not reported as an offender. Raw `readFileSync` did exactly that — a commented-out tool
    // whose description carried an issue number turned the gate red on a tool that does not exist.
    const src = readScannedSource(abs).code;
    return src.includes('registerAgentTool(') ? extractGameTools(src, rel) : [];
  });
}

/** Per file: how many calls exist vs how many the extractor could read. */
function liveCallCensus(): Array<{ file: string; calls: number; read: number }> {
  const files = repoFiles({
    under: ['games', 'demos'], match: /\.tsx?$/,
    exclude: ['node_modules', 'dist', 'ios', 'android'], floor: 0,
  }) as Array<{ rel: string; abs: string }>;
  return files.flatMap(({ rel, abs }) => {
    const src = readScannedSource(abs).code;
    if (!src.includes('registerAgentTool(')) return [];
    return [{ file: rel, calls: countRegisterCalls(src), read: extractGameTools(src, rel).length }];
  });
}

describe('extractGameTools reads what the corpus actually writes', () => {
  it('reads a single-literal description', () => {
    const t = extractGameTools("registerAgentTool({ name: 'g_a', description: 'Does a thing.' });", 'f.ts');
    expect(t).toEqual([{ name: 'g_a', description: 'Does a thing.', file: 'f.ts' }]);
  });

  // The form court uses: trailing `+`, one literal per line.
  it('joins a + chain across lines', () => {
    const t = extractGameTools(`registerAgentTool({
      name: 'g_b',
      description:
        'First half — ' +
        'second half.',
    });`, 'f.ts');
    expect(t[0].description).toBe('First half — second half.');
  });

  // The form wordweave uses: leading `+`, and an escaped apostrophe inside the literal.
  it('joins a leading-+ chain and unescapes', () => {
    const t = extractGameTools(`registerAgentTool({
      name: 'g_c',
      description:
        'Set the view\\'s zoom'
        + ' directly.',
    });`, 'f.ts');
    expect(t[0].description).toBe("Set the view's zoom directly.");
  });

  it('finds every call in a file, and is not ended early by a nested object', () => {
    const t = extractGameTools(`registerAgentTool({ name: 'g_d', description: 'A.', params: { x: { y: 1 } } });
      registerAgentTool({ name: 'g_e', description: 'B.' });`, 'f.ts');
    expect(t.map((x) => x.name)).toEqual(['g_d', 'g_e']);
  });

  // ⚠️ The case above CANNOT measure the brace walk: `g_d`'s description precedes its nested
  // object, so an early cut still reads it, and `exec` advances `lastIndex` past the opening brace
  // either way so both calls are found however the block is sliced. Review proved that by replacing
  // the whole walk with `indexOf('}')` and watching every test stay green. THIS fixture is the one
  // that discriminates — the description sits AFTER a nested object, so a walk that stops at the
  // first `}` never reaches it. It is F2's shape too: `params` before `description`.
  it('reads a description that sits AFTER a nested object, and does not take a param\'s', () => {
    const t = extractGameTools(`registerAgentTool({
      name: 'g_after',
      params: { cell: { type: 'string', description: 'Target cell, e.g. a1.' } },
      description: 'Place a piece on the board.',
    });`, 'f.ts');
    expect(t[0].description).toBe('Place a piece on the board.');
  });

  it('counts a call made through a variable, even though it cannot read it', () => {
    const src = "const d = { name: 'g_var', description: 'Hidden.' };\nregisterAgentTool(d);";
    expect(countRegisterCalls(src)).toBe(1);
    expect(extractGameTools(src, 'f.ts')).toEqual([]);   // …which is why the census below exists
  });

  it('does not count unregisterAgentTool as a registration', () => {
    expect(countRegisterCalls('unregisterAgentTool({ name: 1 });')).toBe(0);
  });

  // #1241: the hand-written walk's edges — a brace inside a `${…}` and inside a regex literal.
  it('is not moved by a brace inside a template substitution or a regex literal', () => {
    const t = extractGameTools(`registerAgentTool({
      name: 'g_tpl',
      run: () => \`\${ { a: 1 }.a }\`,
      match: /[}]/,
      description: 'Reads past both.',
    });`, 'f.ts');
    expect(t).toEqual([{ name: 'g_tpl', description: 'Reads past both.', file: 'f.ts' }]);
  });

  // It must NOT invent a description it cannot read — '' is how the live test learns to fail.
  it('returns an empty description for a form it cannot read, rather than guessing', () => {
    const t = extractGameTools('registerAgentTool({ name: \'g_f\', description: buildDesc() });', 'f.ts');
    expect(t[0].description).toBe('');
    // …including a chain with ONE unreadable link: half a description is not the description.
    expect(extractGameTools("registerAgentTool({ name: 'g_g', description: 'Starts. ' + suffix });", 'f.ts')[0].description).toBe('');
    // An EMPTY literal link is readable — it is not the unreadable marker.
    expect(extractGameTools("registerAgentTool({ name: 'g_h', description: 'Does X.' + '' });", 'f.ts')[0].description).toBe('Does X.');
  });
});

describe.skipIf(!hasInternalGames())("a game tool's first sentence says what the tool does (§11, #1218)", () => {
  const tools = liveGameTools();

  // A scan that found nothing would make every assertion below vacuous. The corpus has 9 today;
  // the floor is deliberately lower so adding or removing one tool is not a gate failure, while
  // an extractor that breaks outright still is.
  it('the scan reaches the game tools at all', () => {
    expect(tools.length).toBeGreaterThanOrEqual(5);
    expect(new Set(tools.map((t) => t.file)).size).toBeGreaterThanOrEqual(2);
  });

  it('every description is readable — one this cannot parse is one the guard cannot police', () => {
    expect(tools.filter((t) => t.description === '').map((t) => `${t.file}: ${t.name}`)).toEqual([]);
  });

  // The other half of "readable": a call the extractor never SAW at all. A template-literal
  // description yields '' and fails the check above; a `registerAgentTool(def)` yields no row, so
  // only this independent count can tell that the guard silently stopped covering a tool.
  it('reads every call site it finds — a registration the extractor cannot see is a gap, not a pass', () => {
    expect(liveCallCensus().filter((c) => c.read !== c.calls)
      .map((c) => `${c.file}: ${c.calls} call(s), ${c.read} readable`)).toEqual([]);
  });

  it('no first sentence leads with a caveat, asks a question, or carries an issue number', () => {
    assertExemptionLedger({
      label: 'GAME_TOOL_FIRST_SENTENCE in gameToolFirstSentence',
      population: tools.flatMap((t) => {
        const why = firstSentenceDefect(t.description);
        return why ? [{ item: t.name, site: `${t.file} — ${t.name}: ${why}` }] : [];
      }),
      // Empty on the day it landed, and a new row needs a reason an agent CHOOSING a tool would
      // accept. "The issue number explains why the tool exists" is not one — that belongs in the
      // second sentence, where #1218 moved all five.
      sanctioned: [],
      // `scanned`, not a population floor: the population here is ONLY the offenders, and empty is
      // the goal — so the vacuity bound has to be on the set the detector WALKED. Sized against a
      // population instead, an empty (correct) result reads as a dead detector.
      scanned: tools.length,
      floor: 5,
      fix: 'rewrite the first sentence as what the tool DOES; move the issue number, caveat or question after it.',
    });
  });
});
