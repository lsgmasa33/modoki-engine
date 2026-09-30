/** Which editor backend does an MCP server aim at? SHARED by both servers (#1894).
 *
 *  `MODOKI_BACKEND` when the environment sets it, else THIS clone's pinned port, else the
 *  server's own last-resort default. The middle step is what lets the committed `.mcp.json`
 *  carry no `MODOKI_BACKEND` at all: a `${MODOKI_BACKEND:-…}` there is evaluated by Claude Code
 *  once before `.claude/settings.local.json`'s `env` applies and once after, and when the two
 *  answers differ it spawns BOTH — every worker session ran a second copy of each server aimed
 *  at the hub's port (#1894). With nothing to expand, the config is the same string both times.
 *
 *  The clone is found from the server's OWN FILE, never `process.cwd()`: Claude Code happens to
 *  spawn project servers in the project root, but "Connect Claude" writes absolute paths for a
 *  `claude` started anywhere, and the packaged editor spawns the bundle outside any clone.
 *  Outside a clone the lookup is `null` and the server falls back to 5179, the value `.mcp.json`
 *  supplied before #1894; the packaged app never reaches it, because "Connect Claude" always writes
 *  a literal MODOKI_BACKEND.
 *
 *  ⚠️ Imports `cloneBackendPorts.mjs`, NOT `editorPorts.mjs`: the latter runs a CLI at top level
 *  when it is the entry point, and inside the esbuild bundle it would be (see that file). */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLONE_BACKEND_PORTS, backendUrlForClone } from '../../scripts/cloneBackendPorts.mjs';

/** Where every MCP server and harness goes outside a known clone: the hub's port, which is also
 *  what `.mcp.json` gave them all before #1894 and where an unlisted clone's editor settles. ONE
 *  value, derived from the table (as `HUB_BACKEND_PORT` is), so the servers cannot drift apart. */
export const DEFAULT_BACKEND_URL = `http://127.0.0.1:${CLONE_BACKEND_PORTS['modoki']}`;

/** Where a backend URL came from — printed in each server's start banner, so "which editor is
 *  this session on, and why" is one `mcp-logs` line rather than an investigation. */
export type BackendSource = 'env' | 'clone' | 'default';

export interface BackendResolution {
  /** No trailing slash. */
  url: string;
  source: BackendSource;
  /** The repo root derived from the entry file — reported so a wrong derivation is visible. */
  repoRoot: string | null;
}

/** The repo root for a server ENTRY module: a file directly in `engine/tools/<server>/src/`
 *  (run by tsx) or `engine/tools/<server>/dist/` (the esbuild bundle, where `import.meta.url` is
 *  the bundle's own). Both sit four directories below the root, so one depth serves both —
 *  which is why the callers pass THEIR `import.meta.url` from a file at that depth rather than
 *  this module reading its own (it lives one level shallower, and is inlined into the bundle). */
export function repoRootForEntry(entryModuleUrl: string): string {
  return path.resolve(fileURLToPath(new URL('../../../../', entryModuleUrl)));
}

export function resolveBackend(opts: {
  /** `process.env.MODOKI_BACKEND`. Empty counts as unset, as `${VAR:-default}` treated it. */
  env: string | undefined;
  /** The calling entry module's `import.meta.url` — see `repoRootForEntry`. */
  entryModuleUrl: string;
  /** Outside a known clone. Defaults to `DEFAULT_BACKEND_URL`; production callers leave it. */
  fallback?: string;
}): BackendResolution {
  const strip = (u: string) => u.replace(/\/$/, '');
  if (opts.env) return { url: strip(opts.env), source: 'env', repoRoot: null };
  let repoRoot: string | null = null;
  let derived: string | null = null;
  try {
    repoRoot = repoRootForEntry(opts.entryModuleUrl);
    derived = backendUrlForClone(repoRoot);
  } catch {
    // A module URL this cannot map (not `file:`) must not stop a server from starting: the
    // derivation is a convenience layered over a default that always worked.
  }
  return derived
    ? { url: strip(derived), source: 'clone', repoRoot }
    : { url: strip(opts.fallback ?? DEFAULT_BACKEND_URL), source: 'default', repoRoot };
}

/** `http://… (from MODOKI_BACKEND)` — the suffix both start banners print. */
export function describeBackend(r: BackendResolution): string {
  const why = r.source === 'env' ? 'from MODOKI_BACKEND'
    : r.source === 'clone' ? `this clone's pinned port, derived from ${r.repoRoot}`
    : 'default — MODOKI_BACKEND unset and not in a known clone';
  return `${r.url} (${why})`;
}
