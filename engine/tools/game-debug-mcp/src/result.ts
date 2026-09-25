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
export { isFailureBody, codeFromBody, optionsFromBody, codeFromStatus } from '../../shared/mcpResult.js';
export { ERROR_CODES, type ErrorCode, type ToolErrorDetail } from '../../shared/mcpResult.js';
import {
  MAX_PAYLOAD_CHARS, capText as sharedCapText, encode, encodeError,
  type ToolErrorDetail,
} from '../../shared/mcpResult.js';
import { decodeDeviceRefusal } from '../../shared/deviceRefusal.js';
import { codeFromBody, optionsFromBody, codeFromStatus } from '../../shared/mcpResult.js';

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

/** A backend call that did not return a usable answer.
 *
 *  ⚠️ It carries the STATUS and the BODY, and that is the whole point: without them every backend
 *  refusal reached `caughtFailure` as bare prose and left as `NOT_AVAILABLE_HERE` — "the app may
 *  have been backgrounded or killed; relaunch it" — including a 409 the caller could have cleared
 *  in one call (#1211 C-4). A message alone cannot be classified; a status can. */
export class BackendError extends Error {
  // Plain fields, not parameter properties: the root tsconfig sets `erasableSyntaxOnly`, under
  // which `constructor(readonly status?: number)` is a syntax error — and the per-package tsc does
  // not set it, so that spelling typechecks locally and fails only at the gate.
  status?: number;
  body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The backend ANSWERED 2xx, but not in a shape this MCP can read (#1313, §9-bis). The editor
 *  backend versions independently of this process, and a host that does not serve the route can
 *  answer 200 with an HTML page. Neither case is an empty answer, so it is reported as "could not read", never
 *  decoded into one. Deliberately NOT a `BackendError`: it has no status to classify. */
export class BackendShapeError extends Error {
  path: string;
  got: string;
  /** The route RAN: a POST answered with JSON this build cannot read. The request may already have
   *  changed state, so the refusal must not read as "safe to retry" (§9-bis — `/api/scene-mutate`
   *  double-applied a write that way). A non-JSON body came from something that is not the route, so
 *  nothing ran. */
  mayHaveApplied: boolean;
  constructor(path: string, got: string, mayHaveApplied: boolean) {
    super(`the editor answered ${path} with a shape this MCP cannot read (${got})`);
    this.path = path;
    this.got = got;
    this.mayHaveApplied = mayHaveApplied;
  }
}

/** Turn a THROWN transport error into an envelope, classified by what actually went wrong.
 *  They all used to arrive as the same `Error: <message>` string. */
export function caughtFailure(tool: string, what: string, e: unknown): DeviceResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof BackendShapeError) {
    return deviceFail({
      code: 'NOT_AVAILABLE_HERE',
      tool, what,
      why: `${msg} — this is NOT an empty answer; nothing could be read.`
        + (e.mayHaveApplied ? ' The request DID reach the editor, so if this call changes state it may already have applied.' : ''),
      options: [
        ...(e.mayHaveApplied ? ['if this call changes state, do not retry blindly — the request reached the editor, so check whether it already applied'] : []),
        'restart the editor — its backend and this MCP are from different builds',
      ],
    });
  }
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
        // #1558: listing devices + claims needs no editor, and 20 of 120 agents refused here fell
        // back to raw `adb devices`/devicectl — which show no claims (#285's bypass). Name the
        // claim-aware CLI FIRST, so the natural next move keeps the claims in view.
        ...(tool === 'device_list' ? ['`npm run device:list` lists the attached devices AND their claims with no editor running — use it rather than raw adb/devicectl, which show no claims'] : []),
        'start this clone\'s editor: engine/scripts/launch-editor.sh games/<id> (it derives THIS clone\'s port — no MODOKI_BACKEND_PORT prefix needed)',
        // Do NOT enumerate the ports here. This line used to read "(main=5179, work-ai=5180,
        // work-ai2=5181)" — written when there were three clones and silently stale from the
        // day a fourth appeared, which is the exact drift #349 was about. Name the one source
        // instead; it cannot go out of date because the launcher reads it too.
        'each clone pins its own backend port (engine/scripts/editorPorts.mjs; docs/clones-and-ports.md § RULE 2) — check MODOKI_BACKEND matches YOUR clone, and trust the launch banner over any table',
      ],
    });
  }
  // ⚠️ AFTER the two transport cases above, deliberately. The lease relay answers "no device
  // connected" as an HTTP failure, so classifying by status first turned the most common failure on
  // this surface — no lease — into REFUSED_BY_OP and dropped the three options that say how a HUMAN
  // connects one. Status classification is for a backend that answered ABOUT THE OP.
  // A backend that ANSWERED — 4xx/5xx with a body — is classified from what it said, exactly as the
  // editor MCP classifies its own (`codeFromStatus` is shared between them). Only a backend that
  // could not be reached at all falls through to the transport cases below. Before this, a 409 read
  // as "relaunch the app" (#1211 C-4).
  if (e instanceof BackendError && typeof e.status === 'number') {
    // The body's own `error`, never `msg`: `backendGet` defaults an empty body's message to
    // "HTTP 404", which `codeFromStatus` would read as a real detail and call NOT_FOUND — where the
    // editor MCP (and the truth: nobody answered for that route) says NOT_AVAILABLE_HERE.
    const detail = e.body && typeof e.body === 'object' && typeof (e.body as { error?: unknown }).error === 'string'
      ? (e.body as { error: string }).error : undefined;
    const bodyOptions = optionsFromBody(e.body);
    // ⚠️ A 5xx is still "the request could not be completed" — the device relay answers every
    // transport failure and timeout as 502, connect/disconnect every failure as 500 — so it keeps
    // the transport advice unless the backend named better. Only a 4xx is the caller's to fix.
    const serverSide = e.status >= 500;
    return deviceFail({
      code: codeFromBody(e.body, codeFromStatus(e.status, detail)),
      tool, what,
      why: serverSide
        ? `the request to the device failed (HTTP ${e.status}): ${msg}`
        : `the backend refused with HTTP ${e.status}: ${msg}`,
      ...(e.body !== undefined ? { got: e.body } : {}),
      ...(bodyOptions ? { options: bodyOptions } : serverSide ? { options: TRANSPORT_OPTIONS } : {}),
    });
  }
  // The backend is up but holds no lease — by far the most common failure, and the only one with a
  // precise remedy. Reported as anonymous prose it read as "the tool is broken".
  return deviceFail({
    code: 'NOT_AVAILABLE_HERE',
    tool, what,
    why: `the request to the device failed: ${msg}`,
    options: TRANSPORT_OPTIONS,
  });
}

const TRANSPORT_OPTIONS = ['device_status — confirm the lease is still held', 'the device app may have been backgrounded or killed; relaunch it and reconnect'];

/** The device answered, but its reply is an `Error: …` STRING rather than a thrown error — a
 *  selector miss, an occluded target, no canvas. A refusal by the op, not a transport failure. */
export function deviceReplyFailure(tool: string, what: string, reply: unknown, options?: string[]): DeviceResult {
  // The refusal's own code/options/stale when the device named them (`deviceRefusal.ts`, #1223 P3):
  // an entity aim knows NOT_FOUND from AMBIGUOUS from OCCLUDED, and its options are the real
  // choices (the guids), which beat this call site's generic advice. An older app build sends no
  // tail and lands on the generic refusal, as before.
  const r = decodeDeviceRefusal(String(reply));
  return deviceFail({
    code: r.code ?? 'REFUSED_BY_OP',
    tool, what,
    why: `the device refused: ${r.message}`,
    ...(r.stale ? { got: { stale: r.stale } } : {}),
    ...(r.options ? { options: r.options } : options ? { options } : {}),
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
