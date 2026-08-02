/** Result formatting for the editor MCP server.
 *
 *  The PRIMITIVES now live in `engine/tools/shared/mcpResult.ts`, shared with the device MCP
 *  server so the two cannot drift again (`docs/mcp-tool-conventions.md` §9 — they already had:
 *  the device copy pretty-printed, mid-sliced JSON, and had no `isFailureBody` at all).
 *
 *  What stays here is the one thing that is genuinely editor-specific: the formatter bound to the
 *  live identity warning. Re-exported below so existing importers are unchanged.
 */

export {
  MAX_PAYLOAD_CHARS,
  ERROR_CODES,
  ERROR_DETAIL,
  encode,
  encodeError,
  errorDetailOf,
  capText,
  summarize,
  retargetNarrowHint,
  isFailureBody,
  type ToolResult,
  type ErrorCode,
  type ToolErrorDetail,
} from '../../shared/mcpResult.js';

import {
  encode, encodeError, ERROR_DETAIL,
  type ToolResult, type ToolErrorDetail,
} from '../../shared/mcpResult.js';

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
    /** The §5 structured refusal — the ONLY failure constructor. There is no free-text `err(msg)`
     *  any more; see the `fail` comment in `context.ts` for why removing it was the point.
     *
     *  Carries the detail on a symbol so `registerAll` can stamp the tool name in centrally — see
     *  `ERROR_DETAIL`. `encodeError` bounds each field, so an echoed backend body cannot cost the
     *  reader the `code`/`why`/`options`. */
    fail: (detail: ToolErrorDetail): ToolResult => ({
      content: [{ type: 'text', text: banner(encodeError(detail)) }],
      isError: true,
      [ERROR_DETAIL]: detail,
    } as ToolResult),
  };
}

