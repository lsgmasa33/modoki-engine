/**
 * Device connection manager — P3 control plane (real TCP, no native dependency to unit-test).
 *
 * The backend-side owner of the device link. Wraps the pure {@link DeviceLeaseClient} (P0) over a
 * real TCP {@link LeaseTransport}, and exposes connect/disconnect/status for the `/api/device/*`
 * routes. One instance per backend process → one per clone (each clone's editor has its own
 * pinned `MODOKI_BACKEND` port), so two clones never share a manager. See
 * `docs/debug-tools-mcp.md`.
 *
 * The GUID is Modoki-generated and PERSISTED per clone (`.modoki/device-guid`), so restarting the
 * editor re-presents the same token and the device (within its grace window) accepts it — the
 * whole reason Modoki, not the device, mints it.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { detectAdb } from '../../toolchain';
import { DeviceLeaseClient, type LeaseTransport, type LeaseRequest, type LeaseReply, type LeaseState } from './deviceLease';

/** The device plugin's TCP port (matches `GameDebugPlugin` default). */
export const DEVICE_PORT = 9095;

/** Resolve the adb binary the editor PROVISIONS (Android SDK platform-tools), NOT a bare `adb` on
 *  PATH: the packaged editor's adb lives under its toolchain dir and is NOT on the system PATH, so
 *  `execFileSync('adb', …)` ENOENTs there (this is why USB failed while WiFi — a direct TCP connect
 *  needing no adb — worked). `detectAdb()` derives `<sdk>/platform-tools/adb(.exe)` from the resolved
 *  Android SDK (env → provisioned userData SDK). */
function adbBinary(): string {
  const d = detectAdb();
  if (!d.present || !d.path) {
    throw new Error(
      'adb not found. USB tunneling needs the Android SDK platform-tools — install the Android SDK ' +
      'from Build Support (or set ANDROID_HOME), then reconnect. WiFi (device IP) works without adb.',
    );
  }
  return d.path;
}

/** The `adb forward` calls behind an overridable seam, so tests can inject a spy without mocking the
 *  `child_process` module (which fights vitest's per-file module cache in the full suite). */
export const adbRunner = {
  forward(port: number): void {
    execFileSync(adbBinary(), ['forward', `tcp:${port}`, `tcp:${port}`], { timeout: 4000, stdio: 'pipe' });
  },
  removeForward(port: number): void {
    execFileSync(adbBinary(), ['forward', '--remove', `tcp:${port}`], { timeout: 4000, stdio: 'pipe' });
  },
};
const REQUEST_TIMEOUT_MS = 5000;
/** Fail a hung TCP connect fast instead of waiting ~75s for the OS to time out — a silent packet
 *  drop (wrong IP / not same WiFi / server not listening / firewall) otherwise looks "stuck". */
const CONNECT_TIMEOUT_MS = 6000;

// ── Real TCP transport (WiFi to a typed IP, or adb-forwarded 127.0.0.1) ───────

/** Newline-delimited-JSON control link to the device. Reuses the device's existing
 *  `{id, method, params}` → `{id, result|error}` envelope; lease methods carry `{guid}`. */
export class TcpLeaseTransport implements LeaseTransport {
  private socket: net.Socket | null = null;
  private buf = '';
  private nextId = 0;
  private pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private dropCb: () => void = () => {};
  private opened = false;
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(host: string, port: number, opts?: { connectTimeoutMs?: number; requestTimeoutMs?: number }) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  onDrop(cb: () => void): void { this.dropCb = cb; }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.buf = ''; // fresh socket → discard any partial frame left from a prior drop (L9)
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.opened = true;
        resolve();
      });
      // Bound the connect: a silent drop (unreachable / not listening) otherwise hangs ~75s.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connect to ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms — check the device is on the same WiFi, running a debug build, and not firewalled`));
      }, this.connectTimeoutMs);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { this.buf += chunk; this.processBuffer(); });
      socket.on('close', () => this.handleClose());
      socket.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); } // pre-connect failure
        socket.destroy();
      });
    });
  }

  private processBuffer(): void {
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let msg: { id?: string; result?: LeaseReply; error?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.id) continue; // ignore console pushes / unsolicited frames
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result ?? null);
    }
  }

  /** Low-level RPC over the socket — one `{id, method, params}` → `{id, result|error}` round-trip. */
  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(new Error('not connected')); return; }
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`device request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Control-plane lease message (connect/ping/disconnect). */
  request(msg: LeaseRequest): Promise<LeaseReply> {
    return this.rpc(msg.type, { guid: msg.guid }) as Promise<LeaseReply>;
  }

  /** Data-plane request proxied on behalf of Claude (eval/screenshot/tap/…) — reuses the same
   *  owned socket, so the device's existing JS bridge handles it and replies on this socket. */
  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.rpc(method, params);
  }

  close(): void {
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }

  private handleClose(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('device link closed')); }
    this.pending.clear();
    this.buf = ''; // drop any partial frame so it can't corrupt the first reply after reconnect (L9)
    const wasOpen = this.opened && !!this.socket;
    this.socket = null;
    if (wasOpen) this.dropCb(); // unexpected drop → client auto-reconnects
  }
}

// ── GUID persistence (per clone) ──────────────────────────────────────────────

/** Load the clone's persistent device GUID, minting + saving one on first use. Keyed on the
 *  backend process's cwd (the clone root) so each checkout keeps its own stable token. `dir` is
 *  injectable for tests; production uses `<cwd>/.modoki`. */
export function loadOrCreateGuid(dir: string = path.join(process.cwd(), '.modoki')): string {
  const file = path.join(dir, 'device-guid');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* not created yet */ }
  const guid = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, guid);
  } catch { /* non-fatal: fall back to an in-memory guid for this process */ }
  return guid;
}

/** The last connect target the user chose, remembered across editor restarts (per clone). The IP
 *  persists even across an adb connect, so switching back to WiFi re-fills it. */
export interface LastTarget { ip: string; useAdb: boolean }

function lastTargetFile(dir: string): string {
  return path.join(dir, 'device-target.json');
}

export function loadLastTarget(dir: string = path.join(process.cwd(), '.modoki')): LastTarget | null {
  try {
    const t = JSON.parse(fs.readFileSync(lastTargetFile(dir), 'utf8'));
    if (typeof t?.ip === 'string' || typeof t?.useAdb === 'boolean') {
      return { ip: String(t.ip ?? ''), useAdb: Boolean(t.useAdb) };
    }
  } catch { /* not created yet */ }
  return null;
}

export function saveLastTarget(t: LastTarget, dir: string = path.join(process.cwd(), '.modoki')): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lastTargetFile(dir), JSON.stringify(t));
  } catch { /* non-fatal */ }
}

// ── Connection manager (the singleton the routes drive) ───────────────────────

export interface DeviceConnectStatus {
  state: LeaseState;
  guid: string;
  target: { host: string; port: number; useAdb: boolean } | null;
  /** Last chosen IP/adb, remembered across restarts, so the panel can pre-fill the field. */
  lastTarget: LastTarget | null;
  detail?: string;
}

export interface ConnectRequest {
  /** Device LAN IP (WiFi). Ignored when `useAdb` is true. */
  ip?: string;
  /** Tunnel over USB via `adb forward` and connect to 127.0.0.1 (Android only). */
  useAdb?: boolean;
  port?: number;
}

export class DeviceConnectionManager {
  private client: DeviceLeaseClient | null = null;
  private transport: TcpLeaseTransport | null = null;
  private state: LeaseState = 'disconnected';
  private detail?: string;
  private target: { host: string; port: number; useAdb: boolean } | null = null;
  private lastTarget: LastTarget | null;
  private readonly guid: string;
  private readonly stateDir: string;

  /** `stateDir` is the per-clone `.modoki` dir the last-target file lives in — injectable so tests
   *  isolate their persisted state instead of scribbling on the real repo's `.modoki`. */
  constructor(guid = loadOrCreateGuid(), stateDir: string = path.join(process.cwd(), '.modoki')) {
    this.guid = guid;
    this.stateDir = stateDir;
    this.lastTarget = loadLastTarget(stateDir);
  }

  /** Connect (or reconnect) to a device. Tears down any prior link first, so a re-Connect with a
   *  new IP is clean. `useAdb` runs `adb forward` and targets 127.0.0.1; otherwise the typed IP.
   *  With NEITHER `ip` nor `useAdb` (a "bare" reconnect), reuse the last target this clone used. */
  async connect(req: ConnectRequest): Promise<DeviceConnectStatus> {
    await this.disconnect();
    // A bare call (no ip, no explicit useAdb) reconnects the last target — all-or-nothing, so that
    // supplying just an ip still means WiFi (never adb) and supplying useAdb still means USB. Capture
    // the prior target BEFORE we overwrite this.lastTarget below.
    const reqIp = req.ip?.trim();
    const bareReconnect = !reqIp && req.useAdb === undefined && !!this.lastTarget;
    const useAdb = bareReconnect ? !!this.lastTarget!.useAdb : !!req.useAdb;
    const ip = reqIp || (bareReconnect ? this.lastTarget!.ip : undefined);
    // Remember what we chose (even if the connect then fails), so the panel pre-fills it next time.
    // Keep the last typed IP across an adb connect (so toggling back to WiFi re-fills).
    this.lastTarget = { ip: ip || this.lastTarget?.ip || '', useAdb };
    saveLastTarget(this.lastTarget, this.stateDir);
    const port = req.port ?? DEVICE_PORT;
    let host: string;
    if (useAdb) {
      try {
        adbRunner.forward(port);
      } catch (e) {
        this.state = 'error';
        this.detail = `adb forward failed: ${e instanceof Error ? e.message : String(e)}`;
        return this.status();
      }
      host = '127.0.0.1';
    } else {
      if (!ip) {
        this.state = 'error';
        this.detail = 'no IP provided (uncheck "Use adb" and enter the device IP, or check it for USB)';
        return this.status();
      }
      host = ip;
    }

    this.transport = new TcpLeaseTransport(host, port);
    this.client = new DeviceLeaseClient({
      guid: this.guid,
      transport: this.transport,
      onState: (s, d) => { this.state = s; this.detail = d; },
    });
    this.target = { host, port, useAdb };
    await this.client.connect();
    return this.status();
  }

  async disconnect(): Promise<DeviceConnectStatus> {
    if (this.client) { try { await this.client.disconnect(); } catch { /* */ } }
    // Reclaim the adb-forward rule this connection created (L10) — an un-removed `tcp:<port>`
    // forward outlives the editor and can mask a device swap (127.0.0.1 keeps answering the old
    // tunnel). Best-effort; a re-connect re-adds the idempotent rule anyway.
    if (this.target?.useAdb) {
      try { adbRunner.removeForward(this.target.port); }
      catch { /* forward may already be gone / adb absent — non-fatal */ }
    }
    this.client = null;
    this.transport = null;
    this.state = 'disconnected';
    this.detail = undefined;
    this.target = null;
    return this.status();
  }

  status(): DeviceConnectStatus {
    return { state: this.state, guid: this.guid, target: this.target, lastTarget: this.lastTarget, ...(this.detail ? { detail: this.detail } : {}) };
  }

  /** Proxy a data-plane request (eval/screenshot/tap/console-logs/…) through the held socket —
   *  the controlled-comms path: Claude's device_* tools go through Modoki, not their own socket. */
  async proxy(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'connected' || !this.transport) {
      throw new Error(`no device connected (state: ${this.state}) — connect in the AI panel first`);
    }
    return this.transport.send(method, params);
  }
}

/** Process-global device connection (one per backend → one per clone). */
export const deviceConnection = new DeviceConnectionManager();
