// Pure display logic for the AI ("Connect Claude Code") panel — separated from the
// React view so the status → summary derivation is unit-testable without a renderer.
// See docs/connect-claude-code.md.

/** The status payload returned by the main-process `modoki:connect-claude-status` IPC. */
export interface ConnectStatus {
  projectRoot: string;
  /** The config claude will actually LOAD — NOT necessarily `<projectRoot>/.mcp.json`
   *  (C9, §13). The panel shows this path verbatim: for an in-repo game it's the repo
   *  root's file, which the user cannot infer. */
  mcpPath?: string;
  /** The directory to run `claude` in (the config's own dir — deeper cwds work too,
   *  since discovery walks up). */
  mcpDir?: string;
  /** 'ancestor' ⇒ the effective config lives ABOVE the project. */
  mcpLocation?: 'project' | 'ancestor';
  /** Other `.mcp.json` files claude would also merge (nearest-first). Non-empty ⇒ which
   *  editor a `modoki` call reaches depends on the cwd `claude` is launched in. */
  mcpShadowing?: string[];
  backendPort: number | null;
  vitePort: number | null;
  /** A CDP endpoint that is OURS, else null (never a port we merely asked Chromium for). */
  cdpPort: number | null;
  /** We asked Chromium for the port — says NOTHING about whether it bound. */
  cdpEnabled: boolean;
  /** Something answered on the configured port. */
  cdpReachable?: boolean;
  /** …and it's our renderer. Enabled + reachable + !ours ⇒ ANOTHER editor holds it. */
  cdpOurs?: boolean;
  /** The port we asked for (shown when it isn't ours, so the user can free it). */
  cdpConfiguredPort?: number | null;
  /** Whose page answered instead — diagnostics for the not-ours case. */
  cdpForeignPageUrl?: string;
  isPackaged: boolean;
  backendReachable: boolean;
  viteReachable: boolean;
  claude: { found: boolean; path?: string };
  /** A `.mcp.json` FILE exists (says nothing about whether it's usable). */
  mcpWritten: boolean;
  /** …and it actually carries our modoki server. False ⇒ corrupt, or someone else's
   *  config — which must NOT read as "Connected" (Claude would silently reach nothing). */
  mcpOurs?: boolean;
  /** The RAW MODOKI_BACKEND string. May be a `${VAR:-default}` expansion rather than a
   *  literal URL — Claude Code resolves those at spawn time from the user's shell, so we
   *  genuinely cannot know which editor it lands on. */
  mcpBackendRaw?: string | null;
  /** The effective config is version-controlled ⇒ the unattended heal refuses to touch it. */
  mcpTracked?: boolean;
  /** The CDP port the project's .mcp.json itself names (independent of our own state). */
  mcpChromePort?: number | null;
  /** The config names a CDP port but we have NOT verified any endpoint as ours ⇒ Claude
   *  may be driving another editor's renderer. Must never read as a clean "Connected". */
  mcpCdpForeign?: boolean;
  /** C6: the config's MODOKI_TOKEN names a DIFFERENT editor/project, so this editor is
   *  refusing its calls with a 403. Normally auto-healed on open; surfaced for the cases
   *  heal won't touch (a config we didn't write, or one it couldn't parse). */
  mcpTokenForeign?: boolean;
  mcpStale: boolean;
}

/** The result of `modoki:connect-claude`. */
export interface ConnectResult {
  ok: boolean;
  error?: string;
  projectRoot?: string;
  backendUrl?: string;
  mcpPath?: string;
  cdpPort?: number | null;
  /** Why the chrome-devtools entry was NOT written (CDP enabled but not verifiably ours).
   *  Surfaced so "no CDP" is explained rather than mysterious. */
  cdpSkipped?: string;
  /** We wrote a git-TRACKED config (an explicit click may; the unattended heal may not) —
   *  the user just baked machine-local ports into a committed, shared file. */
  mcpTrackedWarning?: string;
  mcpLocation?: 'project' | 'ancestor';
  mcpShadowing?: string[];
  gitignored?: boolean;
  /** We copied the starter CLAUDE.md primer in (the project had none) so `claude` knows
   *  the tool surface. Never set when the project already had its own CLAUDE.md. */
  claudeMdWritten?: boolean;
  claude?: { found: boolean; path?: string };
}

export type PortLevel = 'ok' | 'down' | 'off';

export interface PortRow {
  label: string;
  /** Human text for the value column, e.g. "5179", "disabled". */
  value: string;
  level: PortLevel;
}

/** The three port rows the panel shows. `off` = not applicable (e.g. CDP disabled),
 *  `down` = expected but unreachable, `ok` = live. */
export function portRows(s: ConnectStatus): PortRow[] {
  const rows: PortRow[] = [
    {
      label: 'Backend (MCP)',
      value: s.backendPort != null ? String(s.backendPort) : '—',
      level: s.backendReachable ? 'ok' : 'down',
    },
    {
      label: 'Vite (renderer)',
      value: s.vitePort != null ? String(s.vitePort) : '—',
      level: s.viteReachable ? 'ok' : 'down',
    },
    cdpRow(s),
  ];
  return rows;
}

/**
 * The CDP row — the one that must never lie. `cdpEnabled` only means we asked Chromium
 * for the port; it can fail to bind silently, or the port can be held by ANOTHER editor
 * (observed: a packaged editor showed "CDP 9222" green while 9222 was a sibling clone's
 * editor, and the written .mcp.json would have aimed Claude at that other renderer).
 * So: green ONLY when the endpoint was probed and proved ours.
 */
function cdpRow(s: ConnectStatus): PortRow {
  if (!s.cdpEnabled) return { label: 'CDP (renderer debug)', value: 'disabled', level: 'off' };
  if (s.cdpOurs && s.cdpPort != null) return { label: 'CDP (renderer debug)', value: String(s.cdpPort), level: 'ok' };
  const port = s.cdpConfiguredPort ?? s.cdpPort;
  // Reachable but not ours = someone else owns the port. Unreachable = it never bound.
  const value = s.cdpReachable ? `${port ?? '?'} in use by another editor` : `${port ?? '?'} unavailable`;
  return { label: 'CDP (renderer debug)', value, level: 'down' };
}

/** Is MODOKI_BACKEND a shell expansion rather than a literal URL? Claude Code resolves
 *  `${VAR}` / `${VAR:-default}` in `.mcp.json` at MCP-spawn time from the user's own
 *  environment — which the editor cannot see, so the target editor is genuinely unknown. */
export function isBackendDeferred(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.includes('${');
}

export type SummaryLevel = 'ok' | 'action' | 'error';

export interface ConnectionSummary {
  level: SummaryLevel;
  message: string;
  /** The primary action button label, or null when there's nothing to do. */
  action: 'Connect' | 'Reconnect' | null;
}

/** Derive the one-line status + the primary action from the payload. The panel keys
 *  its headline, colour, and button label off this. */
export function connectionSummary(s: ConnectStatus | null): ConnectionSummary {
  if (s == null) {
    return { level: 'error', message: 'Not running inside the Modoki desktop editor — the AI connection is unavailable.', action: null };
  }
  if (!s.backendReachable) {
    return { level: 'error', message: 'Editor backend is not reachable yet — wait for it to start, then re-check.', action: null };
  }
  if (!s.mcpWritten) {
    return { level: 'action', message: 'Not connected. Click Connect to write .mcp.json into this project.', action: 'Connect' };
  }
  // A file exists but isn't a usable modoki config (corrupt JSON, or someone else's).
  // We deliberately never overwrite it unprompted — but it must not read as "Connected",
  // because Claude Code would silently reach nothing.
  if (s.mcpOurs === false) {
    return {
      level: 'action',
      message: 'This project has a .mcp.json that isn’t a usable Modoki config (unreadable, or missing the modoki server). Click Connect to write one.',
      action: 'Connect',
    };
  }
  // The config names a different editor (C6), so this one is 403ing every call it makes.
  // Checked before `mcpStale` — which also fires here, but reports it as a changed port.
  if (s.mcpTokenForeign) {
    return {
      level: 'error',
      message: 'This project’s .mcp.json was written for a DIFFERENT editor — this one refuses its requests rather than silently applying them. Click Reconnect, then restart `claude`.',
      action: 'Reconnect',
    };
  }
  // The config defers MODOKI_BACKEND to the shell (`${VAR}` / `${VAR:-default}`, which
  // Claude Code expands at spawn time). We CANNOT know what it resolves to — so neither a
  // green "Connected" nor a red "stale" is honest. Say exactly what's true and give both
  // fixes. (This repo's own committed .mcp.json is deliberately written this way.)
  if (isBackendDeferred(s.mcpBackendRaw)) {
    return {
      level: 'action',
      message: `This config leaves MODOKI_BACKEND to your shell (\`${s.mcpBackendRaw}\`), so Claude will reach whatever that resolves to — not necessarily this editor (port ${s.backendPort ?? '?'}). Either export MODOKI_BACKEND=http://127.0.0.1:${s.backendPort ?? '?'} before running \`claude\`, or Reconnect to bake this editor's port in.`,
      action: 'Reconnect',
    };
  }
  if (s.mcpStale) {
    return { level: 'action', message: 'Configuration is out of date — click Reconnect, then restart `claude`.', action: 'Reconnect' };
  }
  // The config aims chrome-devtools at a CDP port we could NOT verify as ours — so Claude
  // may attach to a DIFFERENT editor's renderer with every call quietly succeeding. We
  // never delete the user's entry, so this is the only place it can surface.
  if (s.mcpCdpForeign) {
    return {
      level: 'error',
      message: `This project’s .mcp.json points chrome-devtools at port ${s.mcpChromePort ?? '?'}, which is NOT this editor — Claude would drive another editor’s renderer. Free that port and Reconnect, or remove the chrome-devtools entry.`,
      action: 'Reconnect',
    };
  }
  if (!s.claude.found) {
    return { level: 'action', message: 'Config written, but the `claude` CLI wasn’t found — install Claude Code, then run it in the folder shown below.', action: 'Reconnect' };
  }
  // Several .mcp.json on the path: claude MERGES them and the NEAREST file wins per server
  // name (measured). So a `modoki` call reaches whichever editor the user's cwd resolves to
  // — a silent mis-target (C6's bug with a new cause). We won't delete someone else's
  // config, so saying so is the only honest move.
  if (s.mcpShadowing && s.mcpShadowing.length > 0) {
    return {
      level: 'action',
      message: `Connected, but ${s.mcpShadowing.length} other .mcp.json ${s.mcpShadowing.length === 1 ? 'file' : 'files'} on this path also define MCP servers (${s.mcpShadowing.join(', ')}). Whichever is NEAREST your terminal's folder wins — run \`claude\` in the folder shown below, or remove the duplicate modoki entry.`,
      action: 'Reconnect',
    };
  }
  return { level: 'ok', message: 'Connected. Open a terminal in the folder shown below and run `claude`.', action: 'Reconnect' };
}

/** The copy-paste terminal instruction. Takes the CONFIG's directory, not the project
 *  root — for an in-repo game the config lives at the repo root (C9), and `cd`-ing into
 *  the game folder would still work (discovery walks up) but is not what we can promise
 *  in general. */
export function runInstruction(dir: string): string {
  return `cd "${dir}" && claude`;
}
