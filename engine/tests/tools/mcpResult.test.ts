/** Unit: the MCP tool-result formatter — the choke point all 64 `modoki_*` tools flow through.
 *
 *  Two invariants here are load-bearing, and both are the kind that fail silently:
 *
 *  1. A capped payload MUST stay parseable. `test-smoke.mjs` does `JSON.parse()` on a tool
 *     result, and the model — the actual consumer — is no better served by a blob severed
 *     mid-string. Truncation must therefore produce a valid `{elided:true,…}` envelope, not
 *     `text.slice(0, N)`.
 *  2. The identity banner ("you are driving the OTHER clone's editor") must survive capping
 *     intact. It is the one line that makes every other byte in the result a lie, so it is
 *     precisely the line that must never be the part that gets cut.
 *
 *  See `docs/mcp-response-budget.md` (Phases 0–1). */

import { describe, it, expect } from 'vitest';
import {
  encode,
  capText,
  summarize,
  createFormatter,
  MAX_PAYLOAD_CHARS,
} from '../../tools/modoki-mcp/src/result';

/** A JSON payload whose compact serialization comfortably exceeds `maxChars`. */
const bigPayload = (entities = 4000) => ({
  scenePath: '/games/3d-test/runtime/assets/scenes/main.json',
  entityCount: entities,
  entities: Array.from({ length: entities }, (_, i) => ({
    id: i,
    name: `Entity_${i}`,
    traits: ['Transform', 'Renderable3D'],
  })),
});

describe('encode — compaction', () => {
  it('emits compact JSON, not pretty-printed', () => {
    const text = encode({ a: 1, b: { c: 2 } });
    expect(text).toBe('{"a":1,"b":{"c":2}}');
    // The regression this guards: `JSON.stringify(data, null, 2)` cost ~40% of every
    // response. Indentation would reintroduce newlines + runs of leading spaces.
    expect(text).not.toContain('\n');
    expect(text).not.toMatch(/ {2}/);
  });

  it('round-trips an under-cap payload byte-for-byte', () => {
    const data = { scenePath: '/x/main.json', entityCount: 3 };
    expect(JSON.parse(encode(data))).toEqual(data);
  });

  it('passes a string payload through unstringified (no JSON quotes)', () => {
    expect(encode('BUILD OK')).toBe('BUILD OK');
  });

  it('does not throw on a non-serializable root', () => {
    expect(() => encode(undefined)).not.toThrow();
  });
});

describe('encode — the cap never mid-slices JSON', () => {
  it('an over-cap payload is STILL VALID JSON', () => {
    const text = encode(bigPayload());
    expect(text.length).toBeGreaterThan(0);
    // The whole point: parseable, not severed.
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('degrades to an elision envelope carrying size + hint + shape', () => {
    const data = bigPayload();
    const parsed = JSON.parse(encode(data));

    expect(parsed.elided).toBe(true);
    expect(parsed.bytes).toBe(JSON.stringify(data).length);
    expect(parsed.bytes).toBeGreaterThan(MAX_PAYLOAD_CHARS);

    // The hint is the entire value of a capped response — it must name the way out.
    expect(parsed.hint).toContain('limit=');
    expect(parsed.hint).toMatch(/trait=|filter/);

    // `preview` reports shape, never values, and must stay small.
    expect(parsed.preview.entities).toBe('array(4000)');
    expect(parsed.preview.entityCount).toBe('4000');
    expect(JSON.stringify(parsed.preview).length).toBeLessThan(1000);
  });

  it('the envelope itself is far smaller than the payload it replaces', () => {
    const data = bigPayload();
    expect(encode(data).length).toBeLessThan(JSON.stringify(data).length / 50);
  });

  it('caps at the EXACT <= edge: 60000 chars verbatim, 60001 elided', () => {
    // `{"s":"…"}` costs exactly 8 chars of envelope, so repeat(MAX-8) serializes to exactly
    // MAX and repeat(MAX-7) to MAX+1. Straddling the boundary loosely (e.g. MAX-20 vs MAX,
    // which land on 59988 and 60008) leaves a dead zone where a `<=` → `<` off-by-one goes
    // undetected — which is precisely the bug this test claims to guard.
    const atCap = { s: 'x'.repeat(MAX_PAYLOAD_CHARS - 8) };
    expect(JSON.stringify(atCap).length).toBe(MAX_PAYLOAD_CHARS); // arithmetic, pinned
    expect(JSON.parse(encode(atCap))).toEqual(atCap); // verbatim: <= is inclusive

    const overCap = { s: 'x'.repeat(MAX_PAYLOAD_CHARS - 7) };
    expect(JSON.stringify(overCap).length).toBe(MAX_PAYLOAD_CHARS + 1);
    expect(JSON.parse(encode(overCap)).elided).toBe(true);
  });

  it('capText caps at the exact <= edge too', () => {
    expect(capText('x'.repeat(MAX_PAYLOAD_CHARS))).toHaveLength(MAX_PAYLOAD_CHARS); // untouched
    expect(capText('x'.repeat(MAX_PAYLOAD_CHARS + 1))).toContain('1 chars elided');
  });

  it('honours an explicit maxChars', () => {
    expect(JSON.parse(encode({ a: 'yyyyyyyyyy' }, 5)).elided).toBe(true);
    expect(JSON.parse(encode({ a: 1 }, 5_000))).toEqual({ a: 1 });
  });
});

describe('capText — plain-text payloads (build logs)', () => {
  it('leaves an under-cap string alone', () => {
    expect(capText('short', 100)).toBe('short');
  });

  it('truncates and reports how much was dropped', () => {
    const out = capText('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('400 chars elided of 500');
  });
});

describe('summarize', () => {
  it('reports shapes and counts, never values', () => {
    expect(summarize({ xs: [1, 2, 3], o: { a: 1 }, n: 7, s: 'hi' })).toEqual({
      xs: 'array(3)',
      o: 'object(1 keys)',
      n: '7',
      s: '"hi"',
    });
  });

  it('elides a long string rather than echoing it', () => {
    expect((summarize({ s: 'z'.repeat(200) }) as Record<string, string>).s).toBe('string(200)');
  });
});

describe('createFormatter — the identity banner outlives the cap', () => {
  const WARNING = '⚠️  BACKEND MISMATCH: driving /Users/x/modoki-ai, not /Users/x/modoki';

  it('ok(): no banner when identities agree', () => {
    const { ok } = createFormatter(() => null);
    expect(ok({ a: 1 }).content[0].text).toBe('{"a":1}');
  });

  it('ok(): banner is prepended, and the payload still parses', () => {
    const { ok } = createFormatter(() => WARNING);
    const text = ok({ a: 1 }).content[0].text;
    expect(text.startsWith(WARNING)).toBe(true);
    expect(JSON.parse(text.slice(WARNING.length))).toEqual({ a: 1 });
  });

  it('ok(): an OVER-CAP payload keeps both the banner and a parseable envelope', () => {
    const { ok } = createFormatter(() => WARNING);
    const text = ok(bigPayload()).content[0].text;
    expect(text.startsWith(WARNING)).toBe(true);
    expect(JSON.parse(text.slice(WARNING.length)).elided).toBe(true);
  });

  it('ok(): the banner cannot push a just-fitting payload over the cap and sever it', () => {
    // THE failure mode this whole file exists for. Cap `banner(payload)` as one string —
    // the natural, wrong implementation — and a payload that legitimately fits is pushed
    // over by the prepended warning. capText() then slices the TAIL, which is the closing
    // brace of the JSON. The banner survives; the answer becomes unparseable garbage.
    // So: cap the payload, THEN prepend the banner. Never the reverse.
    const { ok } = createFormatter(() => WARNING);
    const justFits = { s: 'x'.repeat(MAX_PAYLOAD_CHARS - 20) }; // under cap alone, over it with the banner
    const text = ok(justFits).content[0].text;

    expect(text.startsWith(WARNING)).toBe(true);
    const payload = text.slice(WARNING.length);
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload)).toEqual(justFits);
    expect(text.length).toBeGreaterThan(MAX_PAYLOAD_CHARS); // banner legitimately exceeds it
  });

  it('reads the warning lazily, so a late identity probe still banners', () => {
    // `ensureIdentity()` arms the warning asynchronously, AFTER the formatter is built.
    let warning: string | null = null;
    const { ok } = createFormatter(() => warning);
    expect(ok({ a: 1 }).content[0].text).toBe('{"a":1}');
    warning = WARNING;
    expect(ok({ a: 1 }).content[0].text.startsWith(WARNING)).toBe(true);
  });

  it('err(): flags isError and caps an unbounded backend body', () => {
    const { err } = createFormatter(() => null);
    const res = err(`backend 500: ${'x'.repeat(MAX_PAYLOAD_CHARS * 2)}`);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('chars elided of');
    expect(res.content[0].text.length).toBeLessThan(MAX_PAYLOAD_CHARS + 200);
  });

  it('err(): banner survives a capped error body too', () => {
    const { err } = createFormatter(() => WARNING);
    const text = err('x'.repeat(MAX_PAYLOAD_CHARS * 2)).content[0].text;
    expect(text.startsWith(WARNING)).toBe(true);
  });
});
