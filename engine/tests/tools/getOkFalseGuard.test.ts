/** Phase 6 source guard — **a GET route must never answer a bare 200 with `{ok:false}`.**
 *
 *  WHY A SOURCE GUARD AND NOT A BEHAVIOURAL ONE. `getJson` deliberately does not run
 *  `isFailureBody`: for `diagnose` / `validate_scene`, `ok:false` IS the answer ("this scene is
 *  unhealthy"), and failing those calls would make an honest negative result look like a broken
 *  tool. That decision is right, and it has a cost — it means **the transport cannot tell a GET's
 *  answer from a GET's refusal**, so a route that reports a genuine failure as `200 {ok:false}` is
 *  invisible: the tool reports success and the agent believes the empty/negative payload.
 *
 *  The behavioural guards cover the routes a TOOL reaches (`mcpToolContracts.test.ts` — every
 *  mutating GET must fail on `ok:false`; `getParamParity.test.ts` — no param is silently dropped).
 *  What neither can see is a route added with no tool in front of it, or a NEW `ok:false` branch in
 *  an existing route. That is what this checks, at the only place the information exists: the route
 *  source.
 *
 *  THE RULE: inside a `method === 'GET'` block, any `json({… ok: false …})` must pass an explicit
 *  non-2xx status. The three routes that emit one today (`/api/watch/read` 404, `/api/ota/keys`
 *  400/500, `/api/ota/status` 400/500) all already do — this keeps it that way. The alternative
 *  fix for a new violation is equally acceptable: make the route a POST, or pass `checkFailure` at
 *  the tool's call site.
 *
 *  Scanning source as text is normally the WEAK option here (`docs/mcp-tool-conventions.md` §9, and
 *  F2 in the ledger: a text guard that loses its target fails OPEN). So this one asserts its own
 *  reach first — the route files must exist, and a minimum number of GET blocks must be found — and
 *  is mutation-tested below against a synthetic violation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE_FILES = [
  '../../plugins/backend/editorBackendRouter.ts',
  '../../electron/main.ts',
  '../../electron/inputRoutes.ts',
];

type Block = { file: string; route: string; line: number; text: string };

/** Split a route module into per-route blocks, keeping only the GET ones. A block runs from its
 *  `urlPath === …` guard to the next one — coarse, but it cannot MISS code (the failure direction
 *  that matters: a missed block would exempt a violation). */
function getBlocks(file: string, src: string): Block[] {
  const lines = src.split('\n');
  const starts: Array<{ i: number; route: string; isGet: boolean }> = [];
  lines.forEach((l, i) => {
    const m = /urlPath === '(\/api\/[^']+)'/.exec(l);
    if (m) starts.push({ i, route: m[1], isGet: l.includes("'GET'") });
  });
  return starts.flatMap((s, k) => {
    if (!s.isGet) return [];
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    return [{ file, route: s.route, line: s.i + 1, text: lines.slice(s.i, end).join('\n') }];
  });
}

/** Every `json(...)` call in `text` that carries `ok: false`, paired with whether it passed an
 *  explicit status. Brace/paren matched rather than regexed — a nested object would otherwise end
 *  the match early and the status check would read the wrong argument. */
export function okFalseResponses(text: string): Array<{ hasStatus: boolean; snippet: string; call: string }> {
  const out: Array<{ hasStatus: boolean; snippet: string; call: string }> = [];
  for (let i = text.indexOf('json('); i !== -1; i = text.indexOf('json(', i + 1)) {
    // Skip identifiers that merely END in `json(` — e.g. `writeJsonAtomic(`, `parseJson(`.
    const prev = text[i - 1] ?? ' ';
    if (/[A-Za-z0-9_$]/.test(prev)) continue;
    let depth = 0;
    let end = -1;
    const commas: number[] = [];        // top-level argument separators
    for (let j = i + 4; j < text.length; j++) {
      const ch = text[j];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) { end = j; break; }
      } else if (ch === ',' && depth === 1) commas.push(j);
    }
    if (end === -1) continue;           // unbalanced (a truncated block) — nothing to judge
    const call = text.slice(i, end + 1);
    if (!/ok:\s*false/.test(call)) continue;
    const lastArg = commas.length ? text.slice(commas[commas.length - 1] + 1, end) : '';
    const flat = call.replace(/\s+/g, ' ');
    // `snippet` is truncated for readable failure output; `call` is the WHOLE thing, because a
    // check that looks for a field can be defeated by a field that falls past the cut.
    out.push({ hasStatus: /\b[45]\d\d\b|\bstatus\b/.test(lastArg), snippet: flat.slice(0, 160), call: flat });
  }
  return out;
}

describe('a GET route never answers a bare 200 with ok:false', () => {
  const blocks = ROUTE_FILES.flatMap((rel) => {
    const abs = join(__dirname, rel);
    return getBlocks(rel, readFileSync(abs, 'utf8'));
  });

  it('the scan has real targets (a text guard that finds nothing passes silently)', () => {
    // F2's lesson, applied to this guard: assert reach BEFORE asserting compliance.
    expect(blocks.length, 'no GET route blocks were found — the scan lost its targets').toBeGreaterThanOrEqual(15);
    // Two routes AUTHOR an `ok:false` body literally (`/api/ota/keys`, `/api/ota/status`).
    // `/api/watch/read` is compliant by a different route: it FORWARDS a body it did not author
    // (`if (result.ok === false) return json(result, 404)`), so there is no literal to find — a
    // pattern this scan cannot police and does not need to, since the status is explicit.
    const withOkFalse = blocks.filter((b) => okFalseResponses(b.text).length > 0);
    expect(withOkFalse.length, 'no ok:false GET response found at all — the parser is not seeing them').toBeGreaterThanOrEqual(2);
  });

  it('every ok:false a GET route emits carries an explicit non-2xx status', () => {
    const offenders = blocks.flatMap((b) =>
      okFalseResponses(b.text).filter((r) => !r.hasStatus)
        .map((r) => `${b.file}:${b.line} ${b.route} → ${r.snippet}`));
    expect(offenders,
      'a GET\'s ok:false at status 200 is invisible to getJson (which cannot tell a GET\'s ANSWER '
      + 'from its REFUSAL), so the tool reports success. Give it a 4xx/5xx, make the route a POST, '
      + 'or pass checkFailure at the tool\'s call site.').toEqual([]);
  });

  it('…and the parser CAN fail — it flags a synthetic bare-200 violation', () => {
    // Mutation test in-place: a guard never seen to fail is not known to work.
    const bad = `if (urlPath === '/api/thing' && method === 'GET') {
      return json({ ok: false, error: 'nope' });
    }`;
    expect(okFalseResponses(bad)).toEqual([expect.objectContaining({ hasStatus: false })]);

    const good = `if (urlPath === '/api/thing' && method === 'GET') {
      return json({ ok: false, error: 'nope' }, 404);
    }`;
    expect(okFalseResponses(good)).toEqual([expect.objectContaining({ hasStatus: true })]);
  });

  it('the parser is not fooled by a NESTED object before the status argument', () => {
    // The reason this matches braces instead of regexing to the first `}`: a nested object would
    // end the match early, and the "did it pass a status?" check would then read `}, 400)` as part
    // of the body — or miss it entirely.
    const nested = `return json({ ok: false, error: 'x', got: { a: 1, b: { c: 2 } } }, 400);`;
    expect(okFalseResponses(nested)).toEqual([expect.objectContaining({ hasStatus: true })]);
    const nestedBare = `return json({ ok: false, got: { a: 1, b: { c: 2 } } });`;
    expect(okFalseResponses(nestedBare)).toEqual([expect.objectContaining({ hasStatus: false })]);
  });

  it('ignores a helper whose name merely ends in json( ', () => {
    expect(okFalseResponses(`writeJsonAtomic({ ok: false });`)).toEqual([]);
  });
});

/** The POST half, which this file did not have (independent review, 2026-07-30).
 *
 *  The scan above deliberately covers GET blocks ONLY, because a GET's `ok:false` is ambiguous to
 *  the transport. POST is not the same problem — `postJson` DOES run `isFailureBody`, and that
 *  helper flags any object body carrying `ok:false` — so a POST failure is correctly classified.
 *
 *  What it is NOT guaranteed to carry is a CAUSE. `isFailureBody` falls back to the literal string
 *  "the operation reported ok:false" when there is no `error`/`errors`/`reason`, which is the §5
 *  violation in miniature: the agent is told the call failed and nothing about why, on the trusted-
 *  input routes where a miss is least self-evident (a tap that hit nothing looks exactly like a tap
 *  that worked). The electron routes gained several new `200 + {ok:false}` bodies this day — short
 *  insert, blocked handle, focus miss — and nothing checked that any of them said why.
 *
 *  So: same parser, POST blocks, different rule — a failure body must name its cause. */
function postBlocks(file: string, src: string): Block[] {
  const lines = src.split('\n');
  const starts: Array<{ i: number; route: string; isGet: boolean }> = [];
  lines.forEach((l, i) => {
    const m = /urlPath === '(\/api\/[^']+)'/.exec(l);
    if (m) starts.push({ i, route: m[1], isGet: l.includes("'GET'") });
  });
  return starts.flatMap((s, k) => {
    if (s.isGet) return [];
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    return [{ file, route: s.route, line: s.i + 1, text: lines.slice(s.i, end).join('\n') }];
  });
}

describe('a POST route\'s ok:false always says WHY', () => {
  const blocks = ROUTE_FILES.flatMap((f) => postBlocks(f, readFileSync(join(__dirname, f), 'utf8')));

  it('reaches the POST routes at all (a text guard that lost its target fails OPEN)', () => {
    expect(blocks.length, 'no POST route blocks found — did the route dispatch shape change?').toBeGreaterThan(5);
    const withOkFalse = blocks.filter((b) => okFalseResponses(b.text).length > 0);
    expect(withOkFalse.length, 'no ok:false POST body found — the parser is not seeing them').toBeGreaterThanOrEqual(3);
  });

  it('every ok:false a POST route emits carries an error/errors/reason', () => {
    // Without one, `isFailureBody` reports the bare fallback "the operation reported ok:false" —
    // a failure with no cause, which §5 calls a bug by definition.
    const offenders = blocks.flatMap((b) =>
      okFalseResponses(b.text)
        // `error: x`, or the shorthand `{ …, errors }` / `{ …, error }`.
        .filter((r) => !/\b(error|errors|reason)\s*[:,}]/.test(r.call))
        .map((r) => `${b.file}:${b.line} ${b.route} → ${r.snippet.slice(0, 120)}`));
    expect(offenders,
      'this POST answers ok:false with no cause, so the agent is told only THAT it failed. Add an '
      + '`error` (or `errors`/`reason`) naming what was attempted and what to do instead.').toEqual([]);
  });

  it('…and that check CAN fail — mutation-tested against a causeless body', () => {
    const causeless = `return json({ ok: false, typed: 0 });`;
    const CAUSE = /\b(error|errors|reason)\s*[:,}]/;
    expect(CAUSE.test(okFalseResponses(causeless)[0].call)).toBe(false);
    const withCause = `return json({ ok: false, typed: 0, error: 'nothing focused' });`;
    expect(CAUSE.test(okFalseResponses(withCause)[0].call)).toBe(true);
    // shorthand counts, and a cause past the 160-char display cut still counts
    expect(CAUSE.test(okFalseResponses(`return json({ ok: false, errors, warnings }, 400);`)[0].call)).toBe(true);
    const long = `return json({ ok: false, a: '${'x'.repeat(200)}', error: 'late' });`;
    expect(CAUSE.test(okFalseResponses(long)[0].call)).toBe(true);
  });
});
