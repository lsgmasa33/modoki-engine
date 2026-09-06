/** #682 — every device input handler in `app/debug/bridge.ts` must REFUSE, rather than dispatch,
 *  when the frame loop cannot actually deliver the input: a dead rAF chain means `inputSystem`
 *  never samples the down/up edge no matter how long the wall-clock `setTimeout` hold waits, so
 *  proceeding reports success over a game that never received anything.
 *
 *  Marries two existing patterns rather than inventing a third:
 *   - `engine/tests/ecs/frameDriver.test.ts`'s dead-loop simulator — fake timers, an injectable
 *     manual clock (`setManualNow`/`advanceManual`), and a `requestAnimationFrame` mock that either
 *     never delivers (a wedge) or delivers on demand (a healthy chain).
 *   - `deviceInputMechanism.test.ts`'s style of driving the real `bridge.ts` handlers directly
 *     under jsdom and asserting on the returned reply text/shape.
 *
 *  A FRESH dynamic import + `vi.resetModules()` per test (rather than the static top-level import
 *  `deviceInputMechanism.test.ts` uses) because frame-loop status is GLOBAL module state in
 *  `frameDriver.ts`, and these tests deliberately drive it into a stalled/unrecoverable condition
 *  — sharing one module instance across tests (or with the healthy-path tests in this same file)
 *  would leak that state. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function loadBridge() {
  return import('../../app/debug/bridge');
}
async function loadRuntime() {
  return import('@modoki/engine/runtime');
}

function withCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return canvas;
}

function mockRaf(deliver: ((cb: (t: number) => void) => void) | null) {
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    if (deliver) deliver(cb as unknown as (t: number) => void);
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
}

/** Arm a frame driver whose rAF chain NEVER delivers, then advance the manual clock + fake timers
 *  past the watchdog's thresholds — `STALL_MS` (3000ms) for a transient stall, or all the way
 *  through `UNRECOVERABLE_AFTER_ATTEMPTS` (~12s post-detection, matching
 *  `frameDriver.test.ts`'s own "recoveryAttempts no longer resets mid-outage" timeline) for a
 *  declared-dead chain. */
async function armDeadLoop(opts: { unrecoverable?: boolean } = {}) {
  const { setManualNow, advanceManual, startFrameDriver, setTargetFPS } = await loadRuntime();
  setManualNow(0);
  mockRaf(null); // captured but never invoked — the wedge itself
  setTargetFPS(0);
  startFrameDriver();
  const ticks = opts.unrecoverable ? 12 : 3;
  for (let i = 0; i < ticks; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
}

describe('device input handlers refuse when the frame loop cannot deliver (#682)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('handleTap refuses with a SPECIFIC reason, not device_step\'s old guess', async () => {
    await armDeadLoop();
    const { handleTap } = await loadBridge();
    withCanvas();
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
    expect(r).not.toContain('may be stopped'); // the guess this issue replaces
    expect(r).not.toContain('[input:synthetic]'); // nothing was dispatched
  });

  it('handleDrag refuses', async () => {
    await armDeadLoop();
    const { handleDrag } = await loadBridge();
    withCanvas();
    const r = await handleDrag({ fromX: 0, fromY: 0, toX: 50, toY: 50 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });

  it('handlePointer refuses', async () => {
    await armDeadLoop();
    const { handlePointer } = await loadBridge();
    withCanvas();
    const r = await handlePointer({ action: 'down', x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });

  it('handlePressKey refuses', async () => {
    await armDeadLoop();
    const { handlePressKey } = await loadBridge();
    const r = await handlePressKey({ key: 'a' });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });

  it('handleHover refuses', async () => {
    await armDeadLoop();
    const { handleHover } = await loadBridge();
    const target = document.createElement('div');
    document.body.appendChild(target);
    document.elementFromPoint = () => target;
    const r = await handleHover({ x: 5, y: 5 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });

  it('handleScroll refuses', async () => {
    await armDeadLoop();
    const { handleScroll } = await loadBridge();
    const r = await handleScroll({ x: 5, y: 5, dy: 10 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });

  it('handleType refuses via its OBJECT shape, not a string — and carries no inputMechanism', async () => {
    await armDeadLoop();
    const { handleType } = await loadBridge();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const r = await handleType({ text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.typed).toBe(0);
    expect(r.error).toContain('frame loop');
    expect(r.inputMechanism).toBeUndefined();
  });

  it('an UNRECOVERABLE loop also refuses — not merely a transient stall', async () => {
    await armDeadLoop({ unrecoverable: true });
    const { handleTap } = await loadBridge();
    withCanvas();
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^Error:/);
    expect(r).toContain('frame loop');
  });
});

describe('device input handlers still work when the frame loop is healthy (#682 accept side)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('handleTap dispatches normally with no frame driver ever started (idle — the common default)', async () => {
    const { handleTap } = await loadBridge();
    withCanvas();
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith('[input:synthetic]')).toBe(true);
  });

  it('handleTap dispatches normally while the loop is ACTIVELY RUNNING, not merely idle', async () => {
    const { startFrameDriver } = await loadRuntime();
    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    startFrameDriver();
    pending!(16); // deliver one real frame -> status 'running'

    const { handleTap } = await loadBridge();
    withCanvas();
    const r = await handleTap({ x: 10, y: 20 });
    expect(r).toMatch(/^ok /);
    expect(r.endsWith('[input:synthetic]')).toBe(true);
  });

  it('handleType still works while running', async () => {
    const { startFrameDriver } = await loadRuntime();
    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    startFrameDriver();
    pending!(16);

    const { handleType } = await loadBridge();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const r = await handleType({ text: 'hi' });
    expect(r.ok).toBe(true);
  });
});
