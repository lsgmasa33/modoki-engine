/** #1903: `device_crash_reports`' Android records bounded by CHARACTERS — each exception and frame line cut, the records
 *  (up to 400 by count) fitted to a log answer's budget, newest first, counting what was left out. `adb` is played by a
 *  stub serving a crash buffer. The shared shape: `tools/logAnswer.test.ts`. */

import { describe, it, expect, vi } from 'vitest';
import { promisify } from 'node:util';

const buffers = { crash: '', events: '' };
vi.mock('node:child_process', () => {
  const execFile = (_bin: string, args: string[], _opts: unknown, cb?: (e: Error | null, out: { stdout: string; stderr: string }) => void) => {
    const out = { stdout: args.includes('crash') ? buffers.crash : buffers.events, stderr: '' };
    cb?.(null, out);
  };
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (_bin: string, args: string[]) =>
    ({ stdout: args.includes('crash') ? buffers.crash : buffers.events, stderr: '' });
  return { execFile, default: { execFile } };
});

const { readAndroidDiagnostics, parseCrashBuffer } = await import('../../plugins/backend/deviceAndroidDiag');
const { LOG_ANSWER_CHARS, LOG_LINE_CHARS } = await import('../../tools/shared/logAnswer');

/** `n` FATAL EXCEPTIONs of com.x, one a second, each with a `msgChars`-long exception message and 12 long frames. */
function crashBuffer(n: number, msgChars: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = `09-30 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000`;
    const l = (text: string) => lines.push(`${t}  100  100 E AndroidRuntime: ${text}`);
    l('FATAL EXCEPTION: main');
    l(`Process: com.x, PID: ${1000 + i}`);
    l(`java.lang.RuntimeException: crash${i} ${'m'.repeat(msgChars)}`);
    for (let f = 0; f < 12; f++) l(`\tat com.x.Frame${f}.run(${'F'.repeat(600)}.java:${f})`);
  }
  return lines.join('\n');
}

describe('Android crash records (#1903)', () => {
  it('each exception and frame line is cut to a log line, saying how much', () => {
    const [c] = parseCrashBuffer(crashBuffer(1, 10_000));
    expect(c.exception.length).toBeLessThan(LOG_LINE_CHARS + 30);
    expect(c.exception).toMatch(/^java\.lang\.RuntimeException: crash0 m+… \(\+\d+ chars\)$/);
    expect(c.frames).toHaveLength(12);
    for (const f of c.frames) expect(f).toMatch(/… \(\+\d+ chars\)$/);
  });

  it('400 records by count are fitted to the budget, newest first, and the rest counted', async () => {
    buffers.crash = crashBuffer(100, 5_000);
    const r = await readAndroidDiagnostics({ pkg: 'com.x', limit: 400 });
    expect(r.matched).toBe(100);
    expect(JSON.stringify(r.records).length).toBeLessThanOrEqual(LOG_ANSWER_CHARS);
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.omittedForSize).toBe(100 - r.records.length);
    expect((r.records[0] as { exception: string }).exception).toContain('crash99 ');
  });

  it('a few small records are all returned, nothing omitted', async () => {
    buffers.crash = crashBuffer(3, 10);
    const r = await readAndroidDiagnostics({ pkg: 'com.x' });
    expect(r.records).toHaveLength(3);
    expect(r.omittedForSize).toBe(0);
  });
});
