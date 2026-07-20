// "Connect Claude Code" — write a machine-correct .mcp.json into the open project so
// the user's own Claude Code (run in that dir) drives the live editor through the
// `modoki` MCP (+ `chrome-devtools` over CDP), with zero manual config.
//
// The two facts a user can't supply themselves — which port the editor bound, and
// where the bundled MCP lives on THIS machine — are known only to the Electron main
// process, which calls these helpers. Everything here is pure / fs+spawn only (no
// electron import) so the merge logic (the highest-risk surface: it must never clobber
// a user's other MCP servers) is unit-tested without an Electron runtime.
//
// See docs/connect-claude-code.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from './atomicWrite';
import { checkToken } from './instanceToken';

export interface McpServerEntry {
  command: string;
  args: string[];
  /** Extra env for the spawned server, MERGED with MODOKI_BACKEND/TOKEN by mergeMcpConfig.
   *  Carries ELECTRON_RUN_AS_NODE=1 when `command` is the editor's own binary (Windows). */
  env?: Record<string, string>;
}

export const MCP_FILE = '.mcp.json';

/** Strip a leading UTF-8 BOM. Windows editors (Notepad, PowerShell `Out-File`) write
 *  one, and JSON.parse rejects it — so a perfectly valid .mcp.json would be misread as
 *  corrupt. String.trim() strips U+FEFF but we parse the raw text, so strip explicitly. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export { atomicWriteFileSync };

/** The MCP entry path, forward-slashed. Node runs a forward-slash path on every OS,
 *  and it keeps the JSON clean (no `C:\\Users\\…` escaped backslashes) — matching the
 *  project's forward-slash convention for machine-written paths. */
function mcpEntryPath(repoRoot: string, ...segments: string[]): string {
  return path.join(repoRoot, 'engine', 'tools', 'modoki-mcp', ...segments).replace(/\\/g, '/');
}

/** The `modoki` MCP server invocation for this machine.
 *  - Dev on macOS/Linux: `npx tsx src/index.ts` — runs live source, no build step.
 *  - macOS/Linux packaged: `node dist/index.js` — self-contained built server.
 *  - **Windows (dev OR packaged): run the BUILT dist through the editor's OWN binary**
 *    (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1` — the same trick devServer.ts
 *    uses to spawn Vite. Two Windows facts force this:
 *      (a) Claude Code spawns an MCP `command` WITHOUT a shell, and `npx` is `npx.cmd`
 *          (a batch file CreateProcess can't execute) → "Failed to connect" / -32000.
 *      (b) Even bare `node` must be resolvable on CLAUDE CODE's spawn PATH, which is
 *          sanitized and does NOT include the user's PATH — so a portable / user-PATH
 *          Node install isn't found either.
 *    `process.execPath` is an ABSOLUTE path to a node-capable binary that is ALWAYS
 *    present (the editor is running it), so it resolves with zero dependency on the
 *    user's PATH or Node install, in dev and packaged alike. Forward-slashed for clean
 *    JSON — Windows CreateProcess accepts a forward-slash executable path (verified).
 *  dist/index.js is emitted by build-electron / postinstall, so it's present everywhere. */
export function buildMcpServerEntry(
  repoRoot: string,
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): McpServerEntry {
  if (platform === 'win32') {
    return {
      command: execPath.replace(/\\/g, '/'),
      args: [mcpEntryPath(repoRoot, 'dist', 'index.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return isPackaged
    ? { command: 'node', args: [mcpEntryPath(repoRoot, 'dist', 'index.js')] }
    : { command: 'npx', args: ['tsx', mcpEntryPath(repoRoot, 'src', 'index.ts')] };
}

/** The `chrome-devtools` MCP server, attached to the editor's OWN renderer over CDP.
 *  Mirrors the repo `.mcp.json` shape; baked with the live remote-debugging port. */
export function buildChromeDevtoolsEntry(cdpPort: number): McpServerEntry {
  return { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', `--browser-url=http://127.0.0.1:${cdpPort}`] };
}

/** JSON shape we read/write. Unknown fields on other servers are preserved verbatim. */
interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Merge our servers into an existing `.mcp.json` text (or start fresh from null),
 * returning the serialized result.
 *
 * INVARIANT: sets ONLY `mcpServers.modoki` (+ `mcpServers['chrome-devtools']` when a
 * CDP entry is given) and PRESERVES every other server + every top-level field. A
 * user's own game-debug / their-own chrome-devtools / unrelated keys survive untouched.
 * When no CDP entry is given, an existing `chrome-devtools` is LEFT AS-IS (we don't own
 * a server we didn't write this call) — disabling CDP doesn't delete the user's config.
 *
 * Throws on a non-null but unparseable existing file rather than clobbering it, so the
 * caller can surface the error and leave the user's file intact.
 */
export function mergeMcpConfig(
  existingText: string | null,
  entries: { modoki: McpServerEntry; chromeDevtools?: McpServerEntry },
  backendUrl: string,
  token?: string | null,
): string {
  let config: McpConfig = {};
  const existing = existingText != null ? stripBom(existingText) : null;
  if (existing != null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (e) {
      throw new Error(`existing .mcp.json is not valid JSON (${e instanceof Error ? e.message : e}) — not overwriting it`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as McpConfig;
    } else {
      throw new Error('existing .mcp.json is not a JSON object — not overwriting it');
    }
  }

  const servers: Record<string, unknown> =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? { ...(config.mcpServers as Record<string, unknown>) }
      : {};

  // MODOKI_TOKEN (C6) names WHICH editor+project this config was written for, so a config
  // that reaches the right PORT but the wrong EDITOR is refused instead of silently
  // driving someone else's project. Omitted when no token was minted — a config without
  // one still works (the backend validates if-present).
  servers.modoki = { ...entries.modoki, env: { ...(entries.modoki.env ?? {}), MODOKI_BACKEND: backendUrl, ...(token ? { MODOKI_TOKEN: token } : {}) } };
  if (entries.chromeDevtools) servers['chrome-devtools'] = { ...entries.chromeDevtools };

  return JSON.stringify({ ...config, mcpServers: servers }, null, 2) + '\n';
}

function parseMcp(mcpText: string | null): McpConfig | null {
  if (!mcpText) return null;
  try {
    const cfg = JSON.parse(stripBom(mcpText));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as McpConfig) : null;
  } catch {
    return null;
  }
}

function urlPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** The MODOKI_BACKEND port baked into an existing `.mcp.json`'s modoki server, or null
 *  if absent/unparseable — used to detect a STALE config (baked port ≠ live port). */
export function mcpBackendPort(mcpText: string | null): number | null {
  const modoki = parseMcp(mcpText)?.mcpServers?.['modoki'] as { env?: { MODOKI_BACKEND?: string } } | undefined;
  return urlPort(modoki?.env?.MODOKI_BACKEND);
}

/**
 * Does this config carry a `modoki` server at all — regardless of whether its
 * MODOKI_BACKEND is a literal URL?
 *
 * Distinct from `mcpBackendPort() != null`, which the panel used to answer "is this ours"
 * with. That conflated "not our config" with "our config, port not a literal" — and
 * Claude Code expands `${VAR}` / `${VAR:-default}` in `.mcp.json`, which THIS REPO's own
 * committed config uses (`"MODOKI_BACKEND": "${MODOKI_BACKEND:-http://127.0.0.1:5179}"`,
 * deliberately generic so one tracked file serves every clone). So the panel called a
 * perfectly working config "not a usable Modoki config" and pushed the user to overwrite
 * the very mechanism it exists to provide.
 */
export function mcpHasModoki(mcpText: string | null): boolean {
  const servers = parseMcp(mcpText)?.mcpServers;
  return !!(servers && typeof servers === 'object' && !Array.isArray(servers) && (servers as Record<string, unknown>)['modoki']);
}

/** The RAW MODOKI_BACKEND string from an existing config's modoki server (may be a
 *  `${VAR:-default}` expansion rather than a URL), or null. Lets the panel distinguish
 *  "defers to your shell" from "baked to a literal port". */
export function mcpBackendRaw(mcpText: string | null): string | null {
  const modoki = parseMcp(mcpText)?.mcpServers?.['modoki'] as { env?: { MODOKI_BACKEND?: unknown } } | undefined;
  const v = modoki?.env?.MODOKI_BACKEND;
  return typeof v === 'string' && v ? v : null;
}

/** The MODOKI_TOKEN baked into an existing `.mcp.json`'s modoki server, or null if absent
 *  (a pre-C6 config, or one we didn't write) — used to detect a config written for a
 *  DIFFERENT editor/project. */
export function mcpToken(mcpText: string | null): string | null {
  const modoki = parseMcp(mcpText)?.mcpServers?.['modoki'] as { env?: { MODOKI_TOKEN?: unknown } } | undefined;
  const t = modoki?.env?.MODOKI_TOKEN;
  return typeof t === 'string' && t ? t : null;
}

/** The 127.0.0.1 CDP port baked into the chrome-devtools server's --browser-url arg, or
 *  null if there's no such entry — used to detect a stale/missing CDP wiring. */
export function mcpChromePort(mcpText: string | null): number | null {
  const chrome = parseMcp(mcpText)?.mcpServers?.['chrome-devtools'] as { args?: unknown } | undefined;
  const args = Array.isArray(chrome?.args) ? (chrome!.args as unknown[]) : [];
  const arg = args.find((a): a is string => typeof a === 'string' && a.startsWith('--browser-url='));
  return arg ? urlPort(arg.slice('--browser-url='.length)) : null;
}

/**
 * Is the project's `.mcp.json` STALE relative to the live editor — i.e. would running
 * `claude` against it hit the wrong (or a missing) endpoint, so the panel should offer
 * Reconnect? True when:
 *  - the baked backend port ≠ the live backend port (editor relaunched onto another port), OR
 *  - CDP is enabled but the config's chrome-devtools port ≠ the live CDP port (covers the
 *    "just enabled CDP → chrome-devtools not written yet" case, where mcpChromePort is null), OR
 *  - the baked MODOKI_TOKEN ≠ this editor's token for the project (C6) — the config names a
 *    DIFFERENT editor, so every call would be refused with a 403.
 * When CDP is off we don't judge chrome-devtools staleness — mergeMcpConfig deliberately
 * leaves a user's own chrome-devtools untouched in that case. Likewise `token: null` (this
 * project was never connected from this install) is NOT judged: a pre-C6 config carries no
 * token and keeps working, so calling it stale would nag for nothing.
 */
export function isMcpStale(opts: {
  mcpText: string | null;
  backendPort: number | null;
  cdpEnabled: boolean;
  cdpPort: number | null;
  token?: string | null;
}): boolean {
  if (opts.mcpText == null) return false; // not written yet → "not stale", just "not connected"
  const baked = mcpBackendPort(opts.mcpText);
  if (baked != null && opts.backendPort != null && baked !== opts.backendPort) return true;
  if (opts.cdpEnabled && opts.cdpPort != null && mcpChromePort(opts.mcpText) !== opts.cdpPort) return true;
  return isMcpTokenForeign(opts.mcpText, opts.token ?? null);
}

/**
 * Would THIS editor refuse the config's requests? (C6)
 *
 * Delegates to `checkToken` — the SAME function the backend gate uses — so the panel's
 * verdict and the gate's behaviour cannot drift apart. That drift is this workstream's
 * signature bug: an earlier cut open-coded `token != null && baked !== token`, which
 * reported a clean "Connected" in exactly the case where minting had failed (`token ==
 * null`) and the gate was 403ing every single call.
 */
export function isMcpTokenForeign(mcpText: string | null, token: string | null): boolean {
  return checkToken(mcpToken(mcpText), token) === 'mismatch';
}

// ─────────────────────────────────────────────────────────────────────────────
// C9 — write the config where `claude` will actually READ it (§13).
//
// MEASURED against claude 2.1.212 (re-run the probe rather than trusting this
// comment — every one of these was an assumption first and a surprise second):
//   - discovery walks UP from cwd; a config in a SUBdirectory is never seen.
//   - several `.mcp.json` on the path are MERGED, not nearest-wins-all.
//   - the same server NAME in two of them → the NEAREST file wins.
//   - it does NOT stop at the git root (a config above the git root still loaded).
//
// The consequence that makes this a bug: an in-repo game (`games/3d-test`) is the
// PROJECT ROOT, but the developer runs `claude` at the REPO ROOT. A config written
// down in the game folder is invisible up there — Connect reports success, the panel
// goes green, and nothing is wired.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the config that `claude` will load actually lives. */
export interface McpTarget {
  /** The file to read / write / heal. */
  mcpPath: string;
  /** 'ancestor' ⇒ we adopted an existing config ABOVE the project (the in-repo case);
   *  the panel must SAY so, because the user cannot infer it. */
  location: 'project' | 'ancestor';
  exists: boolean;
  /** Other `.mcp.json` files on the path that ALSO define a `modoki` server, nearest-first.
   *
   *  Only a rival `modoki` entry can mis-target: claude merges every config it finds, but
   *  resolves a name collision NEAREST-first (measured). So an unrelated config (a
   *  `weather` server in `~/Desktop/.mcp.json`) is harmless and must NOT be reported —
   *  flagging it would leave the panel permanently amber for a healthy setup, and a
   *  warning that cries wolf is a warning nobody reads. A rival `modoki`, though, means
   *  which EDITOR a call reaches depends on the cwd `claude` was launched in — C6's
   *  silent-wrong-target bug with a new cause. */
  shadowing: string[];
}

/** Does this `.mcp.json` define a `modoki` server? (Unreadable/corrupt ⇒ no — it can't
 *  win a name collision it can't be parsed to declare.) */
function definesModoki(file: string): boolean {
  try {
    const cfg = parseMcp(fs.readFileSync(file, 'utf8'));
    const servers = cfg?.mcpServers;
    return !!(servers && typeof servers === 'object' && !Array.isArray(servers) && (servers as Record<string, unknown>)['modoki']);
  } catch {
    return false;
  }
}

const isFsRoot = (d: string): boolean => path.dirname(d) === d;

/** Canonicalize for COMPARISON: resolve symlinks (macOS `/var` → `/private/var`, and a
 *  symlinked $HOME) and case-fold where the filesystem is case-insensitive. The $HOME
 *  write boundary was a raw `===` on `os.homedir()`, so any of those mismatches silently
 *  turned the guard off — and the guard is the only thing standing between us and writing
 *  a machine-wide `$HOME/.mcp.json`. A boundary that fails OPEN must not depend on the
 *  home path happening to be spelled the same way twice. */
function canonical(p: string): string {
  let out = path.resolve(p);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    /* doesn't exist yet — resolve() is the best we can do */
  }
  return process.platform === 'darwin' || process.platform === 'win32' ? out.toLowerCase() : out;
}

const samePath = (a: string, b: string): boolean => canonical(a) === canonical(b);

/**
 * The git root at-or-above `dir`, or null.
 *
 * Stops at `home` DELIBERATELY. Discovery itself doesn't stop there (measured), but
 * *writing* must: a dotfiles repo at `$HOME` would otherwise make `$HOME/.mcp.json` an
 * adoptable ancestor, and a `modoki` server written there hijacks every project on the
 * machine. `.git` is probed with existsSync, not isDirectory — a worktree/submodule's
 * `.git` is a FILE.
 */
function gitRootFor(dir: string, home: string): string | null {
  let d = dir;
  for (;;) {
    if (samePath(d, home)) return null;
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (isFsRoot(d)) return null;
    d = path.dirname(d);
  }
}

/** Is `dir` inside a git repo at all? Answered from the FILESYSTEM, with no `git` binary —
 *  a packaged app launched from Finder has a minimal PATH (the same trap `detectClaudeCli`
 *  already works around), so anything that must be correct on the DMG cannot shell out.
 *  Unlike `gitRootFor` this does NOT stop at $HOME: it's asking "could this be tracked?",
 *  not "where may we write?". */
function inGitRepo(dir: string): boolean {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (isFsRoot(d)) return false;
    d = path.dirname(d);
  }
}

/** Every dir from `from` up to the filesystem root — the path claude itself walks. */
function dirsUpward(from: string): string[] {
  const out: string[] = [];
  let d = from;
  for (;;) {
    out.push(d);
    if (isFsRoot(d)) return out;
    d = path.dirname(d);
  }
}

/**
 * Decide WHICH `.mcp.json` to write/heal/report for the open project.
 *
 * The rule: **the nearest existing config at-or-above the project root, searching only
 * within the project's OWN git repo.** Nothing found ⇒ the project root.
 *
 * Why the git-repo bound, rather than "nearest existing ancestor anywhere":
 *  - It targets exactly the motivating case. An in-repo game sits inside the repo whose
 *    root is where the developer runs `claude` — and that root's `.mcp.json` is both the
 *    file they load AND (measured: nearest-wins) the one whose `modoki` entry beats ours.
 *  - It refuses the collateral. A standalone `~/Desktop/moge` next to some unrelated
 *    `~/Desktop/.mcp.json` must NOT have our server written into that shared file — it
 *    would change every other project on the Desktop. `~/Desktop` is not a git repo, so
 *    no ancestor is adopted and we write `moge/.mcp.json`, which is CORRECT anyway:
 *    nearest-wins means a `claude` run in `moge` always prefers the project's own file.
 *
 * So an ancestor is adopted only on real evidence that the user runs `claude` up there
 * (a repo, with a config already in it) — never on a coincidence of directory layout.
 *
 * `shadowing` is computed over the UNBOUNDED walk, because that's what claude does: the
 * write boundary constrains where we WRITE, never what we admit is out there.
 */
export function resolveMcpTarget(projectRoot: string, opts: { home?: string } = {}): McpTarget {
  const home = opts.home ?? os.homedir();
  const root = path.resolve(projectRoot);
  const repo = gitRootFor(root, home);

  // Candidate dirs we may write to: the project root always, plus its ancestors up to
  // and including the git root (only when the project is INSIDE a repo, not when it IS one).
  const writable = [root];
  if (repo && repo !== root) {
    for (const d of dirsUpward(path.dirname(root))) {
      writable.push(d);
      if (d === repo) break;
    }
  }

  const found = writable.map((d) => path.join(d, MCP_FILE)).filter((p) => fs.existsSync(p));
  const mcpPath = found[0] ?? path.join(root, MCP_FILE);
  // The shadow scan is UNBOUNDED (claude's own walk doesn't stop at the git root — measured),
  // because the write boundary limits where we WRITE, never what we admit is out there.
  const all = dirsUpward(root).map((d) => path.join(d, MCP_FILE)).filter((p) => fs.existsSync(p));

  return {
    mcpPath,
    location: samePath(path.dirname(mcpPath), root) ? 'project' : 'ancestor',
    exists: found.length > 0,
    shadowing: all.filter((p) => p !== mcpPath && definesModoki(p)),
  };
}

/**
 * Is `file` under version control?
 *
 * TRI-state on purpose. The first cut returned a boolean and mapped THREE outcomes onto
 * two: tracked (exit 0), untracked (1/128) — and **git failed to run at all**, which
 * `spawnSync` reports as `status: null` WITHOUT throwing, so the catch never fires and
 * `null === 0` silently became "untracked". That fails OPEN into the exact trap the check
 * exists to close, on the exact surface that can't be tested from dev: a packaged app
 * launched from Finder has a minimal PATH and may have no `git` at all.
 *
 * The common shipped case never shells out — a standalone project with no `.git` anywhere
 * above it is definitively untracked by inspection, so the DMG doesn't need git on PATH.
 */
export type TrackedState = 'tracked' | 'untracked' | 'unknown';

export function gitTrackedState(file: string): TrackedState {
  const dir = path.dirname(file);
  if (!inGitRepo(dir)) return 'untracked'; // not a repo → nothing can track it. No spawn.
  try {
    const r = spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', path.basename(file)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000,
    });
    if (r.error || r.status == null) return 'unknown'; // ENOENT / timeout / killed
    return r.status === 0 ? 'tracked' : 'untracked';
  } catch {
    return 'unknown';
  }
}

/**
 * Ignore the `.mcp.json` we just wrote — but only when that's OUR file to ignore.
 *
 * Refuses when:
 *  - it's an ANCESTOR config (we adopted a file we didn't create; adding a `.gitignore`
 *    entry to someone's repo root for it is not ours to do), or
 *  - git tracks it, or we COULDN'T TELL. The entry would be a no-op that reads like a
 *    fact (git keeps tracking a tracked file regardless of `.gitignore`), and a
 *    `.gitignore` line is a convenience — worth skipping rather than guessing wrong.
 */
export function ensureMcpGitignored(target: McpTarget): boolean {
  if (target.location !== 'project') return false;
  if (gitTrackedState(target.mcpPath) !== 'untracked') return false;
  return ensureGitignored(path.dirname(target.mcpPath), MCP_FILE);
}

export const CLAUDE_MD_FILE = 'CLAUDE.md';

/** Why the primer was or wasn't copied — so Connect can report it and stay silent when
 *  there was nothing to do. */
export type ClaudeMdReason = 'exists' | 'no-template' | 'written' | 'error';

export interface ClaudeMdResult {
  written: boolean;
  reason: ClaudeMdReason;
  /** The file we wrote (only when written), for the panel note. */
  path?: string;
}

/**
 * Copy the starter CLAUDE.md primer into a project that has none (§5.3).
 *
 * A scaffolded project already ships this primer, so a `claude` run there knows the whole
 * agent surface (the verify loop, Percept, Enact, CDP, the GUID rule). But an *opened
 * existing* project — a hand-made or imported game — has no primer, so its `claude` starts
 * blind: it doesn't know `modoki_get_scene_state` exists, let alone to prefer it over a
 * screenshot. Connecting such a project is exactly the moment to offer the primer.
 *
 * Hard rules:
 *  - **NEVER overwrite.** A project's own CLAUDE.md is the human's instructions — untouchable.
 *    Absent is the ONLY trigger.
 *  - Writes to the PROJECT ROOT, not the `.mcp.json` location. CLAUDE.md is genuinely
 *    project-scoped (claude reads it from cwd upward like `.mcp.json`, but unlike the config
 *    there's no single-owner collision to resolve — an ancestor's CLAUDE.md and the
 *    project's both apply). So the game's own primer belongs in the game folder. In practice
 *    this never fires for an in-repo game: those already carry a CLAUDE.md.
 *  - Missing template ⇒ a quiet no-op, never a thrown Connect. A packaging drop that lost
 *    the template must not break the actual wiring.
 *
 * `__GAME_NAME__` is the only token in the primer; `projectName` fills it (falling back to
 * the folder name is the caller's job).
 */
export function ensureProjectClaudeMd(opts: {
  projectRoot: string;
  templatePath: string;
  projectName: string;
}): ClaudeMdResult {
  const dest = path.join(opts.projectRoot, CLAUDE_MD_FILE);
  // lstat, NOT existsSync: existsSync FOLLOWS a symlink, so a CLAUDE.md that is a symlink to
  // a currently-unreachable target (an unmounted volume) would read as "absent" — and
  // atomicWriteFileSync's temp+rename replaces the LINK itself, silently destroying the
  // human's pointer to their real instructions. Any directory entry at all = present.
  try {
    fs.lstatSync(dest);
    return { written: false, reason: 'exists' };
  } catch {
    /* ENOENT — genuinely absent, the only case we write */
  }
  let template: string;
  try {
    template = fs.readFileSync(opts.templatePath, 'utf8');
  } catch {
    return { written: false, reason: 'no-template' };
  }
  try {
    const text = template.split('__GAME_NAME__').join(opts.projectName);
    atomicWriteFileSync(dest, text);
    return { written: true, reason: 'written', path: dest };
  } catch {
    return { written: false, reason: 'error' };
  }
}

/** Why a heal did or didn't happen — lets the caller stay silent for the normal cases
 *  and WARN for the one that silently breaks the user ('unparseable'). */
export type HealReason = 'absent' | 'unparseable' | 'not-ours' | 'fresh' | 'healed' | 'tracked';

export interface HealResult {
  healed: boolean;
  reason: HealReason;
  oldPort?: number | null;
  newPort?: number;
  mcpPath?: string;
  /** WHICH axes were actually repaired. The caller's dialog says what changed, and "the
   *  editor's port changed" would be a lie for a token-only heal. */
  changed?: Array<'backend' | 'cdp' | 'token'>;
}

/**
 * Auto-heal a project's `.mcp.json` when the editor bound a different port than the one
 * baked in it (C5, docs/connect-claude-code.md §9). Rewrites the config with the live
 * ports so `claude` in that folder targets the running editor.
 *
 * Deliberately SCOPED — it heals only when ALL of:
 *   - a `.mcp.json` exists, AND
 *   - it already contains OUR `modoki` server (i.e. the user connected before), AND
 *   - the baked backend port differs from the live one.
 * So we never create a config for a project that never connected, and never touch a
 * `.mcp.json` that isn't ours. Other servers survive (mergeMcpConfig).
 *
 * The caller announces the change: Claude Code bakes MODOKI_BACKEND at MCP-spawn time,
 * so a healed port only takes effect after the user RESTARTS `claude`.
 */
export function healMcpPort(opts: {
  /** The config actually in effect — `resolveMcpTarget().mcpPath`, NOT
   *  `<projectRoot>/.mcp.json`. For an in-repo game those differ, and healing the latter
   *  repairs a file the user's `claude` never reads (C9, §13). */
  mcpPath: string;
  backendPort: number;
  cdpPort?: number | null;
  /** C6: this editor's token for the project. A baked token that DIFFERS is repaired like
   *  a drifted port — the case that matters is a wiped/reset userData, which would
   *  otherwise 403 the user against their own editor forever with no way back but a manual
   *  Reconnect. A config with NO baked token is left alone (pre-C6 configs keep working;
   *  adding one would cost a `claude` restart for zero functional gain). */
  token?: string | null;
  /** Test seam ONLY — inject the tracked verdict instead of shelling out to git. */
  trackedState?: TrackedState;
}): HealResult {
  const { mcpPath } = opts;
  let existing: string;
  try {
    existing = fs.readFileSync(mcpPath, 'utf8');
  } catch {
    return { healed: false, reason: 'absent' }; // never connected → we don't create one
  }

  let config: McpConfig;
  try {
    const parsed: unknown = JSON.parse(stripBom(existing));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    config = parsed as McpConfig;
  } catch {
    // Refuse to touch it (never clobber), but the caller WARNS: the user's claude can't
    // use this file at all, and nothing else would say so.
    return { healed: false, reason: 'unparseable', mcpPath };
  }

  const servers = config.mcpServers;
  const modoki = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)['modoki'] : undefined;
  const modokiObj = modoki && typeof modoki === 'object' && !Array.isArray(modoki) ? (modoki as Record<string, unknown>) : undefined;
  const env = modokiObj?.env && typeof modokiObj.env === 'object' ? (modokiObj.env as Record<string, unknown>) : undefined;
  const oldPort = urlPort(typeof env?.MODOKI_BACKEND === 'string' ? env.MODOKI_BACKEND : undefined);
  if (!modokiObj || oldPort == null) return { healed: false, reason: 'not-ours', mcpPath };

  // Locate an EXISTING chrome-devtools entry (never ADD one — that's Connect's job; heal
  // only repairs what's already wired).
  const chrome = (servers as Record<string, unknown> | undefined)?.['chrome-devtools'];
  const chromeObj = chrome && typeof chrome === 'object' && !Array.isArray(chrome) ? (chrome as Record<string, unknown>) : undefined;
  const chromeArgs = Array.isArray(chromeObj?.args) ? (chromeObj.args as unknown[]) : null;
  const oldCdp = chromeArgs
    ? urlPort((chromeArgs.find((a): a is string => typeof a === 'string' && a.startsWith('--browser-url=')) ?? '').slice('--browser-url='.length) || undefined)
    : null;

  // Check BOTH axes before deciding. The backend port is sticky by design (C5), so the
  // common relaunch keeps it stable while CDP may well have moved — returning 'fresh' on
  // the backend alone would leave a drifted --browser-url baked forever.
  const oldToken = typeof env?.MODOKI_TOKEN === 'string' && env.MODOKI_TOKEN ? env.MODOKI_TOKEN : null;
  const backendDrifted = oldPort !== opts.backendPort;
  const cdpDrifted = opts.cdpPort != null && oldCdp != null && oldCdp !== opts.cdpPort;
  const tokenDrifted = opts.token != null && oldToken != null && oldToken !== opts.token;
  if (!backendDrifted && !cdpDrifted && !tokenDrifted) return { healed: false, reason: 'fresh', mcpPath };

  // ── The write boundary for an UNATTENDED heal: never a file git tracks. ──
  //
  // A tracked `.mcp.json` is a SHARED, committed artifact, not machine state. C9 made this
  // reachable: heal used to target `<projectRoot>/.mcp.json` (a game folder — never
  // tracked), and now targets the ADOPTED config, which for an in-repo game is the repo
  // root's — committed, in this very repo. Rewriting it on every launch would:
  //   - dirty the working tree with no user action, and
  //   - thrash across clones: CLAUDE.md pins 5179/5180/5181 per clone and the file is
  //     merged via origin, so each editor would rewrite it to its own port forever.
  // This repo's committed config is also deliberately GENERIC — `${MODOKI_BACKEND:-…}` plus
  // relative paths, so one file serves every clone. Baking a literal port into it destroys
  // the mechanism it exists to provide.
  //
  // The doctrine (§11.1): a surprise write is worse than a clear error. So we refuse, the
  // panel reports stale, and Reconnect — an explicit click on the user's own repo, where
  // git shows them the diff — remains available. Checked only AFTER drift is established,
  // so the common no-op launch never spawns git.
  if (opts.trackedState !== undefined ? opts.trackedState !== 'untracked' : gitTrackedState(mcpPath) !== 'untracked') {
    return { healed: false, reason: 'tracked', mcpPath, oldPort };
  }

  // PATCH, don't rebuild. This runs UNATTENDED at startup, so it must touch the minimum:
  // only the port(s) that drifted. A full mergeMcpConfig rewrite would silently drop any
  // field the user added to their modoki entry (an extra env var, `cwd`, a custom command)
  // — acceptable for an explicit Connect click, not for a background heal.
  if (backendDrifted || tokenDrifted) {
    modokiObj.env = {
      ...env,
      ...(backendDrifted ? { MODOKI_BACKEND: `http://127.0.0.1:${opts.backendPort}` } : {}),
      ...(tokenDrifted ? { MODOKI_TOKEN: opts.token } : {}),
    };
  }
  if (cdpDrifted && chromeObj && chromeArgs) {
    chromeObj.args = chromeArgs.map((a) =>
      typeof a === 'string' && a.startsWith('--browser-url=') ? `--browser-url=http://127.0.0.1:${opts.cdpPort}` : a,
    );
  }

  atomicWriteFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  const changed: Array<'backend' | 'cdp' | 'token'> = [];
  if (backendDrifted) changed.push('backend');
  if (cdpDrifted) changed.push('cdp');
  if (tokenDrifted) changed.push('token');
  return { healed: true, reason: 'healed', oldPort, newPort: opts.backendPort, mcpPath, changed };
}

/**
 * Append `entry` (e.g. `.mcp.json`) to the project's `.gitignore` if one EXISTS and
 * doesn't already ignore it. No-op when there's no `.gitignore` (don't assume git, and
 * don't create ignore files the user didn't ask for). The packaged `.mcp.json` bakes an
 * absolute app-bundle path, so it shouldn't be committed. Returns whether it changed.
 */
export function ensureGitignored(projectRoot: string, entry: string): boolean {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let text: string;
  try {
    text = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    return false; // no .gitignore → nothing to do
  }
  const already = text.split(/\r?\n/).some((line) => line.trim() === entry);
  if (already) return false;
  const needsNl = text.length > 0 && !text.endsWith('\n');
  atomicWriteFileSync(gitignorePath, text + (needsNl ? '\n' : '') + entry + '\n');
  return true;
}

/** `which`/`where claude` against the given env's PATH. Null if not found. */
function whichClaude(env: NodeJS.ProcessEnv): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(finder, ['claude'], { encoding: 'utf8', env });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
  } catch { /* ignore */ }
  return null;
}

/** Resolve `claude` via the user's LOGIN shell PATH (macOS/Linux). A DMG launched from
 *  Finder/Gatekeeper inherits a MINIMAL PATH that omits ~/.local/bin, /opt/homebrew/bin,
 *  npm-global, etc. — so a real install looks "not found". A login+interactive shell
 *  sources the user's profile and reports the true PATH. */
function loginShellClaude(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null;
  const shell = env.SHELL || '/bin/zsh';
  try {
    const r = spawnSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    if (r.status === 0 && r.stdout) {
      const p = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
      if (p && p.startsWith('/')) return p;
    }
  } catch { /* ignore */ }
  return null;
}

// Memoize: the status panel polls ~every 2.5s and each poll calls this; without a cache
// we'd spawn a login shell on every poll when claude isn't on the app's stripped PATH.
// A found result is stable for the session; a not-found is re-checked at most every 15s
// (so installing claude mid-session is picked up without a relaunch).
let _claudeMemo: { at: number; result: { found: boolean; path?: string } } | null = null;
const CLAUDE_MEMO_TTL_MS = 15_000;

/** Is the `claude` CLI available? Checks the inherited PATH first (fast; correct in dev
 *  and terminal launches), then falls back to the login-shell PATH for a Finder-launched
 *  DMG. Result shape is stable so the panel can show "install Claude Code" when absent. */
export function detectClaudeCli(env: NodeJS.ProcessEnv = process.env): { found: boolean; path?: string } {
  const now = Date.now();
  if (_claudeMemo && (_claudeMemo.result.found || now - _claudeMemo.at < CLAUDE_MEMO_TTL_MS)) {
    return _claudeMemo.result;
  }
  const resolved = whichClaude(env) ?? loginShellClaude(env);
  const result = resolved ? { found: true, path: resolved } : { found: false };
  _claudeMemo = { at: now, result };
  return result;
}

/** Test hook: clear the detectClaudeCli memo. */
export function _resetClaudeMemo(): void {
  _claudeMemo = null;
}
