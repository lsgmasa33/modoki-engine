// C6 — the instance token: a port is a SOCKET, not an EDITOR.
//
// C5 made the backend port sticky, which makes the classic failure rare — but not
// impossible. If a `.mcp.json` targets port X and a DIFFERENT editor now holds X, every
// MCP call SUCCEEDS while driving the wrong editor: `tap` taps, `get_scene_state` returns
// a scene, the undo stack grows, and nothing the agent expects to change changes. There is
// no error anywhere. That failure mode has cost whole sessions.
//
// So the config carries a token that names WHICH editor+project it was written for, and
// the backend rejects a request whose token doesn't match.
//
// The token keys on (userData dir, project root):
//   - NOT per-launch — that would invalidate the config on every restart and defeat C5's
//     whole point (Claude Code bakes env at MCP-spawn time; a change costs a `claude`
//     restart).
//   - NOT committed per-project — two clones of the same project would then share a token,
//     which is exactly the case we exist to catch.
//
// WHERE the store lives is userDataDir.ts's problem, not this file's — don't restate its
// layout here. (An earlier version of this comment did, and went stale the moment
// userDataDir.ts changed: it described the pre-fix world as "MEASURED" truth. Duplicated
// facts rot; a pointer doesn't.)
//
// The only property THIS file depends on: one userData dir can be shared by editors running
// CONCURRENTLY (e.g. MODOKI_MULTI within one clone), so `instance-tokens.json` has multiple
// writers. That is why ensureToken re-reads before its read-modify-write (see readAll) — a
// stale snapshot would erase a sibling's entry.
//
// HONEST SCOPE: this is CORRECTNESS, not security. Validation is "if present" (see
// checkToken), so an attacker simply omits the header. Requiring a token would break the
// documented `curl /api/scene-state` API, the `game-debug` MCP, and chrome-devtools — a
// separate decision with real compatibility cost, tracked but deliberately not smuggled in
// here. See docs/connect-claude-code.md §10.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from './atomicWrite';

/** The request header the `modoki` MCP sends. Lowercase — Node lowercases inbound
 *  header names, and this constant is compared against `req.headers[...]` directly. */
export const TOKEN_HEADER = 'x-modoki-token';

/** The env var baked into `.mcp.json`, read by the MCP at spawn. */
export const TOKEN_ENV = 'MODOKI_TOKEN';

/** userData filename for the (projectRoot → token) map. */
export const TOKEN_FILE = 'instance-tokens.json';

/** Mint a fresh token. UUIDv4 — we need unguessable-ENOUGH-to-not-collide, not secrecy. */
export function newToken(): string {
  return randomUUID();
}

/** Canonical key for a project root. Resolved + de-trailing-slashed so `/a/b` and `/a/b/`
 *  are one entry; case-folded on the case-insensitive platforms (win32/darwin) so a
 *  `/Users/me/Game` vs `/Users/me/game` spelling of the SAME directory doesn't mint two
 *  tokens and 403 the user against their own editor. */
export function rootKey(projectRoot: string): string {
  const abs = path.resolve(projectRoot);
  const trimmed = abs.length > 1 && (abs.endsWith('/') || abs.endsWith('\\')) ? abs.slice(0, -1) : abs;
  return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

// The token gate runs on EVERY backend request, so an fs read per request would be a silly
// tax — hence a cache, keyed by userData dir.
//
// But the file can have MULTIPLE CONCURRENT WRITERS: editors that share a userData dir
// share this file, and several run at once by design (MODOKI_MULTI within one clone; and
// before userDataDir.ts scoped them, EVERY dev clone shared one dir — which is how this bug
// was found). So the cache is valid for READS only, and every write MUST re-read first:
// `ensureToken` is a read-modify-write over the whole map, and merging onto a stale
// snapshot would erase whatever a sibling added since we last looked.
let _cache: { dir: string; map: Record<string, string> } | null = null;

function readAll(userDataDir: string, fresh = false): Record<string, string> {
  if (!fresh && _cache && _cache.dir === userDataDir) return _cache.map;
  let map: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(userDataDir, TOKEN_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Keep only string values — a hand-mangled file must not put a non-string into a
      // header comparison.
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v) map[k] = v;
      }
    }
  } catch {
    map = {}; // absent or corrupt → no tokens (nothing is rejected; see checkToken)
  }
  _cache = { dir: userDataDir, map };
  return map;
}

/** The token for this (install, project), or null if the project was never connected.
 *  Null is NOT an error — see checkToken. */
export function readToken(userDataDir: string, projectRoot: string): string | null {
  if (!projectRoot) return null;
  return readAll(userDataDir)[rootKey(projectRoot)] ?? null;
}

/** The token for this (install, project), minting + persisting one if absent. Called at
 *  Connect — the moment the user asks us to write a config that names this editor. */
export function ensureToken(userDataDir: string, projectRoot: string): string {
  // Re-read from DISK, never the cache: a sibling editor sharing this userData may have
  // added entries since we cached, and the write below replaces the whole map. Also
  // re-checks OUR key — the sibling may have minted this very project's token already,
  // in which case we must adopt it rather than mint a competing one.
  const fresh = readAll(userDataDir, true);
  const key = rootKey(projectRoot);
  if (fresh[key]) return fresh[key];
  const map = { ...fresh, [key]: newToken() };
  fs.mkdirSync(userDataDir, { recursive: true });
  atomicWriteFileSync(path.join(userDataDir, TOKEN_FILE), JSON.stringify(map, null, 2) + '\n');
  _cache = { dir: userDataDir, map };
  return map[key];
}

/** How a request's token relates to the editor it reached.
 *  - `absent`   — no token presented. ACCEPTED (curl / game-debug / a pre-C6 .mcp.json).
 *  - `ok`       — presented and matches.
 *  - `mismatch` — presented but names a DIFFERENT editor/project. REJECTED (403).
 */
export type TokenCheck = 'ok' | 'absent' | 'mismatch';

/**
 * Validate-if-present. The whole policy, in one pure function, so there is exactly one
 * place that decides — the recurring bug in this workstream has been a second, subtly
 * different notion of "is it valid" drifting from the first.
 *
 * `expected == null` (this project was never connected from this install) + a presented
 * token ⇒ **mismatch**, deliberately: that config was written for some OTHER editor, and
 * it reached us only because it targets a port we now hold. That's precisely the bug.
 */
export function checkToken(presented: string | string[] | undefined | null, expected: string | null): TokenCheck {
  const got = Array.isArray(presented) ? presented[0] : presented;
  if (!got) return 'absent';
  return expected != null && got === expected ? 'ok' : 'mismatch';
}

/** The 403 body for a mismatch. Actionable: the user cannot debug a bare "forbidden", and
 *  the whole point of the token is to convert a SILENT wrong-editor into a loud one. */
export function tokenMismatchError(projectRoot: string, backendPort: number | null): string {
  return (
    `WRONG EDITOR: this .mcp.json was written for a different editor or project, but it ` +
    `reached the editor on port ${backendPort ?? '?'}, which has ${projectRoot || '(no project)'} open. ` +
    `Its requests are refused rather than silently applied to the wrong project. ` +
    `Fix: in THIS editor run AI → Connect Claude Code, then restart \`claude\`.`
  );
}

/** Test hook: drop the cache (tests write the file directly). */
export function _resetTokenCache(): void {
  _cache = null;
}
