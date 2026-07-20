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

/** ~15k tokens, matching the modoki-mcp cap. */
export const MAX_TEXT_CHARS = 60_000;

/** Truncate plain text, saying how much was dropped. */
export function capText(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[${text.length - maxChars} chars elided of ${text.length}]`;
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

/** Encode a structured op result (Percept: `scene-state`/`diagnose`/`journal`/…) as pretty, bounded
 *  JSON. The ops are already summary-first (index mode, tails, per-field stats), so the cap is a
 *  backstop, not the primary limiter. A string passes through (a device may hand back a bare reply). */
export function encodeStructuredResult(value: unknown, maxChars: number = MAX_TEXT_CHARS): string {
  if (typeof value === 'string') return capText(value, maxChars);
  try {
    return capText(JSON.stringify(value, null, 2) ?? String(value), maxChars);
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
