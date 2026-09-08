/** #644: `device_console_logs` failed on every call against a live, healthy lease with
 *  `NOT_AVAILABLE_HERE — result.map is not a function`. Root cause: this MCP server is a
 *  LONG-LIVED process (started once per session, does not pick up a rebuilt tree), so a session
 *  straddling `6f5e81b48` (which changed `handleConsoleLogs`'s reply from a bare array to
 *  `{logs, dropped}`) ran the OLD parser — a blind `{logs, dropped} = parseReply(raw)` destructure
 *  followed by `.map(...)` — against a device on the NEW shape (or vice versa). The throw landed
 *  in `caughtFailure`, which misclassified it as a TRANSPORT failure and offered the wrong
 *  remedies ('device_status — confirm the lease is still held', 'relaunch the app').
 *
 *  Two layers: direct unit tests on `parseConsoleLogsReply` (`reply.ts`), and tests through the
 *  real `device_console_logs` handler via the stub-backend harness (`deviceSurface.ts`), following
 *  the pattern in `devicePointerAndType.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { parseConsoleLogsReply } from '../../tools/game-debug-mcp/src/reply';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

describe('parseConsoleLogsReply', () => {
  it('current shape: {logs, dropped}', () => {
    const entry = { level: 'log', args: ['hi'], timestamp: 1000 };
    expect(parseConsoleLogsReply({ logs: [entry], dropped: 2 })).toEqual({ ok: true, logs: [entry], dropped: 2 });
  });

  it('current shape as a JSON string (the device safeStringify convention)', () => {
    const entry = { level: 'warn', args: ['careful'], timestamp: 2000 };
    const raw = JSON.stringify({ logs: [entry], dropped: 0 });
    expect(parseConsoleLogsReply(raw)).toEqual({ ok: true, logs: [entry], dropped: 0 });
  });

  it('{logs, dropped} with dropped absent (an older-but-object bridge) defaults dropped to 0', () => {
    const entry = { level: 'log', args: ['x'], timestamp: 3000 };
    expect(parseConsoleLogsReply({ logs: [entry] })).toEqual({ ok: true, logs: [entry], dropped: 0 });
  });

  it('the pre-6f5e81b48 bare-array shape', () => {
    const entries = [{ level: 'error', args: ['boom'], timestamp: 4000 }];
    expect(parseConsoleLogsReply(entries)).toEqual({ ok: true, logs: entries, dropped: 0 });
  });

  it('the bare-array shape as a JSON string', () => {
    const entries = [{ level: 'info', args: ['ok'], timestamp: 5000 }];
    expect(parseConsoleLogsReply(JSON.stringify(entries))).toEqual({ ok: true, logs: entries, dropped: 0 });
  });

  it('null/undefined — a quiet ring is an ANSWER, not a failure', () => {
    expect(parseConsoleLogsReply(null)).toEqual({ ok: true, logs: [], dropped: 0 });
    expect(parseConsoleLogsReply(undefined)).toEqual({ ok: true, logs: [], dropped: 0 });
  });

  it('an unrecognised shape (a bare number) is reported as a shape mismatch', () => {
    const r = parseConsoleLogsReply(42);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.got).toBe('a number');
  });

  it('an unrecognised shape (a non-array logs field) is reported as a shape mismatch', () => {
    const r = parseConsoleLogsReply({ logs: 'not an array', dropped: 0 });
    expect(r.ok).toBe(false);
  });

  it('an unrecognised shape (a bare object with no logs) is reported as a shape mismatch', () => {
    const r = parseConsoleLogsReply({ foo: 1 });
    expect(r.ok).toBe(false);
  });

  it('the "got" shape description names the SHAPE, never the CONTENT — a log line can carry secrets', () => {
    const r = parseConsoleLogsReply({ oops: 'SECRET-TOKEN-VALUE' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.got).toMatch(/oops/);
      expect(r.got).not.toMatch(/SECRET-TOKEN-VALUE/);
    }
  });
});

describe('device_console_logs (through the real tool handler)', () => {
  let s: DeviceSurface | undefined;
  afterEach(() => { s?.restore(); s = undefined; });

  it('the current {logs, dropped:0} shape renders the log lines', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ logs: [{ level: 'log', args: ['hello', 'world'], timestamp: 0 }], dropped: 0 })
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toMatch(/\[log\] hello world/);
  });

  it('a bare array (the OLD bridge) renders the same lines and does NOT error — this is the regression', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply([{ level: 'error', args: ['boom'], timestamp: 0 }])
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toMatch(/\[error\] boom/);
  });

  it('dropped: 3 appends the gap note', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ logs: [{ level: 'log', args: ['x'], timestamp: 0 }], dropped: 3 })
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toMatch(/3 earlier entries dropped between the boot log and this window/);
  });

  it('an unrecognised shape returns isError:true, names the restart-the-MCP-server remedy, and drops the wrong ones', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply(42)
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBe(true);
    const text = s.text(r);
    expect(text).toMatch(/restart the MCP server/);
    expect(text).not.toMatch(/backgrounded/);
    expect(text).not.toMatch(/lease is still held/);
  });

  it('an empty ring ({logs:[],dropped:0}) returns "No console logs." with isError falsy', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ logs: [], dropped: 0 })
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toBe('No console logs.');
  });

  it('an empty ring reported as null returns "No console logs." with isError falsy', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply(null)
      : undefined);
    const r = await s.call('device_console_logs', {});
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toBe('No console logs.');
  });
});
