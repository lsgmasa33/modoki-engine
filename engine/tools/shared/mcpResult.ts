/** Result shaping shared by BOTH MCP servers — `modoki-mcp` (editor) and `game-debug-mcp`
 *  (device). One implementation, because a rule implemented twice diverges
 *  (`docs/mcp-tool-conventions.md` §9).
 *
 *  It already had. The device copy of this file was 64 lines to the editor's 136, and the two had
 *  drifted into disagreeing about things this module treats as correctness, not style:
 *
 *  - **Pretty-printing.** `encodeStructuredResult` used `JSON.stringify(v, null, 2)`, so every
 *    device Percept response paid the ~40% indentation overhead the editor side exists to avoid.
 *    MCP ships `content[].text` opaquely; the model reads compact JSON identically.
 *  - **Mid-slicing JSON.** It capped structured payloads with `capText`, i.e. cut JSON at N chars.
 *    A blob severed mid-object is unparseable garbage to a `JSON.parse` and to the model alike —
 *    the exact failure the `{elided:true,…}` envelope below exists to prevent.
 *  - **`isFailureBody`.** The device server had no equivalent at all, so a 200 answering
 *    `{ok:false, error}` was reported to the agent as a SUCCESSFUL tool call across all six device
 *    Percept tools — the C7 class, fixed on the editor side and silently unfixed here.
 *
 *  Response SIZE is a correctness concern, not an optimization: a tool that returns 40k tokens can
 *  be called once before it crowds out the task it was meant to serve.
 *
 *  Keep this module dependency-free (no MCP SDK, no zod) so both packages can import it directly
 *  and it stays unit-testable. Full design: `docs/mcp-response-budget.md`.
 */

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** ~15k tokens. Chosen so a capped response still leaves room to act on it.
 *  NOTE: pre-Phase-3/4 this fires on the DEFAULT `get_scene_state` / `get_layout_bounds`
 *  (99,570 and 153,455 chars compact). That is intended — the agent gets a hint instead of
 *  a flood. Do not raise the cap to accommodate a bad default; fix the default. */
export const MAX_PAYLOAD_CHARS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// The error envelope (`docs/mcp-tool-conventions.md` §5)
//
// "It didn't work" is a bug by definition. Every failure has to name what was attempted, why it
// failed, and what to do instead — a refusal that lists the real options converts a dead end into
// the caller's next move, which is the single highest-value thing this surface produces.
//
// Why STRUCTURED rather than a well-written sentence: prose cannot be asserted on. The audit found
// the same failure reported four different ways across the surface, and no test could tell a
// deliberate refusal from a wedged renderer because both arrived as free text. A closed code set
// gives tests (and the reader) a stable spine, while `what`/`why`/`options` carry the specifics.
// ─────────────────────────────────────────────────────────────────────────────

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

export type ToolErrorDetail = {
  code: ErrorCode;
  /** Which tool refused. Filled in centrally at registration when a call site omits it. */
  tool?: string;
  /** What was attempted, in the CALLER's terms — not the internal route. */
  what: string;
  /** The actual cause. */
  why: string;
  /** What was received, when that is the point (a bad value, an echoed backend body). */
  got?: unknown;
  /** The shape or values that would work. */
  expected?: string;
  /** The real choices, when there is a finite set. This is the field that unblocks the caller. */
  options?: string[];
  /** Char budget for `got`. Defaults to 8k; pass MAX_PAYLOAD_CHARS when `got` is a payload the
   *  caller has already bounded deliberately (see GOT_CHARS). */
  gotBudget?: number;
};

/** Attached to a failing `ToolResult` so the tool name can be stamped in centrally without
 *  re-parsing the rendered text (which may carry an identity banner in front of the JSON).
 *  A SYMBOL on purpose: `JSON.stringify` and the MCP transport both drop it, so it cannot leak
 *  into the wire result or trip the SDK's result-schema validation. */
export const ERROR_DETAIL = Symbol.for('modoki.errorDetail');

/** Per-field budget inside an envelope. An echoed backend body is the usual bloat source, and an
 *  envelope must NEVER be the thing that gets elided — the code and the options are the payload. */
/** `got` is usually an echoed backend body, where 8k is generous. But a caller can pass a payload
 *  it has ALREADY bounded for the reader — `modoki_batch` hands over a per-step report that
 *  `reportBatch` shrank to fit MAX_PAYLOAD_CHARS, preserving the failing step's error on purpose —
 *  and re-cutting that at 8k threw away exactly what the earlier work protected. `gotBudget` lets
 *  such a caller opt into the full payload budget; everything else keeps the tighter default. */
const GOT_CHARS = 8_000;
const TEXT_CHARS = 4_000;

/** Render an error envelope to compact JSON text. Bounded field-by-field rather than as a whole,
 *  so an oversized `got` can never cost the reader the `code`/`why`/`options`. */
export function encodeError(detail: ToolErrorDetail): string {
  const got = detail.got === undefined ? undefined : boundedGot(detail.got, detail.gotBudget ?? GOT_CHARS);
  return JSON.stringify({
    error: {
      code: detail.code,
      tool: detail.tool,
      what: capText(detail.what, TEXT_CHARS),
      why: capText(detail.why, TEXT_CHARS),
      ...(got === undefined ? {} : { got }),
      ...(detail.expected === undefined ? {} : { expected: capText(detail.expected, TEXT_CHARS) }),
      ...(detail.options === undefined ? {} : { options: detail.options }),
    },
  });
}

/** `got` STAYS STRUCTURED when it fits.
 *
 *  The first cut of this stringified every object `got` and then capped the string, which meant an
 *  object arrived as a JSON blob nested inside JSON — the caller had to parse twice to reach it. The
 *  live smoke caught it on `modoki_batch`, whose `got` IS the per-step report: `error.got.failedAt`
 *  was unreachable without a second `JSON.parse`. An envelope that makes its own payload harder to
 *  read defeats the point of having a shape. */
function boundedGot(v: unknown, budget: number = GOT_CHARS): unknown {
  if (typeof v === 'string') return capText(v, budget);
  const text = JSON.stringify(v);
  if (text === undefined) return String(v);
  if (text.length <= budget) return v;
  // Too big to embed: a shallow shape report, never a severed blob (same rule as `encode`).
  return { elided: true, bytes: text.length, preview: summarize(v) };
}

/** Read back the detail attached to a failing result, if any. */
export function errorDetailOf(result: ToolResult): ToolErrorDetail | undefined {
  return (result as { [ERROR_DETAIL]?: ToolErrorDetail })[ERROR_DETAIL];
}

/** A shallow, cheap description of what the caller WOULD have received. Deliberately dumb:
 *  it must never itself be large, so it reports shapes and counts, never values. */
export function summarize(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return describe(data);
  if (Array.isArray(data)) return `array(${data.length})`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = describe(v);
  return out;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object(${Object.keys(v as object).length} keys)`;
  if (typeof v === 'string') return v.length > 40 ? `string(${v.length})` : JSON.stringify(v);
  return String(v);
}

/** The over-cap hint. `filters` are the CALLED TOOL's real narrowing params when the caller knows
 *  them (see `retargetNarrowHint`); without them it falls back to the generic list.
 *
 *  S3.21 — the fallback list is `get_scene_state`'s. Sent to every tool it advertised parameters
 *  the tool does not accept, so a capped `modoki_get_console_logs` (level/limit/since) or
 *  `modoki_list_assets` (type/folder/name/all) was told to "pass trait=/where=/layer=" — which its
 *  own strict schema then refuses. A hint naming a dead end reads as the agent's mistake. */
const narrowHint = (bytes: number, cap: number, filters?: readonly string[]) =>
  `Response was ${bytes} chars (cap ${cap}). Narrow it: ` +
  (filters?.length
    ? `this tool's filters are ${filters.join('=/')}=. `
    : `pass a filter (trait=/id=/name=/where=/layer=/ids=) or limit=N, or drop full=1. ` +
      `See this tool's description for the filters it accepts.`);

/** Rewrite an over-cap `{elided:true,…}` envelope's `hint` to name the CALLING tool's own filters.
 *
 *  Done as a post-pass rather than by threading a tool name through the transport on purpose:
 *  `ok()` is bound once per context and every tool's payload flows through the same
 *  `getJson`/`postJson` helpers, so there is no per-call slot to put a name in that would survive
 *  interleaved MCP calls (the same reason `ERROR_DETAIL` is a symbol on the result rather than a
 *  module-level "current tool"). This runs in `createToolDef`, which is the one place that knows
 *  both the tool name and its result.
 *
 *  Conservative by construction: it only touches text that parses as an elided envelope with a
 *  hint, and it preserves any identity-warning banner in front of the JSON. Anything else is
 *  returned unchanged. */
export function retargetNarrowHint(text: string, filters: readonly string[]): string {
  if (!filters.length || !text.includes('"elided":true')) return text;
  // The banner (`${warning}\n\n${payload}`) is prepended OUTSIDE the cap, so the payload is the
  // LAST blank-line-separated segment.
  const cut = text.lastIndexOf('\n\n');
  const prefix = cut === -1 ? '' : text.slice(0, cut + 2);
  const payload = cut === -1 ? text : text.slice(cut + 2);
  let parsed: { elided?: boolean; bytes?: number; hint?: string } | undefined;
  try { parsed = JSON.parse(payload) as typeof parsed; } catch { return text; }
  if (!parsed || parsed.elided !== true || typeof parsed.hint !== 'string') return text;
  return prefix + JSON.stringify({
    ...parsed,
    hint: narrowHint(parsed.bytes ?? 0, MAX_PAYLOAD_CHARS, filters),
  });
}

/** Serialize a tool payload to text, compact, and bounded.
 *  - `string` payloads (build logs, plain messages) truncate with a trailing note; they are
 *    not JSON, so there is no envelope to preserve.
 *  - everything else is compact JSON; over the cap it becomes a valid `{elided:true,…}`
 *    envelope carrying counts + a hint instead of a severed blob. */
export function encode(data: unknown, maxChars: number = MAX_PAYLOAD_CHARS): string {
  if (typeof data === 'string') return capText(data, maxChars);
  const text = JSON.stringify(data);
  // `undefined` (and other non-serializable roots) stringify to undefined, not a string.
  if (text === undefined) return String(data);
  if (text.length <= maxChars) return text;
  return JSON.stringify({
    elided: true,
    bytes: text.length,
    hint: narrowHint(text.length, maxChars),
    preview: summarize(data),
  });
}

/** Truncate a plain-text payload (never JSON — see `encode`). */
export function capText(text: string, maxChars: number = MAX_PAYLOAD_CHARS): string {
  if (text.length <= maxChars) return text;
  const note = `\n…[${text.length - maxChars} chars elided of ${text.length}]`;
  return text.slice(0, maxChars) + note;
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
