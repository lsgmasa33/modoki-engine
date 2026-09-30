/** Every tool answer names the outside changes the editor has not applied yet (#1879): while the editor holds a git pull,
 *  a hand edit or a file-direct write, a read of it shows the OLD file, and an agent must not measure that unknowingly.
 *
 *  The backend stamps the held list on every response (`tools/shared/pendingOutside.ts`); `call` hands each response's
 *  header here, and the tool's answer gets the LAST one it saw — the freshest, taken after the tool's own calls. Scoped
 *  per tool call (AsyncLocalStorage), because MCP calls interleave: a module-level "last header" would give one tool's
 *  answer another's list.
 *
 *  Spliced into the answer's JSON as three fields when its first text block is a JSON object (every `ok`/`fail` answer:
 *  `encode` is compact `JSON.stringify`, behind an optional identity banner), so a client that parses the text as one
 *  document keeps working. Anything else (plain text, an array) gets the fields as a text block of its own. Only on the
 *  answer the client receives: a `modoki_batch` step's text is parsed as ONE document too, and the batch's own answer
 *  carries the list once. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { decodePendingOutside, type PendingOutsideSummary } from '../../shared/pendingOutside.js';
import type { ToolResult } from './result.js';

const scope = new AsyncLocalStorage<{ pending?: PendingOutsideSummary }>();

/** A backend response's header. The backend stamps every answer it writes, the empty list included, so a response
 *  without one (an error path that bypasses the stamp, an older backend) says nothing and keeps what an earlier call
 *  of this tool saw. */
export function notePendingHeader(value: string | null): void {
  const store = scope.getStore();
  const seen = decodePendingOutside(value);
  if (store && seen) store.pending = seen;
}

export const PENDING_HINT = 'The editor has NOT applied these outside file changes yet, so it shows their OLD contents. '
  + 'Call modoki_refresh to apply them (a human with the editor focused sees a countdown first); one that Play or an '
  + 'operation in progress holds applies when that ends (modoki_refresh answers `deferred` with the reason).';

/** Run one tool call and add the pending list its backend calls reported, when there is one. */
export async function withPendingStamp<R extends ToolResult>(run: () => Promise<R>): Promise<R> {
  const store: { pending?: PendingOutsideSummary } = {};
  const result = await scope.run(store, run);
  return stampPending(result, store.pending);
}

export function stampPending<R extends ToolResult>(result: R, pending: PendingOutsideSummary | undefined): R {
  if (!pending?.count) return result;
  const fields = { pendingOutsideChanges: pending.paths, pendingOutsideCount: pending.count, pendingOutsideHint: PENDING_HINT };
  const [first, ...rest] = result.content;
  const spliced = first?.type === 'text' ? spliceIntoJson(first.text, fields) : null;
  // A spread keeps the result's own symbol keys (`ERROR_DETAIL` on a failure).
  return spliced !== null
    ? { ...result, content: [{ ...first, text: spliced }, ...rest] }
    : { ...result, content: [...result.content, { type: 'text' as const, text: JSON.stringify(fields) }] };
}

/** `text` with `fields` added, when it is a JSON object behind an optional banner (`createFormatter`: banner + blank
 *  line + JSON); null otherwise. */
function spliceIntoJson(text: string, fields: Record<string, unknown>): string | null {
  const gap = text.indexOf('\n\n{');
  const at = text.startsWith('{') ? 0 : gap < 0 ? -1 : gap + 2;
  if (at < 0) return null;
  try {
    const body = JSON.parse(text.slice(at)) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return text.slice(0, at) + JSON.stringify({ ...(body as object), ...fields });
  } catch { return null; }
}
