/** #682 — `waitTwoFramesBounded` (extracted from `App.tsx`'s boot sequence) races two chained
 *  `requestAnimationFrame`s against a timeout, so a dead rAF chain cannot hang boot forever.
 *  Resolves `'frames' | 'timeout'` (close-out LOW 6) so a caller can tell the two apart — `App.tsx`
 *  uses this to decide whether `confirmShellBoot()` should fire at all. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitTwoFramesBounded } from '../../app/bootFrameWait';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setVisibility('visible');
});

describe('waitTwoFramesBounded', () => {
  it('resolves "frames" once both rAFs fire, well under the timeout', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      calls++;
      cb(0);
      return calls;
    });
    const outcome = await waitTwoFramesBounded(5000);
    expect(calls).toBe(2); // two CHAINED rAFs, not one
    expect(outcome).toBe('frames');
  });

  it('resolves "timeout" instead of hanging forever when rAF never fires (a dead frame loop, #682)', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // captured, never invoked
    let resolved = false;
    let outcome: string | undefined;
    const p = waitTwoFramesBounded(5000).then((o) => { resolved = true; outcome = o; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(resolved).toBe(false); // not yet — the bound has not elapsed
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(resolved).toBe(true); // the bound fired
    expect(outcome).toBe('timeout');
  });

  it('a LATE rAF after the timeout does not resolve twice or throw', async () => {
    // `clearTimeout(timer)` lives in the INNER callback (`bootFrameWait.ts:21`), not the outer
    // one — a mock that only ever captures and drives the FIRST (outer) rAF never reaches it, so
    // deleting that `clearTimeout` outright left this test green. Capture BOTH chained callbacks
    // and drive them in order, the way a genuinely-late rAF delivery actually would.
    vi.useFakeTimers();
    let pendingOuter: FrameRequestCallback | null = null;
    let pendingInner: FrameRequestCallback | null = null;
    let calls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      calls++;
      if (calls === 1) pendingOuter = cb; // never fires until we force it, after the timeout
      else pendingInner = cb;
      return calls;
    });
    let resolveCount = 0;
    const p = waitTwoFramesBounded(1000).then(() => { resolveCount++; });
    await vi.advanceTimersByTimeAsync(1001);
    await p;
    expect(resolveCount).toBe(1);
    // The stale OUTER callback finally fires — it chains into a SECOND (inner) rAF request.
    expect(() => pendingOuter!(0)).not.toThrow();
    expect(pendingInner, 'the outer callback must have requested the inner rAF').not.toBeNull();
    // The inner callback is where `clearTimeout(timer)` + `resolve()` actually live — driving it
    // must not throw (an already-fired timer/settled promise) or resolve a second time (Promise
    // semantics already guarantee the latter, but reaching this line at all proves the former).
    expect(() => pendingInner!(0)).not.toThrow();
    expect(resolveCount).toBe(1);
  });

  it('timeoutMs of 0 resolves promptly even when rAF never fires', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // captured, never invoked
    let resolved = false;
    const p = waitTwoFramesBounded(0).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it('a NEGATIVE timeoutMs is clamped to immediate, not treated as "wait forever"', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // captured, never invoked
    let resolved = false;
    const p = waitTwoFramesBounded(-5).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  // A HIDDEN document (an OTA relaunch that lands backgrounded, or a launch never foregrounded in
  // time) must not be charged as a dead loop — see bootFrameWait.ts's header. rAF is throttled to
  // near-zero while hidden, so the ceiling must be paused rather than racing it to 'timeout'.
  it('a document HIDDEN before the wait starts does not consume the ceiling — resolves "frames" once visible, however long it stayed hidden', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    let pendingOuter: FrameRequestCallback | null = null;
    let pendingInner: FrameRequestCallback | null = null;
    let calls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      calls++;
      if (calls === 1) pendingOuter = cb;
      else pendingInner = cb;
      return calls;
    });
    let outcome: string | undefined;
    const p = waitTwoFramesBounded(5000).then((o) => { outcome = o; });

    // Stay hidden for far longer than the ceiling — a dead-loop-unaware implementation would
    // already have resolved 'timeout' here.
    await vi.advanceTimersByTimeAsync(20000);
    expect(outcome).toBeUndefined();

    // Now come back to the foreground and let the two rAFs land, well inside a FRESH ceiling.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    pendingOuter!(0);
    pendingInner!(0);
    await p;
    expect(outcome).toBe('frames');
  });

  it('a document that goes hidden MID-WAIT re-arms a fresh ceiling on resume, rather than firing "timeout" for elapsed hidden time', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // never invoked — this is the "still dead after resuming" half below
    let outcome: string | undefined;
    const p = waitTwoFramesBounded(5000).then((o) => { outcome = o; });

    await vi.advanceTimersByTimeAsync(4000); // 4s of the original 5s ceiling burned while visible
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60000); // long hidden stretch — must not fire 'timeout'
    expect(outcome).toBeUndefined();

    // Resume: the ceiling re-arms for a FULL fresh 5000ms, not just the 1000ms that was left.
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(outcome).toBeUndefined(); // the re-armed ceiling has not elapsed yet
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(outcome).toBe('timeout'); // genuinely dead loop, visible the whole time it counted
  });

  it('a GENUINELY dead loop (document visible throughout) still resolves "timeout" — the hidden handling above must not swallow a real stall', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // captured, never invoked
    let outcome: string | undefined;
    const p = waitTwoFramesBounded(5000).then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(outcome).toBe('timeout');
  });

  // #682 close-out round 3, BLOCKER 1: per spec, `document.visibilityState` flips to 'visible'
  // synchronously on resume, but the `visibilitychange` EVENT is a separately queued task — so an
  // overdue ceiling armed before the hide (never cancelled by the buggy code, which only ever
  // RE-ARMED on the visible transition and did nothing on hide) can be DELIVERED before that queued
  // event, reading `isHidden() === false` inside its own callback and firing 'timeout' for a page
  // that had been visible for 0ms. This models exactly that delivery order: hide (with its own
  // event, so a fixed implementation cancels the ceiling right there), flip back to visible WITHOUT
  // yet dispatching the event, advance past the ORIGINAL deadline (the overdue timer's task
  // running first), and only then dispatch the resume event (the queued task arriving second).
  it('an overdue ceiling delivered AFTER visibilityState already reads "visible" must not fire "timeout" (order-of-delivery race)', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // never invoked
    let outcome: string | undefined;
    const p = waitTwoFramesBounded(5000).then((o) => { outcome = o; });

    // Hide immediately (no time elapsed) — a fixed implementation cancels the pending ceiling here
    // rather than leaving it pending across the background stretch.
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    // Resume: the property flips first (per spec) ...
    setVisibility('visible');
    // ... and the overdue timer's task is delivered BEFORE the visibilitychange task (the unsafe
    // order the buggy code got wrong).
    await vi.advanceTimersByTimeAsync(5000);
    expect(outcome).not.toBe('timeout'); // must not fire falsely — the ceiling was cancelled on hide

    // The delayed resume event finally arrives — re-arms a fresh ceiling.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(outcome).toBeUndefined(); // still waiting on the FRESH ceiling, not resolved

    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(outcome).toBe('timeout'); // a genuinely dead loop after the fresh ceiling still resolves
  });
});
