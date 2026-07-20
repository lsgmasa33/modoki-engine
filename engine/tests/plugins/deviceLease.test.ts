import { describe, it, expect } from 'vitest';
import {
  DeviceLeaseAuthority,
  DeviceLeaseClient,
  type LeaseTransport,
  type LeaseRequest,
  type LeaseReply,
  type LeaseState,
  LEASE_GRACE_MS,
} from '../../plugins/backend/deviceLease';

// ── Test harness: a manual clock that also drives the client's timers, so the
//    authority's grace deadline and the client's ping/reconnect schedule share one
//    deterministic timeline (no vitest fake-timer / microtask interplay). ──

class ManualClock {
  now = 0;
  private timers: { id: number; at: number; cb: () => void }[] = [];
  private seq = 0;

  setTimer = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (h: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter((t) => t.id !== (h as unknown as number));
  };

  /** Advance time to now+ms, firing every timer that comes due (including ones scheduled
   *  by the callbacks we fire), flushing microtasks between each so async chains progress. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    // Safety bound against a runaway reschedule loop in a buggy test.
    for (let guard = 0; guard < 100_000; guard++) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.cb();
      await flush();
    }
    this.now = target;
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** In-memory device the transport talks to. Models the app process: `reachable` gates whether a
 *  socket can open (false while the game is relaunching), `relaunch()` restarts the authority. */
class MockDevice {
  authority: DeviceLeaseAuthority;
  reachable = true;
  constructor(private clock: ManualClock, graceMs = LEASE_GRACE_MS) {
    this.authority = new DeviceLeaseAuthority(graceMs);
  }
  get now(): number { return this.clock.now; }
  relaunch(): void { this.authority = new DeviceLeaseAuthority(); }
}

/** LeaseTransport over a MockDevice. `drop()` simulates an unexpected link loss. */
class MockTransport implements LeaseTransport {
  private dropCb: () => void = () => {};
  private attached = false;
  constructor(private dev: MockDevice) {}

  onDrop(cb: () => void): void { this.dropCb = cb; }

  async open(): Promise<void> {
    if (!this.dev.reachable) throw new Error('device unreachable');
    this.attached = true;
  }

  async request(msg: LeaseRequest): Promise<LeaseReply> {
    if (!this.attached) throw new Error('not connected');
    const now = this.dev.now;
    switch (msg.type) {
      case 'connect': return this.dev.authority.connect(msg.guid, now);
      case 'ping': return this.dev.authority.ping(msg.guid, now);
      case 'disconnect': return this.dev.authority.disconnect(msg.guid, now);
    }
  }

  close(): void { this.attached = false; }

  /** Unexpected drop: detach + tell the authority its owner's socket died + fire onDrop. */
  drop(): void {
    if (!this.attached) return;
    this.attached = false;
    this.dev.authority.socketDropped(this.dev.now);
    this.dropCb();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device-side authority
// ─────────────────────────────────────────────────────────────────────────────

describe('DeviceLeaseAuthority', () => {
  it('grants the lease when free', () => {
    const a = new DeviceLeaseAuthority();
    expect(a.connect('A', 0)).toEqual({ ok: true });
    const s = a.status(0);
    expect(s.leased).toBe(true);
    expect(s.live).toBe(true);
    expect(s.guid).toBe('A');
  });

  it('refuses a different guid while owned (busy)', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    expect(a.connect('B', 100)).toEqual({ ok: false, reason: 'busy' });
  });

  it('resumes the SAME guid after a drop within the grace window', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);
    expect(a.status(3000).live).toBe(false);       // in grace, not live
    expect(a.status(3000).leased).toBe(true);      // but still held
    expect(a.connect('A', 3000)).toEqual({ ok: true, resumed: true });
    expect(a.status(3000).live).toBe(true);
  });

  it('frees the lease once the grace window elapses', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);
    expect(a.status(LEASE_GRACE_MS - 1).leased).toBe(true);
    expect(a.status(LEASE_GRACE_MS).leased).toBe(false);   // freed at the deadline
    expect(a.connect('B', LEASE_GRACE_MS)).toEqual({ ok: true }); // now available
  });

  it('reports not-owner to the evicted owner after another takes over', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);
    a.connect('B', LEASE_GRACE_MS);                 // B grabs it post-grace
    expect(a.ping('A', LEASE_GRACE_MS)).toEqual({ ok: false, reason: 'not-owner' });
    expect(a.ping('B', LEASE_GRACE_MS)).toEqual({ ok: true });
  });

  it('frees immediately on an owner disconnect, and rejects a wrong-guid disconnect', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    expect(a.disconnect('B', 10)).toEqual({ ok: false, reason: 'not-owner' });
    expect(a.status(10).leased).toBe(true);         // still A's
    expect(a.disconnect('A', 10)).toEqual({ ok: true });
    expect(a.status(10).leased).toBe(false);
  });

  it('ping refreshes a stale grace (defensive)', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);
    expect(a.ping('A', 1000)).toEqual({ ok: true });
    expect(a.status(1000).live).toBe(true);         // ping re-attached
  });

  it('reset() (game relaunch) unconditionally frees', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.reset();
    expect(a.status(0).leased).toBe(false);
    expect(a.connect('B', 0)).toEqual({ ok: true });
  });

  it('does NOT re-arm grace when a non-owner socket drops mid-window (L7)', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);          // owner drops → grace anchored to now → 5000
    a.socketDropped(2000);       // an extra/refused socket closing must NOT push the deadline out
    expect(a.status(4999).leased).toBe(true);
    expect(a.status(LEASE_GRACE_MS).leased).toBe(false); // still frees at the ORIGINAL 5000
  });

  it('does NOT revive an already-expired lease on a late socket drop (L7)', () => {
    const a = new DeviceLeaseAuthority();
    a.connect('A', 0);
    a.socketDropped(0);          // grace → 5000
    // Past the deadline with no message yet observed; a late drop must not resurrect the dead lease.
    a.socketDropped(6000);
    expect(a.status(6000).leased).toBe(false);
    expect(a.connect('B', 6000)).toEqual({ ok: true }); // device is genuinely available
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Modoki-side client (connect / ping / auto-reconnect / disconnect)
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(dev: MockDevice, clock: ManualClock, guid: string, states: LeaseState[] = []) {
  const transport = new MockTransport(dev);
  const client = new DeviceLeaseClient({
    guid,
    transport,
    pingIntervalMs: 2000,
    reconnectDelayMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (s) => states.push(s),
  });
  return { client, transport, states };
}

describe('DeviceLeaseClient', () => {
  it('connects, becomes connected, and keeps the lease alive via ping', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client } = makeClient(dev, clock, 'mine');

    expect(await client.connect()).toBe('connected');
    expect(dev.authority.status(clock.now).guid).toBe('mine');

    // Several ping intervals pass — the lease stays live, state unchanged.
    await clock.advance(10_000);
    expect(client.getState()).toBe('connected');
    expect(dev.authority.status(clock.now).live).toBe(true);
  });

  it('reports busy when another Modoki already owns the device', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    dev.authority.connect('other', 0);              // someone else holds it

    const { client } = makeClient(dev, clock, 'mine');
    expect(await client.connect()).toBe('busy');
  });

  it('reports error when the device is unreachable on the initial connect', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    dev.reachable = false;

    const { client } = makeClient(dev, clock, 'mine');
    expect(await client.connect()).toBe('error');
  });

  it('reports busy when reachable but the connect handshake is refused (first-wins drop)', async () => {
    const clock = new ManualClock();
    // Transport that connects at the TCP level but drops the connect handshake with no reply —
    // exactly what a first-wins device does to an extra client while an owner is live.
    const refusingTransport: LeaseTransport = {
      onDrop() { /* */ },
      async open() { /* TCP connects fine */ },
      async request() { throw new Error('device link closed'); },
      close() { /* */ },
    };
    const client = new DeviceLeaseClient({
      guid: 'mine', transport: refusingTransport,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    expect(await client.connect()).toBe('busy');
  });

  it('AUTO-RECONNECTS with the same GUID across a game relaunch (the core case)', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client, transport, states } = makeClient(dev, clock, 'mine');

    await client.connect();
    expect(client.getState()).toBe('connected');

    // Game relaunches: link drops, app goes away, its lease is wiped.
    transport.drop();
    dev.reachable = false;
    dev.relaunch();
    expect(client.getState()).toBe('reconnecting');

    // App still down — reconnect attempts fail, client keeps trying.
    await clock.advance(3000);
    expect(client.getState()).toBe('reconnecting');

    // App comes back (fresh authority) — the next attempt re-presents 'mine' and wins.
    dev.reachable = true;
    await clock.advance(2000);
    expect(client.getState()).toBe('connected');
    expect(dev.authority.status(clock.now).guid).toBe('mine');
    expect(states).toContain('reconnecting');
  });

  it('resumes ownership through a brief WiFi blip (drop within grace, app still up)', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client, transport } = makeClient(dev, clock, 'mine');

    await client.connect();
    transport.drop();                               // blip: socket dies, app + lease survive
    expect(client.getState()).toBe('reconnecting');

    await clock.advance(1500);                      // one reconnect delay
    expect(client.getState()).toBe('connected');    // same guid resumed within grace
    expect(dev.authority.status(clock.now).live).toBe(true);
  });

  it('goes busy if it was evicted while gone (another Modoki grabbed it post-grace)', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client, transport } = makeClient(dev, clock, 'mine');

    await client.connect();
    transport.drop();
    dev.reachable = false;                          // our reconnects will fail for a while

    // Let the grace window lapse, then a competing Modoki claims the device.
    await clock.advance(LEASE_GRACE_MS + 500);
    dev.authority.connect('rival', clock.now);
    expect(dev.authority.status(clock.now).guid).toBe('rival');

    // App reachable again — our next reconnect presents 'mine', gets refused → busy.
    dev.reachable = true;
    await clock.advance(2000);
    expect(client.getState()).toBe('busy');
  });

  it('recovers when the lease vanishes without a socket drop (relaunch, ping detects it)', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client } = makeClient(dev, clock, 'mine');

    await client.connect();
    dev.authority.reset();                          // lease gone, but socket still "attached"

    // Next ping sees no-lease → client reconnects and re-grabs the free device.
    await clock.advance(5000);
    expect(client.getState()).toBe('connected');
    expect(dev.authority.status(clock.now).guid).toBe('mine');
  });

  it('disconnect() releases the lease and stops all timers', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    const { client } = makeClient(dev, clock, 'mine');

    await client.connect();
    await client.disconnect();
    expect(client.getState()).toBe('disconnected');
    expect(dev.authority.status(clock.now).leased).toBe(false);

    // No stray ping/reconnect fires after release.
    await clock.advance(10_000);
    expect(client.getState()).toBe('disconnected');
  });

  it('a fresh Modoki can take over cleanly after the owner disconnects', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);

    const a = makeClient(dev, clock, 'A');
    await a.client.connect();
    await a.client.disconnect();

    const b = makeClient(dev, clock, 'B');
    expect(await b.client.connect()).toBe('connected');
    expect(dev.authority.status(clock.now).guid).toBe('B');
  });

  it('a drop DURING the connect handshake ends in busy with NO stray reconnect loop (L1)', async () => {
    const clock = new ManualClock();
    // TCP connects, but the socket dies mid-handshake: onDrop fires, then the request rejects with
    // no reply — exactly a first-wins device refusing an extra client. The client must surface
    // busy AND must not arm a background reconnect that contradicts it (the L1 bug).
    let dropCb = (): void => {};
    const transport: LeaseTransport = {
      onDrop(cb) { dropCb = cb; },
      async open() { /* TCP connects fine */ },
      async request() { dropCb(); throw new Error('device link closed'); },
      close() { /* */ },
    };
    const states: LeaseState[] = [];
    const client = new DeviceLeaseClient({
      guid: 'mine', transport,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      onState: (s) => states.push(s),
    });

    expect(await client.connect()).toBe('busy');
    // Advancing time must NOT resurrect a reconnect loop or flip the surfaced state.
    await clock.advance(10_000);
    expect(client.getState()).toBe('busy');
    expect(states).not.toContain('reconnecting');
  });

  it('a ping reply landing after disconnect() stays inert (L8)', async () => {
    const clock = new ManualClock();
    const dev = new MockDevice(clock);
    // Ping hangs until we release it, so we can tear down while it's in flight.
    let releasePing: (r: LeaseReply) => void = () => {};
    const base = new MockTransport(dev);
    const transport: LeaseTransport = {
      onDrop: (cb) => base.onDrop(cb),
      open: () => base.open(),
      request: (msg) => msg.type === 'ping'
        ? new Promise<LeaseReply>((res) => { releasePing = res; })
        : base.request(msg),
      close: () => base.close(),
    };
    const client = new DeviceLeaseClient({
      guid: 'mine', transport, pingIntervalMs: 2000, reconnectDelayMs: 1000,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });

    await client.connect();
    await clock.advance(2000);        // ping tick fires → request(ping) is now pending
    await client.disconnect();        // tear down while the ping is in flight
    expect(client.getState()).toBe('disconnected');

    releasePing({ ok: true });        // the late reply lands after teardown
    await flush();
    await clock.advance(10_000);
    expect(client.getState()).toBe('disconnected'); // no ping/reconnect resurrected
  });
});
