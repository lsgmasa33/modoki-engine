/** A device refusal that keeps its §5 code across the device bridge's STRING protocol (#1223 P3).
 *
 *  The device bridge signals failure by RETURNING `Error: <message>` — never by throwing, never as an
 *  object — and every reader on the path keys on that prefix: the device MCP's `isDeviceError`, the
 *  backend's `isDeviceFailureReply`, and `decodeAimReply`'s string branch. So a refusal cannot turn
 *  into an object without an older reader reporting it as a SUCCESS (the MCP server is long-lived and
 *  versions independently of the app on the phone — #644's skew). It stays a string that starts with
 *  `Error:`.
 *
 *  What the string could not carry was the part that unblocks the caller: an entity aim on the
 *  device resolves through the same `resolveEntityAddress` as the editor, which names `NOT_FOUND` +
 *  `stale`, `AMBIGUOUS` + the guids, `REFUSED_BY_OP` + the guid to use instead of an id — and every
 *  device refusal still reached the agent as a generic `REFUSED_BY_OP` with that detail flattened
 *  into prose. This module puts those fields in ONE trailing line, machine-delimited, so the MCP reads
 *  them structurally (§5 rider 3: classify by structure, never by message) while an older reader just
 *  shows one extra line of text.
 *
 *  The tail is the LAST line on purpose: the backend's synthetic-input banner is a PREFIX, so the
 *  tail survives it. Dependency-free, like `errorCodes.ts`, so the page, the backend and the MCP all
 *  import this one copy (§9). */

import { ERROR_CODES, type ErrorCode } from './errorCodes.js';

/** The structured half of a refusal. `error` is the whole `Error: …` message. */
export interface DeviceRefusal {
  error: string;
  code?: ErrorCode;
  /** The real choices (§5) — an ambiguous name's guids, the guid to use instead of an id. */
  options?: string[];
  /** Why a runtime guid missed (`'despawned'` | `'world-swapped'`), on a `NOT_FOUND` (#1223 D4). */
  stale?: string;
}

/** Marks the trailing machine line. Bracketed and namespaced so no message of ours can end in it. */
export const DEVICE_REFUSAL_TAIL = '[modoki-refusal]';

/** Render a refusal as the device's `Error:` string, with the structured fields as a tail line when
 *  there are any. A refusal with none renders exactly as it did before this module existed. */
export function encodeDeviceRefusal(r: DeviceRefusal): string {
  const message = r.error.startsWith('Error:') ? r.error : `Error: ${r.error}`;
  const fields = {
    ...(r.code ? { code: r.code } : {}),
    ...(r.options && r.options.length ? { options: r.options } : {}),
    ...(r.stale ? { stale: r.stale } : {}),
  };
  return Object.keys(fields).length ? `${message}\n${DEVICE_REFUSAL_TAIL}${JSON.stringify(fields)}` : message;
}

/** Read a device failure reply back into its parts. `message` is the text without the tail; the
 *  structured fields are present only when a well-formed tail carried them. An unknown code is
 *  dropped rather than trusted — the closed set is the contract (§5). */
export function decodeDeviceRefusal(reply: string): { message: string; code?: ErrorCode; options?: string[]; stale?: string } {
  const at = reply.lastIndexOf(`\n${DEVICE_REFUSAL_TAIL}`);
  if (at < 0) return { message: reply };
  let parsed: unknown;
  try { parsed = JSON.parse(reply.slice(at + 1 + DEVICE_REFUSAL_TAIL.length)); } catch { return { message: reply }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: reply };
  const o = parsed as { code?: unknown; options?: unknown; stale?: unknown };
  const code = typeof o.code === 'string' && (ERROR_CODES as readonly string[]).includes(o.code) ? o.code as ErrorCode : undefined;
  const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string' && !!x) : [];
  return {
    message: reply.slice(0, at),
    ...(code ? { code } : {}),
    ...(options.length ? { options } : {}),
    ...(typeof o.stale === 'string' && o.stale ? { stale: o.stale } : {}),
  };
}

/** Is this device reply a failure? The bridge's `Error:`/`Unknown method:` sentinel — found at the
 *  START of the reply, or at the start of the line after the backend's synthetic-input banner, which
 *  is prepended to whatever the synthetic handler answered. Judging only the first character of the
 *  composed string reported a refused synthetic tap as `Tapped — ⚠️ SYNTHETIC INPUT … Error: …`, ok. */
export function isDeviceFailureText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (startsFailure(v)) return true;
  if (!v.startsWith(SYNTHETIC_BANNER_OPENING)) return false;
  const nl = v.indexOf('\n');
  return nl >= 0 && startsFailure(v.slice(nl + 1));
}

const startsFailure = (s: string) => s.startsWith('Error:') || s.startsWith('Unknown method:');
/** The backend's `synthFallbackBanner` opens with this — `engine/plugins/backend/deviceCdp.ts`,
 *  which builds its banner from this constant so the two cannot drift, and folds any newline in its
 *  reason so the WHOLE banner is one line (pinned in `deviceCdp.test.ts`). */
export const SYNTHETIC_BANNER_OPENING = '⚠️ SYNTHETIC INPUT (NOT TRUSTED)';
