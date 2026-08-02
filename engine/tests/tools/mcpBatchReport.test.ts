/** Unit: how a completed batch is REPORTED — the phase where the token saving happens, and the
 *  phase where it would be easiest to accidentally hide a failure.
 *
 *  `mcpBatch.test.ts` proves the executor runs the right things in the right order. This file
 *  proves the envelope tells the truth about what it ran. The three invariants below are the
 *  whole reason `result:'none'` is safe to offer at all; if any of them breaks, `'none'` becomes
 *  a mechanism for swallowing errors, which is strictly worse than never having added it.
 *
 *  See `docs/mcp-response-budget.md` (the `modoki_batch` section). */

import { describe, it, expect } from 'vitest';
import { reportBatch, ACK_VERBATIM_CHARS } from '../../tools/modoki-mcp/src/batchReport';
import { MAX_PAYLOAD_CHARS } from '../../tools/modoki-mcp/src/result';
import type { BatchOutcome, StepOutcome, ResultMode } from '../../tools/modoki-mcp/src/batch';

const step = (i: number, over: Partial<StepOutcome> = {}): StepOutcome => ({
  i, tool: `t${i}`, ok: true, mode: 'ack' as ResultMode, text: '{"changed":1}', ...over,
});

const outcome = (steps: StepOutcome[], over: Partial<BatchOutcome> = {}): BatchOutcome => ({
  ok: steps.every((s) => s.ok), ran: steps.length, steps, ...over,
});

type Report = {
  ok: boolean; ran: number;
  quiet?: { i: number; tool: string }[];
  steps?: { i: number; tool: string; ok: boolean; result?: unknown; error?: unknown }[];
  failedAt?: number; notRun?: unknown[]; hint?: string;
};

describe("'none' suppresses a clean step", () => {
  it('lists it in `quiet` — index and tool only, no payload', () => {
    const r = reportBatch(outcome([
      step(0, { mode: 'none' }), step(1, { mode: 'none' }), step(2, { mode: 'full' }),
    ])) as Report;
    expect(r.quiet).toEqual([{ i: 0, tool: 't0' }, { i: 1, tool: 't1' }]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps![0]).toMatchObject({ i: 2, result: { changed: 1 } });
  });

  it('is a real saving — a 10-step macro collapses to one line plus the terminal read', () => {
    const big = 'x'.repeat(20_000);
    const steps = Array.from({ length: 9 }, (_, i) => step(i, { mode: 'none', text: `{"blob":"${big}"}` }));
    steps.push(step(9, { mode: 'full', text: '{"final":true}' }));
    const chars = JSON.stringify(reportBatch(outcome(steps))).length;
    expect(chars).toBeLessThan(1_000); // vs ~180k emitted verbatim
  });
});

describe('a failure is never swallowed', () => {
  it("reports a FAILED step in full even when its mode is 'none'", () => {
    // The invariant that makes silence mean success and nothing else.
    const r = reportBatch(outcome(
      [step(0, { mode: 'none' }), step(1, { mode: 'none', ok: false, text: '{"error":"backend 500"}' })],
      { ok: false, failedAt: 1, notRun: [{ i: 2, tool: 't2' }] },
    )) as Report;
    const failed = r.steps!.find((s) => s.i === 1)!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toEqual({ error: 'backend 500' });
  });

  it("un-suppresses the steps BEFORE the failure, despite their 'none' mode", () => {
    // Steps 0-1 already applied and are not rolled back. Reporting only the failure and the
    // not-run tail would describe a scene state that does not exist.
    const r = reportBatch(outcome(
      [step(0, { mode: 'none' }), step(1, { mode: 'none' }), step(2, { mode: 'none', ok: false, text: 'boom' })],
      { ok: false, failedAt: 2 },
    )) as Report;
    expect(r.quiet).toBeUndefined();
    expect(r.steps!.map((s) => s.i)).toEqual([0, 1, 2]);
    expect(r.steps![0]).toMatchObject({ i: 0, ok: true });
  });

  it('promotes a suppressed step at ACK detail, not full', () => {
    // It ran and succeeded — that is what the caller needs. Re-reading a payload the caller
    // already declared uninteresting would undo the saving on exactly the path where the
    // envelope is already largest.
    const big = `{"blob":"${'x'.repeat(5_000)}"}`;
    const r = reportBatch(outcome(
      [step(0, { mode: 'none', text: big }), step(1, { ok: false, text: 'boom' })],
      { ok: false, failedAt: 1 },
    )) as Report;
    expect(r.steps![0].result).toMatchObject({ elided: true, bytes: big.length });
  });

  it('carries a hint that a batch is NOT a transaction', () => {
    const r = reportBatch(outcome([step(0, { ok: false, text: 'boom' })], { ok: false, failedAt: 0 })) as Report;
    expect(r.hint).toMatch(/ALREADY APPLIED/);
    expect(r.hint).toMatch(/did NOT run/);
  });
});

describe("'ack' degrades instead of flooding", () => {
  it('includes a small payload verbatim', () => {
    const r = reportBatch(outcome([step(0, { mode: 'ack', text: '{"a":1}' })])) as Report;
    expect(r.steps![0].result).toEqual({ a: 1 });
  });

  it('summarizes a large one — shapes and counts, never values', () => {
    const text = JSON.stringify({ entities: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `e${i}` })) });
    expect(text.length).toBeGreaterThan(ACK_VERBATIM_CHARS);
    const r = reportBatch(outcome([step(0, { mode: 'ack', text })])) as Report;
    expect(r.steps![0].result).toMatchObject({ elided: true, bytes: text.length, preview: { entities: 'array(400)' } });
    expect(JSON.stringify(r.steps![0].result)).not.toContain('e399');
  });

  it('passes a non-JSON payload (a build log) through as a string', () => {
    const r = reportBatch(outcome([step(0, { mode: 'ack', text: 'plain log line' })])) as Report;
    expect(r.steps![0].result).toBe('plain log line');
  });
});

describe('the whole envelope is bounded, and stays parseable', () => {
  it('over the cap it drops SUCCESSFUL payloads and keeps the report — not a shape summary', () => {
    // Many FULL steps, each individually under the per-tool cap: the batch is where they add up.
    // This used to fall through to `encode`'s generic elision, whose `summarize` is one level deep
    // — so `steps` became the string 'array(10)'. On a failed batch that erased which step failed
    // and why, and the attached hint then advised narrowing with `trait=`/`limit=`/`full=1`, none
    // of which modoki_batch even has.
    const chunk = `{"blob":"${'x'.repeat(20_000)}"}`;
    const steps = Array.from({ length: 10 }, (_, i) => step(i, { mode: 'full', text: chunk }));
    const body = reportBatch(outcome(steps)) as Record<string, unknown>;
    const text = JSON.stringify(body);
    expect(text.length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(() => JSON.parse(text)).not.toThrow();
    // The REPORT survives: still a real steps array, not 'array(10)'.
    expect(body.elided).toBeUndefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.payloadsDropped).toBe(10);
    expect(String(body.hint)).toMatch(/payloads were dropped/);
  });

  it('over the cap, a FAILING step keeps its error text while successes lose theirs', () => {
    // The whole point: the failure detail is what the caller needs to reconcile state, and it was
    // the first thing the old degradation threw away.
    const chunk = `{"blob":"${'x'.repeat(20_000)}"}`;
    const steps = [
      ...Array.from({ length: 9 }, (_, i) => step(i, { mode: 'full', text: chunk })),
      step(9, { mode: 'full', ok: false, text: 'backend 500: the specific thing that broke' }),
    ];
    const body = reportBatch(outcome(steps, { ok: false, failedAt: 9 })) as Record<string, unknown>;
    expect(JSON.stringify(body).length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(body.failedAt).toBe(9);
    expect(JSON.stringify(body)).toContain('the specific thing that broke');
  });
});

describe('the identity banner appears once, not per step', () => {
  const BANNER = '⚠️ WRONG EDITOR: this backend is a different checkout';

  it('strips the banner from every step payload', () => {
    const r = reportBatch(outcome([
      step(0, { mode: 'full', text: `${BANNER}\n\n{"a":1}` }),
      step(1, { mode: 'full', text: `${BANNER}\n\n{"b":2}` }),
    ]), BANNER) as Report;
    expect(JSON.stringify(r)).not.toContain('WRONG EDITOR');
    expect(r.steps!.map((s) => s.result)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('only strips an EXACT leading banner, never a payload that resembles one', () => {
    // A fuzzy match here would eat real data. The banner is a known literal, so anchor on it.
    const r = reportBatch(outcome([step(0, { mode: 'full', text: `{"note":"${BANNER} appeared"}` })]), BANNER) as Report;
    expect(r.steps![0].result).toEqual({ note: `${BANNER} appeared` });
  });

  it('is a no-op when no banner is armed', () => {
    const r = reportBatch(outcome([step(0, { mode: 'full', text: '{"a":1}' })]), null) as Report;
    expect(r.steps![0].result).toEqual({ a: 1 });
  });
});

describe("a summarized step says how to get its payload", () => {
  // Only the LAST step defaults to `full`, which is right — and a trap the moment a batch ends
  // with teardown (restore the timescale, stop play), because then the read you cared about is in
  // the middle and `ack` trims it. MEASURED on use case 4: `modoki_journal` came back as
  // `{elided:true,bytes:1579,preview:…}` and the verification the batch existed to do was simply
  // not in the response. Nothing in the envelope said why, or what to do.
  const bigAck = (i: number) => step(i, { mode: 'ack', text: JSON.stringify({ events: Array.from({ length: 200 }, (_, k) => ({ k })) }) });

  it('names the summarized indexes and the fix', () => {
    const r = reportBatch(outcome([bigAck(0), step(1, { mode: 'full' })])) as Report & { summarized?: number[]; summarizedHint?: string };
    expect(r.summarized).toEqual([0]);
    expect(r.summarizedHint).toMatch(/result:'full'/);
    expect(r.summarizedHint).toMatch(/LAST step/);
  });

  it('stays silent when every ack fitted verbatim — no hint for a non-problem', () => {
    const r = reportBatch(outcome([step(0, { mode: 'ack', text: '{"a":1}' })])) as Report & { summarized?: number[] };
    expect(r.summarized).toBeUndefined();
  });

  it('does not fire on a FAILED batch, where the failure is the story', () => {
    // A failed batch already carries the fail-fast hint; two competing hints would bury it, and
    // the promoted-prefix summaries are deliberately terse (they were declared uninteresting).
    const r = reportBatch(outcome([bigAck(0), step(1, { ok: false, text: 'boom' })], { ok: false, failedAt: 1 })) as Report & { summarized?: number[] };
    expect(r.summarized).toBeUndefined();
    expect(r.hint).toMatch(/ALREADY APPLIED/);
  });
});
