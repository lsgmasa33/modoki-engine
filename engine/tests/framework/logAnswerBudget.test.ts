/** #1903: the console-logs op (behind `modoki_get_console_logs` and `device_console_logs`) and diagnose's
 *  `consoleErrors` bounded by CHARACTERS, not by entry count. `limit` counted entries and an entry has no size, so one
 *  logged blob or deep stack sent the whole answer past the 60k cap — a `TOO_LARGE` envelope even at limit=1. The
 *  shared shape itself: `tools/logAnswer.test.ts`. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installConsoleRing, recordConsoleRingEntry, __resetConsoleRingForTest } from '@modoki/engine/runtime/core/consoleRing';
import { _resetConsoleSourceForTests } from '../../app/debug/consoleSource';
import { runAgentOp } from '../../app/debug/agentBridge';
import { computeDiagnostics } from '../../app/debug/diagnose';
import { LOG_ANSWER_CHARS, LOG_ENTRY_CHARS } from '../../tools/shared/logAnswer';
import { MAX_PAYLOAD_CHARS } from '../../tools/shared/mcpResult';

type Reply = {
  logs: Array<{ seq: number; level: string; ts: number; text: string }>;
  returnedCount: number; totalCount: number; nextSeq: number; epoch: string; truncated?: true; hint?: string; omittedForSize?: number;
};
const read = async (p: Record<string, unknown> = {}) => (await runAgentOp('console-logs', p)) as Reply;

beforeEach(() => {
  _resetConsoleSourceForTests();
  __resetConsoleRingForTest();
  installConsoleRing({ capacity: 200, bootPrefix: 0 });
});
afterEach(() => { __resetConsoleRingForTest(); });

describe('console-logs: one oversized entry', () => {
  it('is cut to the entry cap, saying how much, and the answer fits under the payload cap even at limit=1', async () => {
    recordConsoleRingEntry('error', ['z'.repeat(200_000)]);
    const r = await read({ limit: 1 });
    expect(JSON.stringify(r).length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(r.logs[0].text).toBe(`${'z'.repeat(LOG_ENTRY_CHARS)}… (+${200_000 - LOG_ENTRY_CHARS} chars)`);
    expect(r.omittedForSize).toBeUndefined();
  });
});

describe('console-logs: many large entries', () => {
  beforeEach(() => {
    for (let i = 1; i <= 50; i++) recordConsoleRingEntry('error', [`e${i} ${'s'.repeat(3_000)}`]);
  });

  it('a tail keeps the NEWEST that fit, counts the rest, and points at the exact cursor for them', async () => {
    const r = await read({ limit: 40 }); // the limit takes seq 11-50; the budget keeps the newest of those
    expect(JSON.stringify(r).length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(JSON.stringify(r.logs).length).toBeLessThanOrEqual(LOG_ANSWER_CHARS);
    expect(r.logs.at(-1)!.seq).toBe(50);
    expect(r.logs[0].seq).toBe(50 - r.logs.length + 1);
    expect(r.returnedCount).toBe(r.logs.length);
    expect(r.totalCount).toBe(50);
    expect(r.omittedForSize).toBe(40 - r.logs.length);
    expect(r.truncated).toBe(true);
    // The first entry the budget left out is seq 11, so the cursor that reads it next is 10.
    expect(r.hint).toContain('since=10 and this epoch');
  });

  it('a cursored page keeps its OLDEST, and nextSeq continues right after the last row shown: paging skips nothing', async () => {
    const seen: number[] = [];
    let since = 0;
    let epoch: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = await read({ since, ...(epoch ? { epoch } : {}) });
      expect(JSON.stringify(r).length).toBeLessThan(MAX_PAYLOAD_CHARS);
      if (guard === 0) {
        // The limit took all 50; the size fit is what cut this page. So the answer says so, and does not send the
        // reader to raise a limit that cannot help (close-out review F3).
        expect(r.omittedForSize).toBe(50 - r.logs.length);
        expect(r.hint).toContain(`${50 - r.logs.length} of the 50 entries the limit took were left out`);
        expect(r.hint).not.toMatch(/raise limit/);
      }
      seen.push(...r.logs.map((l) => l.seq));
      epoch = r.epoch;
      if (!r.truncated) break;
      expect(r.nextSeq).toBe(r.logs.at(-1)!.seq);
      since = r.nextSeq;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('diagnose: consoleErrors', () => {
  const now = 1_000_000;
  const errors = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({ level: 'error', ts: now - 1_000 + i, text: `err${i} ${'q'.repeat(size)}` }));

  it('twenty huge errors: each cut, the newest fitted to its share, the rest counted; the verdict still sees them', () => {
    const d = computeDiagnostics({ consoleErrors: errors(20, 50_000), now, errorWindowMs: 60_000 });
    expect(JSON.stringify(d.consoleErrors).length).toBeLessThanOrEqual(LOG_ANSWER_CHARS / 2);
    expect(d.consoleErrors.at(-1)!.text.startsWith('err19 ')).toBe(true);
    expect(d.consoleErrors[0].text).toMatch(/… \(\+\d+ chars\)$/);
    expect((d as { consoleErrorsOmittedForSize?: number }).consoleErrorsOmittedForSize).toBe(20 - d.consoleErrors.length);
    expect(d.ok).toBe(false);
    expect(d.summary).toContain('20 console error(s)');
  });

  it('small errors are unchanged, with no omitted count', () => {
    const d = computeDiagnostics({ consoleErrors: errors(3, 10), now, errorWindowMs: 60_000 });
    expect(d.consoleErrors).toEqual(errors(3, 10));
    expect('consoleErrorsOmittedForSize' in d).toBe(false);
  });
});
