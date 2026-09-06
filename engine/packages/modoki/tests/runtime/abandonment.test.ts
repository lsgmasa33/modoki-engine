import { describe, expect, it, vi, afterEach } from 'vitest';

import { withTimeout, TimeoutError } from '../../src/runtime/core/abandonment';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withTimeout', () => {
  it('resolves through when p resolves in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'thing', { discard: 'unused' }))
      .resolves.toBe('ok');
  });

  it('rejects through with the ORIGINAL error when p rejects in time', async () => {
    const original = new Error('boom');
    await expect(withTimeout(Promise.reject(original), 1_000, 'thing', { discard: 'unused' }))
      .rejects.toBe(original);
  });

  it('rejects with TimeoutError when ms elapses first, with what/ms set', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => { /* never settles */ });
    const pending = withTimeout(never, 1_000, 'the thing', { discard: 'unused' });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // Re-run to inspect the error's fields directly (the promise above is already settled).
    const never2 = new Promise<string>(() => { /* never settles */ });
    const pending2 = withTimeout(never2, 1_000, 'the thing', { discard: 'unused' });
    let caught: unknown;
    const check = pending2.catch((err: unknown) => { caught = err; });
    await vi.advanceTimersByTimeAsync(1_000);
    await check;
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as TimeoutError).what).toBe('the thing');
    expect((caught as TimeoutError).ms).toBe(1_000);
  });

  it('includes the hint in the message when given, and no empty parens when not', async () => {
    vi.useFakeTimers();

    const withHint = withTimeout(new Promise<string>(() => {}), 100, 'op', { discard: 'x' }, 'extra context');
    const hintAssertion = expect(withHint).rejects.toThrow('op timed out after 100ms (extra context)');
    await vi.advanceTimersByTimeAsync(100);
    await hintAssertion;

    const withoutHint = withTimeout(new Promise<string>(() => {}), 100, 'op', { discard: 'x' });
    const noHintAssertion = expect(withoutHint).rejects.toThrow('op timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await noHintAssertion;
    await expect(withoutHint).rejects.not.toThrow(/\(\)/);
  });

  it('does NOT call onSettled when p settles in time', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const result = withTimeout(Promise.resolve('ok'), 1_000, 'thing', { onSettled });
    await vi.advanceTimersByTimeAsync(0);
    await result;
    // Advance well past ms — if onSettled were going to fire spuriously, this gives it the chance.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('calls onSettled with {ok:true,value} for a late resolve', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    let resolveLate: (v: string) => void;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });
    const pending = withTimeout(late, 100, 'thing', { onSettled });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    resolveLate!('late value');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ ok: true, value: 'late value' });
  });

  it('calls onSettled with {ok:false,error} for a late rejection', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    let rejectLate: (e: unknown) => void;
    const late = new Promise<string>((_resolve, reject) => { rejectLate = reject; });
    const pending = withTimeout(late, 100, 'thing', { onSettled });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    const lateError = new Error('late boom');
    rejectLate!(lateError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ ok: false, error: lateError });
  });

  it('calls onSettled at most once', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    let resolveLate: (v: string) => void;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });
    const pending = withTimeout(late, 100, 'thing', { onSettled });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    resolveLate!('once');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('adopt and discard swallow a late rejection without throwing or an unhandled rejection', async () => {
    vi.useFakeTimers();
    let rejectLate: (e: unknown) => void;
    const late = new Promise<string>((_resolve, reject) => { rejectLate = reject; });
    const pendingAdopt = withTimeout(late, 100, 'thing', { adopt: 'handled elsewhere' });
    const assertion = expect(pendingAdopt).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    expect(() => rejectLate!(new Error('late boom, ignored'))).not.toThrow();
    // If this rejection were ever unhandled, vitest would flag it around here.
    await vi.advanceTimersByTimeAsync(0);
  });

  it('an onSettled that throws is caught and logged, not propagated', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSettled = vi.fn(() => { throw new Error('onSettled blew up'); });
    let resolveLate: (v: string) => void;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });
    const pending = withTimeout(late, 100, 'thing', { onSettled });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    resolveLate!('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it('clears the timer on the happy path', async () => {
    vi.useFakeTimers();
    const result = withTimeout(Promise.resolve('ok'), 1_000, 'thing', { discard: 'unused' });
    await vi.advanceTimersByTimeAsync(0);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
