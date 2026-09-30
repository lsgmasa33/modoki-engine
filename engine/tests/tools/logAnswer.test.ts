/** #1903: an MCP answer carrying raw log text is bounded by CHARACTERS, not by the count of entries — the shared shape
 *  (`tools/shared/logAnswer.ts`) and `device_native_logs`, which returned `logs.join('\n')` with no bound at all.
 *  The console-logs op, diagnose and the Android crash records are pinned beside their own code
 *  (`framework/logAnswerBudget.test.ts`, `plugins/deviceAndroidDiagBudget.test.ts`).
 *  Mutations, measured across the three files: `capLogText` a no-op → the five cut cases go red; `fitLogBudget`
 *  keeping everything → nine (every fit case); a cursored console page fitted from the end, or `nextSeq` taken from the
 *  limit's page instead of the fitted one → "paging skips nothing" alone; `device_native_logs` joining the unfitted
 *  lines → its two long cases; diagnose emitting the unfitted errors → its huge case; the Android records unfitted →
 *  "400 records"; the exception line uncut → "each exception and frame line"; the crash note's size clause dropped →
 *  "the listing note". Each alone; the rest stayed green. Close-out review: the cursored hint without its size note,
 *  or still sending the reader to raise the limit when the fit cut the page → "paging skips nothing" alone. */

import { describe, it, expect, afterEach } from 'vitest';
import { capLogText, fitLogBudget, encodedSize, LOG_ANSWER_CHARS, LOG_LINE_CHARS } from '../../tools/shared/logAnswer';
import { MAX_PAYLOAD_CHARS } from '../../tools/shared/mcpResult';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

describe('capLogText', () => {
  it('cuts to the cap and says how much it cut; a short text passes unchanged', () => {
    expect(capLogText('x'.repeat(450), 400)).toBe(`${'x'.repeat(400)}… (+50 chars)`);
    expect(capLogText('short', 400)).toBe('short');
    expect(capLogText('x'.repeat(400), 400)).toBe('x'.repeat(400));
  });
});

describe('fitLogBudget', () => {
  const items = [1, 2, 3, 4, 5];
  it('last keeps the newest, contiguous, and counts the rest', () => {
    expect(fitLogBudget(items, () => 10, 30, 'last')).toEqual({ items: [3, 4, 5], omitted: 2 });
  });
  it('first keeps the head', () => {
    expect(fitLogBudget(items, () => 10, 30, 'first')).toEqual({ items: [1, 2, 3], omitted: 2 });
  });
  it('everything fits: nothing omitted', () => {
    expect(fitLogBudget(items, () => 10, 50, 'last')).toEqual({ items, omitted: 0 });
  });
  it('never empties a non-empty list: one item over the budget is still kept', () => {
    expect(fitLogBudget(['big', 'bigger'], () => 100, 10, 'last')).toEqual({ items: ['bigger'], omitted: 1 });
    expect(fitLogBudget([], () => 100, 10, 'first')).toEqual({ items: [], omitted: 0 });
  });
  it('stops at the first item that does not fit — a smaller older one past it is not taken (no gap)', () => {
    const sizes: Record<string, number> = { a: 1, b: 100, c: 10 };
    expect(fitLogBudget(['a', 'b', 'c'], (s) => sizes[s], 20, 'last')).toEqual({ items: ['c'], omitted: 2 });
  });
  it('encodedSize measures the compact JSON, escapes included', () => {
    expect(encodedSize({ t: 'a\nb' })).toBe(JSON.stringify({ t: 'a\nb' }).length);
  });
});

describe('device_native_logs is bounded by characters (#1903)', () => {
  let surface: DeviceSurface | undefined;
  afterEach(() => { surface?.restore(); surface = undefined; });
  const replyWith = async (logs: string[]) => {
    surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? deviceReply({ logs }) : undefined);
    return surface;
  };

  it('a line of 200k chars is cut, saying how much, and the answer stays under the budget', async () => {
    const s = await replyWith(['before', 'x'.repeat(200_000), 'after']);
    const text = s.text(await s.call('device_native_logs', {}));
    expect(text.length).toBeLessThan(LOG_ANSWER_CHARS);
    expect(text).toContain(`${'x'.repeat(LOG_LINE_CHARS)}… (+${200_000 - LOG_LINE_CHARS} chars)`);
    expect(text).toMatch(/before[\s\S]*after$/);
  });

  it('many long lines keep the NEWEST that fit and say how many older ones were left out', async () => {
    const logs = Array.from({ length: 400 }, (_, i) => `line-${String(i).padStart(3, '0')} ${'y'.repeat(300)}`);
    const s = await replyWith(logs);
    const text = s.text(await s.call('device_native_logs', {}));
    expect(text.length).toBeLessThanOrEqual(LOG_ANSWER_CHARS + 500);
    expect(text.length).toBeLessThan(MAX_PAYLOAD_CHARS);
    expect(text.endsWith(logs[399])).toBe(true);
    const shown = text.split('\n').filter((l) => l.startsWith('line-')).length;
    expect(shown).toBeGreaterThan(50);
    expect(text).toContain(`[${400 - shown} older of 400 lines left out to keep this answer under ${LOG_ANSWER_CHARS} chars`);
  });

  it('a read that fits is unchanged: no note, every line', async () => {
    const s = await replyWith(['one', 'two']);
    expect(s.text(await s.call('device_native_logs', {}))).toBe('one\ntwo');
  });
});

describe('device_crash_reports says what the budget left out (#1903)', () => {
  let surface: DeviceSurface | undefined;
  afterEach(() => { surface?.restore(); surface = undefined; });

  it('the listing note names the records left out for size, beside shown-of-matched', async () => {
    const s = (surface = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? { body: { result: [{ kind: 'crash', exception: 'boom' }], shown: 1, matched: 5, totalOnDevice: 9, omittedForSize: 4 } }
      : undefined));
    const text = s.text(await s.call('device_crash_reports', { platform: 'android' }));
    expect(text).toContain(`[1 of 5 matching · 9 on device · 4 more within limit left out to keep this answer under ${LOG_ANSWER_CHARS} chars]`);
  });

  it('with nothing left out the note is as before', async () => {
    const s = (surface = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? { body: { result: [{ kind: 'crash', exception: 'boom' }], shown: 1, matched: 1, totalOnDevice: 1 } }
      : undefined));
    expect(s.text(await s.call('device_crash_reports', { platform: 'android' }))).toContain('[1 of 1 matching · 1 on device]');
  });
});
