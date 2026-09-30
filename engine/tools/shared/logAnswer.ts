/** One answer shape for every MCP answer that carries raw log text (#1903, after #1900's `modoki_build`): bounded by
 *  CHARACTERS, not by the count of entries. A count has no size: one logged JSON blob, one long stack or one Vite asset
 *  listing is a single entry, so "the last 50" could be any size, and one oversized entry pushed the whole answer past
 *  the 60k cap (an uninformative `TOO_LARGE` envelope) or, where nothing encoded the answer, past any bound at all.
 *
 *  Two steps, in this order, and each says what it cut:
 *  1. every entry's text is cut to a per-entry cap ({@link capLogText}), with how many chars it lost;
 *  2. the entries are fitted to a character budget ({@link fitLogBudget}), keeping the end the reader wants — the
 *     newest for a tail, the oldest for a forward cursor or a newest-first listing — and counting what was left out.
 *
 *  Dependency-free (like `mcpResult.ts`): the editor and device MCPs, the device-shipped agent bridge and the host's
 *  device readers all import it. */

/** One LINE: a stack frame, a minified asset path or a logcat line fits; a pasted blob does not. */
export const LOG_LINE_CHARS = 400;
/** One console ENTRY, which carries its whole stack and cause chain (~25 frames): the cause survives the cut. */
export const LOG_ENTRY_CHARS = 4_000;
/** The entries' share of one answer, measured as encoded: under `MAX_PAYLOAD_CHARS` (60k) with room for the rest of
 *  the reply (counts, cursor, hint) and for a caller wrapping it in another answer. */
export const LOG_ANSWER_CHARS = 40_000;

/** `text` cut to `max` chars, with how much was cut. */
export function capLogText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}

/** The items that fit `budget` chars, measured by `sizeOf`, taken from the end the reader wants: `last` keeps the
 *  newest of an oldest-first list (a tail), `first` keeps the head (a forward cursor's page, a newest-first listing).
 *  Contiguous from that end, so a cursor built on the result skips nothing. Never empties a non-empty list: the first
 *  item it keeps is kept whatever its size — cap it first with {@link capLogText}. `omitted` counts what did not fit. */
export function fitLogBudget<T>(
  items: readonly T[], sizeOf: (item: T) => number, budget: number, keep: 'first' | 'last',
): { items: T[]; omitted: number } {
  const order = keep === 'last' ? [...items].reverse() : [...items];
  const kept: T[] = [];
  let used = 0;
  for (const it of order) {
    const size = sizeOf(it);
    if (kept.length && used + size > budget) break;
    kept.push(it);
    used += size;
  }
  if (keep === 'last') kept.reverse();
  return { items: kept, omitted: items.length - kept.length };
}

/** An item's size as the answer encodes it: its compact JSON, escapes and field names included. */
export function encodedSize(item: unknown): number {
  return JSON.stringify(item)?.length ?? 0;
}
