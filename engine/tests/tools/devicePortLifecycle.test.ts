/** `createPortLifecycleHandler` (#95) — the debug bridge releases port 9095 when the app
 *  backgrounds and re-binds when it returns, so THE FOREGROUND APP OWNS THE PORT.
 *
 *  The behaviour was verified on the Samsung (foreground binds 9095 → HOME releases it, confirmed
 *  absent from `/proc/net/tcp` → returning re-binds 9095 rather than falling back). Hardware cannot
 *  re-run in CI, and the parts most likely to rot are exactly the ones a device run makes
 *  invisible. In particular: if the pause branch stops calling `stop`, **nothing fails loudly** —
 *  the port simply stays held and the #88 wrong-app hazard silently returns. That is what these
 *  pin down. */

import { describe, it, expect, vi } from 'vitest';
import { createPortLifecycleHandler } from '../../app/debug/bridge';

/** Let the handler's detached async body settle — it is fire-and-forget by design (a lifecycle
 *  listener must not be awaited by the caller). */
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(overrides: { start?: () => Promise<{ port: number }>; stop?: () => Promise<{ ok: boolean }> } = {}) {
  const start = vi.fn(overrides.start ?? (async () => ({ port: 9095 })));
  const stop = vi.fn(overrides.stop ?? (async () => ({ ok: true })));
  const log = vi.fn();
  return { start, stop, log, handler: createPortLifecycleHandler({ start, stop, log }) };
}

describe('createPortLifecycleHandler (#95)', () => {
  it('backgrounding RELEASES the port', async () => {
    const h = harness();
    h.handler({ isActive: false });
    await settle();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('foregrounding RE-BINDS, and logs the port it actually got', async () => {
    // Not necessarily the default — something else may have taken 9095 first, and reporting the
    // requested port rather than the bound one is the exact lie #88 was about.
    const h = harness({ start: async () => ({ port: 40193 }) });
    h.handler({ isActive: true });
    await settle();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls.flat()).toContain(40193);
  });

  it('a slow rebind cannot stack with the next state flip', async () => {
    // Real devices flip state faster than a bind completes (app switching, notification shade).
    // Overlapping start/stop on one socket is how you end up bound to nothing.
    let release!: () => void;
    const h = harness({ start: () => new Promise((r) => { release = () => r({ port: 9095 }); }) });
    h.handler({ isActive: true });   // begins, does not finish
    h.handler({ isActive: false });  // must be dropped while the first is in flight
    await settle();
    expect(h.stop).not.toHaveBeenCalled();
    release();
    await settle();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('a failing stop/start is swallowed — debug plumbing must not break app lifecycle', async () => {
    // A failed release just restores the old behaviour (port stays held); a failed rebind surfaces
    // host-side as an unreachable lease. Neither is worth throwing out of a lifecycle listener.
    const h = harness({ stop: async () => { throw new Error('socket already closed'); } });
    expect(() => h.handler({ isActive: false })).not.toThrow();
    await settle();
    expect(h.log.mock.calls.flat().join(' ')).toMatch(/appStateChange handling failed/);
  });

  it('recovers after a failure — one bad transition does not wedge the handler forever', async () => {
    // The `busy` guard is released in a `finally`; if it were not, the first error would silently
    // disable port management for the rest of the session.
    const h = harness({ stop: async () => { throw new Error('boom'); } });
    h.handler({ isActive: false });
    await settle();
    h.handler({ isActive: true });
    await settle();
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
