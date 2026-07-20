import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildMcpServerEntry,
  buildChromeDevtoolsEntry,
  mergeMcpConfig,
  mcpBackendPort,
  mcpToken,
  mcpChromePort,
  isMcpStale,
  isMcpTokenForeign,
  ensureGitignored,
  atomicWriteFileSync,
  detectClaudeCli,
  healMcpPort,
  resolveMcpTarget,
  ensureMcpGitignored,
  ensureProjectClaudeMd,
  gitTrackedState,
  mcpHasModoki,
  mcpBackendRaw,
  _resetClaudeMemo,
} from '../../electron/connectClaude';

/**
 * C2 unit gate — the "Connect Claude Code" .mcp.json writer.
 *
 * The load-bearing correctness property: mergeMcpConfig must set ONLY our servers and
 * PRESERVE every other MCP server + top-level field a user already has. A regression
 * that clobbers a user's game-debug / their-own chrome-devtools / unrelated keys would
 * silently break their setup on every Connect — so it's pinned hard here.
 */
describe('buildMcpServerEntry', () => {
  it('macOS/Linux packaged → node dist/index.js (self-contained, absolute, forward-slashed)', () => {
    const e = buildMcpServerEntry('/opt/Modoki.app/Contents/Resources/app.asar.unpacked', true, 'darwin');
    expect(e.command).toBe('node');
    expect(e.args).toEqual(['/opt/Modoki.app/Contents/Resources/app.asar.unpacked/engine/tools/modoki-mcp/dist/index.js']);
    expect(e.env).toBeUndefined();
  });

  it('dev on macOS/Linux → npx tsx src/index.ts (live source)', () => {
    const e = buildMcpServerEntry('/home/me/modoki', false, 'linux');
    expect(e.command).toBe('npx');
    expect(e.args).toEqual(['tsx', '/home/me/modoki/engine/tools/modoki-mcp/src/index.ts']);
  });

  it('Windows dev → editor binary + ELECTRON_RUN_AS_NODE on dist (npx.cmd unspawnable; bare node off Claude Code\'s sanitized PATH)', () => {
    // Regression: Claude Code spawns an MCP command WITHOUT a shell. npx is a .cmd
    // (CreateProcess can't run it), and bare `node` must be on Claude Code's spawn PATH
    // (sanitized — a portable/user-PATH Node isn't there). process.execPath is absolute +
    // always present, run as node via ELECTRON_RUN_AS_NODE.
    const e = buildMcpServerEntry('C:\\Users\\me\\modoki', false, 'win32', 'C:\\Users\\me\\modoki\\node_modules\\electron\\dist\\electron.exe');
    expect(e.command).toBe('C:/Users/me/modoki/node_modules/electron/dist/electron.exe');
    expect(e.command).not.toContain('\\');
    expect(e.args).toEqual(['C:/Users/me/modoki/engine/tools/modoki-mcp/dist/index.js']);
    expect(e.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('Windows packaged → same editor-binary form (absolute, PATH-independent)', () => {
    const e = buildMcpServerEntry('C:\\Program Files\\Modoki Editor\\resources\\app.asar.unpacked', true, 'win32', 'C:\\Program Files\\Modoki Editor\\Modoki Editor.exe');
    expect(e.command).toBe('C:/Program Files/Modoki Editor/Modoki Editor.exe');
    expect(e.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('forward-slashes a Windows dist path (clean JSON, Node runs it either way)', () => {
    const e = buildMcpServerEntry('C:\\Users\\shois\\AppData\\app.asar.unpacked', true, 'darwin');
    expect(e.args[0]).toBe('C:/Users/shois/AppData/app.asar.unpacked/engine/tools/modoki-mcp/dist/index.js');
    expect(e.args[0]).not.toContain('\\');
  });
});

describe('buildChromeDevtoolsEntry', () => {
  it('bakes the live CDP port into --browser-url', () => {
    expect(buildChromeDevtoolsEntry(9222)).toEqual({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9222'],
    });
  });
});

describe('mergeMcpConfig', () => {
  const modoki = { command: 'node', args: ['/x/dist/index.js'] };
  const chrome = { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9222'] };

  it('starts fresh from null → only modoki + its MODOKI_BACKEND env', () => {
    const out = JSON.parse(mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers.modoki).toEqual({ command: 'node', args: ['/x/dist/index.js'], env: { MODOKI_BACKEND: 'http://127.0.0.1:5179' } });
    expect(out.mcpServers['chrome-devtools']).toBeUndefined();
  });

  it('adds chrome-devtools only when a CDP entry is given', () => {
    const out = JSON.parse(mergeMcpConfig(null, { modoki, chromeDevtools: chrome }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers['chrome-devtools']).toEqual(chrome);
  });

  it('PRESERVES a user\'s other servers + top-level fields', () => {
    const existing = JSON.stringify({
      $schema: 'https://example/mcp.json',
      mcpServers: {
        'game-debug': { command: 'npx', args: ['tsx', 'game-debug.ts'] },
        weather: { command: 'weather-mcp', args: [] },
      },
    });
    const out = JSON.parse(mergeMcpConfig(existing, { modoki, chromeDevtools: chrome }, 'http://127.0.0.1:5199'));
    // ours set
    expect(out.mcpServers.modoki.env.MODOKI_BACKEND).toBe('http://127.0.0.1:5199');
    expect(out.mcpServers['chrome-devtools']).toEqual(chrome);
    // theirs untouched
    expect(out.mcpServers['game-debug']).toEqual({ command: 'npx', args: ['tsx', 'game-debug.ts'] });
    expect(out.mcpServers.weather).toEqual({ command: 'weather-mcp', args: [] });
    expect(out.$schema).toBe('https://example/mcp.json');
  });

  it('overwrites a prior modoki entry (we own it) but leaves an existing chrome-devtools alone when CDP is off', () => {
    const existing = JSON.stringify({
      mcpServers: {
        modoki: { command: 'npx', args: ['tsx', 'OLD.ts'], env: { MODOKI_BACKEND: 'http://127.0.0.1:1111' } },
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9000'] },
      },
    });
    const out = JSON.parse(mergeMcpConfig(existing, { modoki }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers.modoki.args).toEqual(['/x/dist/index.js']);
    expect(out.mcpServers.modoki.env.MODOKI_BACKEND).toBe('http://127.0.0.1:5179');
    // CDP off this call → we don't touch the user's existing chrome-devtools
    expect(out.mcpServers['chrome-devtools'].args).toContain('--browser-url=http://127.0.0.1:9000');
  });

  it('emits stable 2-space-indented JSON with a trailing newline', () => {
    const text = mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "mcpServers": {');
  });

  it('THROWS on a corrupt existing file rather than clobbering it', () => {
    expect(() => mergeMcpConfig('{ not json', { modoki }, 'http://127.0.0.1:5179')).toThrow(/not valid JSON/);
  });

  it('THROWS on a non-object existing file (array) rather than clobbering it', () => {
    expect(() => mergeMcpConfig('[1,2,3]', { modoki }, 'http://127.0.0.1:5179')).toThrow(/not a JSON object/);
  });

  it('treats an empty/whitespace file as fresh (not corrupt)', () => {
    const out = JSON.parse(mergeMcpConfig('   \n', { modoki }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers.modoki).toBeDefined();
  });

  it('accepts a UTF-8 BOM-prefixed file (Windows-authored) — not falsely rejected as corrupt', () => {
    const withBom = '﻿' + JSON.stringify({ mcpServers: { weather: { command: 'w', args: [] } } });
    const out = JSON.parse(mergeMcpConfig(withBom, { modoki }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers.weather).toEqual({ command: 'w', args: [] });
    expect(out.mcpServers.modoki).toBeDefined();
  });
});

describe('mcpChromePort', () => {
  it('extracts the CDP --browser-url port', () => {
    const text = mergeMcpConfig(null, { modoki: { command: 'node', args: ['x'] }, chromeDevtools: buildChromeDevtoolsEntry(9222) }, 'http://127.0.0.1:5179');
    expect(mcpChromePort(text)).toBe(9222);
  });
  it('null when there is no chrome-devtools entry', () => {
    const text = mergeMcpConfig(null, { modoki: { command: 'node', args: ['x'] } }, 'http://127.0.0.1:5179');
    expect(mcpChromePort(text)).toBeNull();
  });
});

describe('isMcpStale', () => {
  const cfg = (port: number, cdp?: number) =>
    mergeMcpConfig(null, { modoki: { command: 'node', args: ['x'] }, chromeDevtools: cdp != null ? buildChromeDevtoolsEntry(cdp) : undefined }, `http://127.0.0.1:${port}`);

  it('not stale when nothing written', () => {
    expect(isMcpStale({ mcpText: null, backendPort: 5179, cdpEnabled: false, cdpPort: null })).toBe(false);
  });
  it('not stale when backend port matches (CDP off)', () => {
    expect(isMcpStale({ mcpText: cfg(5179), backendPort: 5179, cdpEnabled: false, cdpPort: null })).toBe(false);
  });
  it('STALE when backend port drifted', () => {
    expect(isMcpStale({ mcpText: cfg(5179), backendPort: 5200, cdpEnabled: false, cdpPort: null })).toBe(true);
  });
  it('STALE when CDP just enabled but config has no chrome-devtools yet', () => {
    expect(isMcpStale({ mcpText: cfg(5179), backendPort: 5179, cdpEnabled: true, cdpPort: 9222 })).toBe(true);
  });
  it('not stale when CDP enabled and chrome port matches', () => {
    expect(isMcpStale({ mcpText: cfg(5179, 9222), backendPort: 5179, cdpEnabled: true, cdpPort: 9222 })).toBe(false);
  });
  it('STALE when CDP enabled and chrome port drifted', () => {
    expect(isMcpStale({ mcpText: cfg(5179, 9000), backendPort: 5179, cdpEnabled: true, cdpPort: 9222 })).toBe(true);
  });
});

describe('atomicWriteFileSync', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-aw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the file and leaves no temp sibling behind', () => {
    const target = path.join(dir, '.mcp.json');
    atomicWriteFileSync(target, 'hello\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello\n');
    expect(fs.readdirSync(dir)).toEqual(['.mcp.json']); // no *.tmp leftover
  });

  it('replaces existing content in place', () => {
    const target = path.join(dir, '.mcp.json');
    fs.writeFileSync(target, 'OLD');
    atomicWriteFileSync(target, 'NEW');
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
  });
});

describe('mcpBackendPort', () => {
  it('extracts the baked port', () => {
    const text = mergeMcpConfig(null, { modoki: { command: 'node', args: ['x'] } }, 'http://127.0.0.1:5181');
    expect(mcpBackendPort(text)).toBe(5181);
  });
  it('null on missing/garbage', () => {
    expect(mcpBackendPort(null)).toBeNull();
    expect(mcpBackendPort('{}')).toBeNull();
    expect(mcpBackendPort('not json')).toBeNull();
  });
});

describe('detectClaudeCli', () => {
  it('returns a stable {found} shape and memoizes the result', () => {
    _resetClaudeMemo();
    const a = detectClaudeCli();
    expect(typeof a.found).toBe('boolean');
    if (a.found) expect(typeof a.path).toBe('string');
    // Second call returns the SAME memoized object (no re-spawn on every status poll).
    expect(detectClaudeCli()).toBe(a);
  });

  it('a corrupt env does not throw (fail closed to not-found)', () => {
    _resetClaudeMemo();
    // An env with an empty PATH → neither `which` nor a login shell can resolve it.
    const r = detectClaudeCli({ PATH: '', SHELL: '/nonexistent/shell' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ found: false });
    _resetClaudeMemo();
  });
});

describe('ensureGitignored', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-gi-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('no-op when there is no .gitignore (does not create one)', () => {
    expect(ensureGitignored(dir, '.mcp.json')).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('appends when missing, preserving existing content', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\n');
    expect(ensureGitignored(dir, '.mcp.json')).toBe(true);
    const text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(text).toBe('node_modules\ndist\n.mcp.json\n');
  });

  it('adds a newline before appending when the file lacks a trailing one', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist'); // no trailing \n
    ensureGitignored(dir, '.mcp.json');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('dist\n.mcp.json\n');
  });

  it('idempotent — no duplicate on a second call', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.mcp.json\n');
    expect(ensureGitignored(dir, '.mcp.json')).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('.mcp.json\n');
  });
});

/**
 * C5 — auto-heal a stale baked port (docs/connect-claude-code.md, C5).
 *
 * Scoping is the load-bearing property: heal ONLY a project that already has OUR modoki
 * server with a stale port. Never create a .mcp.json for a project that never connected,
 * and never touch a config that isn't ours.
 */
/** C6 — the token names WHICH editor+project the config was written for, so a config that
 *  reaches the right PORT but the wrong EDITOR is refused instead of silently obeyed. */
describe('the instance token in .mcp.json', () => {
  const modoki = { command: 'node', args: ['/opt/mcp/index.js'] };

  it('mergeMcpConfig bakes MODOKI_TOKEN alongside MODOKI_BACKEND', () => {
    const out = JSON.parse(mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179', 'tok-a'));
    expect(out.mcpServers.modoki.env).toEqual({ MODOKI_BACKEND: 'http://127.0.0.1:5179', MODOKI_TOKEN: 'tok-a' });
  });

  it('no token → no MODOKI_TOKEN key at all (a pre-C6 config stays valid, not "")', () => {
    const out = JSON.parse(mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179'));
    expect(out.mcpServers.modoki.env).toEqual({ MODOKI_BACKEND: 'http://127.0.0.1:5179' });
    expect('MODOKI_TOKEN' in out.mcpServers.modoki.env).toBe(false);
  });

  it('mcpToken reads it back; absent/blank/non-string → null (never fed to a comparison)', () => {
    expect(mcpToken(mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179', 'tok-a'))).toBe('tok-a');
    expect(mcpToken(mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179'))).toBeNull();
    expect(mcpToken(JSON.stringify({ mcpServers: { modoki: { env: { MODOKI_TOKEN: '' } } } }))).toBeNull();
    expect(mcpToken(JSON.stringify({ mcpServers: { modoki: { env: { MODOKI_TOKEN: 42 } } } }))).toBeNull();
    expect(mcpToken(null)).toBeNull();
    expect(mcpToken('{ not json')).toBeNull();
  });

  it('reconnecting rewrites the token rather than accumulating env keys', () => {
    const first = mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179', 'tok-a');
    expect(mcpToken(mergeMcpConfig(first, { modoki }, 'http://127.0.0.1:5179', 'tok-b'))).toBe('tok-b');
  });
});

describe('isMcpStale — token axis', () => {
  const modoki = { command: 'node', args: ['/opt/mcp/index.js'] };
  const cfg = (token?: string) => mergeMcpConfig(null, { modoki }, 'http://127.0.0.1:5179', token);
  const stale = (mcpText: string, token: string | null) =>
    isMcpStale({ mcpText, backendPort: 5179, cdpEnabled: false, cdpPort: null, token });

  it('a config naming ANOTHER editor is stale → the panel offers Reconnect', () => {
    expect(stale(cfg('tok-other'), 'tok-ours')).toBe(true);
  });

  it('a matching token is not stale', () => {
    expect(stale(cfg('tok-ours'), 'tok-ours')).toBe(false);
  });

  it('a pre-C6 config (no baked token) is NOT stale — it still works, so do not nag', () => {
    expect(stale(cfg(), 'tok-ours')).toBe(false);
  });

  it('THE GATE 403s a tokened config when minting FAILED (token null) → must read as stale', () => {
    // checkToken('tok-x', null) === 'mismatch', so the backend refuses every call. An
    // open-coded `token != null && ...` guard reported "Connected" here — a green panel
    // over an agent that 403s on every tool. The panel must use the GATE's own decider.
    expect(stale(cfg('tok-other'), null)).toBe(true);
    expect(isMcpTokenForeign(cfg('tok-other'), null)).toBe(true);
  });

  it('isMcpTokenForeign agrees with the gate on every combination', () => {
    // One decider or none: these two must never drift apart.
    const cases: Array<[string | undefined, string | null, boolean]> = [
      [undefined, 'tok-ours', false],  // pre-C6 config → accepted
      ['tok-ours', 'tok-ours', false], // matches → accepted
      ['tok-other', 'tok-ours', true], // another editor → 403
      ['tok-other', null, true],       // mint failed → 403
      [undefined, null, false],        // nothing anywhere → accepted
    ];
    for (const [baked, token, foreign] of cases) {
      expect(isMcpTokenForeign(cfg(baked), token), `baked=${baked} token=${token}`).toBe(foreign);
    }
  });
});

describe('healMcpPort', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-heal-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeConnected = (port: number, cdp?: number) =>
    fs.writeFileSync(path.join(root, '.mcp.json'), mergeMcpConfig(null, {
      modoki: buildMcpServerEntry('/opt/app.asar.unpacked', true),
      chromeDevtools: cdp != null ? buildChromeDevtoolsEntry(cdp) : undefined,
    }, `http://127.0.0.1:${port}`));

  it('no .mcp.json → no-op (reason absent), and does NOT create one', () => {
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 })).toMatchObject({ healed: false, reason: 'absent' });
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
  });

  it('a .mcp.json without OUR modoki server is left byte-identical (reason not-ours)', () => {
    const foreign = JSON.stringify({ mcpServers: { weather: { command: 'w', args: [] } } }, null, 2);
    fs.writeFileSync(path.join(root, '.mcp.json'), foreign);
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 })).toMatchObject({ healed: false, reason: 'not-ours' });
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(foreign);
  });

  it('port already correct → no-op (reason fresh)', () => {
    writeConnected(5179);
    const before = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 })).toMatchObject({ healed: false, reason: 'fresh' });
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('stale port → patches to the live port and reports the change', () => {
    writeConnected(62681);
    const r = healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 });
    expect(r).toMatchObject({ healed: true, reason: 'healed', oldPort: 62681, newPort: 5179 });
    expect(mcpBackendPort(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))).toBe(5179);
  });

  // ── C6 token axis ──
  const writeTokened = (port: number, token?: string) =>
    fs.writeFileSync(path.join(root, '.mcp.json'), mergeMcpConfig(null, {
      modoki: buildMcpServerEntry('/opt/app.asar.unpacked', true),
    }, `http://127.0.0.1:${port}`, token));
  const readToken = () => mcpToken(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));

  it('a drifted token is healed even when the port is FRESH (the sticky-port case)', () => {
    // The wiped/reset-userData recovery: the editor minted a new token, so its own user
    // would be 403'd against their own editor forever with no way back but a manual
    // Reconnect. The port never moved, so a backend-only check would report 'fresh'.
    writeTokened(5179, 'tok-old');
    const r = healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-new' });
    expect(r).toMatchObject({ healed: true, reason: 'healed' });
    expect(r.changed).toEqual(['token']); // and the dialog must not claim the port changed
    expect(readToken()).toBe('tok-new');
  });

  it('port AND token drift together → both patched, both reported', () => {
    writeTokened(62681, 'tok-old');
    const r = healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-new' });
    expect(r.changed).toEqual(['backend', 'token']);
    expect(readToken()).toBe('tok-new');
    expect(mcpBackendPort(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))).toBe(5179);
  });

  it('a matching token → fresh (no needless "restart claude" nag)', () => {
    writeTokened(5179, 'tok-same');
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-same' })).toMatchObject({ reason: 'fresh' });
  });

  it('a pre-C6 config gets NO token added — it works as-is, and adding one costs a restart', () => {
    writeTokened(5179);
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-new' })).toMatchObject({ reason: 'fresh' });
    expect(readToken()).toBeNull();
  });

  it('healing a port on a pre-C6 config still does not inject a token', () => {
    writeTokened(62681);
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-new' });
    expect(mcpBackendPort(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))).toBe(5179);
    expect(readToken()).toBeNull();
  });

  it('an editor with no token of its own leaves a baked token alone', () => {
    writeTokened(5179, 'tok-old');
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: null })).toMatchObject({ reason: 'fresh' });
    expect(readToken()).toBe('tok-old');
  });

  it('a token heal preserves the user\'s own env vars on the modoki entry', () => {
    writeTokened(5179, 'tok-old');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    cfg.mcpServers.modoki.env.MY_VAR = 'keep-me';
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(cfg, null, 2));
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, token: 'tok-new' });
    const after = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(after.mcpServers.modoki.env).toMatchObject({ MY_VAR: 'keep-me', MODOKI_TOKEN: 'tok-new' });
  });

  it('healing preserves the user\'s other servers', () => {
    const existing = mergeMcpConfig(
      JSON.stringify({ mcpServers: { 'game-debug': { command: 'npx', args: ['tsx', 'gd.ts'] } } }),
      { modoki: buildMcpServerEntry('/opt/app.asar.unpacked', true) },
      'http://127.0.0.1:62681',
    );
    fs.writeFileSync(path.join(root, '.mcp.json'), existing);
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 });
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(cfg.mcpServers['game-debug']).toEqual({ command: 'npx', args: ['tsx', 'gd.ts'] });
    expect(cfg.mcpServers.modoki.env.MODOKI_BACKEND).toBe('http://127.0.0.1:5179');
  });

  it('PATCHES rather than rebuilds — user-added fields on the modoki entry survive', () => {
    // The heal runs UNATTENDED at startup, so it must not silently drop a user's own
    // customisations (a second env var, cwd, a hand-edited command).
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        modoki: {
          command: 'node',
          args: ['/custom/path/index.js'],
          cwd: '/somewhere',
          type: 'stdio',
          env: { MODOKI_BACKEND: 'http://127.0.0.1:62681', MODOKI_LOG: 'debug' },
        },
      },
    }, null, 2));
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 }).healed).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.modoki;
    expect(m.env.MODOKI_BACKEND).toBe('http://127.0.0.1:5179'); // the only thing changed
    expect(m.env.MODOKI_LOG).toBe('debug'); // preserved
    expect(m.cwd).toBe('/somewhere');
    expect(m.type).toBe('stdio');
    expect(m.args).toEqual(['/custom/path/index.js']); // NOT rewritten to our path
  });

  it('re-points an EXISTING chrome-devtools entry, but never adds one', () => {
    writeConnected(62681, 9000);
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, cdpPort: 9222 });
    const text = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    expect(mcpBackendPort(text)).toBe(5179);
    expect(mcpChromePort(text)).toBe(9222);

    // No chrome entry present → heal leaves it absent (Connect's job to add it).
    fs.rmSync(path.join(root, '.mcp.json'));
    writeConnected(62681);
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, cdpPort: 9222 });
    expect(mcpChromePort(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))).toBeNull();
  });

  it('heals a drifted CDP port even when the backend port is FRESH (sticky backend)', () => {
    // C5 makes the backend port sticky, so the common relaunch keeps it while CDP moves.
    // Returning 'fresh' on the backend alone would bake a stale --browser-url forever.
    writeConnected(5179, 9000);
    const r = healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, cdpPort: 9222 });
    expect(r.healed).toBe(true);
    const text = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    expect(mcpBackendPort(text)).toBe(5179); // untouched
    expect(mcpChromePort(text)).toBe(9222); // healed
  });

  it('both ports fresh → still a no-op', () => {
    writeConnected(5179, 9222);
    const before = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, cdpPort: 9222 })).toMatchObject({ healed: false, reason: 'fresh' });
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('CDP not verified (cdpPort null) → the existing chrome entry is left alone, not re-aimed', () => {
    writeConnected(5179, 9222);
    // Backend drifts, CDP unverified: heal the backend but never point chrome somewhere unproven.
    healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5200, cdpPort: null });
    const text = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    expect(mcpBackendPort(text)).toBe(5200);
    expect(mcpChromePort(text)).toBe(9222); // untouched
  });

  it('a corrupt .mcp.json is not clobbered and reports reason=unparseable (so main can warn)', () => {
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ not json');
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179 })).toMatchObject({ healed: false, reason: 'unparseable' });
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe('{ not json');
  });
});

/**
 * Integration — the full on-disk write path the modoki:connect-claude handler composes
 * (read existing → merge → write → gitignore), against a real temp project. Proves the
 * composed behavior on files, not just the pure string helpers.
 */
describe('connect write path (handler composition)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-proj-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function connect(opts: { isPackaged: boolean; repoRoot: string; port: number; cdpPort?: number }) {
    const modoki = buildMcpServerEntry(opts.repoRoot, opts.isPackaged);
    const chromeDevtools = opts.cdpPort != null ? buildChromeDevtoolsEntry(opts.cdpPort) : undefined;
    const mcpPath = path.join(root, '.mcp.json');
    const existing = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : null;
    fs.writeFileSync(mcpPath, mergeMcpConfig(existing, { modoki, chromeDevtools }, `http://127.0.0.1:${opts.port}`));
    const gitignored = ensureGitignored(root, '.mcp.json');
    return { mcpPath, gitignored };
  }

  it('writes a parseable .mcp.json with the live port, preserves a sibling, and gitignores', () => {
    // A pre-existing project with its own server + a .gitignore.
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'game-debug': { command: 'npx', args: ['tsx', 'gd.ts'] } },
    }, null, 2));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');

    const { mcpPath, gitignored } = connect({ isPackaged: true, repoRoot: '/opt/app.asar.unpacked', port: 5179, cdpPort: 9222 });

    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(cfg.mcpServers.modoki.env.MODOKI_BACKEND).toBe('http://127.0.0.1:5179');
    expect(mcpBackendPort(fs.readFileSync(mcpPath, 'utf8'))).toBe(5179);
    expect(cfg.mcpServers['chrome-devtools'].args).toContain('--browser-url=http://127.0.0.1:9222');
    expect(cfg.mcpServers['game-debug']).toEqual({ command: 'npx', args: ['tsx', 'gd.ts'] });
    expect(gitignored).toBe(true);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.mcp.json\n');
  });

  it('reconnect after a port change updates the baked port (fixes stale)', () => {
    connect({ isPackaged: true, repoRoot: '/opt/app.asar.unpacked', port: 5179 });
    // Editor relaunched onto a different port → reconnect.
    const { mcpPath } = connect({ isPackaged: true, repoRoot: '/opt/app.asar.unpacked', port: 5200 });
    expect(mcpBackendPort(fs.readFileSync(mcpPath, 'utf8'))).toBe(5200);
  });
});

/**
 * C9 unit gate — write the config where `claude` will actually READ it (§13).
 *
 * The property under test: Connect must target the file the user's `claude` LOADS. Claude
 * Code searches from its cwd UPWARD only, so for an in-repo game (`games/3d-test` inside a
 * monorepo, opened as the project root while the developer runs `claude` at the REPO root)
 * a config written into the game folder is never seen — Connect reports success, the panel
 * goes green, and nothing is wired.
 *
 * These rules were MEASURED against claude 2.1.212, not read from docs (re-measure before
 * trusting them): discovery walks up; multiple configs MERGE; same server name → NEAREST
 * wins; it does NOT stop at the git root.
 *
 * A tmpdir is NOT inside a git repo, so `gitRootFor` returns null unless a test creates a
 * `.git` — which is exactly the discriminator under test. `home` is injected so no test
 * can depend on (or write near) the real $HOME.
 */
describe('resolveMcpTarget', () => {
  let home: string;
  let repo: string;
  let game: string;
  const mcp = (d: string) => path.join(d, '.mcp.json');
  // Configs here DEFINE modoki: that's what makes one adoptable and what makes a rival
  // count as shadowing. (An unrelated config can't win a `modoki` name collision — pinned
  // separately in the C9b describe.)
  const write = (d: string, text = JSON.stringify({ mcpServers: { modoki: { command: 'node', args: ['x'] } } })) => {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(mcp(d), text);
  };

  beforeEach(() => {
    // fs.realpathSync: macOS tmpdir is a /var → /private/var symlink, and resolveMcpTarget
    // path.resolve()s the project root. Without this the `home` guard would never match.
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-')));
    repo = path.join(home, 'Projects', 'modoki');
    game = path.join(repo, 'games', '3d-test');
    fs.mkdirSync(game, { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const gitInit = (d: string) => fs.mkdirSync(path.join(d, '.git'), { recursive: true });

  it('standalone project, nothing anywhere → the project root (today’s behaviour)', () => {
    const t = resolveMcpTarget(game, { home });
    expect(t).toMatchObject({ mcpPath: mcp(game), location: 'project', exists: false, shadowing: [] });
  });

  it('standalone project with its OWN config → its own', () => {
    write(game);
    expect(resolveMcpTarget(game, { home })).toMatchObject({ mcpPath: mcp(game), location: 'project', exists: true });
  });

  it('THE BUG: in-repo game + a repo-root config → the REPO ROOT’s, not the game’s', () => {
    gitInit(repo);
    write(repo);
    const t = resolveMcpTarget(game, { home });
    expect(t).toMatchObject({ mcpPath: mcp(repo), location: 'ancestor', exists: true });
    // …and Connect must not have invented a second config down in the game folder.
    expect(fs.existsSync(mcp(game))).toBe(false);
  });

  it('in-repo game, config at an INTERMEDIATE dir → the NEAREST one wins (claude’s rule)', () => {
    gitInit(repo);
    write(repo);
    write(path.join(repo, 'games'));
    expect(resolveMcpTarget(game, { home }).mcpPath).toBe(mcp(path.join(repo, 'games')));
  });

  it('in-repo game with its OWN config → its own (nearest), and the ancestor is flagged', () => {
    gitInit(repo);
    write(repo);
    write(game);
    const t = resolveMcpTarget(game, { home });
    expect(t).toMatchObject({ mcpPath: mcp(game), location: 'project' });
    // BOTH exist ⇒ which editor a `modoki` call reaches depends on the cwd the user
    // launched `claude` in. Surfaced, never silently picked.
    expect(t.shadowing).toEqual([mcp(repo)]);
  });

  it('in-repo game, NO config anywhere → the project root (never invents one at the repo root)', () => {
    gitInit(repo);
    const t = resolveMcpTarget(game, { home });
    expect(t).toMatchObject({ mcpPath: mcp(game), location: 'project', exists: false });
  });

  it('the project IS the git root → its own config, never a parent’s', () => {
    gitInit(game);
    write(game);
    write(repo); // an unrelated config above; the project is its own repo, so it's out of scope
    expect(resolveMcpTarget(game, { home })).toMatchObject({ mcpPath: mcp(game), location: 'project' });
  });

  it('a .git FILE (worktree/submodule) counts as the repo root', () => {
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    write(repo);
    expect(resolveMcpTarget(game, { home })).toMatchObject({ mcpPath: mcp(repo), location: 'ancestor' });
  });

  // ── The two traps §13 must not spring ──

  it('NO REPO: a stray config in a parent dir is NOT adopted (the ~/Desktop case)', () => {
    // ~/Desktop/moge next to an unrelated ~/Desktop/.mcp.json. Writing our server into
    // that shared file would change every other project on the Desktop — and it isn't
    // even necessary: nearest-wins means a `claude` run in the project prefers its own.
    write(path.join(home, 'Projects'));
    const t = resolveMcpTarget(game, { home });
    expect(t).toMatchObject({ mcpPath: mcp(game), location: 'project' });
    // …but we still ADMIT it's out there, because claude would merge it.
    expect(t.shadowing).toEqual([mcp(path.join(home, 'Projects'))]);
  });

  it('never walks to $HOME, even when $HOME is itself a git repo (the dotfiles hijack)', () => {
    // A `modoki` server written into $HOME/.mcp.json applies to EVERY project on the
    // machine. claude WOULD read it (measured: discovery doesn't stop at the git root),
    // which is exactly why the write boundary has to be explicit.
    gitInit(home);
    write(home);
    const t = resolveMcpTarget(game, { home });
    expect(t.mcpPath).toBe(mcp(game));
    expect(t.location).toBe('project');
    expect(t.shadowing).toContain(mcp(home)); // admitted, not adopted
  });

  it('reports EVERY config claude would merge, including above the git root', () => {
    // Measured: discovery does NOT stop at the git root. So a config above it still
    // shadows — the panel must be able to say so even though we'd never write there.
    gitInit(repo);
    write(repo);
    write(path.join(home, 'Projects'));
    const t = resolveMcpTarget(game, { home });
    expect(t.mcpPath).toBe(mcp(repo)); // adopted: inside the project's own repo
    expect(t.shadowing).toEqual([mcp(path.join(home, 'Projects'))]);
  });

  it('a trailing slash resolves to the same target', () => {
    gitInit(repo);
    write(repo);
    expect(resolveMcpTarget(game + path.sep, { home }).mcpPath).toBe(mcp(repo));
  });
});

describe('ensureMcpGitignored', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ignore-'))); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('project-root config in a plain dir → ignored as before', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist\n');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    expect(ensureMcpGitignored({ mcpPath: path.join(dir, '.mcp.json'), location: 'project', exists: true, shadowing: [] })).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.mcp.json');
  });

  it('an ADOPTED ancestor config is never gitignored — it isn’t ours to ignore', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist\n');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    expect(ensureMcpGitignored({ mcpPath: path.join(dir, '.mcp.json'), location: 'ancestor', exists: true, shadowing: [] })).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).not.toContain('.mcp.json');
  });

  it('THE TRAP: a TRACKED .mcp.json is never gitignored (the entry would be a lie)', () => {
    // This repo's own root .mcp.json is committed. git keeps tracking an already-tracked
    // file regardless of .gitignore, so the entry changes nothing except to mislead.
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist\n');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    git('add', '.mcp.json', '.gitignore');
    git('commit', '-qm', 'x');
    expect(ensureMcpGitignored({ mcpPath: path.join(dir, '.mcp.json'), location: 'project', exists: true, shadowing: [] })).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).not.toContain('.mcp.json');
  });
});

/**
 * C9b — the guards the first cut left UNPINNED.
 *
 * Each of these was proved vacuous by MUTATION: the review deleted the guard and all 135
 * tests still passed. A boundary nobody tests is a boundary that silently stops existing,
 * and these two both fail OPEN (into a machine-wide config hijack, and into rewriting a
 * committed file). So they're pinned by the mutation that broke them.
 */
describe('resolveMcpTarget — the write boundary, pinned by mutation', () => {
  let home: string;
  let repo: string;
  let game: string;
  const mcp = (d: string) => path.join(d, '.mcp.json');
  // A config that DEFINES modoki — only a rival modoki entry can mis-target, so only that
  // counts as shadowing, and only that is worth adopting.
  const write = (d: string) => {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(mcp(d), JSON.stringify({ mcpServers: { modoki: { command: 'node', args: ['x'] } } }));
  };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-')));
    repo = path.join(home, 'Projects', 'modoki');
    game = path.join(repo, 'games', '3d-test');
    fs.mkdirSync(game, { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('MUTATION `if (d === repo) break`: a config ABOVE the git root is never adopted', () => {
    // Deleting that break let the writable walk run past the repo to the filesystem root.
    // Every earlier test still passed, because they all put a config AT the repo root —
    // where nearest-wins picks the same file either way. Only an ancestor OUTSIDE the repo,
    // with nothing inside it, can tell the two apart.
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(home, 'Projects')); // above the git root
    const t = resolveMcpTarget(game, { home });
    expect(t.mcpPath).toBe(mcp(game));      // NOT ~/Projects/.mcp.json
    expect(t.location).toBe('project');
    expect(t.shadowing).toEqual([mcp(path.join(home, 'Projects'))]); // admitted, not adopted
  });

  it('MUTATION `repo !== root`: a project that IS the git root ignores a parent config', () => {
    fs.mkdirSync(path.join(game, '.git'), { recursive: true });
    write(repo);
    write(path.join(home, 'Projects'));
    expect(resolveMcpTarget(game, { home }).mcpPath).toBe(mcp(game));
  });

  it('the $HOME guard survives a non-canonical home (symlink / trailing slash / case)', () => {
    // The guard was `d === home` on a raw os.homedir(). On macOS a tmpdir is a
    // /var → /private/var symlink and the FS is case-insensitive, so ANY of those
    // spellings turned the only anti-hijack boundary off without a word.
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    write(home);
    const spellings = [home + path.sep, path.join(home, 'Projects', '..')];
    // The case-fold spelling is only the SAME directory where the filesystem is
    // case-insensitive (macOS/Windows). On Linux (CI) `home.toUpperCase()` is a
    // genuinely different, non-existent path — and `canonical()` correctly refuses to
    // case-fold there — so asserting it resolves to `home` would be testing a false
    // premise. Mirror the code's own platform rule.
    if (process.platform === 'darwin' || process.platform === 'win32') spellings.push(home.toUpperCase());
    for (const spelling of spellings) {
      const t = resolveMcpTarget(game, { home: spelling });
      expect(t.mcpPath).toBe(mcp(game)); // never $HOME/.mcp.json
    }
  });

  it('an unrelated config (no modoki server) is NOT reported as shadowing', () => {
    // Reporting it left the panel permanently amber for a healthy setup: claude merges
    // configs and only resolves a NAME collision nearest-first, so a `weather` server in
    // ~/Desktop/.mcp.json can never mis-target a `modoki` call. A warning that cries wolf
    // is a warning nobody reads.
    fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
    fs.writeFileSync(mcp(path.join(home, 'Projects')), JSON.stringify({ mcpServers: { weather: { command: 'w', args: [] } } }));
    expect(resolveMcpTarget(game, { home }).shadowing).toEqual([]);
  });
});

describe('healMcpPort — never rewrites a version-controlled config (C9b)', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-healtrack-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeConnected = (port: number) =>
    fs.writeFileSync(path.join(root, '.mcp.json'), mergeMcpConfig(null, {
      modoki: buildMcpServerEntry('/opt/app.asar.unpacked', true),
    }, `http://127.0.0.1:${port}`));

  it('THE REGRESSION: a TRACKED config is refused, not rewritten', () => {
    // C9 pointed heal at the ADOPTED config, which for an in-repo game is the repo root's
    // — committed, in this very repo. Unattended, on every launch, from three clones that
    // pin different ports and merge the file via origin: a permanent conflict, with no
    // user action. §13's trap 1 was implemented for the .gitignore half only.
    writeConnected(62681);
    const before = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    const r = healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, trackedState: 'tracked' });
    expect(r).toMatchObject({ healed: false, reason: 'tracked' });
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(before); // byte-identical
  });

  it('"couldn’t tell" is refused too — a boundary must not fail OPEN', () => {
    // spawnSync on a missing `git` returns {status: null} WITHOUT throwing, so the first
    // cut's `r.status === 0` quietly answered "untracked" on a packaged Finder launch.
    writeConnected(62681);
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, trackedState: 'unknown' }))
      .toMatchObject({ healed: false, reason: 'tracked' });
  });

  it('an untracked config still heals (the shipped standalone case must keep working)', () => {
    writeConnected(62681);
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, trackedState: 'untracked' }))
      .toMatchObject({ healed: true, reason: 'healed' });
  });

  it('a fresh config never even asks git (no spawn on the common launch)', () => {
    writeConnected(5179);
    expect(healMcpPort({ mcpPath: path.join(root, '.mcp.json'), backendPort: 5179, trackedState: 'tracked' }))
      .toMatchObject({ healed: false, reason: 'fresh' });
  });
});

describe('gitTrackedState', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tracked-'))); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('outside any repo → untracked, WITHOUT shelling out to git', () => {
    // The shipped-DMG standalone case. It must not depend on `git` being on PATH — a
    // Finder-launched app has a minimal one (the same trap detectClaudeCli works around).
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    const orig = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent'; // git is now unreachable
      expect(gitTrackedState(path.join(dir, '.mcp.json'))).toBe('untracked');
    } finally { process.env.PATH = orig; }
  });

  it('tracked vs untracked inside a real repo', () => {
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    fs.writeFileSync(path.join(dir, 'other.json'), '{}');
    git('add', '.mcp.json');
    git('commit', '-qm', 'x');
    expect(gitTrackedState(path.join(dir, '.mcp.json'))).toBe('tracked');
    expect(gitTrackedState(path.join(dir, 'other.json'))).toBe('untracked');
  });
});

describe('mcpHasModoki / mcpBackendRaw — the ${VAR:-default} config (C9b)', () => {
  // THIS REPO's committed .mcp.json is exactly this shape: deliberately generic so one
  // tracked file serves every clone. Judging "is this ours" by a parseable port called it
  // "not a usable Modoki config" and pushed the user to overwrite the very mechanism.
  const deferred = JSON.stringify({
    mcpServers: { modoki: { command: 'npx', args: ['tsx', 'x.ts'], env: { MODOKI_BACKEND: '${MODOKI_BACKEND:-http://127.0.0.1:5179}' } } },
  });

  it('a ${VAR:-default} config IS ours, even though its port is unparseable', () => {
    expect(mcpBackendPort(deferred)).toBeNull(); // the old test — still true
    expect(mcpHasModoki(deferred)).toBe(true);   // …but it is NOT "someone else's config"
  });

  it('a config with no modoki server is not ours', () => {
    expect(mcpHasModoki(JSON.stringify({ mcpServers: { weather: { command: 'w' } } }))).toBe(false);
    expect(mcpHasModoki(null)).toBe(false);
    expect(mcpHasModoki('{ not json')).toBe(false);
  });

  it('mcpBackendRaw surfaces the expansion verbatim so the panel can explain it', () => {
    expect(mcpBackendRaw(deferred)).toBe('${MODOKI_BACKEND:-http://127.0.0.1:5179}');
  });

  it('a deferred config is NOT healed (we must not clobber their expansion)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-defer-'));
    try {
      fs.writeFileSync(path.join(d, '.mcp.json'), deferred);
      expect(healMcpPort({ mcpPath: path.join(d, '.mcp.json'), backendPort: 5180, trackedState: 'untracked' }))
        .toMatchObject({ healed: false, reason: 'not-ours' });
      expect(fs.readFileSync(path.join(d, '.mcp.json'), 'utf8')).toBe(deferred);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

/**
 * §5.3 — copy the CLAUDE.md primer into an opened existing project that has none, so its
 * `claude` knows the tool surface instead of starting blind. The load-bearing property is
 * NEVER-overwrite: a project's own CLAUDE.md is the human's instructions.
 */
describe('ensureProjectClaudeMd', () => {
  let dir: string;
  let template: string;
  const TEMPLATE_TEXT = '# __GAME_NAME__ — a Modoki game project\n\nUse modoki_get_scene_state.\n';

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-primer-')));
    template = path.join(dir, 'starter-CLAUDE.md');
    fs.writeFileSync(template, TEMPLATE_TEXT);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the primer with the name substituted when the project has none', () => {
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    const r = ensureProjectClaudeMd({ projectRoot: project, templatePath: template, projectName: 'My Cool Game' });
    expect(r).toMatchObject({ written: true, reason: 'written', path: path.join(project, 'CLAUDE.md') });
    const text = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('# My Cool Game — a Modoki game project');
    expect(text).not.toContain('__GAME_NAME__');
  });

  it('NEVER overwrites an existing CLAUDE.md — that is the human’s instructions', () => {
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# MINE — do not touch\n');
    const r = ensureProjectClaudeMd({ projectRoot: project, templatePath: template, projectName: 'X' });
    expect(r).toMatchObject({ written: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# MINE — do not touch\n');
  });

  it('an empty CLAUDE.md still counts as present (absence is the ONLY trigger)', () => {
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '');
    expect(ensureProjectClaudeMd({ projectRoot: project, templatePath: template, projectName: 'X' }))
      .toMatchObject({ written: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe(''); // untouched
  });

  it('a missing template is a quiet no-op, never a throw (Connect must not fail on it)', () => {
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    const r = ensureProjectClaudeMd({ projectRoot: project, templatePath: path.join(dir, 'nope.md'), projectName: 'X' });
    expect(r).toMatchObject({ written: false, reason: 'no-template' });
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('a name with no token still writes cleanly (idempotent substitution)', () => {
    fs.writeFileSync(template, '# Modoki project\n\nNo token here.\n');
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    expect(ensureProjectClaudeMd({ projectRoot: project, templatePath: template, projectName: 'X' }).written).toBe(true);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Modoki project\n\nNo token here.\n');
  });

  // Skipped on Windows: fs.symlinkSync requires elevation / Developer Mode there, so the
  // dangling-symlink scenario can't even be constructed. The behavior under test is
  // OS-agnostic and covered on macOS/Linux CI.
  it.skipIf(process.platform === 'win32')('a DANGLING SYMLINK CLAUDE.md is left untouched — absence, not unreadability, is the trigger', () => {
    // existsSync FOLLOWS the link and would read a broken symlink as absent; the atomic
    // temp+rename would then replace the LINK, destroying the human's pointer to their real
    // (temporarily unmounted) instructions. lstat sees the link entry itself.
    const project = path.join(dir, 'proj');
    fs.mkdirSync(project);
    fs.symlinkSync(path.join(dir, 'does-not-exist-yet.md'), path.join(project, 'CLAUDE.md'));
    const r = ensureProjectClaudeMd({ projectRoot: project, templatePath: template, projectName: 'X' });
    expect(r).toMatchObject({ written: false, reason: 'exists' });
    // The entry is still the symlink, not a regular file we clobbered it with.
    expect(fs.lstatSync(path.join(project, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('scopes to the PROJECT ROOT even when .mcp.json is adopted at an ANCESTOR (an in-repo game)', () => {
    // The config and the primer deliberately land in different places: resolveMcpTarget
    // adopts the repo-root .mcp.json (claude reads it up-tree), while the primer is
    // project-scoped and belongs in the game folder. Pins that main.ts must pass projectRoot,
    // NOT path.dirname(target.mcpPath).
    const repo = path.join(dir, 'repo');
    const game = path.join(repo, 'games', 'mygame');
    fs.mkdirSync(game, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { modoki: { command: 'node', args: ['x'] } } }));

    const target = resolveMcpTarget(game);
    expect(target.location).toBe('ancestor'); // config is the repo root's
    const r = ensureProjectClaudeMd({ projectRoot: game, templatePath: template, projectName: 'My Game' });
    expect(r.path).toBe(path.join(game, 'CLAUDE.md')); // primer is the game's own
    expect(path.dirname(target.mcpPath)).not.toBe(game); // …and they genuinely differ
  });
});
