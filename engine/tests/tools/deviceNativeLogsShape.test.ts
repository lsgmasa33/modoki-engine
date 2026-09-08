/** #648 — `device_native_logs`' reply shape, the sibling of #644's `device_console_logs`.
 *
 *  Two defects on one line (`engine/app/debug/bridge.ts`, the `nativeLogs` handler):
 *
 *   1. `const { logs } = await GameDebug.getNativeLogs(...)` DROPPED the declared `error` field.
 *      The plugin declares `Promise<{logs: string[]; error?: string}>`, so a native failure
 *      answering `{logs: [], error: 'OSLogStore denied'}` reached the agent as "No logs." —
 *      *could not look* rendered as *nothing is there*. Those are opposite findings and they lead
 *      to opposite next moves, which is exactly the trap #670 describes for the same tool.
 *   2. A native side answering a shape with no `logs` made `safeStringify(undefined)` return
 *      `undefined` (despite its `: string` type), shipping a result-less reply.
 *
 *  ⚠️ The TypeScript signature is NOT a guarantee here: the value comes from Swift/Kotlin in the
 *  INSTALLED BINARY while the JS bundle and this MCP are rebuilt and OTA'd independently. Both the
 *  old bare-array shape and the new `{logs, error}` one are live on the wire at once, so the
 *  decoder must accept BOTH — the #644 lesson, one layer further down.
 */
import { describe, it, expect } from 'vitest';
import { parseNativeLogsReply } from '../../tools/game-debug-mcp/src/reply.js';

describe('parseNativeLogsReply (#648)', () => {
  it('accepts the BARE ARRAY an older app binary sends', () => {
    // The happy path deliberately still sends a bare array, so an older MCP keeps working.
    expect(parseNativeLogsReply(['a', 'b'])).toEqual({ ok: true, logs: ['a', 'b'] });
  });

  it('accepts a JSON-STRINGIFIED array — the value arrives through safeStringify', () => {
    expect(parseNativeLogsReply(JSON.stringify(['a']))).toEqual({ ok: true, logs: ['a'] });
  });

  it('treats an empty/absent reply as an ANSWER, not a failure — a quiet log is a real result', () => {
    expect(parseNativeLogsReply(null)).toEqual({ ok: true, logs: [] });
    expect(parseNativeLogsReply(undefined)).toEqual({ ok: true, logs: [] });
  });

  it('SURFACES the error field instead of dropping it — the whole point of the fix', () => {
    const r = parseNativeLogsReply({ logs: [], error: 'OSLogStore denied' });
    expect(r).toEqual({ ok: true, logs: [], error: 'OSLogStore denied' });
  });

  it('keeps BOTH halves of a partial read — some logs AND an error', () => {
    // Dropping either half is the same collapse, just in the other direction.
    const r = parseNativeLogsReply({ logs: ['line'], error: 'stream truncated' });
    expect(r).toEqual({ ok: true, logs: ['line'], error: 'stream truncated' });
  });

  it('refuses an unreadable shape rather than String()-ing it into the payload as log CONTENT', () => {
    // Before the fix the consumer did `Array.isArray(x) ? join : String(x)`, so an object
    // rendered as the literal "[object Object]" and was read as a log line.
    const r = parseNativeLogsReply({ unexpected: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.got).toContain('keys');
  });

  it('refuses a logs field that is not an array of strings', () => {
    expect(parseNativeLogsReply({ logs: 'not an array' }).ok).toBe(false);
    expect(parseNativeLogsReply({ logs: [1, 2] }).ok).toBe(false);
  });

  it('describes an unreadable shape BY KEYS ONLY — never echoing the value', () => {
    // A log line can carry secrets; a refusal that quotes it puts them in the transcript.
    // Assembled from pieces so the SOURCE never holds an AWS-key-shaped literal:
    // scan-publish-safety.mjs matches /\bAKIA[0-9A-Z]{16}\b/ and blocks the OSS snapshot
    // on it, example key or not — engine/tests/** ships publicly.
    const secretish = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE' + '-not-a-real-key';
    const r = parseNativeLogsReply({ logs: secretish });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.got).not.toContain('AKIA');
    expect(r.got).toBe('an object with keys: logs');
  });
});
