import { describe, it, expect } from 'vitest';
import { connectionSummary, portRows, runInstruction, isBackendDeferred, type ConnectStatus } from '../../src/editor/panels/aiPanelModel';

/**
 * C3 — the AI ("Connect Claude Code") panel's pure display logic. The panel keys its
 * headline colour, message, and primary-button label off connectionSummary(), so the
 * branch order (backend down → not written → stale → no-claude → ok) is pinned here.
 */
const base: ConnectStatus = {
  projectRoot: '/home/me/game',
  backendPort: 5179,
  vitePort: 5173,
  cdpPort: null,
  cdpEnabled: false,
  isPackaged: true,
  backendReachable: true,
  viteReachable: true,
  claude: { found: true },
  mcpWritten: true,
  mcpOurs: true,
  mcpStale: false,
};

describe('connectionSummary', () => {
  it('null payload → error, no action (not in the desktop editor)', () => {
    expect(connectionSummary(null)).toMatchObject({ level: 'error', action: null });
  });

  it('backend unreachable → error, no action', () => {
    expect(connectionSummary({ ...base, backendReachable: false })).toMatchObject({ level: 'error', action: null });
  });

  it('not written → action Connect', () => {
    expect(connectionSummary({ ...base, mcpWritten: false })).toMatchObject({ level: 'action', action: 'Connect' });
  });

  it('stale → action Reconnect', () => {
    expect(connectionSummary({ ...base, mcpStale: true })).toMatchObject({ level: 'action', action: 'Reconnect' });
  });

  it('a file that exists but is NOT a usable modoki config never reads as Connected', () => {
    // Corrupt JSON / someone else's config: we refuse to overwrite it unprompted, so the
    // panel must say so — otherwise it shows "Connected" while claude reaches nothing.
    const s = connectionSummary({ ...base, mcpOurs: false });
    expect(s.level).toBe('action');
    expect(s.action).toBe('Connect');
    expect(s.message).toMatch(/isn.t a usable Modoki config/i);
  });

  it('mcpOurs undefined (older backend) is treated as fine — no false alarm', () => {
    expect(connectionSummary({ ...base, mcpOurs: undefined })).toMatchObject({ level: 'ok' });
  });

  it('a config aiming chrome-devtools at an UNVERIFIED CDP port never reads as Connected', () => {
    // The original bug displaced into the file: a .mcp.json written before verification
    // existed still points Claude at another editor's renderer. We don't delete the user's
    // entry, so the panel is the only place this can surface.
    const s = connectionSummary({ ...base, mcpChromePort: 9222, mcpCdpForeign: true });
    expect(s.level).toBe('error');
    expect(s.message).toMatch(/9222/);
    expect(s.message).toMatch(/another editor/i);
  });

  it('chrome-devtools aimed at a VERIFIED-ours port is fine', () => {
    expect(connectionSummary({ ...base, mcpChromePort: 9222, mcpCdpForeign: false })).toMatchObject({ level: 'ok' });
  });

  it('a config written for ANOTHER editor never reads as Connected (C6)', () => {
    // Its calls are being 403'd — the panel is where the user learns why.
    const s = connectionSummary({ ...base, mcpTokenForeign: true });
    expect(s.level).toBe('error');
    expect(s.action).toBe('Reconnect');
    expect(s.message).toMatch(/different editor/i);
  });

  it('the token verdict beats the generic stale message (which blames a port)', () => {
    expect(connectionSummary({ ...base, mcpTokenForeign: true, mcpStale: true }).level).toBe('error');
  });

  it('written but no claude → action (prompt install)', () => {
    const s = connectionSummary({ ...base, claude: { found: false } });
    expect(s.level).toBe('action');
    expect(s.message).toMatch(/claude/i);
  });

  it('all good → ok, Reconnect available', () => {
    expect(connectionSummary(base)).toMatchObject({ level: 'ok', action: 'Reconnect' });
  });

  it('backend-down takes precedence over an un-written config', () => {
    expect(connectionSummary({ ...base, backendReachable: false, mcpWritten: false })).toMatchObject({ level: 'error', action: null });
  });
});

describe('portRows', () => {
  it('marks a reachable backend/vite ok and CDP off when disabled', () => {
    const rows = portRows(base);
    expect(rows.find((r) => r.label.startsWith('Backend'))).toMatchObject({ value: '5179', level: 'ok' });
    expect(rows.find((r) => r.label.startsWith('Vite'))).toMatchObject({ value: '5173', level: 'ok' });
    expect(rows.find((r) => r.label.startsWith('CDP'))).toMatchObject({ value: 'disabled', level: 'off' });
  });

  // The CDP row must never lie. Found live: a packaged editor showed "CDP 9222" GREEN
  // while 9222 belonged to a sibling clone's editor — so green requires PROVED-ours.
  const cdp = (s: Partial<ConnectStatus>) => portRows({ ...base, ...s }).find((r) => r.label.startsWith('CDP'))!;

  it('CDP verified ours → ok (green)', () => {
    expect(cdp({ cdpEnabled: true, cdpPort: 9222, cdpReachable: true, cdpOurs: true })).toMatchObject({ value: '9222', level: 'ok' });
  });

  it('CDP enabled + reachable but NOT ours → down, and says another editor holds it', () => {
    const r = cdp({ cdpEnabled: true, cdpPort: null, cdpConfiguredPort: 9222, cdpReachable: true, cdpOurs: false });
    expect(r.level).toBe('down'); // never green
    expect(r.value).toMatch(/9222.*another editor/i);
  });

  it('CDP enabled but the port never bound → down, unavailable', () => {
    const r = cdp({ cdpEnabled: true, cdpPort: null, cdpConfiguredPort: 9222, cdpReachable: false, cdpOurs: false });
    expect(r.level).toBe('down');
    expect(r.value).toMatch(/9222.*unavailable/i);
  });

  it('unreachable backend → down', () => {
    expect(portRows({ ...base, backendReachable: false }).find((r) => r.label.startsWith('Backend'))).toMatchObject({ level: 'down' });
  });
});

describe('runInstruction', () => {
  it('quotes the project path for the terminal', () => {
    expect(runInstruction('/home/me/my game')).toBe('cd "/home/me/my game" && claude');
  });
});

/**
 * C9 / C9b — the panel must name the file `claude` will actually READ, and must not go
 * green on a config whose target it cannot know.
 */
describe('isBackendDeferred', () => {
  it('a ${VAR:-default} expansion is deferred to the shell', () => {
    expect(isBackendDeferred('${MODOKI_BACKEND:-http://127.0.0.1:5179}')).toBe(true);
    expect(isBackendDeferred('${MODOKI_BACKEND}')).toBe(true);
  });
  it('a literal URL is not', () => {
    expect(isBackendDeferred('http://127.0.0.1:5179')).toBe(false);
    expect(isBackendDeferred(null)).toBe(false);
    expect(isBackendDeferred(undefined)).toBe(false);
  });
});

describe('connectionSummary — C9 config location + expansion', () => {
  it('run instruction cds to the CONFIG dir, which for an in-repo game is NOT the project', () => {
    // The whole point of C9: `claude` searches upward only, so for games/3d-test the
    // effective config is the repo root's — and the repo root is where it must be run.
    expect(runInstruction('/home/me/repo')).toBe('cd "/home/me/repo" && claude');
  });

  it('a ${VAR:-default} config is NOT green — we cannot know which editor it resolves to', () => {
    // THIS REPO's committed .mcp.json is exactly this. Claude expands it at spawn time from
    // the user's shell, which the editor can't see. Green would be a guess; "stale" would
    // be wrong too (nothing drifted). Say what's true, and give both fixes.
    // Distinct ports on purpose: the config defaults to 5179 while THIS editor is on 5180,
    // so the message has to name both or it can't show the user the mismatch.
    const s = connectionSummary({ ...base, backendPort: 5180, mcpBackendRaw: '${MODOKI_BACKEND:-http://127.0.0.1:5179}' });
    expect(s.level).toBe('action');
    expect(s.action).toBe('Reconnect');
    expect(s.message).toContain('${MODOKI_BACKEND:-http://127.0.0.1:5179}'); // what it'd reach
    expect(s.message).toContain('5180'); // …and this editor's port
  });

  it('a rival modoki config on the path → warn, because the cwd decides which editor wins', () => {
    const s = connectionSummary({ ...base, mcpShadowing: ['/home/me/.mcp.json'] });
    expect(s.level).toBe('action');
    expect(s.message).toContain('/home/me/.mcp.json');
  });

  it('no rivals → still green (the warning must not fire on a healthy setup)', () => {
    expect(connectionSummary({ ...base, mcpShadowing: [] })).toMatchObject({ level: 'ok' });
  });

  it('a config with our modoki server but an unparseable port is still OURS (not "unusable")', () => {
    // mcpOurs used to mean "has a parseable backend port", so a ${VAR} config read as
    // someone else's and the panel pushed the user to overwrite it.
    const s = connectionSummary({ ...base, mcpOurs: true, mcpBackendRaw: '${MODOKI_BACKEND}' });
    expect(s.message).not.toContain('isn’t a usable Modoki config');
  });
});
