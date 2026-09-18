/**
 * #1374 — Scene2D's material-sprite texture path had an in-flight guard and no failure memory, so a
 * 404 texture was re-requested on every dirty frame. `MaterialTexRetry` (the state Scene2D holds as
 * `_materialTex`) now shares #1371's `loadFailureMemo` with `unknownIs: 'transient'` — Pixi's load
 * error cannot tell a 404 from a dropped connection — and schedules its own wake when the backoff
 * expires so an idle scene still retries.
 *
 * Drives the real class, with only the texture loader faked: `request(url)` is the call the
 * material pass makes every frame.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MaterialTexRetry } from '../../packages/modoki/src/runtime/loaders/materialTexRetry';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../../packages/modoki/src/runtime/core/loadFailureMemo';
import { setManualNow, advanceManual, restoreRealClock } from '../../packages/modoki/src/runtime/core/clock';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let load: ReturnType<typeof vi.fn<(url: string) => Promise<unknown>>>;
let wakes: number;
let retry: MaterialTexRetry;

beforeEach(() => {
  setManualNow(0);
  load = vi.fn();
  wakes = 0;
  retry = new MaterialTexRetry((url) => load(url), () => { wakes++; });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  retry.clear();
  restoreRealClock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#1374 — a failed material-sprite texture is not refetched every dirty frame', () => {
  it('an opaque failure (Pixi\'s 404) is requested once across many frames inside its backoff, then retried', async () => {
    load.mockRejectedValue(new Error('[Loader.load] Failed to load /built/a.png'));
    for (let frame = 0; frame < 30; frame++) { retry.request('a.png'); await flush(); }
    expect(load).toHaveBeenCalledTimes(1);
    advanceManual(RETRY_BASE_MS);
    retry.request('a.png');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a texture that fails forever costs at most one request per 10 minutes, and is never given up', async () => {
    load.mockRejectedValue(new Error('404'));
    for (let i = 0; i < 20; i++) {
      retry.request('b.png');
      await flush();
      retry.request('b.png'); // a second frame inside the window never fetches
      advanceManual(RETRY_CAP_MS);
    }
    expect(load).toHaveBeenCalledTimes(20);
  });

  it('schedules its own wake for when the backoff expires, and clear() cancels it', async () => {
    vi.useFakeTimers();
    load.mockRejectedValue(new Error('offline'));
    retry.request('c.png');
    await flush();
    expect(retry.pendingWakes).toBe(1);
    expect(wakes).toBe(0);
    vi.advanceTimersByTime(RETRY_BASE_MS);
    expect(wakes).toBe(1);
    expect(retry.pendingWakes).toBe(0);

    advanceManual(RETRY_BASE_MS);
    retry.request('c.png');
    await flush();
    expect(retry.pendingWakes).toBe(1);
    retry.clear(); // teardown with a wake pending
    vi.advanceTimersByTime(RETRY_CAP_MS);
    expect(wakes).toBe(1);
  });

  it('a success clears the failure, so a later failure starts a fresh streak at the base delay', async () => {
    load.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('y')).mockRejectedValueOnce(new Error('z'));
    retry.request('d.png'); await flush();
    advanceManual(RETRY_BASE_MS);
    retry.request('d.png'); await flush(); // lands → forgotten
    retry.request('d.png'); await flush(); // loads again (no Assets cache in this harness), fails
    expect(load).toHaveBeenCalledTimes(3);
    advanceManual(RETRY_BASE_MS); // base delay again, not 2 s
    retry.request('d.png'); await flush();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('a load superseded by clear() cannot release the newer load that replaced it (#1374 review)', async () => {
    let rejectOld!: (e: unknown) => void;
    load.mockReturnValueOnce(new Promise((_, rej) => { rejectOld = rej; }))
      .mockReturnValueOnce(new Promise(() => {})); // the newer load stays in flight
    retry.request('e.png');
    retry.clear();          // world swap
    retry.request('e.png'); // the new world asks again
    rejectOld(new Error('late'));
    await flush();
    retry.request('e.png'); // still in flight — must not start a third load
    expect(load).toHaveBeenCalledTimes(2);
    expect(retry.pendingWakes).toBe(0); // the stale failure schedules nothing
  });

  it('a landed load wakes the surface — the redraw an idle scene depends on', async () => {
    load.mockResolvedValue({});
    retry.request('f.png');
    await flush();
    expect(wakes).toBe(1);
  });

  it('a SUCCESS superseded by clear() cannot release the newer in-flight load either', async () => {
    let resolveOld!: (v: unknown) => void;
    load.mockReturnValueOnce(new Promise((res) => { resolveOld = res; }))
      .mockReturnValueOnce(new Promise(() => {}));
    retry.request('g.png');
    retry.clear();
    retry.request('g.png');
    resolveOld({});
    await flush();
    retry.request('g.png'); // the newer load is still in flight — no third request
    expect(load).toHaveBeenCalledTimes(2);
  });
});

/** #1397 — a sprite SLOT is built once (`Scene2D.makeSprite`) and never asks again, so a failed
 *  load left it `Texture.EMPTY` until the slot was rebuilt. `whenResident` + `drain` keep the
 *  waiting slot and re-ask on its behalf. `resident` stands in for Pixi's cache. */
describe('#1397 — a sprite slot waiting on a texture recovers from a failed load', () => {
  const resident = new Set<string>();
  const isResident = (url: string) => resident.has(url);
  beforeEach(() => { resident.clear(); });

  it('binds once the texture lands, and not before', async () => {
    let settle!: () => void;
    load.mockImplementation(() => new Promise<void>((r) => { settle = () => { resident.add('s.png'); r(); }; }));
    const bind = vi.fn();
    retry.whenResident('s.png', () => false, bind);
    expect(retry.drain(isResident)).toBe(false);
    expect(bind).not.toHaveBeenCalled();
    settle();
    await flush();
    expect(wakes).toBe(1); // the landed load wakes the frame the drain runs in
    expect(retry.drain(isResident)).toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(retry.waitingUrls).toBe(0);
  });

  it('a failed load is retried after its backoff and the slot binds — was: blank until the slot was rebuilt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    load.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const bind = vi.fn();
    retry.whenResident('s.png', () => false, bind);
    await vi.advanceTimersByTimeAsync(0);
    for (let frame = 0; frame < 10; frame++) retry.drain(isResident); // frames inside the backoff
    expect(load).toHaveBeenCalledTimes(1);

    advanceManual(RETRY_BASE_MS);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(wakes).toBe(1); // the retry is due — wake the idle frame
    load.mockImplementationOnce(async () => { resident.add('s.png'); });
    retry.drain(isResident);  // that frame re-asks
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    retry.drain(isResident);  // and the next one binds
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it('a waiter whose sprite was destroyed is dropped, never bound', async () => {
    load.mockImplementation(async () => { resident.add('s.png'); });
    let destroyed = false;
    const bind = vi.fn();
    retry.whenResident('s.png', () => destroyed, bind);
    await flush();
    destroyed = true; // the slot's ref changed before the frame ran
    expect(retry.drain(isResident)).toBe(false);
    expect(bind).not.toHaveBeenCalled();
    expect(retry.waitingUrls).toBe(0);
  });

  it('clear() drops every waiter (world swap)', () => {
    load.mockImplementation(() => new Promise(() => {}));
    retry.whenResident('s.png', () => false, vi.fn());
    retry.clear();
    expect(retry.waitingUrls).toBe(0);
  });
});

describe('#1402 — a texture missing from a native app bundle', () => {
  // Android's page shape (every game sets `androidScheme: "http"`); the iOS `capacitor://` shape is
  // driven in the package tests (prefabRequest, pixiShaderBuilder, audioBufferCache).
  beforeEach(() => { vi.stubGlobal('location', { href: 'http://localhost/', protocol: 'http:', host: 'localhost' }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is requested ONCE on a native build (the app serves it itself, so it is absent, not an outage)', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    load.mockRejectedValue(new Error('[Loader.load] Failed to load /built/a.png.\n[object Event]'));
    retry.request('/built/a.png');
    await flush();
    advanceManual(RETRY_CAP_MS * 3);
    retry.request('/built/a.png');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('accept side: a REMOTE url on native still backs off and retries', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    load.mockRejectedValue(new Error('[Loader.load] Failed to load https://cdn.example.com/a.png.\n[object Event]'));
    retry.request('https://cdn.example.com/a.png');
    await flush();
    advanceManual(RETRY_BASE_MS);
    retry.request('https://cdn.example.com/a.png');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
