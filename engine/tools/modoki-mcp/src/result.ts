/** How an MCP tool result becomes text — the one choke point every tool flows through.
 *
 *  Response SIZE is a correctness concern here, not an optimization. A tool that returns
 *  40k tokens can be called once before it crowds out the task it was meant to serve; a
 *  tool that returns 2k can be called forty times and actually converge. Measured against
 *  a 135-entity project, a default `get_scene_state` cost ~40k tokens and a default
 *  `get_layout_bounds` ~74k — and roughly 40% of both was PRETTY-PRINT INDENTATION, which
 *  no consumer wants: MCP ships `content[].text` opaquely and the model reads compact JSON
 *  identically. So: compact.
 *
 *  Beyond compaction there is a hard ceiling, because a tool with a bad default (or a
 *  genuinely huge world) must degrade into a HINT rather than a context flood.
 *
 *  The subtle rule, and the reason this file exists instead of a one-line `slice()`:
 *
 *    NEVER MID-SLICE JSON.
 *
 *  `test-smoke.mjs` does `JSON.parse()` on a tool result, and so, in effect, does the
 *  model — a blob cut off at 60,000 characters is unparseable garbage to both. Over the
 *  cap we therefore emit a *valid JSON envelope* that says what was elided, how big it
 *  was, and which filter to reach for. A truncated answer is worse than a small, honest
 *  one that tells you how to ask again.
 *
 *  Full design + phase status: `docs/mcp-response-budget.md`. */

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** ~15k tokens. Chosen so a capped response still leaves room to act on it.
 *  NOTE: pre-Phase-3/4 this fires on the DEFAULT `get_scene_state` / `get_layout_bounds`
 *  (99,570 and 153,455 chars compact). That is intended — the agent gets a hint instead of
 *  a flood. Do not raise the cap to accommodate a bad default; fix the default. */
export const MAX_PAYLOAD_CHARS = 60_000;

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

const narrowHint = (bytes: number, cap: number) =>
  `Response was ${bytes} chars (cap ${cap}). Narrow it: pass a filter ` +
  `(trait=/id=/name=/where=/layer=/ids=) or limit=N, or drop full=1. ` +
  `See this tool's description for the filters it accepts.`;

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

/** Build `ok`/`err` bound to a live identity-warning source.
 *
 *  The warning is prepended OUTSIDE the cap on purpose. It says "you are driving the other
 *  clone's editor", which makes every other byte in the result a lie — it is the one thing
 *  that must never be the part that gets truncated. */
export function createFormatter(getWarning: () => string | null) {
  const banner = (text: string) => {
    const w = getWarning();
    return w ? `${w}\n\n${text}` : text;
  };
  return {
    banner,
    ok: (data: unknown): ToolResult => ({ content: [{ type: 'text', text: banner(encode(data)) }] }),
    /** Error messages are interpolated from backend bodies (`backend 500: {…}`), which are
     *  unbounded — a 500 that echoes a scene or a stack would otherwise flood the transcript. */
    err: (msg: string): ToolResult => ({ content: [{ type: 'text', text: banner(capText(msg)) }], isError: true }),
  };
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
  const b = body as { ok?: unknown; errors?: unknown; error?: unknown };
  if (b.ok === true) return null; // the route says it succeeded — believe its explicit verdict
  const errors = Array.isArray(b.errors) ? b.errors.filter((e) => typeof e === 'string') : [];
  const hasError = typeof b.error === 'string' && b.error !== '';
  if (b.ok !== false && errors.length === 0 && !hasError) return null;
  const detail = errors.length ? errors.join('; ') : hasError ? (b.error as string) : 'the operation reported ok:false';
  // Keep the whole body: callers diagnose with `changed`/`warnings`/`hint` — notably the
  // scene-mutate `hint` that explains an unsaved live-world entity.
  return `${detail}\n\nfull response: ${JSON.stringify(body)}`;
}
