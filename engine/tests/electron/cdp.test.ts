import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_CDP_PORT,
  resolveCdpPort,
  resolveCdpConfig,
  readCdpEnabled,
  writeCdpEnabled,
  probeCdp,
  newCdpNonce,
  cdpNonceOf,
  buildRendererUrl,
  CDP_NONCE_PARAM,
  resolveStickyCdpPort,
  cdpMemoVerdict,
  readCdpPortMemo,
  writeCdpPortMemo,
  CDP_PORT_PREF_FILE,
  CDP_SCAN_SPAN,
} from '../../electron/cdp';

/**
 * C1 unit gate — the CDP (renderer remote-debugging) port + switch decision.
 *
 * The packaged app is AGENT-FIRST, so CDP is ON BY DEFAULT (opt-OUT): a plain launch
 * DOES open the 127.0.0.1 remote-debugging port unless the user explicitly disabled it
 * (`readCdpEnabled` → `{enabled:false}`). The load-bearing invariants this gate pins:
 * DEV never opens the switch (the launcher owns the CLI arg — `openSwitch:false`
 * regardless of pref/memo), an invalid MODOKI_CDP_PORT can't force it, and an explicit
 * opt-out closes it. `resolveCdpConfig.openSwitch` is the single boolean main.ts keys
 * `app.commandLine.appendSwitch('remote-debugging-port', …)` off.
 */
describe('resolveCdpPort', () => {
  it('defaults when unset', () => {
    expect(resolveCdpPort({})).toBe(DEFAULT_CDP_PORT);
  });
  it('honors a valid MODOKI_CDP_PORT', () => {
    expect(resolveCdpPort({ MODOKI_CDP_PORT: '9333' })).toBe(9333);
  });
  it('ignores garbage / out-of-range / empty → default', () => {
    expect(resolveCdpPort({ MODOKI_CDP_PORT: 'nope' })).toBe(DEFAULT_CDP_PORT);
    expect(resolveCdpPort({ MODOKI_CDP_PORT: '0' })).toBe(DEFAULT_CDP_PORT);
    expect(resolveCdpPort({ MODOKI_CDP_PORT: '70000' })).toBe(DEFAULT_CDP_PORT);
    expect(resolveCdpPort({ MODOKI_CDP_PORT: '' })).toBe(DEFAULT_CDP_PORT);
  });
});

describe('resolveCdpConfig', () => {
  it('packaged + pref OFF + no env → CLOSED (never opens the port)', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: false, env: {} });
    expect(c.enabled).toBe(false);
    expect(c.openSwitch).toBe(false);
  });

  it('packaged + pref ON → opens the switch on the default port', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: true, env: {} });
    expect(c.enabled).toBe(true);
    expect(c.openSwitch).toBe(true);
    expect(c.port).toBe(DEFAULT_CDP_PORT);
  });

  it('packaged + MODOKI_CDP_PORT force-opens even with the pref off (CI/testing knob)', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: false, env: { MODOKI_CDP_PORT: '9445' } });
    expect(c.enabled).toBe(true);
    expect(c.openSwitch).toBe(true);
    expect(c.port).toBe(9445);
  });

  it('dev with MODOKI_CDP_PORT set (launcher) → reported but main does NOT open the switch', () => {
    const c = resolveCdpConfig({ isPackaged: false, prefEnabled: false, env: { MODOKI_CDP_PORT: '9223' } });
    expect(c.enabled).toBe(true);
    expect(c.port).toBe(9223);
    expect(c.openSwitch).toBe(false); // the dev launcher owns the CLI arg
  });

  it('packaged + INVALID MODOKI_CDP_PORT (0 / garbage) + pref off → fails CLOSED, does NOT open 9222', () => {
    for (const bad of ['0', 'nope', '70000', '-5', ' ']) {
      const c = resolveCdpConfig({ isPackaged: true, prefEnabled: false, env: { MODOKI_CDP_PORT: bad } });
      expect(c.enabled, `MODOKI_CDP_PORT=${JSON.stringify(bad)}`).toBe(false);
      expect(c.openSwitch, `MODOKI_CDP_PORT=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('packaged + pref ON still opens even if MODOKI_CDP_PORT is garbage (pref wins, on the default port)', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: true, env: { MODOKI_CDP_PORT: 'nope' } });
    expect(c.enabled).toBe(true);
    expect(c.openSwitch).toBe(true);
    expect(c.port).toBe(DEFAULT_CDP_PORT);
  });

  it('dev with nothing set → disabled, no switch', () => {
    const c = resolveCdpConfig({ isPackaged: false, prefEnabled: false, env: {} });
    expect(c.enabled).toBe(false);
    expect(c.openSwitch).toBe(false);
  });

  it('a stale pref cannot open the port in DEV (dev never keys off the pref)', () => {
    const c = resolveCdpConfig({ isPackaged: false, prefEnabled: true, env: {} });
    expect(c.openSwitch).toBe(false);
  });

  // ── Sticky ladder wiring (§12.2 item 5) ──
  it('packaged + memo of a WORKING port → sticks on it', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: true, env: {}, memo: { port: 9224, ours: true } });
    expect(c.port).toBe(9224);
  });

  it('packaged + memo of a COLLIDED port → advances past it', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: true, env: {}, memo: { port: 9222, ours: false } });
    expect(c.port).toBe(9223);
  });

  it('an explicit MODOKI_CDP_PORT OVERRIDES the sticky memo (the pin always wins)', () => {
    const c = resolveCdpConfig({ isPackaged: true, prefEnabled: true, env: { MODOKI_CDP_PORT: '9999' }, memo: { port: 9224, ours: true } });
    expect(c.port).toBe(9999);
  });

  it('DEV ignores the memo entirely (the launcher owns the port)', () => {
    const c = resolveCdpConfig({ isPackaged: false, prefEnabled: false, env: {}, memo: { port: 9224, ours: false } });
    expect(c.port).toBe(DEFAULT_CDP_PORT); // reported default, memo not consulted
  });
});

describe('resolveStickyCdpPort — the ONE synchronous shot (§12.2 item 5)', () => {
  it('no memo → the default port', () => {
    expect(resolveStickyCdpPort({})).toBe(DEFAULT_CDP_PORT);
    expect(resolveStickyCdpPort({ memo: null })).toBe(DEFAULT_CDP_PORT);
  });

  it('last was OURS → STICK on that exact port (even off the default)', () => {
    expect(resolveStickyCdpPort({ memo: { port: 9225, ours: true } })).toBe(9225);
  });

  it('last was NOT ours → ADVANCE to the next port in the band', () => {
    expect(resolveStickyCdpPort({ memo: { port: DEFAULT_CDP_PORT, ours: false } })).toBe(DEFAULT_CDP_PORT + 1);
    expect(resolveStickyCdpPort({ memo: { port: DEFAULT_CDP_PORT + 3, ours: false } })).toBe(DEFAULT_CDP_PORT + 4);
  });

  it('a repeated collision walks the whole band, then WRAPS to the base', () => {
    let port = DEFAULT_CDP_PORT;
    const seen = new Set<number>();
    for (let i = 0; i < CDP_SCAN_SPAN; i++) {
      seen.add(port);
      port = resolveStickyCdpPort({ memo: { port, ours: false } }); // each one "failed"
    }
    // Visited every port in the band exactly once, and the last advance wrapped home.
    expect(seen.size).toBe(CDP_SCAN_SPAN);
    expect(port).toBe(DEFAULT_CDP_PORT);
  });

  it('a memo port OUTSIDE the band (a stale hand-set value that failed) restarts at base', () => {
    expect(resolveStickyCdpPort({ memo: { port: 40000, ours: false } })).toBe(DEFAULT_CDP_PORT);
  });

  it('a memo with an invalid port is ignored → base', () => {
    expect(resolveStickyCdpPort({ memo: { port: 0, ours: true } })).toBe(DEFAULT_CDP_PORT);
    expect(resolveStickyCdpPort({ memo: { port: 99999, ours: false } })).toBe(DEFAULT_CDP_PORT);
  });

  it('never returns an invalid port even for a base near the top of the range', () => {
    // Defensive: the band is clamped so base+span can't run past 65535 (exported helper).
    for (let i = 0; i < 20; i++) {
      const p = resolveStickyCdpPort({ base: 65530, memo: { port: 65530 + (i % 6), ours: false } });
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(65536);
    }
  });
});

describe('cdpMemoVerdict — a TRANSIENT probe must not advance off a good port', () => {
  it('ours → stick (true)', () => {
    expect(cdpMemoVerdict({ reachable: true, ours: true })).toBe(true);
  });

  it('a FOREIGN CDP endpoint answered (reachable, not ours) → advance (false)', () => {
    expect(cdpMemoVerdict({ reachable: true, ours: false })).toBe(false);
  });

  it('UNREACHABLE (a transient 800ms timeout, indistinguishable from a bind failure) → null, keep prior', () => {
    // THE BUG: probeCdp collapses a real collision and a transient timeout into ours:false.
    // Advancing on the transient churns the port + nags "restart Claude Code" for a collision
    // that never happened. null ⇒ the memo is left unchanged.
    expect(cdpMemoVerdict({ reachable: false, ours: false })).toBeNull();
  });
});

describe('CDP port memo persistence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cdpmemo-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips {port, ours}', () => {
    writeCdpPortMemo(dir, { port: 9223, ours: true });
    expect(readCdpPortMemo(dir)).toEqual({ port: 9223, ours: true });
  });

  it('missing file → null (never a throw)', () => {
    expect(readCdpPortMemo(dir)).toBeNull();
  });

  it('a corrupt / malformed memo reads as null (fail safe → base next launch)', () => {
    fs.writeFileSync(path.join(dir, CDP_PORT_PREF_FILE), '{ not json');
    expect(readCdpPortMemo(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, CDP_PORT_PREF_FILE), JSON.stringify({ port: 'nope', ours: true }));
    expect(readCdpPortMemo(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, CDP_PORT_PREF_FILE), JSON.stringify({ port: 9223 })); // no ours
    expect(readCdpPortMemo(dir)).toBeNull();
  });

  it('creates the userData dir if missing', () => {
    const nested = path.join(dir, 'sub', 'ud');
    writeCdpPortMemo(nested, { port: 9224, ours: false });
    expect(readCdpPortMemo(nested)).toEqual({ port: 9224, ours: false });
  });
});

/**
 * probeCdp — the fix for a bug found on a real 0.2.13 install: the panel showed
 * "CDP 9222" GREEN while 9222 was owned by a SIBLING CLONE's editor, and Connect would
 * have written a chrome-devtools entry pointing Claude at that other project's renderer.
 * Chromium fails to bind a taken --remote-debugging-port SILENTLY, so the pref proves
 * nothing. The page URL is the discriminator: each editor's renderer is served from its
 * OWN Vite origin.
 */
/**
 * probeCdp — the fix for a bug found on a real 0.2.13 install: the panel showed a green
 * CDP that was really a SIBLING editor's port. §12.2 replaced the C8 origin+UA heuristics
 * with a per-launch NONCE baked into our own loaded URL (`?cdpNonce=<uuid>#/editor`) — an
 * EXACT proof of our process that has neither of the heuristics' false edges (a Vite
 * ephemeral `:5173x` prefix collision; a Chrome tab sitting on our origin).
 */
describe('probeCdp — verify the endpoint is OURS by the per-launch nonce', () => {
  let server: http.Server;
  let port = 0;
  const OURS = 'our-nonce-abc123';
  /** Build a page target URL carrying a given (or no) cdpNonce, like a real renderer. */
  const pageUrl = (origin: string, nonce?: string) =>
    nonce ? `${origin}/?${CDP_NONCE_PARAM}=${nonce}#/editor` : `${origin}/#/editor`;
  const serve = (payload: unknown, status = 200) =>
    new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/json/list') {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } else { res.writeHead(404); res.end(); }
      });
      server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); });
    });

  afterEach(() => new Promise<void>((r) => { server?.close(() => r()); }));

  it('OURS — a page target carrying THIS launch nonce', async () => {
    await serve([{ type: 'page', url: pageUrl('http://127.0.0.1:63297', OURS), title: 'Modoki' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: true });
  });

  it('FOREIGN — reachable, but the page has a DIFFERENT nonce (the real 9222 bug)', async () => {
    // 9222 answered, but its page was the sibling clone's editor — a different launch,
    // so a different nonce.
    await serve([{ type: 'page', url: pageUrl('http://127.0.0.1:5173', 'sibling-nonce-xyz'), title: 'Modoki' }]);
    const r = await probeCdp(port, OURS);
    expect(r.reachable).toBe(true);
    expect(r.ours).toBe(false); // must NOT be reported as ours
    expect(r.pageUrl).toContain('5173'); // and we can say WHOSE answered
  });

  it('SAME ORIGIN, no nonce → not ours (a page that predates the nonce / isn’t ours)', async () => {
    // The nonce is what proves identity, not the origin — an ephemeral-port collision or a
    // Chrome tab on our exact origin can NEVER carry a random UUID we minted this launch.
    await serve([{ type: 'page', url: pageUrl('http://127.0.0.1:63297'), title: 'Modoki' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: false });
  });

  it('a CHROME tab on our exact origin WITHOUT our nonce is NOT ours', async () => {
    // The user's own Chrome on --remote-debugging-port=9222 with a tab on our editor URL.
    // Right origin, wrong process — and no nonce, so it can't be mistaken for ours.
    await serve([{ type: 'page', url: 'http://127.0.0.1:63297/#/editor', title: 'Modoki' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: false });
  });

  it('DOWN — nothing listening → not reachable, not ours', async () => {
    await serve([]); // bind then close, so the port is definitely dead
    const dead = port;
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probeCdp(dead, OURS, 300)).toEqual({ reachable: false, ours: false });
    server = http.createServer(); // afterEach close() needs a server
  });

  it('an endpoint with NO page targets is reachable but not ours', async () => {
    await serve([{ type: 'worker', url: '' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: false });
  });

  it('a non-200 / garbage response is not ours (never fail open)', async () => {
    await serve({ nope: true }, 500);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: false, ours: false });
  });

  it('an EMPTY probe nonce can never match — fail CLOSED, even against an EMPTY page nonce', async () => {
    // THE fail-open the `nonce ?` guard blocks: a page carrying a present-but-empty
    // `?cdpNonce=` makes cdpNonceOf return '' (not null), so a naive `cdpNonceOf(u) === nonce`
    // with nonce='' would match ('' === '') and call it OURS. Serve exactly that empty-param
    // page (not a non-empty one — that would pass vacuously) and probe with ''.
    await serve([{ type: 'page', url: `http://127.0.0.1:63297/?${CDP_NONCE_PARAM}=#/editor`, title: 'Modoki' }]);
    expect(await probeCdp(port, '')).toMatchObject({ reachable: true, ours: false });
  });

  it('a page with an EMPTY nonce is not ours even for a real probe nonce', async () => {
    await serve([{ type: 'page', url: `http://127.0.0.1:63297/?${CDP_NONCE_PARAM}=#/editor`, title: 'Modoki' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: false });
  });

  it('a non-URL target (about:blank / empty) does not throw or match', async () => {
    await serve([{ type: 'page', url: 'about:blank' }, { type: 'page', url: '' }]);
    expect(await probeCdp(port, OURS)).toMatchObject({ reachable: true, ours: false });
  });
});

describe('CDP nonce helpers (§12.2)', () => {
  it('newCdpNonce mints distinct, non-empty values', () => {
    const a = newCdpNonce();
    const b = newCdpNonce();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('cdpNonceOf extracts the query param, coexisting with ?scene=', () => {
    expect(cdpNonceOf('http://127.0.0.1:5180/?cdpNonce=abc#/editor')).toBe('abc');
    // The runtime's own ?scene= param must not shadow it (both are read by name).
    expect(cdpNonceOf('http://127.0.0.1:5180/?scene=level1&cdpNonce=abc#/editor')).toBe('abc');
  });

  it('cdpNonceOf is null when absent or unparseable', () => {
    expect(cdpNonceOf('http://127.0.0.1:5180/#/editor')).toBeNull();
    expect(cdpNonceOf('about:blank')).toBeNull();
    expect(cdpNonceOf('')).toBeNull();
  });

  it('buildRendererUrl round-trips through cdpNonceOf (the load-bearing placement contract)', () => {
    // main.ts's loadURL calls buildRendererUrl, and cdpStatus() matches via cdpNonceOf —
    // pinning the exact URL BUILDER (not a hand-written string) means a placement change in
    // the one production code path fails HERE, not silently in a packaged app.
    const n = newCdpNonce();
    const url = buildRendererUrl('http://127.0.0.1:5180', n);
    expect(cdpNonceOf(url)).toBe(n);
    expect(url).toContain('#/editor'); // the hash route survives
  });

  it('a FRAGMENT-placed nonce is UNREADABLE — proving WHY buildRendererUrl uses the query', () => {
    // If someone "simplified" the URL to `#/editor?cdpNonce=<n>`, the nonce lands in the
    // fragment, which URL.searchParams never sees → probeCdp reports not-ours forever and
    // the feature dies silently. This documents the trap the builder avoids.
    const n = newCdpNonce();
    expect(cdpNonceOf(`http://127.0.0.1:5180/#/editor?${CDP_NONCE_PARAM}=${n}`)).toBeNull();
  });

  it('buildRendererUrl round-trips even a nonce with URL-special chars', () => {
    // randomUUID is URL-safe, but the builder encodes defensively — pin that it survives.
    const url = buildRendererUrl('http://127.0.0.1:5180', 'a b&c=d');
    expect(cdpNonceOf(url)).toBe('a b&c=d');
  });
});

describe('CDP pref persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cdp-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to TRUE (on) when no pref file exists — packaged CDP is opt-OUT', () => {
    expect(readCdpEnabled(dir)).toBe(true);
  });

  it('round-trips true/false', () => {
    writeCdpEnabled(dir, true);
    expect(readCdpEnabled(dir)).toBe(true);
    writeCdpEnabled(dir, false);
    expect(readCdpEnabled(dir)).toBe(false);
  });

  it('ONLY an explicit {enabled:false} disables — a pref without the key stays on', () => {
    fs.writeFileSync(path.join(dir, 'cdp.json'), JSON.stringify({ somethingElse: 1 }));
    expect(readCdpEnabled(dir)).toBe(true);
  });

  it('creates the userData dir if missing', () => {
    const nested = path.join(dir, 'sub', 'user-data');
    writeCdpEnabled(nested, true);
    expect(readCdpEnabled(nested)).toBe(true);
  });

  it('defaults ON for a corrupt pref file (corruption is not an explicit opt-out)', () => {
    fs.writeFileSync(path.join(dir, 'cdp.json'), '{ not json');
    expect(readCdpEnabled(dir)).toBe(true);
  });
});
