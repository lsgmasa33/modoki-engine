/** `device_console_logs` reads the SHARED `console-logs` agent op — the editor's own reader — rather than a
 *  device-only bridge command (#1559 C-4). The device used to keep its own projection
 *  (`bridge.ts`'s `handleConsoleLogs`): a prose reply with no `returnedCount`/`totalCount`, no `since`,
 *  and an exact-match `level` that disagreed with the editor's about `info`. That command, its
 *  shape-tolerant parser (#644) and their tests are gone; what is pinned here is the relay itself, and
 *  that the op's reply and refusals reach the agent unchanged. The op's semantics are pinned where it
 *  runs, in `consoleLogsCursor.test.ts`.
 *
 *  Driven through the REAL handler against the stub backend (`deviceSurface.ts`). */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

let s: DeviceSurface | undefined;
afterEach(() => { s?.restore(); s = undefined; });

function relayed(surface: DeviceSurface): { method?: string; params?: Record<string, unknown> } {
  const req = surface.real().find((r) => r.path.startsWith('/api/device/request'));
  return (req?.body ?? {}) as { method?: string; params?: Record<string, unknown> };
}

describe('device_console_logs relays the shared console-logs op (#1559)', () => {
  it('sends console-logs with exactly the args given', async () => {
    s = await loadDeviceSurface(() => deviceReply({ logs: [], returnedCount: 0, totalCount: 0, ringTotal: 0, byLevel: {}, dropped: 0, nextSeq: 0 }));
    const r = await s.call('device_console_logs', { level: 'warn', since: 12, limit: 5 });
    expect(r.isError).toBeFalsy();
    expect(relayed(s)).toEqual({ method: 'console-logs', params: { level: 'warn', since: 12, limit: 5 } });
  });

  it('answers the op reply as JSON — the counts and the cursor reach the agent', async () => {
    const reply = {
      logs: [{ seq: 7, level: 'error', ts: 1_700_000_000_000, text: 'boom' }],
      returnedCount: 1, totalCount: 1, ringTotal: 9, byLevel: { log: 8, error: 1 }, dropped: 0, nextSeq: 9,
    };
    s = await loadDeviceSurface(() => deviceReply(reply));
    const r = await s.call('device_console_logs', { level: 'error' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(s.text(r))).toMatchObject(reply);
  });

  it("a refusal from the op keeps its code (since + sinceMs → AMBIGUOUS)", async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: false, code: 'AMBIGUOUS', error: 'console-logs: pass since OR sinceMs, not both', options: ['since', 'sinceMs'] }));
    const r = await s.call('device_console_logs', { since: 1, sinceMs: 2 });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/AMBIGUOUS/);
  });
});
