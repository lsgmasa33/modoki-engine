/**
 * Device connection lease — P0 core (pure state machines, no sockets, no native).
 *
 * Replaces the game-debug MCP's Bonjour/adb auto-connect (which lets an idle Claude session
 * in any clone silently grab the single-client device) with a DELIBERATE, Modoki-owned lease.
 * See `docs/debug-tools-mcp.md` for the full design.
 *
 * Two halves, both clock-injected so they unit-test without wall-clock or real timers:
 *
 *   • {@link DeviceLeaseAuthority} — the DEVICE-side owner of the lease. This is the canonical
 *     spec P1 ports to Swift (`GameDebugPlugin`) + Kotlin. Every method takes `now` so grace
 *     expiry is evaluated lazily (no device-side timer needed): a `connect`/`ping` that arrives
 *     after the grace window observes the lease already free.
 *
 *   • {@link DeviceLeaseClient} — the MODOKI-side manager. Holds the (Modoki-generated, stable)
 *     GUID, connects through an injected {@link LeaseTransport}, pings to detect a dead link, and
 *     AUTO-RECONNECTS with the SAME GUID so a game relaunch needs no human click. The GUID's
 *     stability across relaunches is the whole point of Modoki (not the device) minting it.
 *
 * Contention resolves by ownership, never by theft: a second Modoki presenting a different GUID
 * is REJECTED (→ the AI panel shows an error dialog). Takeover happens only by the owner
 * disconnecting, the grace window expiring after it's gone, or relaunching the game.
 */

/** Grace window (ms) the device holds a lease after its owner's socket drops, before freeing it.
 *  Long enough to ride a WiFi blip + one auto-reconnect; short enough that a crashed editor frees
 *  fast. Locked at 5s in the plan (§Resolved decisions). */
export const LEASE_GRACE_MS = 5000;

/** Control-plane message Modoki sends the device. (Data-plane requests will carry `guid` too.) */
export interface LeaseRequest {
  type: 'connect' | 'ping' | 'disconnect';
  guid: string;
}

/** Device's reply to a {@link LeaseRequest}. */
export interface LeaseReply {
  ok: boolean;
  /** Why a request was refused — for the client's state + the panel's error copy. */
  reason?: 'busy' | 'no-lease' | 'not-owner';
  /** true when `connect` re-attached the SAME guid to an existing (grace-window) lease. */
  resumed?: boolean;
}

// ── Device-side authority (the native spec) ──────────────────────────────────

/**
 * The lease as the DEVICE enforces it. One instance == one physical device. Pure + synchronous;
 * `now` is passed in so there is no internal timer to port to Swift/Kotlin — grace is a deadline
 * compared on the next message.
 */
export class DeviceLeaseAuthority {
  private leaseGuid: string | null = null;
  /** Is the owner's socket currently attached? (false during the post-drop grace window.) */
  private live = false;
  /** Wall-clock ms after which a dropped lease is freed; null when live or free. */
  private graceUntil: number | null = null;

  private readonly graceMs: number;

  constructor(graceMs: number = LEASE_GRACE_MS) {
    this.graceMs = graceMs;
  }

  /** Free the lease if its grace window has elapsed. Called at the top of every entry point so
   *  time is observed lazily. */
  private expireIfDue(now: number): void {
    if (this.leaseGuid !== null && !this.live && this.graceUntil !== null && now >= this.graceUntil) {
      this.leaseGuid = null;
      this.graceUntil = null;
    }
  }

  /** A Modoki asks to own the device. Granted when free, or when it re-presents the SAME guid
   *  (reconnect within grace). A different guid while owned → refused `busy`. */
  connect(guid: string, now: number): LeaseReply {
    this.expireIfDue(now);
    if (this.leaseGuid === null) {
      this.leaseGuid = guid;
      this.live = true;
      this.graceUntil = null;
      return { ok: true };
    }
    if (this.leaseGuid === guid) {
      // Same owner reattaching — after a socket blip or a game relaunch it kept its GUID.
      const resumed = !this.live;
      this.live = true;
      this.graceUntil = null;
      return { ok: true, resumed };
    }
    return { ok: false, reason: 'busy' };
  }

  /** Keepalive + ownership check. Confirms the caller still holds a live lease. */
  ping(guid: string, now: number): LeaseReply {
    this.expireIfDue(now);
    if (this.leaseGuid === null) return { ok: false, reason: 'no-lease' };
    if (this.leaseGuid !== guid) return { ok: false, reason: 'not-owner' };
    // Owner pinged → it's clearly attached; heal a stale grace (defensive; a ping normally
    // only arrives over a live socket).
    this.live = true;
    this.graceUntil = null;
    return { ok: true };
  }

  /** The owner's socket closed (quit / crash / sleep / WiFi drop). Start the grace countdown;
   *  the lease is NOT freed yet, so an auto-reconnect with the same guid resumes it. */
  socketDropped(now: number): void {
    this.expireIfDue(now);
    // Only the LIVE owner's drop starts the countdown. A drop while already in grace — e.g. a
    // refused extra client's socket closing, or a late drop after the deadline elapsed — must NOT
    // re-arm it: grace is anchored to the owner's drop, so a rival's takeover isn't pushed past 5s
    // and an already-expired lease isn't revived (L7).
    if (this.leaseGuid !== null && this.live) {
      this.live = false;
      this.graceUntil = now + this.graceMs;
    }
  }

  /** Owner explicitly releases (Disconnect clicked). Frees immediately if the guid matches. */
  disconnect(guid: string, now: number): LeaseReply {
    this.expireIfDue(now);
    if (this.leaseGuid !== guid) return { ok: false, reason: this.leaseGuid === null ? 'no-lease' : 'not-owner' };
    this.leaseGuid = null;
    this.live = false;
    this.graceUntil = null;
    return { ok: true };
  }

  /** Game relaunch — the app process restarts, so its in-memory lease is unconditionally gone.
   *  (On device this is implicit: a fresh process starts with a fresh authority.) */
  reset(): void {
    this.leaseGuid = null;
    this.live = false;
    this.graceUntil = null;
  }

  /** Inspect state (for status endpoints + tests). */
  status(now: number): { leased: boolean; live: boolean; guid: string | null; graceRemaining: number } {
    this.expireIfDue(now);
    return {
      leased: this.leaseGuid !== null,
      live: this.live,
      guid: this.leaseGuid,
      graceRemaining: this.graceUntil !== null ? Math.max(0, this.graceUntil - now) : 0,
    };
  }
}

// ── Modoki-side client ───────────────────────────────────────────────────────

/** A live link to the device the client drives. Real impl wraps a TCP socket (WiFi or adb-
 *  forwarded); the test impl is in-memory. `open` establishes a fresh connection; `request`
 *  does one control round-trip; `onDrop` fires when the link closes unexpectedly. */
export interface LeaseTransport {
  open(): Promise<void>;
  request(msg: LeaseRequest): Promise<LeaseReply>;
  close(): void;
  onDrop(cb: () => void): void;
}

export type LeaseState =
  | 'disconnected' // no attempt / cleanly released
  | 'connecting'   // initial connect in flight
  | 'connected'    // owns a live lease
  | 'reconnecting' // link dropped, retrying with the same guid (rides relaunch/blip)
  | 'busy'         // device owned by another Modoki — human must resolve (error dialog)
  | 'error';       // device unreachable on the initial connect

export interface LeaseClientOptions {
  /** The Modoki-generated, per-clone-persistent GUID. Stable across game relaunches. */
  guid: string;
  transport: LeaseTransport;
  /** Ping cadence (ms). */
  pingIntervalMs?: number;
  /** Delay between reconnect attempts while the link is down (ms). */
  reconnectDelayMs?: number;
  /** Fired on every state transition (drives the AI-panel button + status). */
  onState?: (state: LeaseState, detail?: string) => void;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Owns the device connection on Modoki's behalf: connect → ping → auto-reconnect → disconnect.
 * A game relaunch drops the link; this keeps retrying `connect{guid}` until the fresh app
 * accepts the same GUID — so the user clicks Connect ONCE per editor session.
 */
export class DeviceLeaseClient {
  private state: LeaseState = 'disconnected';
  private readonly guid: string;
  private readonly transport: LeaseTransport;
  private readonly pingIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly onState?: (state: LeaseState, detail?: string) => void;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  private pingHandle: ReturnType<typeof setTimeout> | null = null;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  /** Set true by disconnect() so an in-flight reconnect loop stops instead of re-grabbing. */
  private released = false;

  constructor(opts: LeaseClientOptions) {
    this.guid = opts.guid;
    this.transport = opts.transport;
    this.pingIntervalMs = opts.pingIntervalMs ?? 2000;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.onState = opts.onState;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.transport.onDrop(() => this.handleDrop());
  }

  getState(): LeaseState { return this.state; }

  private setState(s: LeaseState, detail?: string): void {
    this.state = s;
    this.onState?.(s, detail);
  }

  /** User clicked Connect. One-shot: on `busy` we stop and surface it (no silent retry against
   *  someone else's lease); on unreachable we report `error`. Success starts the ping loop. */
  async connect(): Promise<LeaseState> {
    this.released = false;
    this.setState('connecting');

    // Split the two failures so the panel can tell them apart:
    //  • open() throws  → no TCP at all → device unreachable → 'error'.
    //  • open() ok but the connect handshake fails → the device is REACHABLE but dropped us
    //    without a reply. A first-wins plugin refuses an extra client exactly that way, so
    //    "reachable + no connect reply" == already owned by another Modoki → 'busy'. (A clean
    //    {ok:false,busy} reply — which happens during the owner's grace window, when the extra
    //    socket IS accepted — is handled below and is the same outcome.)
    try {
      await this.transport.open();
    } catch (e) {
      this.transport.close();
      this.setState('error', e instanceof Error ? e.message : String(e));
      return this.state;
    }

    try {
      const reply = await this.transport.request({ type: 'connect', guid: this.guid });
      if (reply.ok) {
        this.setState('connected', reply.resumed ? 'resumed' : undefined);
        this.startPing();
      } else {
        // Another Modoki owns it — the human decides (Disconnect there, or relaunch the game).
        this.transport.close();
        this.setState('busy', reply.reason);
      }
    } catch {
      this.transport.close();
      this.setState('busy', 'refused'); // reachable but the connect got no reply → owned
    }
    return this.state;
  }

  /** User clicked Disconnect. Best-effort release, then tear down. */
  async disconnect(): Promise<void> {
    this.released = true;
    this.stopPing();
    this.stopReconnect();
    try { await this.transport.request({ type: 'disconnect', guid: this.guid }); }
    catch { /* link may already be gone — the grace window frees it device-side */ }
    this.transport.close();
    this.setState('disconnected');
  }

  private startPing(): void {
    this.stopPing();
    const tick = async (): Promise<void> => {
      if (this.state !== 'connected') return;
      try {
        const reply = await this.transport.request({ type: 'ping', guid: this.guid });
        // A disconnect()/teardown may have landed while the ping was in flight — bail before
        // touching handleDrop or rescheduling, so no stray timer is armed post-teardown (L8).
        if (this.released || this.state !== 'connected') return;
        if (!reply.ok) { this.handleDrop(reply.reason); return; }
      } catch {
        if (this.released || this.state !== 'connected') return;
        this.handleDrop('ping-timeout');
        return;
      }
      this.pingHandle = this.setTimer(() => void tick(), this.pingIntervalMs);
    };
    this.pingHandle = this.setTimer(() => void tick(), this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingHandle !== null) { this.clearTimer(this.pingHandle); this.pingHandle = null; }
  }

  private stopReconnect(): void {
    if (this.reconnectHandle !== null) { this.clearTimer(this.reconnectHandle); this.reconnectHandle = null; }
  }

  /** Link lost (socket dropped, or a ping failed). If a ping told us another owner has the lease
   *  (`not-owner`), someone stole it during our absence → surface `busy`. Otherwise retry with
   *  the same GUID (the common case: the game is relaunching). */
  private handleDrop(reason?: string): void {
    if (this.released) return;                 // deliberate disconnect — not a drop
    // Only a LIVE connection reacts to a drop. During the initial 'connecting' handshake a drop is
    // the first-wins refusal — connect() surfaces 'busy'/'error'; arming a reconnect here would run
    // a stray loop that contradicts that state and could silently re-grab the device (L1). During
    // 'reconnecting' the attemptReconnect loop already owns retries; and once 'busy'/'error'/
    // 'disconnected', a late drop must not resurrect a reconnect.
    if (this.state !== 'connected') return;
    this.stopPing();
    if (reason === 'not-owner') {
      // We were evicted (grace expired + another Modoki connected). Don't fight for it.
      this.transport.close();
      this.setState('busy', reason);
      return;
    }
    this.setState('reconnecting', reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.stopReconnect();
    this.reconnectHandle = this.setTimer(() => void this.attemptReconnect(), this.reconnectDelayMs);
  }

  /** Re-open the link and re-present the SAME guid. Loops until it succeeds, is told `busy`, or
   *  the user disconnects. */
  private async attemptReconnect(): Promise<void> {
    if (this.released) return;
    try {
      await this.transport.open();
      const reply = await this.transport.request({ type: 'connect', guid: this.guid });
      if (reply.ok) {
        this.setState('connected', reply.resumed ? 'resumed' : undefined);
        this.startPing();
        return;
      }
      // The device is up but our GUID is refused → another Modoki grabbed it. Give up cleanly.
      this.transport.close();
      this.setState('busy', reply.reason);
    } catch {
      // Device still unreachable (app mid-relaunch) — try again after the delay.
      try { this.transport.close(); } catch { /* */ }
      if (!this.released) this.scheduleReconnect();
    }
  }
}
