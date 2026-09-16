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
  const CALL = /(?<![A-Za-z0-9_$])registerAgentTool\s*\(\s*\{/g;
  for (let m = CALL.exec(src); m; m = CALL.exec(src)) {
    const fields = readTopLevelFields(src, m.index + m[0].length);
    if (fields.name === undefined) continue;
    out.push({ name: fields.name, description: fields.description ?? '', file });
  }
  return out;
}

/** Scan one object literal from just after its `{`, returning the `name` and `description` written
 *  at ITS top level — depth 1 only.
 *
 *  ⚠️ Depth-tracking is not tidiness here, it is the whole correctness of the guard. A regex that
 *  takes the first `description:` in the block takes a PARAM's, because every game tool's `params`
 *  carry their own `description` fields; the corpus only escapes that by happening to write
 *  `description` before `params`. Anchoring to "the value opens a quote" does not help either — a
 *  param's description opens with a quote too. So the reader walks the literal, counting braces and
 *  skipping over string bodies, and considers a key only while depth === 1.
 *
 *  Skipping string BODIES also fixes the other half: a `{` or `}` inside a description (or a
 *  regex-looking literal) no longer desynchronises the brace count and truncate the block early. */
function readTopLevelFields(src: string, from: number): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ']') { depth--; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i); continue; }
    if (depth === 1) {
      const key = /^\b(name|description)\s*:\s*/.exec(src.slice(i));
      if (key && out[key[1] as 'name' | 'description'] === undefined) {
        const read = readConcatenatedString(src, i + key[0].length);
        // A non-literal value (a template literal, a helper call, an identifier) reads as '' and is
        // RECORDED as '', not skipped — the live check treats '' as unreadable and fails, which is
        // the honest outcome for a description this cannot police.
        out[key[1] as 'name' | 'description'] = read.value;
        i = read.next;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Index just past the string literal starting at `i` (handles escapes). */
function skipString(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j + 1;
  }
  return src.length;
}

/** A chain of plain string literals joined by `+`, from `at`. `value` is '' when the value is not
 *  one (a template literal, an identifier, a call). */
function readConcatenatedString(src: string, at: number): { value: string; next: number } {
  const parts: string[] = [];
  let i = at;
  for (;;) {
    const lit = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(src.slice(i));
    if (!lit) return { value: parts.join(''), next: i };
    parts.push(unescape(lit[1] ?? lit[2] ?? ''));
    i += lit[0].length;
    const plus = /^\s*\+/.exec(src.slice(i));
    if (!plus) return { value: parts.join(''), next: i };
    i += plus[0].length;
  }
}

const unescape = (s: string): string =>
  s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');

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

  // It must NOT invent a description it cannot read — '' is how the live test learns to fail.
  it('returns an empty description for a form it cannot read, rather than guessing', () => {
    const t = extractGameTools('registerAgentTool({ name: \'g_f\', description: buildDesc() });', 'f.ts');
    expect(t[0].description).toBe('');
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
