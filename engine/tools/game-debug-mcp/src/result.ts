/** Result shaping for the game-debug MCP server — the device-side twin of
 *  `tools/modoki-mcp/src/result.ts`.
 *
 *  Two flooders live on this server:
 *
 *  - `device_eval` serialized an arbitrary expression result with
 *    `JSON.stringify(result, null, 2)` — pretty-printed and unbounded. `device_eval('document')`
 *    or any large object dumps straight into the transcript.
 *  - `device_screenshot` inlined a full-resolution base64 image, *even when `savePath` was
 *    given* — it wrote the file, opened Preview, and returned the blob anyway. iOS
 *    `drawHierarchy` captures at ~1800px.
 *
 *  (`device_console_logs` / `device_native_logs` already default to `limit: 50`; they were never
 *  the problem, contrary to the audit that prompted this work.)
 *
 *  See `docs/mcp-response-budget.md` Phase 7. */

// The cap, `capText`, `encode` and `isFailureBody` are SHARED with the editor MCP server — one
// implementation, because a rule implemented twice diverges (conventions §9). This file keeps only
// what is genuinely device-specific: eval serialization, screenshots, MIME extensions.
export { isFailureBody } from '../../shared/mcpResult.js';
export { ERROR_CODES, type ErrorCode, type ToolErrorDetail } from '../../shared/mcpResult.js';
import {
  MAX_PAYLOAD_CHARS, capText as sharedCapText, encode, encodeError,
  type ToolErrorDetail,
} from '../../shared/mcpResult.js';

// ── Failures: the §5 envelope, device edition ────────────────────────────────
// `docs/mcp-tool-conventions.md` §5. Before this, every device tool ended in
// `catch (e) { text: `Error: ${e.message}` }` — literally the "it didn't work" shape the audit
// exists to remove. The message that mattered most ("no device connected — connect in the AI
// panel") was in there, but flattened to the same anonymous prose as a wedged socket or a typo'd
// selector, with no code to branch on and no next move spelled out.
//
// This server registers tools directly with `server.tool(...)` (it has no `registerAll` indirection
// like the editor server), so `tool` is passed EXPLICITLY at each site rather than stamped centrally.

export type DeviceResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** The one failure constructor for this server. */
export function deviceFail(detail: ToolErrorDetail): DeviceResult {
  return { content: [{ type: 'text', text: encodeError(detail) }], isError: true };
}

/** Turn a THROWN transport error into an envelope, classified by what actually went wrong.
 *  All three cases used to arrive as the same `Error: <message>` string. */
export function caughtFailure(tool: string, what: string, e: unknown): DeviceResult {
  const msg = e instanceof Error ? e.message : String(e);
  // The backend is up but holds no lease — by far the most common failure, and the only one with a
  // precise remedy. Reported as anonymous prose it read as "the tool is broken".
  if (/no device connected/i.test(msg)) {
    return deviceFail({
      code: 'NOT_AVAILABLE_HERE',
      tool, what,
      why: `Modoki holds no device lease, so there is no device to talk to (${msg}).`,
      options: [
        'the HUMAN connects the device deliberately: editor AI panel → "Connect a Device" (device IP from the debug menu, or adb)',
        'device_connect {ip} / {useAdb:true} opens the lease from here',
        'device_status reports the current lease state',
      ],
    });
  }
  if (/can't reach the modoki backend/i.test(msg)) {
    return deviceFail({
      code: 'NOT_AVAILABLE_HERE',
      tool, what,
      why: msg,
      options: [
        'start this clone\'s editor: engine/scripts/launch-editor.sh games/<id> (it derives THIS clone\'s port — no MODOKI_BACKEND_PORT prefix needed)',
        // Do NOT enumerate the ports here. This line used to read "(main=5179, work-ai=5180,
        // work-ai2=5181)" — written when there were three clones and silently stale from the
        // day a fourth appeared, which is the exact drift #349 was about. Name the one source
        // instead; it cannot go out of date because the launcher reads it too.
        'each clone pins its own backend port (engine/scripts/editorPorts.mjs; docs/clones-and-ports.md § RULE 2) — check MODOKI_BACKEND matches YOUR clone, and trust the launch banner over any table',
      ],
    });
  }
  return deviceFail({
    code: 'NOT_AVAILABLE_HERE',
    tool, what,
    why: `the request to the device failed: ${msg}`,
    options: ['device_status — confirm the lease is still held', 'the device app may have been backgrounded or killed; relaunch it and reconnect'],
  });
}

/** The device answered, but its reply is an `Error: …` STRING rather than a thrown error — a
 *  selector miss, an occluded target, no canvas. A refusal by the op, not a transport failure. */
export function deviceReplyFailure(tool: string, what: string, reply: unknown, options?: string[]): DeviceResult {
  return deviceFail({
    code: 'REFUSED_BY_OP',
    tool, what,
    why: `the device refused: ${String(reply)}`,
    ...(options ? { options } : {}),
  });
}

/** ~15k tokens. Re-exported under the device server's historical name so call sites are unchanged. */
export const MAX_TEXT_CHARS = MAX_PAYLOAD_CHARS;

/** Truncate plain text, saying how much was dropped. */
export function capText(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  return sharedCapText(text, maxChars);
}

/** Serialize a `device_eval` result: compact, bounded, and never `[object Object]`.
 *  Circular structures (`device_eval('window')`) would otherwise throw inside the tool. */
export function encodeEvalResult(result: unknown, maxChars: number = MAX_TEXT_CHARS): string {
  if (result == null) return 'undefined';
  if (typeof result === 'string') return capText(result, maxChars);
  let text: string;
  try {
    text = JSON.stringify(result) ?? String(result);
  } catch (e) {
    // Circular ref, BigInt, etc. Say what happened rather than crashing the tool call.
    return `[unserializable eval result: ${e instanceof Error ? e.message : String(e)}] — return a projection instead, e.g. \`return {w: innerWidth, h: innerHeight}\``;
  }
  return capText(text, maxChars);
}

/** Encode a structured op result (Percept: `scene-state`/`diagnose`/`journal`/…): COMPACT and
 *  bounded, via the shared encoder. A string passes through (a device may hand back a bare reply).
 *
 *  This used to `JSON.stringify(value, null, 2)` and then `capText` the result — two defects the
 *  shared module fixes: the pretty-print paid ~40% indentation overhead on every device Percept
 *  response, and capping JSON by characters MID-SLICES IT, producing a blob that neither
 *  `JSON.parse` nor the model can read. Over the cap the shared encoder emits a valid
 *  `{elided:true, bytes, hint, preview}` envelope instead. */
export function encodeStructuredResult(value: unknown, maxChars: number = MAX_TEXT_CHARS): string {
  if (typeof value === 'string') return capText(value, maxChars);
  try {
    return encode(value, maxChars);
  } catch (e) {
    return `[unserializable result: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/** Pick a file extension from a MIME type, for the auto-save path. */
export function extFor(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg' : 'png';
}

/** How a screenshot is reported when the image is NOT inlined: the caller needs the path
 *  (to open it) and the dimensions (to aim `device_tap`), not 3MB of base64. */
export function describeScreenshot(info: string, savedTo: string, bytes: number): string {
  return `${info} Saved to ${savedTo} (${Math.round(bytes / 1024)} KB). ` +
    `Image not inlined — pass inline:true to embed it in the response.`;
}
