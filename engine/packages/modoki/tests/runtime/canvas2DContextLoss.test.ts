/** The 2D pool must SEE a lost GPU context, and come back from it (#213).
 *
 *  The bug: a lost WebGL context is invisible from every angle except pixels. The canvas keeps
 *  its size, its opacity and its place in the DOM, the ECS stays correct, and `renderAll` keeps
 *  issuing draws that do nothing — the screen simply goes blank, with no error. Measured on an
 *  iPhone 8 (A11 / iOS 16) deployed from Xcode: `gl.isContextLost()` true, a 0x0 drawing buffer,
 *  0 of 25,680 sampled pixels ever drawn, while all 64 board entities sat there correctly sized.
 *  The 3D path had watched for this since #121; the 2D path had no listener at all, so a
 *  2D-only game had no protection.
 *
 *  These assert the POOL's half of the contract. The scheduling policy (delay, single-flight,
 *  coalescing, bounded backoff) belongs to `rendererRecovery.ts` and is tested there — the point
 *  here is that the pool actually WIRES a slot's canvas to it, and that a rebuild tells the
 *  renderer it owes a full redraw.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pixi is mocked: a real Application needs a GPU. What matters is the wiring, not Pixi.
const created: Array<{ destroyed: boolean; destroyArg: unknown }> = [];
/** Lets a test HOLD `Application.init()` open. The timeout/retry race lives entirely inside that
 *  window, and a mock that always resolves immediately cannot express it. */
const initGate: { hold: Promise<void> | null } = { hold: null };
/** Lets a test control a WebGPU renderer's `gpu.device.lost` promise (#794). Read at Application
 *  CONSTRUCTION time (mirroring real Pixi, where the device exists as soon as the renderer does),
 *  so a test must set this BEFORE the allocate()/mount() call that creates the Application it
 *  wants wired. `null` (the default) means "no `renderer.gpu` at all" — the WebGL-backend shape
 *  every other test in this file already relies on. */
const deviceLostGate: { promise: Promise<{ reason?: string; message?: string }> | null } = { promise: null };
vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    sortableChildren = false;
    parent: unknown = null;
    destroyed = false;
    // reclaimIfUnclaimed resets the transform when a slot goes back to the free pool.
    position = { set() {} };
    scale = { set() {} };
    rotation = 0;
    removeFromParent() { this.parent = null; }
    addChild(c: unknown) { this.children.push(c); return c; }
    destroy() { this.destroyed = true; }
  }
  class Application {
    stage = new Container();
    ticker = { stop() {} };
    // A predictable, sequential uid — mirroring Pixi's real incrementing-int `renderer.uid`
    // scoped to the process (see gpuResourceInvalidation.ts's file header for why that matters:
    // a REBUILT renderer's fresh uid can collide with a stale `_gpuData` key). Assigned from
    // `created.length` BEFORE this instance is pushed, so the Nth Application built in a test
    // (0-based, reset per test by `created.length = 0` in beforeEach) gets uid N.
    uid = created.length;
    renderer!: { resize(): void; screen: { width: number; height: number }; uid: number; gpu?: { device: { lost: Promise<{ reason?: string; message?: string }> } } };
    private rec = { destroyed: false, destroyArg: undefined as unknown };
    constructor() {
      this.renderer = { resize() {}, screen: { width: 0, height: 0 }, uid: this.uid };
      if (deviceLostGate.promise) this.renderer.gpu = { device: { lost: deviceLostGate.promise } };
      created.push(this.rec);
    }
    async init() { if (initGate.hold) await initGate.hold; /* resolved = context acquired */ }
    destroy(arg: unknown) { this.rec.destroyed = true; this.rec.destroyArg = arg; }
  }
  return { Application, Container };
});
vi.mock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported: async () => false }));
// Each registration records its own disposer-call count, so "the passthrough was actually
// UNREGISTERED" is observable. A plain `() => () => {}` made that teardown half untestable: a
// regression that stopped disposing would leak a pointer-passthrough registration for a dead or
// replaced canvas and every test here would still pass.
const passthroughs: Array<{ disposed: number }> = [];
vi.mock('../../src/runtime/core/pointerBlockers', () => ({
  registerPointerPassthrough: () => {
    const rec = { disposed: 0 };
    passthroughs.push(rec);
    return () => { rec.disposed++; };
  },
}));

import { Canvas2DPool } from '../../src/runtime/rendering/canvas2DPool';

let pool: Canvas2DPool;
beforeEach(() => { created.length = 0; passthroughs.length = 0; initGate.hold = null; deviceLostGate.promise = null; pool = new Canvas2DPool(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Drive the event the browser fires. jsdom has no WebGL, so the listener is what we test. */
const fireLost = (canvas: HTMLCanvasElement) => {
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};

describe('canvas2DPool — GPU context loss', () => {
  it('marks the slot lost and reports it, instead of failing silently', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const slot = pool.allocate(1)!;
    await slot.ready;

    fireLost(slot.canvas);

    expect(slot.contextLost, 'a lost context must be OBSERVABLE on the slot').toBe(true);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/CONTEXT LOST/);
  });

  it('calls preventDefault — without it the browser will never restore the context', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const slot = pool.allocate(2)!;
    const e = fireLost(slot.canvas);
    expect(e.defaultPrevented).toBe(true);
  });

  it('rebuilds onto a FRESH canvas, swapped in place, keeping the scene graph', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(3)!;
    await slot.ready;
    const canvasBefore = slot.canvas;
    const containerBefore = slot.container;
    const appBefore = slot.app;
    const madeBefore = created.length;

    fireLost(slot.canvas);
    await vi.advanceTimersByTimeAsync(2000);   // let the policy's delay elapse
    vi.useRealTimers();
    await slot.ready;

    expect(created.length, 'a new Application must be created').toBeGreaterThan(madeBefore);
    expect(slot.app, 'the slot must point at the NEW app').not.toBe(appBefore);
    // ⚠️ REVERSED from this test's first version, by device evidence. It originally asserted the
    // canvas ELEMENT must survive — reasoning that the element is not what died, the context is.
    // That is true and irrelevant: measured on an iPhone 8, once a context is lost and the
    // browser never fires `webglcontextrestored`, re-initialising on the SAME element hands back
    // a dead context forever (one canvas, isContextLost() true, 0x0 buffer, no recovery). A fresh
    // element is the only reliable way back.
    expect(slot.canvas, 'the rebuild must use a FRESH canvas element').not.toBe(canvasBefore);
    expect(slot.canvas.isConnected, 'and it must take the old one\'s place in the DOM').toBe(
      canvasBefore.isConnected,
    );
    // `destroy(false)` — `destroy(true)` (used elsewhere in the pool) would also destroy the
    // canvas; here the old node is being replaced, not torn down under a live mount.
    expect(created[madeBefore - 1].destroyArg, 'must not destroy via the view path').toBe(false);
    // Pixi's scene graph is renderer-agnostic; re-attaching it is what makes the content come
    // back without Scene2D rebuilding every display object.
    expect(slot.container, 'the scene graph must survive').toBe(containerBefore);
    expect(slot.contextLost, 'the slot is healthy again').toBe(false);
  });

  // ⚠️ These two exist because Pixi's `GlContextSystem.destroy()` ENDS with
  // `extensions.loseContext?.loseContext()` — an explicit forced context loss on every
  // `app.destroy()` — and it removes only Pixi's own listeners, not the pool's. So the pool's
  // handler really does run on its own teardown, on a real device, not just in theory.

  it('stays SILENT when the context loss is our OWN teardown', async () => {
    const slot = pool.mount(11)!;
    await slot.ready;
    pool.unmount(11);            // drop the claim so this is a genuine disposal
    pool.destroyPool();
    expect(slot.destroyed, 'precondition: the slot really was disposed').toBe(true);

    // The listeners must actually be OFF the element. Asserted directly because the silence
    // assertion below cannot distinguish it from the `slot.destroyed` early-return in the handler:
    // both produce silence, so on its own it pins neither. (That early-return is deliberate
    // belt-and-braces; no reachable state has listeners attached while `destroyed` is true, so
    // nothing can pin it independently — the detach is the mechanism that does the work.)
    expect(slot.detachCanvasListeners, 'disposal must run and clear the listener disposer').toBeUndefined();

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireLost(slot.canvas);       // exactly what Pixi's destroy() provokes

    // Unguarded, this emits TWO errors — "the surface will stay BLANK" and "rebuild request
    // DROPPED as 'disposed'" — both citing #213, on a path where nothing is wrong. A false alarm
    // in the recovery log is the precise thing that made #213 cost what it did, so a correct
    // teardown must say nothing at all.
    expect(err, 'our own teardown must not claim the surface will stay blank').not.toHaveBeenCalled();
  });

  it('a rebuild detaches the OLD canvas listeners, so its forced loss cannot corrupt the live slot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(12)!;
    await slot.ready;
    const oldCanvas = slot.canvas;

    fireLost(oldCanvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await slot.ready;

    expect(slot.canvas, 'precondition: the rebuild swapped in a fresh element').not.toBe(oldCanvas);
    expect(slot.contextLost, 'precondition: the slot is healthy again').toBe(false);

    // The old element is where Pixi's forced loss lands when the OLD app is destroyed. Its
    // listeners close over the SLOT, not over the canvas — so if they survive the swap they go on
    // mutating the live slot: `contextLost` flips back to true on a perfectly healthy renderer and
    // `recovery.request()` queues a redundant second rebuild via its `again` flag.
    fireLost(oldCanvas);

    expect(slot.contextLost, 'a replaced canvas must not flip the live slot back to lost').toBe(false);
  });

  it('destroys an Application whose init finishes after a rebuild superseded it', async () => {
    // The leak this pins: `rebuildSlotApp`'s `init()` is bounded by a timeout that REJECTS but
    // cannot cancel. The retry assigns a new Application; when the abandoned one finally settles
    // (a slow-but-alive driver — exactly what the timeout bounds), the resumed code used to re-read
    // `slot.app` and configure the RETRY's app a second time, double-counting the context budget
    // while the timed-out Application was never destroyed at all.
    let release!: () => void;
    initGate.hold = new Promise<void>((r) => { release = r; });
    const slot = pool.allocate(20)!;
    // ⚠️ Let `initSlotApp` actually REACH `app.init()`. It first awaits `initPool()`, so a
    // reassignment made right after `allocate()` lands BEFORE the capture and proves nothing —
    // the test then fails against the correct code, which is how this bug in the test was caught.
    await new Promise((r) => setTimeout(r, 0));
    const superseded = slot.app;
    const rec = created[created.length - 1];      // …belonging to THIS Application

    // What a retry does: a fresh Application takes the slot while the first init is still pending.
    initGate.hold = null;
    slot.app = new (superseded.constructor as new () => typeof superseded)();
    release();
    await slot.ready;

    expect(slot.app, 'precondition: a later Application owns the slot').not.toBe(superseded);
    expect(rec.destroyed, 'the superseded Application must not leak its GPU context').toBe(true);
    expect(slot.initialized, 'and it must not claim the slot came up').toBe(false);
  });

  it('never drops a rebuild request in SILENCE', async () => {
    // ⚠️ Written after a wasted device round trip. The policy returned with no message when it
    // declined to schedule, so the log could not distinguish "the rebuild rejected" from "the
    // rebuild never started" — and on device we saw the loss reported and then nothing at all,
    // with no way to tell which. A recovery path that can decline silently cannot be debugged
    // from a log, which is the whole and only way we can see that device.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const slot = pool.allocate(9)!;
    await slot.ready;
    slot.destroyed = true;               // the one decline that is a BUG rather than coalescing

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    slot.recovery!.request();

    const said = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said, 'a dropped rebuild must say so').toMatch(/DROPPED as 'disposed'/);
  });

  it('tells the renderer it owes a FULL redraw, exactly once per rebuild', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(4)!;
    await slot.ready;
    expect(pool.consumeRebuildFlag()).toBe(false);   // nothing rebuilt yet

    fireLost(slot.canvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    // Without this the surface stays blank behind a healthy context: the new renderer's frame is
    // empty and Scene2D's per-entity change detection would conclude nothing needs drawing.
    expect(pool.consumeRebuildFlag(), 'a rebuilt renderer owes a full redraw').toBe(true);
    expect(pool.consumeRebuildFlag(), 'read-and-clear — only once').toBe(false);
  });

  // Adversarial review of #590 (docs/plans/ios-rendering-update-wedge.md): the FIRST
  // `Application.init()` (in `createSlot`) used to be wrapped in the SAME rejecting `withTimeout`
  // the rebuild path uses — and that turned a merely SLOW cold bring-up (measured 8.5s on a
  // low-end GPU) into a NEVER: `slot.ready` rejected at the 8000ms bound while `initSlotApp` kept
  // running underneath and succeeded anyway at 8.5s, leaving a live, budget-counted GPU context
  // whose canvas nothing ever appends (`Canvas2DMount`'s `.catch` only logs, and nothing re-arms
  // it — `recovery.request()` is reachable only from `webglcontextlost`, which needs a context
  // that came up in the first place). The fix: the first init is WATCHDOGGED, not bounded — past
  // `APP_INIT_TIMEOUT_MS` it reports loudly but never rejects `slot.ready`, which just keeps
  // waiting on the real `initSlotApp` promise.
  it('reports a FIRST init that has not settled after the watchdog interval, but does not reject `slot.ready`', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    initGate.hold = new Promise<void>(() => {}); // a genuine hang: never settles, simulating a dead GPU
    const slot = pool.allocate(30)!;

    let settled = false;
    slot.ready.then(() => { settled = true; }, () => { settled = true; });

    expect(settled, 'precondition: still pending before the watchdog interval elapses').toBe(false);
    // 8000ms matches `APP_INIT_TIMEOUT_MS` in canvas2DPool.ts.
    await vi.advanceTimersByTimeAsync(8001);
    vi.useRealTimers();

    expect(err, 'the watchdog must report — naming the entity — instead of staying silent').toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/entity 30/);
    expect(String(err.mock.calls[0][0])).toMatch(/has not settled/);
    // The regression this guards: a rejection here made a slow-but-alive device WORSE than doing
    // nothing. Nothing can retry a first init, so the only honest move is to report, not fail it.
    expect(settled, 'a hung first init must not reject (or resolve) `slot.ready` — there is nothing to retry it with').toBe(false);
  });

  it('still resolves `slot.ready` and finishes initializing when the FIRST init is merely SLOW-BUT-ALIVE, past the watchdog interval', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // the watchdog fires too — that's expected here
    vi.useFakeTimers();
    let release!: () => void;
    initGate.hold = new Promise<void>((r) => { release = r; }); // slow, not hung — settles later
    const slot = pool.allocate(31)!;

    let settled = false;
    slot.ready.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(8001); // past the watchdog interval — the cold GPU is still coming up
    expect(settled, 'precondition: still slow, not yet finished').toBe(false);

    release(); // the slow-but-alive driver finally comes up
    vi.useRealTimers();
    await slot.ready;

    expect(settled, 'a slow-but-alive first init must still resolve `slot.ready`, however late').toBe(true);
    expect(slot.initialized, 'and the slot must actually finish coming up, usable').toBe(true);
  });
});

describe('canvas2DPool.destroyPool — the boot race (#213 root cause)', () => {
  // ⚠️ These assert against the CLAIM (`slot.mounted`), not against the DOM. The first fix for
  // #213 kept a slot whose `<canvas>` had a parent, which reads as the same thing and is not:
  // `Canvas2DMount` takes the claim synchronously and appends the canvas only once `slot.ready`
  // resolves. The device failed inside that gap, so a DOM-shaped guard could not see it.
  //
  // `pool.mount()` starts an async `Application.init()`, so calling `destroyPool()` SYNCHRONOUSLY
  // after it — before any `await slot.ready` — puts the teardown inside that exact window. That is
  // the whole reproduction; it needs no timer control.

  it('does NOT destroy a slot whose canvas is still in the DOM', async () => {
    const slot = pool.mount(1)!;
    await slot.ready;
    document.body.appendChild(slot.canvas);   // what Canvas2DMount does
    const appBefore = slot.app;
    const rec = created[created.length - 1];  // this slot's Application bookkeeping

    // `useCanvas2DInit`'s cleanup runs `destroyPool()` while `Canvas2DMount` — a component with
    // its own independent lifecycle — still shows this canvas.
    pool.destroyPool();

    expect(slot.destroyed, 'a visible canvas must survive pool teardown (F6)').toBeFalsy();
    // ⚠️ This assertion used to read
    //   `expect(created.find((c) => c === appBefore) ?? true).toBeTruthy()`
    // which is `expect(true).toBeTruthy()`: `created` holds the mock's private {destroyed,…}
    // bookkeeping records, never the Application instances, so `.find` was always `undefined` and
    // `?? true` made it unfailable. It was the ONE assertion that read as "the Application was not
    // torn down", and it checked nothing — a source change that destroyed a KEPT slot's app
    // without reassigning `slot.app` would have sailed through, which is #213 itself.
    expect(rec.destroyed, 'its GPU context must NOT be torn down').toBe(false);
    expect(slot.canvas.isConnected, 'and stay on screen').toBe(true);
    // Destroying it is what killed the WebGL context behind a visible canvas and produced the
    // blank board: correct DOM, correct sizes, correct ECS, nothing drawn.
    expect(slot.app, 'its Application must not be torn down').toBe(appBefore);
  });

  it('still destroys slots nothing claims', async () => {
    const slot = pool.mount(2)!;
    await slot.ready;
    const madeBefore = created.length;
    // ⚠️ The claim must be DROPPED for this to be a teardown candidate. This test used to call
    // `destroyPool()` with the mount claim still held and assert the slot was destroyed — encoding
    // the #213 failure as the expected behaviour, which is why the guard added for that bug passed
    // while the device stayed blank.
    pool.unmount(2);
    pool.destroyPool();
    expect(slot.destroyed, 'an unclaimed slot is torn down as before').toBe(true);
    expect(created[madeBefore - 1].destroyed).toBe(true);
  });

  it('keeps a slot a Canvas2DMount claims but has not appended YET', async () => {
    const slot = pool.mount(4)!;          // claim taken; init in flight; canvas has no parent
    const rec = created[created.length - 1];
    expect(slot.canvas.parentElement, 'precondition: the append has not happened').toBeNull();

    pool.destroyPool();                   // …and the teardown lands right here

    expect(slot.destroyed, 'a claimed slot must survive pool teardown').toBeFalsy();
    await slot.ready;
    // The device symptom in one assertion: this context was destroyed out from under a mount that
    // then appended its corpse into the DOM — correct size, correct ECS, zero pixels ever drawn.
    expect(rec.destroyed, 'its GPU context must not be torn down').toBe(false);
    expect(slot.initialized, 'and it must finish coming up, usable').toBe(true);
    expect(pool.allocate(4), 'and stay addressable, so Scene2D renders into THIS slot').toBe(slot);
  });

  it('unregisters the pointer passthrough when it disposes a slot', async () => {
    const slot = pool.mount(6)!;
    await slot.ready;
    const mine = passthroughs[passthroughs.length - 1];
    expect(mine.disposed, 'precondition: still registered while the slot lives').toBe(0);

    pool.unmount(6);
    pool.destroyPool();

    // Otherwise a dead canvas keeps a live passthrough registration in `core/pointerBlockers`, and
    // mount/unmount churn multiplies it — the pool holds `unpassthrough` per slot precisely so this
    // cannot happen, and nothing asserted it.
    expect(mine.disposed, 'a disposed slot must unregister its passthrough').toBe(1);
  });

  it('still tears down a context that finishes initialising after a genuine disposal', async () => {
    const slot = pool.mount(5)!;
    const rec = created[created.length - 1];
    pool.unmount(5);                      // no claim left, so this really is a disposal…
    pool.destroyPool();
    expect(slot.destroyed).toBe(true);

    await slot.ready;                     // …and the late-arriving context must not leak
    expect(rec.destroyed, 'a disposed slot must not orphan its GPU context').toBe(true);
    expect(rec.destroyArg).toBe(true);
    expect(slot.initialized, 'and it must not report itself as usable').toBe(false);
  });

  it('keeps a surviving slot addressable, so the next allocate reuses it', async () => {
    const slot = pool.mount(3)!;
    await slot.ready;
    document.body.appendChild(slot.canvas);
    pool.destroyPool();
    // Without the re-map, allocate() would take a FRESH slot and the mounted canvas would be
    // orphaned — visible, and permanently blank.
    expect(pool.allocate(3), 'the same slot must be handed back').toBe(slot);
  });

  // Defect B: `destroyPool()` never destroyed a KEPT slot's Application once its last claim
  // dropped — the doc comment claimed `renderAll`'s shrink path collected it, but by the time
  // `destroyPool()` runs, `Game.tsx` has already called `stopScene2D()`, which unregisters the
  // frame callback that drives `renderAll`. Up to MAX_SLOTS Applications could survive a
  // "destroy" forever, holding live GPU contexts.
  it('destroys a KEPT slot once its last claim finally drops, with no driver left to do it (defect B)', async () => {
    const slot = pool.mount(7)!;
    await slot.ready;
    document.body.appendChild(slot.canvas);   // still on screen when the pool is torn down
    const rec = created[created.length - 1];

    pool.destroyPool();                       // kept — mount claim still held
    expect(slot.destroyed, 'precondition: kept, not destroyed yet').toBeFalsy();
    expect(rec.destroyed, 'precondition: its Application is still alive').toBe(false);

    document.body.removeChild(slot.canvas);
    pool.unmount(7);                          // the last claim drops. Nothing else runs `renderAll`.

    expect(slot.destroyed, 'a kept slot must be destroyed once its last claim drops').toBe(true);
    expect(rec.destroyed, 'its Application must actually be torn down, not merely flagged').toBe(true);
    expect(rec.destroyArg, 'the same full teardown the shrink/disposal paths use').toBe(true);

    // It must not have been quietly RECYCLED either — a slot this pool destroyed must not be
    // handed back for reuse. With only one slot ever created here, the old (buggy) reclaim-only
    // behaviour would have made this exact slot the sole free one and handed it straight back.
    const reused = pool.allocate(7)!;
    expect(reused, 'a destroyed slot must not be reused — a DESTROY destroys').not.toBe(slot);
  });
});

describe('canvas2DPool.rebuildSlotApp — stale _gpuData purge (#678)', () => {
  // These are CALLER-level tests: `revalidateSubtreeAfterRendererRebuild` itself is covered by
  // gpuResourceInvalidation.test.ts. What matters here is that `rebuildSlotApp` calls it with the
  // DEAD renderer's own uid — NOT a caller-built "live renderer uids" exclusion set.
  //
  // ⚠️ An earlier version of this suite had a "uid-collision" test here, asserting that a purge
  // built from a live-uid EXCLUSION set correctly reached an entry keyed under the REBUILT
  // renderer's freshly-minted uid. That input cannot occur: Pixi renderer `uid`s come from a
  // monotonic counter (`AbstractRenderer.mjs`'s `uid('renderer')`) that this repo never resets
  // (`resetUids()` has zero callers), so two renderers can never collide on the same uid. The test
  // asserted a real fact about the old implementation (an excluded uid IS purged) while resting it
  // on a premise that was never true. It is replaced below with a test of what the function
  // actually does now: purge the uid it is TOLD is dead, nothing else.

  it("purges the dead renderer's own _gpuData entry from a surviving node after a rebuild", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(50)!;
    await slot.ready;
    const deadUid = slot.app.renderer.uid;

    // A surviving display object carrying a stale `_gpuData` entry keyed under the OLD (about to
    // be destroyed) renderer's uid — exactly what `revalidateSubtreeAfterRendererRebuild` is told
    // to purge.
    const stale: { _gpuData: Record<number, unknown> } = { _gpuData: { [deadUid]: 'sentinel' } };
    slot.container.addChild(stale as unknown as never);

    fireLost(slot.canvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await slot.ready;

    expect(slot.app.renderer.uid, 'precondition: the rebuild produced a NEW (never-reused) uid').not.toBe(deadUid);
    expect(
      stale._gpuData[deadUid],
      "the entry keyed under the renderer that was destroyed must be purged",
    ).toBeUndefined();
  });

  it("does NOT purge an entry belonging to ANOTHER live slot's renderer (same pool)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slotA = pool.allocate(51)!;
    const slotB = pool.allocate(52)!;
    await slotA.ready;
    await slotB.ready;
    const bUid = slotB.app.renderer.uid;

    // A resource shared with (or simply cached against) slot B's still-live renderer, sitting on
    // slot A's surviving scene graph.
    const shared: { _gpuData: Record<number, unknown> } = { _gpuData: { [bUid]: 'owned-by-b' } };
    slotA.container.addChild(shared as unknown as never);

    fireLost(slotA.canvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await slotA.ready;

    expect(
      shared._gpuData[bUid],
      "an entry belonging to a DIFFERENT live slot's renderer must survive — deleting it would " +
        'orphan a GPU object that slot still owns',
    ).toBe('owned-by-b');
  });

  it("a rebuild whose FIRST init times out still purges the ORIGINAL dead renderer's uid on the retry", async () => {
    // Regression pinned after a second adversarial review of #678: `deadRendererUid` used to be a
    // plain local captured at the top of `rebuildSlotApp` and passed to the purge call AFTER the
    // `await withTimeout(...)` for `Application.init()`. If that timed out (APP_INIT_TIMEOUT_MS,
    // 8000ms), the function threw right there and the purge call — further down — never ran. The
    // uid was then lost: on the RETRY, `rebuildSlotApp` starts over and only knows about the
    // retry's OWN (never-initialized) app, not the renderer that originally died. So the original
    // dead renderer's `_gpuData` entries were never purged by any path. The fix accumulates dead
    // uids on `slot.pendingDeadRendererUids` across attempts instead of a single local.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(60)!;
    await slot.ready;
    const originalDeadUid = slot.app.renderer.uid;   // the renderer this test kills

    // A surviving display object carrying a stale `_gpuData` entry keyed under the ORIGINAL
    // renderer's uid — exactly the entry a timed-out-then-retried rebuild must still purge.
    const stale: { _gpuData: Record<number, unknown> } = { _gpuData: { [originalDeadUid]: 'sentinel' } };
    slot.container.addChild(stale as unknown as never);

    // Make the FIRST rebuild attempt's `Application.init()` hang forever, so it is bounded only by
    // `APP_INIT_TIMEOUT_MS` (8000ms) inside `withTimeout` and REJECTS rather than resolving.
    initGate.hold = new Promise<void>(() => { /* never settles — simulates a dead GPU */ });
    fireLost(slot.canvas);
    // Past the policy's initial delay (250ms) plus the full init timeout (8000ms): the first
    // attempt has now REJECTED, and `rendererRecovery` has scheduled a retry with backoff.
    await vi.advanceTimersByTimeAsync(8300);

    // Let the RETRY's `Application.init()` actually succeed.
    initGate.hold = null;
    // Past the backoff delay (500ms = delayMs * 2**1) plus the retry's (now instant) init.
    await vi.advanceTimersByTimeAsync(700);
    vi.useRealTimers();
    await slot.ready;

    expect(slot.initialized, 'the retry must have brought a renderer up').toBe(true);
    expect(slot.app.renderer.uid, 'precondition: the retry produced a NEW uid').not.toBe(originalDeadUid);
    expect(
      stale._gpuData[originalDeadUid],
      "the ORIGINAL dead renderer's entry must be purged, even though it died on an EARLIER " +
        'attempt than the one that finally purges it',
    ).toBeUndefined();
  });

  it('calls onViewUpdate on a surviving view in slot.container after a rebuild (#678 — the actual cure)', async () => {
    // The `_gpuData` purge alone was device-measured to leave the frame blank; `onViewUpdate` is
    // what restores it (see gpuResourceInvalidation.ts's file header for the isolation table).
    // This is the CALLER-level check that `rebuildSlotApp` actually reaches a surviving view.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const slot = pool.allocate(53)!;
    await slot.ready;

    const survivingView: { onViewUpdate: () => void } = { onViewUpdate: vi.fn() };
    slot.container.addChild(survivingView as unknown as never);

    fireLost(slot.canvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await slot.ready;

    expect(survivingView.onViewUpdate, 'a surviving view must be marked dirty after the rebuild').toHaveBeenCalled();
  });
});

describe('canvas2DPool.rebuildSlotApp — TWO POOLS (cross-pool _gpuData safety)', () => {
  // The important regression here: TWO `Canvas2DPool` instances are live at once in real usage —
  // `defaultPool` (this file) and `editorCanvas2DPool` (`editor/rendering/editorScene2D.ts`) — and
  // Pixi `TextureSource`s are process-global, so the SAME resource object can be shared between
  // slots that belong to DIFFERENT pools. A purge that reasons about "every uid I know is live"
  // from only ONE pool's own slots is an INCOMPLETE live set: it would delete the other pool's
  // still-live renderer's entry off a shared resource, orphaning a GPU object that pool still
  // owns. Purging only the uid `rebuildSlotApp` is TOLD is dead (its own destroyed renderer's)
  // cannot make this mistake, because it never has to reason about what else is "live" at all.
  //
  // Pattern follows `scene2DBoundsSurface.test.ts`'s two-pool fixture: two independent
  // `Canvas2DPool` instances, each with its own slots and renderers.

  it("a rebuild on pool A purges only pool A's dead uid — pool B's live entry on the SAME shared node survives", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    const poolA = new Canvas2DPool();
    const poolB = new Canvas2DPool();
    const slotA = poolA.allocate(100)!;
    const slotB = poolB.allocate(200)!;
    await slotA.ready;
    await slotB.ready;

    const deadUidA = slotA.app.renderer.uid;
    const liveUidB = slotB.app.renderer.uid;

    // One node, shared across both pools' scene graphs (a process-global `TextureSource` would be
    // exactly this shape in real Pixi) — carrying a `_gpuData` entry for EACH pool's renderer.
    const shared: { _gpuData: Record<number, unknown> } = {
      _gpuData: { [deadUidA]: 'owned-by-a', [liveUidB]: 'owned-by-b' },
    };
    slotA.container.addChild(shared as unknown as never);

    fireLost(slotA.canvas);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await slotA.ready;

    expect(shared._gpuData[deadUidA], "pool A's dead renderer entry must be purged").toBeUndefined();
    expect(
      shared._gpuData[liveUidB],
      "pool B's LIVE renderer entry must survive untouched — deleting it would orphan a GPU " +
        'object pool B still owns',
    ).toBe('owned-by-b');
  });
});

describe('canvas2DPool — WebGPU device.lost (#794)', () => {
  it('a device.lost resolving marks the slot lost and requests recovery', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let resolveLost!: (info: { reason?: string }) => void;
    deviceLostGate.promise = new Promise((r) => { resolveLost = r; });
    const slot = pool.allocate(40)!;
    await slot.ready;
    const madeBefore = created.length;

    // The handler does NOT filter on `reason` — deliberately, per the doc comment on
    // `attachDeviceLostListener`. Any resolution is a real loss.
    resolveLost({ reason: 'unknown' });
    await Promise.resolve();
    await Promise.resolve();

    expect(slot.contextLost, 'a lost WebGPU device must be OBSERVABLE on the slot').toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // let the recovery policy's delay elapse
    vi.useRealTimers();
    await slot.ready;

    expect(created.length, 'recovery must actually rebuild a new renderer').toBeGreaterThan(madeBefore);
  });

  it('does NOT report a phantom device loss once OUR OWN teardown has run', async () => {
    // ⚠️ Isolates the `disposed` guard specifically, not just the overall "teardown is silent"
    // outcome. Going through the full `pool.mount()`/`unmount()`/`destroyPool()` path also flips
    // `slot.destroyed` and (on a rebuild) reassigns `slot.app` — either of which independently
    // guards the handler, so a mutation removing ONLY the `disposed` check would sail through
    // that path undetected. `detachDeviceLost()` is called BEFORE `app.destroy()` in every real
    // teardown (see canvas2DPool.ts's own comment on `detachDeviceLost`), which is exactly the
    // window this exercises directly: the listener has been told to stand down, but nothing else
    // about the slot has changed yet.
    let resolveLost!: (info: { reason?: string }) => void;
    deviceLostGate.promise = new Promise((r) => { resolveLost = r; });
    const slot = pool.allocate(41)!;
    await slot.ready;
    expect(slot.detachDeviceLost, 'precondition: the listener actually attached').toBeTypeOf('function');

    slot.detachDeviceLost!(); // the disposer our own teardown calls before app.destroy()
    expect(slot.destroyed, 'precondition: NOT a full disposal — isolates the disposed flag alone').toBeFalsy();

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const madeBefore = created.length;

    // `{reason:'destroyed'}` is what a real `GPUDevice.destroy()` resolves `device.lost` with.
    // ⚠️ NOT provoked by our own teardown: Pixi never calls `GPUDevice.destroy()` at all
    // (`GpuDeviceSystem.destroy()` only nulls `gpu`/`extensions`/`_renderer`), so this reason can
    // only come from OUTSIDE Pixi. That is exactly why the `disposed` guard is worth pinning — the
    // window it defends is an external destruction landing after `detachDeviceLost()`, not a
    // self-inflicted one. (An earlier comment here claimed our own `app.destroy()` provoked it;
    // that claim is retracted — see `gpuResourceInvalidation.ts`'s header. The WebGL twin above,
    // `fireLost(slot.canvas)`, IS self-provoked, and its comment is correct as written.)
    resolveLost({ reason: 'destroyed' });
    await Promise.resolve();
    await Promise.resolve();

    expect(err, 'a detached listener must not report a phantom device loss').not.toHaveBeenCalled();
    expect(slot.contextLost, 'must not flip to lost once the listener is detached').toBeFalsy();

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    expect(created.length, 'no rebuild must be queued from a phantom device loss').toBe(madeBefore);
  });
});

describe('canvas2DPool — slot-reused label is read at FIRE time, not attach time (finding 4)', () => {
  it('a handler-failure catch message names the CURRENT entity after the slot is reused by a different one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveLost!: (info: { reason?: string }) => void;
    deviceLostGate.promise = new Promise((r) => { resolveLost = r; });

    const slotA = pool.allocate(50)!;
    await slotA.ready;
    pool.release(50); // frees the slot WITHOUT destroying its Application — reuse, not rebuild
    const slotB = pool.allocate(51)!;
    // Precondition: this is the SAME slot/Application/listener as entity 50's — the reuse the
    // finding is about, not a fresh one that would trivially get the right label anyway.
    expect(slotB, 'precondition: the freed slot is reused, not recreated').toBe(slotA);

    // Force the WebGPU device-lost `onLost` callback itself to throw, so
    // `attachDeviceLostListener`'s handler-failure catch fires — the ONE place that reads
    // `handlers.label` directly rather than through the (already-dynamic) `describe()` closure.
    slotB.recovery!.request = () => { throw new Error('boom'); };

    resolveLost({ reason: 'unknown' });
    await Promise.resolve();
    await Promise.resolve();

    expect(err).toHaveBeenCalled();
    const msg = String(err.mock.calls.at(-1)![0]);
    expect(msg, 'must name the entity the slot serves NOW').toMatch(/canvas2DPool:51\b/);
    expect(msg, 'must NOT still name the entity it was attached under').not.toMatch(/canvas2DPool:50\b/);
    // The #794 issue reference the shared module's generic catch message drops per-caller —
    // canvas2DPool restores it via the label itself (see canvas2DPool.ts).
    expect(msg).toMatch(/#794/);
  });
});
