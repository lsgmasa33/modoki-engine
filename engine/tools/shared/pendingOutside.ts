/** Outside file changes the editor has not applied yet (#1879), carried from the backend to the MCP on EVERY answer.
 *
 *  The editor holds each outside change (a git pull, a hand edit, an agent's file-direct write) until it regains focus
 *  or an agent calls `modoki_refresh`. While any is held, a read of the editor shows the OLD contents of those files, so
 *  every MCP answer says which: an agent never measures a stale editor without knowing it.
 *
 *  The renderer owns the list (`agentBridge.ts`) and pushes it to its backend on every change; a file-direct route adds
 *  its own path at once (`noteWrite`), because the watcher raises it only after its debounce. The backend stamps the
 *  list on every response as {@link PENDING_OUTSIDE_HEADER}, and the MCP server copies it into the tool's answer.
 *
 *  CAPPED (hub, 2026-09-30): a pull of hundreds of files must not make a giant header — or a 431 — so the header and
 *  the answer carry the first {@link PENDING_OUTSIDE_CAP} paths and the total count. */

export const PENDING_OUTSIDE_HEADER = 'X-Modoki-Pending-Outside';
export const PENDING_OUTSIDE_CAP = 50;

export interface PendingOutsideSummary { paths: string[]; count: number }

/** The header's value: JSON, ASCII only (a path can hold any character, and a header value may not), at most
 *  {@link PENDING_OUTSIDE_CAP} paths. */
export function encodePendingOutside(all: readonly string[]): string {
  const body: PendingOutsideSummary = { paths: all.slice(0, PENDING_OUTSIDE_CAP), count: all.length };
  return JSON.stringify(body).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The header back, or null for a missing or malformed one (an older backend sends none). */
export function decodePendingOutside(value: string | null | undefined): PendingOutsideSummary | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<PendingOutsideSummary>;
    if (!Array.isArray(v.paths) || typeof v.count !== 'number') return null;
    return { paths: v.paths.filter((p): p is string => typeof p === 'string'), count: v.count };
  } catch { return null; }
}

export interface PendingOutside {
  /** The renderer's whole list, replacing the last one. */
  fromRenderer(paths: readonly string[]): void;
  /** A route wrote `urlPath` outside the editor's own write guard: pending from now, before the watcher raises it. */
  noteWrite(urlPath: string): void;
  list(): string[];
  /** The header to stamp on a response — on every one, the empty list too, so a response WITHOUT it (an error path
   *  that bypasses the stamp) tells the MCP nothing rather than "nothing pending" (review U2). */
  headers(): Record<string, string>;
  /** Wait (at most `maxMs`) until every path a route noted has reached the renderer's list, so a refresh right after a
   *  write applies it. */
  settled(maxMs: number): Promise<void>;
}

/** `ttlMs`: how long a route's note stands on its own. The watcher raises a write within its debounce (150 ms); a note
 *  the renderer never confirms (a write of identical bytes raises nothing) must not stay pending forever. */
export function createPendingOutside(now: () => number = Date.now, ttlMs = 3000): PendingOutside {
  let renderer: string[] = [];
  const noted = new Map<string, number>();
  const live = (): string[] => {
    const t = now();
    for (const [p, at] of noted) if (t - at > ttlMs) noted.delete(p);
    return [...noted.keys()];
  };
  const list = () => [...new Set([...renderer, ...live()])];
  return {
    // A note the renderer now holds is confirmed: from here the renderer's list alone says whether it is pending, so its
    // release ends it (a note kept past that would report an applied change as pending until it expired).
    fromRenderer(paths) {
      renderer = [...paths];
      for (const p of renderer) noted.delete(p);
    },
    noteWrite(urlPath) { noted.set(urlPath, now()); },
    list,
    headers() {
      return { [PENDING_OUTSIDE_HEADER]: encodePendingOutside(list()) };
    },
    async settled(maxMs) {
      const until = now() + maxMs;
      while (live().length && now() < until) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
