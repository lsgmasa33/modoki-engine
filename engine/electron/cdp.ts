// CDP (Chrome DevTools Protocol) remote-debugging for the editor renderer.
//
// CDP is what lets the user's Claude Code reach the LIVE renderer when data isn't
// enough — read React fiber state / CSS-animation clocks, validate WGSL, and capture
// the TRUE framebuffer via Page.captureScreenshot (which, unlike capture_viewport,
// does NOT force a render, so it exposes render-on-demand / stale-frame bugs).
//
// Chromium requires `--remote-debugging-port` at STARTUP (before app.ready) and binds
// it to 127.0.0.1 only. Remote debugging = full renderer control, so in the PACKAGED
// app it is OFF by default and opt-in: the user enables it (persisted pref), which
// relaunches with the switch. In DEV the launcher (launch-editor.sh) passes the CLI
// arg directly, so main only REPORTS the port there — it never double-opens it.
//
// These helpers are pure / fs-only (no electron import) so main.ts wires them and the
// unit tests can exercise the port + switch decision without an Electron runtime.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Chromium's conventional remote-debugging port. Overridable via MODOKI_CDP_PORT. */
export const DEFAULT_CDP_PORT = 9222;

/** The pref file under userData that persists the packaged opt-in. */
export const CDP_PREF_FILE = 'cdp.json';

/** How many ports in the deterministic band the sticky ladder advances through on repeated
 *  collisions before wrapping back to the default. */
export const CDP_SCAN_SPAN = 8;
/** The pref file that remembers the last CDP port we tried + whether it bound OURS. */
export const CDP_PORT_PREF_FILE = 'cdp-port.json';

/** Is `raw` a usable TCP port number (1..65535)? The single source of truth for BOTH
 *  the port value AND the force-on decision, so a garbage/out-of-range MODOKI_CDP_PORT
 *  can't be VALID enough to force-open CDP yet INVALID enough to fall back to 9222 —
 *  the split that let `MODOKI_CDP_PORT=0` (a user meaning "off") silently open 9222. */
export function isValidCdpPort(raw: unknown): boolean {
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536;
}

/** Resolve the CDP port from the environment, falling back to the default. Pure.
 *  A non-integer / out-of-range MODOKI_CDP_PORT is ignored (→ default). */
export function resolveCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MODOKI_CDP_PORT;
  return isValidCdpPort(raw) ? Number(raw) : DEFAULT_CDP_PORT;
}

/**
 * Read the persisted CDP preference. The packaged editor is AGENT-FIRST, so CDP
 * (renderer remote-debugging) is **ON BY DEFAULT** — the pref file records only an
 * EXPLICIT user opt-OUT. So the endpoint is ON unless the file says exactly
 * `{ "enabled": false }`: file absent, present-without-the-key, or `{enabled:true}` all
 * leave it ON, and a corrupt/unreadable pref is NOT an explicit off ⇒ stays ON (the
 * default). The security tradeoff — a 127.0.0.1 remote-debug port on every packaged
 * launch — is a deliberate, documented choice for this engine (docs/connect-claude-code.md);
 * a user who wants it closed unchecks it in the AI panel (writes `{enabled:false}`).
 * DEV never keys off this pref (the launcher owns the CLI arg) — see resolveCdpConfig.
 */
export function readCdpEnabled(userDataDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, CDP_PREF_FILE), 'utf8');
    // Only an explicit boolean `false` disables — everything else is ON (opt-out model).
    return (JSON.parse(raw) as { enabled?: unknown })?.enabled !== false;
  } catch {
    return true; // absent/corrupt → default ON
  }
}

/** Persist the CDP enable/disable choice to userData (creating the dir if needed). */
export function writeCdpEnabled(userDataDir: string, enabled: boolean): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, CDP_PREF_FILE), JSON.stringify({ enabled: !!enabled }, null, 2) + '\n');
}

// ── Sticky CDP port (§12.2 item 5). ───────────────────────────────────────────
//
// The packaged app opens a FIXED 9222 every launch. If 9222 is taken — the user's own
// Chrome (chrome-devtools-mcp's default port), or an ad-hoc dev editor — Chromium fails to
// bind SILENTLY, the nonce probe reports not-ours, and the user is stuck: CDP never works
// unless they hand-set MODOKI_CDP_PORT and relaunch.
//
// We CANNOT probe-then-bind like the backend ladder: MEASURED — `--remote-debugging-port`
// must be appended SYNCHRONOUSLY at module load (after even one `await`, Chromium has
// already read the switch and does NOT bind). So the choice is a PURE synchronous decision
// from persisted state: remember the port we tried and whether it bound OURS, then STICK on
// a success or ADVANCE past a collision on the next launch. A persistent collision self-heals
// in one relaunch instead of dead-ending.

export interface CdpPortMemo {
  /** The port we appended `--remote-debugging-port` for last launch. */
  port: number;
  /** Whether the nonce probe then confirmed the endpoint was OURS. */
  ours: boolean;
}

/** Read the last CDP port memo from userData, or null if unknown/corrupt. */
export function readCdpPortMemo(userDataDir: string): CdpPortMemo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, CDP_PORT_PREF_FILE), 'utf8')) as { port?: unknown; ours?: unknown };
    if (isValidCdpPort(raw?.port) && typeof raw.ours === 'boolean') return { port: Number(raw.port), ours: raw.ours };
    return null;
  } catch {
    return null;
  }
}

/** Persist the CDP port we tried + whether it bound ours, for the next launch's decision. */
export function writeCdpPortMemo(userDataDir: string, memo: CdpPortMemo): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, CDP_PORT_PREF_FILE), JSON.stringify(memo, null, 2) + '\n');
  } catch {
    /* best-effort: failing to remember must never break launch */
  }
}

/**
 * The CDP port to appendSwitch this launch, from the persisted memo. Pure — the unit under
 * test. We get ONE synchronous shot (see above), so this returns exactly one port:
 *  - no memo → the default (9222).
 *  - last was OURS → the same port (STICK — it worked).
 *  - last was NOT ours → the next port in the deterministic band [base, base+span), wrapping
 *    to base at the end (ADVANCE past the collision). A memo port outside the band (a stale
 *    hand-set value that failed) restarts at base.
 */
export function resolveStickyCdpPort(opts: { memo?: CdpPortMemo | null; base?: number; span?: number }): number {
  const base = isValidCdpPort(opts.base) ? Number(opts.base) : DEFAULT_CDP_PORT;
  // Clamp the band so it never runs past a valid TCP port, whatever base is passed — this is
  // an exported helper, so a future caller with a high base must not get an invalid port.
  const span = Math.max(1, Math.min(Number.isInteger(opts.span) && (opts.span as number) > 0 ? (opts.span as number) : CDP_SCAN_SPAN, 65535 - base + 1));
  const memo = opts.memo;
  if (!memo || !isValidCdpPort(memo.port)) return base;
  if (memo.ours) return memo.port; // stick on the port that worked
  const idx = memo.port - base;    // advance within [base, base+span)
  if (idx < 0 || idx >= span) return base; // out of band → restart at base
  return base + ((idx + 1) % span);
}

/**
 * What to persist to the CDP memo after a probe settles — or null to LEAVE IT UNCHANGED.
 *
 * The load-bearing distinction (a review caught this): `probeCdp` collapses a real collision
 * and a TRANSIENT failure into the same `ours:false`. If we advanced off the port on any
 * not-ours, a single 800ms `/json/list` timeout (renderer busy / GC) after a confirmed bind
 * would churn the port next launch — re-heal `.mcp.json` and nag "restart Claude Code" for a
 * collision that never happened. So:
 *  - `ours` → `true` (stick on the port that worked).
 *  - `reachable` but not ours → `false` (a FOREIGN CDP endpoint answered — a genuine
 *    collision; advance next launch).
 *  - unreachable → `null` (couldn't confirm; keep the prior verdict rather than advancing off
 *    a good port).
 */
export function cdpMemoVerdict(probe: { reachable: boolean; ours: boolean }): boolean | null {
  if (probe.ours) return true;
  if (probe.reachable) return false;
  return null;
}

/** The query param that carries the per-launch CDP nonce in the loaded renderer URL. */
export const CDP_NONCE_PARAM = 'cdpNonce';

/** Mint a per-launch nonce. Baked into the renderer URL (`?cdpNonce=<uuid>#/editor`) at
 *  window creation and matched by `probeCdp`, so the CDP endpoint can be proven to be OUR
 *  process — not a sibling editor, not a stray Chrome tab. Minted once per process. */
export function newCdpNonce(): string {
  return randomUUID();
}

/** The `cdpNonce` query param from a page target's URL, or null if absent/unparseable. */
export function cdpNonceOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get(CDP_NONCE_PARAM);
  } catch {
    return null; // 'about:blank', '', or a non-URL target
  }
}

/**
 * The editor renderer URL, with the nonce baked in.
 *
 * PLACEMENT IS LOAD-BEARING and lives HERE, not inline in main.ts, so it's testable in one
 * place: the nonce MUST be a QUERY param BEFORE the `#` — that's the only spot CDP's
 * `/json/list` reports in a form `cdpNonceOf` (i.e. `URL.searchParams`) can read. A nonce
 * AFTER the hash (`#/editor?cdpNonce=…`) lands in the fragment, which `searchParams` never
 * sees → `probeCdp` would report not-ours forever and the whole feature dies silently.
 * Query-before-hash also leaves the hash route (`#/editor`), the origin (will-navigate/CSP),
 * and `waitForServer` untouched, and coexists with the runtime's own `?scene=` param.
 * (Measured against real Chromium: the query round-trips through `/json/list`.)
 */
export function buildRendererUrl(pageOrigin: string, nonce: string): string {
  return `${pageOrigin}/?${CDP_NONCE_PARAM}=${encodeURIComponent(nonce)}#/editor`;
}

export interface CdpProbe {
  /** A CDP endpoint answered on that port. */
  reachable: boolean;
  /** …AND it is OUR renderer — a page target carrying THIS launch's nonce. */
  ours: boolean;
  /** The page URL we judged against (diagnostics: shows WHOSE editor answered). */
  pageUrl?: string;
}

/**
 * Ask a CDP port whether it is OURS. **Never trust the pref** — Chromium takes
 * `--remote-debugging-port` at startup and FAILS SILENTLY if the port is taken, so a
 * pref saying "CDP on, port 9222" can coexist with (a) no endpoint at all, or worse
 * (b) an endpoint owned by a DIFFERENT editor. That really happened: a packaged editor
 * reported CDP 9222 green while 9222 belonged to a sibling clone's editor, and the
 * written `.mcp.json` would have pointed Claude at that other project's renderer.
 *
 * The discriminator is a **per-launch nonce** we bake into our own loaded URL
 * (`?cdpNonce=<uuid>#/editor`) and match here (§12.2). Only THIS process's renderer
 * carries it: a random UUID minted this launch can't appear in a sibling editor's URL, a
 * user's Chrome tab, or an ephemeral-port origin collision. It is EXACT and subsumes the
 * two heuristics the C8 probe stacked — an origin prefix-match (false-positive on a Vite
 * ephemeral `:5173x` port) and a `/json/version` UA sniff (to reject a Chrome tab sitting
 * on our origin) — with one check that has neither false edge, and one fewer round-trip.
 *
 * An empty/absent nonce can never match ⇒ fail-CLOSED (never claim a port is ours without
 * proof), matching the pref-distrust posture.
 */
export async function probeCdp(port: number, nonce: string, timeoutMs = 800): Promise<CdpProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, ours: false };
    const targets = (await res.json()) as Array<{ type?: string; url?: string }>;
    const pages = targets.filter((t): t is { type: string; url: string } => t?.type === 'page' && typeof t.url === 'string');
    const mine = nonce ? pages.find((t) => cdpNonceOf(t.url) === nonce) : undefined;
    if (mine) return { reachable: true, ours: true, pageUrl: mine.url };
    return { reachable: true, ours: false, pageUrl: pages[0]?.url };
  } catch {
    return { reachable: false, ours: false }; // no endpoint, or it didn't answer in time
  }
}

export interface CdpConfig {
  /** Whether a CDP endpoint is (or will be) available on this launch. */
  enabled: boolean;
  /** The port the endpoint uses (whether or not it's open). */
  port: number;
  /** Whether THIS process must appendSwitch the remote-debugging port. True only in
   *  the packaged app (OS-launched, no CLI arg); false in dev (the launcher opens it). */
  openSwitch: boolean;
}

/** Decide the CDP configuration for this launch. Pure — the unit under test.
 *
 *  - Packaged: OS-launched with no CLI arg, so main must open the port itself. Enabled
 *    by DEFAULT (agent-first editor) — main passes `prefEnabled` from `readCdpEnabled`,
 *    which is ON unless the user explicitly opted OUT — OR forced by a valid
 *    MODOKI_CDP_PORT (CI / power users). When enabled, main appendSwitches the port. An explicit
 *    MODOKI_CDP_PORT wins; otherwise the STICKY ladder picks the port from the persisted
 *    memo (§12.2 item 5) so a 9222 collision self-heals across relaunches.
 *  - Dev: the launcher passes --remote-debugging-port directly (Chromium reads it), so
 *    main NEVER opens the switch — it only reports the port as enabled when the launcher
 *    set MODOKI_CDP_PORT. (Dev never uses the sticky ladder — the launcher owns the port.) */
export function resolveCdpConfig(opts: {
  isPackaged: boolean;
  prefEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  /** The persisted last-tried CDP port + ours-verdict (packaged only). */
  memo?: CdpPortMemo | null;
}): CdpConfig {
  const env = opts.env ?? process.env;
  // Force-on ONLY for a VALID port — so a garbage/`0` MODOKI_CDP_PORT fails CLOSED
  // (no port) rather than force-opening the default 9222. Same validator as the port.
  const envForced = isValidCdpPort(env.MODOKI_CDP_PORT);
  // An explicit MODOKI_CDP_PORT always wins (dev launcher pins it; CI/power users). Else
  // the packaged app uses the sticky ladder; dev's reported port is the plain default.
  const port = envForced
    ? resolveCdpPort(env)
    : opts.isPackaged
      ? resolveStickyCdpPort({ memo: opts.memo ?? null })
      : DEFAULT_CDP_PORT;
  if (opts.isPackaged) {
    const enabled = opts.prefEnabled || envForced;
    return { enabled, port, openSwitch: enabled };
  }
  // Dev: the launcher (launch-editor.sh) owns the switch; main only reports it.
  return { enabled: envForced, port, openSwitch: false };
}
