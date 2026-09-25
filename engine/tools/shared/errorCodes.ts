/** The §5 error-code set (`docs/mcp-tool-conventions.md` §5), the ONE membership test over it, and
 *  the ONE test of whether a reply body is a failure (`isFailureBody`).
 *
 *  Split out of `mcpResult.ts` (#1561) so the agent bridge — which ships to devices — can ask the
 *  same question without importing the MCP result formatter: `engine/app` imports `tools/shared` by
 *  value only for small, dependency-free modules (`bridgeHelpers.ts`' #648 note). `mcpResult.ts`
 *  re-exports both, so the servers' imports are unchanged. Keep this file import-free. */

/** The CLOSED set of failure codes. Extend deliberately — a new code is a claim that the caller
 *  should react differently, so if the reaction is the same as an existing code, reuse it. */
export const ERROR_CODES = [
  'UNKNOWN_PARAM',      // a parameter the tool does not accept (a typo is a different operation)
  'AMBIGUOUS',          // the aim matched more than one target — never first-match silently
  'NOT_FOUND',          // the named target does not exist
  'AMBIGUOUS_SURFACE',  // on screen in several viewports; `surface` is required
  'OCCLUDED',           // the target is covered, so the input would land elsewhere
  'REFUSED_BY_OP',      // the operation itself declined (incl. a no-op the caller asked to change)
  'NO_RENDERER',        // nothing is rendering, so there is no live state to read or drive
  'TIMEOUT',            // no answer in time — the editor may be busy or wedged
  'TOO_LARGE',          // the answer exists but exceeds the response budget; narrow it
  'REQUIRES_SAVE',      // live-world work is not on disk and this reads the file
  'NOT_AVAILABLE_HERE', // could not look (auth/network/route absent) — NOT "nothing is there"
  'PARTIAL',            // some of the work succeeded; a failure unless the tool documents it
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The §5 code the REPLY named, or `fallback` when it named none.
 *
 *  ⚠️ **A layer relays the classification it was handed; it never invents one.** That rule has been
 *  broken at four separate hops and fixed four times (#1012 ops threw plain Errors so the route
 *  named the code; #1070 the same hop again; #1013 `/api/eval`'s bare 504; #1223 P3 the device
 *  wire, which is what `deviceRefusal.ts` exists for). #1211 is the fifth: this function lived
 *  INSIDE `modoki-mcp/src/context.ts`, so the editor MCP relayed codes correctly and the device MCP
 *  — which cannot import it — hard-coded `REFUSED_BY_OP` at every envelope site. It lives here now
 *  because `shared/` is the one module both servers already import (§9).
 *
 *  `fallback` is whatever the call site would have used anyway, so a body with no `code` — or a
 *  junk value outside the closed set — is unaffected. */
export function codeFromBody(body: unknown, fallback: ErrorCode): ErrorCode {
  if (body && typeof body === 'object') {
    const c = (body as { code?: unknown }).code;
    if (typeof c === 'string' && (ERROR_CODES as readonly string[]).includes(c)) return c as ErrorCode;
  }
  return fallback;
}

/**
 * A 200 that says the operation DIDN'T HAPPEN is a FAILURE — describe it, else null. (C7)
 *
 * Our routes answer "I refused / nothing matched" with HTTP 200 + `{ok:false, errors:[…]}`,
 * so an MCP client keying only off `status >= 400` reported those to Claude as SUCCESSFUL
 * tool calls with the bad news buried in a JSON field. The C7 audit found that shape across
 * the surface: `scene-mutate` changing nothing, `persistAsset` when the disk write was
 * rejected, `save_all` on cancel. An agent that cannot see a failure builds on it — the
 * worst outcome for an agent-first engine.
 *
 * `ok` is a success FLAG throughout the backend, never an answer (`validate_scene` reports
 * its findings in `warnings`), so this cannot misfire on a legitimate negative result.
 * Returns the message to fail with, or null when the body claims no failure.
 *
 * An EXPLICIT `ok:true` WINS over a non-empty `errors[]`: it is the route's own verdict, and
 * `errors[]` is not always a failure flag. `/api/reimport` deliberately answers 200 with
 * `{converted, skipped, errors}` on PARTIAL success (500 only when NOTHING converted) — its
 * `errors[]` names the assets that failed while N others were re-baked, and the tool's own
 * description advertises that shape. Failing the whole call there would report a successful
 * 20-of-21 bake as a failed tool call. (The original C7 pass verified "ok is a success flag"
 * but keyed off THREE fields — the invariant was asserted over a narrower surface than the
 * code enforced. Same bug class, one layer down.)
 */
export function isFailureBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as { ok?: unknown; errors?: unknown; error?: unknown; reason?: unknown };
  if (b.ok === true) return null; // the route says it succeeded — believe its explicit verdict
  const errors = Array.isArray(b.errors) ? b.errors.filter((e) => typeof e === 'string') : [];
  const hasError = typeof b.error === 'string' && b.error !== '';
  // `reason` too: the journal/watch capture ops answer a refusal as `{ok:false, reason:'…'}`, and
  // reading only `error` demoted their one useful sentence to "the operation reported ok:false".
  const hasReason = typeof b.reason === 'string' && b.reason !== '';
  if (b.ok !== false && errors.length === 0 && !hasError) return null;
  const detail = errors.length ? errors.join('; ')
    : hasError ? (b.error as string)
      : hasReason ? (b.reason as string)
        : 'the operation reported ok:false';
  // Keep the whole body: callers diagnose with `changed`/`warnings`/`hint` — notably the
  // scene-mutate `hint` that explains an unsaved live-world entity.
  return `${detail}\n\nfull response: ${JSON.stringify(body)}`;
}
