// Sticky backend port for "Connect Claude Code" (docs/connect-claude-code.md §9).
//
// The backend port is the MCP target: the user's Claude Code bakes it into
// `.mcp.json` → `MODOKI_BACKEND` at MCP-spawn time, so a port that changes across
// launches silently breaks their connection (and Claude Code can only pick up a new
// port by RESTARTING). The old logic was `findFreePort(5179, allowFallback)` — prefer
// 5179, else a RANDOM ephemeral port — so on a machine where 5179 was taken (e.g. dev
// editors on 5179/5180/5181) every launch drew a different high port (observed: 62681).
//
// Fix: a deterministic ladder that PREFERS THE PORT WE LAST BOUND, so a relaunch reuses
// it whenever it's free and the user's `.mcp.json` stays valid with no restart. A random
// ephemeral port becomes the last resort rather than the first fallback.
//
// Pure / fs-only (no electron import) so the ladder is unit-testable.

import fs from 'node:fs';
import path from 'node:path';

/** The conventional backend port — the first choice when we have no memory. */
export const DEFAULT_BACKEND_PORT = 5179;
/** How many consecutive ports to scan past the default before giving up on a low port. */
export const SCAN_SPAN = 10;
/** The pref file under userData that remembers the last successfully-bound port. */
export const PORT_PREF_FILE = 'backend-port.json';

/**
 * Ports owned by the PINNED `MODOKI_BACKEND_PORT` contract — an UNPINNED editor must
 * never squat one. 5180/5181 are the two-clone dev editors (CLAUDE.md: work-ai / work-ai2,
 * `npm run editor:ai`) and 5188 is the packaged-smoke gate (smoke-packaged.sh). Squatting
 * one is worse than it looks: we'd also `writeLastPort` it, so EVERY later launch grabs it
 * first, and the pinned editor then hits its "refusing to drift" `app.exit(1)` — a consumer
 * editor would permanently break `npm run editor:ai` / `verify:packaged`.
 *
 * 5179 is deliberately NOT reserved: it's the conventional default, and a lone consumer
 * editor (no dev clones) should land on it. When it IS taken, we skip past the reserved
 * band to 5182+.
 */
export const RESERVED_BACKEND_PORTS = [5180, 5181, 5188];

/** Parse a port from an env string. Null = absent or NOT a valid port — the SINGLE
 *  source of truth for "is this a usable port", so a caller can't treat a value as
 *  pinned-and-present while this treats it as invalid (the drift bug). */
export function parseBackendPort(raw: string | undefined | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** Read the last-bound backend port from userData, or null if unknown/corrupt. */
export function readLastPort(userDataDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, PORT_PREF_FILE), 'utf8');
    const port = (JSON.parse(raw) as { port?: unknown })?.port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** Persist the port we actually bound, so the next launch prefers it. */
export function writeLastPort(userDataDir: string, port: number): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, PORT_PREF_FILE), JSON.stringify({ port }, null, 2) + '\n');
  } catch {
    /* best-effort: failing to remember a port must never break launch */
  }
}

/**
 * The ordered list of ports to try binding, most-preferred first. Pure — the unit
 * under test.
 *
 * - **Pinned** (`MODOKI_BACKEND_PORT`): exactly that port, nothing else — and the reserved
 *   skiplist does NOT apply (pinning 5180 is exactly how the dev clones claim it). The
 *   caller refuses to drift off a pinned port (the MCP target must stay stable), so
 *   offering alternatives here would be wrong.
 * - **Otherwise**: last-bound port (sticky — this is what keeps `.mcp.json` valid) →
 *   the 5179 default → a deterministic scan upward, always SKIPPING
 *   `RESERVED_BACKEND_PORTS`. Deduped, invalid entries dropped. The caller falls back to
 *   an ephemeral port only if EVERY candidate is taken.
 *
 * The reserved filter applies to `lastPort` too — a port persisted before the skiplist
 * existed (or by a differently-configured build) must not resurrect a squat.
 */
export function portCandidates(opts: {
  pinned?: number | null;
  lastPort?: number | null;
  base?: number;
  span?: number;
  reserved?: readonly number[];
}): number[] {
  const valid = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536;
  if (valid(opts.pinned)) return [opts.pinned]; // pinned is exact — skiplist must not apply

  const base = valid(opts.base) ? opts.base : DEFAULT_BACKEND_PORT;
  const span = valid(opts.span) ? opts.span : SCAN_SPAN;
  const reserved = new Set(opts.reserved ?? RESERVED_BACKEND_PORTS);
  const out: number[] = [];
  const push = (p: number) => { if (valid(p) && !reserved.has(p) && !out.includes(p)) out.push(p); };

  if (valid(opts.lastPort)) push(opts.lastPort); // sticky: keep the user's baked port working
  push(base);
  for (let i = 1; i < span; i++) push(base + i);
  return out;
}
