/** getSafeAreaInsets — the measured safe-area insets game LAYOUT ARITHMETIC reads (#273).
 *
 *  The load-bearing property is WHERE it measures: inside the UI root's cascade, so an
 *  editor device preview's simulated `--ui-sa-*` reaches it. A probe on document.body
 *  would read a confident, wrong 0 in every preview — that is the bug this file exists to
 *  make impossible, and the reason the happy-path test alone would not be enough.
 *
 *  ⚠️ **jsdom does not substitute `var()` into a property**, so these tests exercise the
 *  module's var-reading branch, NOT the padding probe a real browser resolves. The live
 *  path is covered by MEASUREMENT instead, and that measurement is the evidence of
 *  record: an iPhone Air over the device lease reports top 68 / bottom 34, and an editor
 *  device preview on the same preset resolves the same 68 through `--ui-sa-top`. What
 *  these tests can and do pin is everything around it — inheritance from an ancestor
 *  (the property the whole design turns on), the zero defaults, cache invalidation, and
 *  that the probe leaves no trace in the DOM. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSafeAreaInsets, measureSafeAreaInsets, resetSafeAreaInsets } from '../../src/runtime/ui/safeArea';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

let root: HTMLElement;
let cancelCount = 0;

/** Deterministic stand-in for `requestAnimationFrame`, so a test can flush the deferred
 *  re-measure (see `getSafeAreaInsets`'s own doc for why it is deferred) without depending on
 *  jsdom's own rAF cadence. Maps to a 0ms macrotask, which `flushRaf` awaits. `cancelAnimationFrame`
 *  is the matching `clearTimeout`, counted so a test can assert a REAL cancellation happened
 *  (not just that a flag got cleared — see the `resetSafeAreaInsets` cancellation test below). */
const flushRaf = async () => { await new Promise((r) => setTimeout(r, 0)); };

/** Spend the whole poll budget the way a per-frame consumer does — one throttle-crossing read
 *  per iteration, each flushed — and keep going until an iteration actually produces NO probe,
 *  rather than looping a fixed count.
 *
 *  ⚠️ **A fixed iteration count is a shadowing constant, and it goes stale exactly the way
 *  `POLL_REFRESH_BUDGET`'s own doc warns a shadowing value does.** That doc says "if a device
 *  turns up where the transition lands later, widen this" — widen it past a hardcoded loop count
 *  here and the loop stops BEFORE the budget is spent, so every test built on "the budget is
 *  exhausted" silently stops proving that while still reading green. Measured, on the version of
 *  this helper that did loop a hardcoded 25: at the budget's CURRENT value of 20 those 25
 *  throttle-crossing reads do spend it, and the re-arm test correctly fails with the re-arm
 *  deleted from `onVisibilityChange` — but take that same doc's advice and widen the budget to 28,
 *  and the 25-iteration loop leaves 3 unspent, the re-arm test PASSES with the re-arm deleted, and
 *  the `visibilitychange`-to-HIDDEN test starts failing with a message pointing at the visibility
 *  guard rather than at the loop that actually broke. So the trap is not latent in today's numbers
 *  — it is armed by the one edit `POLL_REFRESH_BUDGET`'s doc actively recommends.
 *
 *  Instruments `root.appendChild` — the same probe-count idiom the "stops self-refreshing..."
 *  test below uses — and stops the moment an iteration appends no probe, which is the actual,
 *  budget-value-independent signal that the self-refresh has stopped scheduling itself. The cap
 *  is a safety net against hanging forever on a REGRESSION (an unbounded/self-re-arming poll),
 *  never a value anything here is tuned against; the trailing assertion proves the loop stopped
 *  because probes stopped, not because the cap was hit — so a regression that removes the bound
 *  entirely fails LOUD (this assertion) instead of just running long.
 *
 *  Takes the root to drain (defaults to the suite's `root`) so a test juggling two roots — the
 *  stale-callback-identity tests below — can drain the OTHER one. Returns the exact number of
 *  probes it counted, i.e. how much budget was actually spent, so a caller can assert on it
 *  directly rather than only on "did it stop". */
const drainPollBudget = async (el: HTMLElement = root): Promise<number> => {
  const originalAppend = el.appendChild.bind(el);
  let appended: boolean;
  el.appendChild = ((node: Node) => { appended = true; return originalAppend(node); }) as typeof el.appendChild;
  const DRAIN_CAP = 200; // generous safety net only — see the doc above
  let iterations = 0;
  try {
    for (; iterations < DRAIN_CAP; iterations += 1) {
      appended = false;
      advanceManual(300);
      getSafeAreaInsets();
      await flushRaf();
      if (!appended) break;
    }
  } finally {
    el.appendChild = originalAppend;
  }
  expect(iterations, 'the drain must stop because probes stopped, not because the safety cap was hit')
    .toBeLessThan(DRAIN_CAP);
  // ⚠️ The LOWER bound matters as much as the cap, and is the easier one to forget. A drain that
  // spends NOTHING also "stops because probes stopped", so without this it returns 0 and every
  // caller's premise ("the budget has run out") is satisfied vacuously — including
  // `expect(spentAfterBail).toBe(spentClean)` below, which 0 === 0 passes. Two ways to reach it,
  // neither hit today but both one refactor away: draining an `el` that is not the module's
  // current `root` (the probe lands on the real root and this instrumentation never sees it), or
  // entering with a refresh already in flight (`refreshQueued` blocks the schedule). Found in the
  // close-out's own follow-up review of this helper.
  expect(iterations, 'the drain must actually spend budget — a zero-spend drain proves nothing')
    .toBeGreaterThan(0);
  return iterations;
};

beforeEach(() => {
  resetSafeAreaInsets();
  root = document.createElement('div');
  document.body.appendChild(root);
  cancelCount = 0;
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number;
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void })
    .cancelAnimationFrame = (id) => { cancelCount += 1; clearTimeout(id as unknown as ReturnType<typeof setTimeout>); };
});
afterEach(() => {
  root.remove();
  resetSafeAreaInsets();
  restoreRealClock();
});

describe('getSafeAreaInsets', () => {
  it('is zeros before anything has measured — a game with no UI layer, or a headless test', () => {
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('reads the --ui-sa-* vars set on the UI root (the editor device-preview path)', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '7px');
    root.style.setProperty('--ui-sa-right', '13px');
    measureSafeAreaInsets(root);
    // The measured iPhone Air quartet, with asymmetric sides so a swapped edge fails.
    expect(getSafeAreaInsets()).toMatchObject({ top: 68, right: 13, bottom: 34, left: 7 });
  });

  it('inherits vars set on an ANCESTOR — the editor sets them on the preview frame, not the UI root', () => {
    const frame = document.createElement('div');
    frame.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(frame);
    const inner = document.createElement('div');
    frame.appendChild(inner);
    measureSafeAreaInsets(inner);
    expect(getSafeAreaInsets().top).toBe(44);
    frame.remove();
  });

  it('falls back to zero when the var is unset and env() resolves to nothing (desktop / jsdom)', () => {
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  // The percentages are the field games should actually use, and they exist because the px
  // alone invite a wrong denominator: a game dividing by its own `getBoundingClientRect`
  // height mixes a PRE-transform inset with a POST-transform box, which is exactly how
  // Court's banner lifted 6.09% where 3.73% was right — correct on the phone, wrong in the
  // editor preview. These are measured against the root's layout box in the same pass.
  it('reports each inset as a percentage of the ROOT box, measured in the same pass', () => {
    Object.defineProperty(root, 'clientHeight', { value: 912, configurable: true });
    Object.defineProperty(root, 'clientWidth', { value: 420, configurable: true });
    root.style.setProperty('--ui-sa-top', '68px');
    root.style.setProperty('--ui-sa-bottom', '34px');
    root.style.setProperty('--ui-sa-left', '21px');
    measureSafeAreaInsets(root);
    const i = getSafeAreaInsets();
    expect(i.topPct).toBeCloseTo((68 / 912) * 100, 9);
    expect(i.bottomPct).toBeCloseTo((34 / 912) * 100, 9);
    expect(i.leftPct).toBeCloseTo((21 / 420) * 100, 9);   // horizontal is a share of WIDTH
  });

  it('percentages are zero rather than Infinity when the root has no box yet', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    expect(getSafeAreaInsets().topPct).toBe(0);
  });

  it('a null root yields zeros rather than throwing — the UI layer may not be mounted', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    measureSafeAreaInsets(null);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('leaves no probe behind in the DOM', () => {
    const before = document.body.querySelectorAll('*').length;
    measureSafeAreaInsets(root);
    expect(document.body.querySelectorAll('*').length).toBe(before);
  });

  it('re-measures rather than caching a stale value when the preset changes', () => {
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);
    root.style.setProperty('--ui-sa-top', '0px');   // e.g. switching to a device with no notch
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(0);
  });

  /**
   * The read REFRESHES ITSELF, and this is the bug that made it necessary (#273).
   *
   * With `setDecorFitsSystemWindows(false)` an Android window keeps its size when the system
   * bars hide — only the insets change — so no ResizeObserver fires and nothing tells the UI
   * layer to re-measure. Court hides the bars a beat after first paint, so the value captured at
   * mount (bottom 48px, the nav bar) stuck: measured on a Galaxy A23 where the live inset was 0
   * while the game still laid out against 48. It lifted the ad band off the bottom edge AND
   * shortened the paper, because the same number feeds `designToHostPct`'s vertical span — two
   * reports, one stale cache.
   *
   * `env()` changing fires no event, so there is nothing to subscribe to. The read throttles
   * itself on the sanctioned clock instead.
   */
  it('re-measures when the cache goes stale, with NO resize to prompt it', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-bottom', '48px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().bottom).toBe(48);

    // The bars hide. Same element, same size — only the inset moved.
    root.style.setProperty('--ui-sa-bottom', '0px');
    // Within the throttle the cached value still stands...
    expect(getSafeAreaInsets().bottom).toBe(48);
    // ...and past it, the read schedules its own refresh (deferred one rAF — see the
    // function's own doc for why) rather than forcing the layout inline...
    advanceManual(300);
    expect(getSafeAreaInsets().bottom, 'still the stale value on the crossing call itself').toBe(48);
    // ...which lands the moment that frame flushes, with nothing else prompting it.
    await flushRaf();
    expect(getSafeAreaInsets().bottom).toBe(0);
  });

  it('does not append (or read) the probe synchronously on the call that crosses the throttle (WebKit compositor-stall fix, #579 follow-up)', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    let appends = 0;
    const originalAppend = root.appendChild.bind(root);
    root.appendChild = ((node: Node) => { appends += 1; return originalAppend(node); }) as typeof root.appendChild;
    advanceManual(300);
    const appendsOnCrossingCall = (() => { getSafeAreaInsets(); return appends; })();
    expect(appendsOnCrossingCall, 'no probe append synchronously inside the crossing call').toBe(0);
    await flushRaf();
    expect(appends, 'the deferred refresh eventually appends the probe it needs').toBe(1);
  });

  it('does not re-measure on every call — a per-frame caller must not force a style read per frame', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    root.style.setProperty('--ui-sa-top', '0px');
    for (let i = 0; i < 20; i += 1) {
      advanceManual(10);                       // 200ms total, under the throttle
      expect(getSafeAreaInsets().top).toBe(68);
    }
    advanceManual(100);
    getSafeAreaInsets();                     // crosses the throttle — schedules the deferred refresh
    await flushRaf();
    expect(getSafeAreaInsets().top).toBe(0);
  });

  it('a read before anything mounted does not throw and stays zero', () => {
    setManualNow(0);
    resetSafeAreaInsets();
    advanceManual(10_000);
    expect(getSafeAreaInsets()).toMatchObject({ top: 0, bottom: 0 });
  });

  /**
   * A DETACHED root must never be measured (#273 close-out).
   *
   * `UIRenderer`'s callback ref returns early on unmount, so this module is never handed a null —
   * its reference just goes stale. `getComputedStyle` on a removed node answers empty strings and
   * `clientHeight` 0, so the self-refresh would rewrite every inset to ZERO and the layout would
   * jump with no device change. Reachable in the editor (two viewports mount a UIRenderer; closing
   * the one that registered last detaches this root while the other is still on screen) and in a
   * shipped game (the UI tree empties for a beat across a scene swap).
   */
  it('does NOT re-measure a detached root — the value must stop tracking it', () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    expect(getSafeAreaInsets().top).toBe(68);

    root.remove();                              // the viewport that registered it goes away
    // Change what the detached node WOULD report. If the refresh still measures it, the cached
    // value follows; if it correctly skips, the value stands.
    // ⚠️ Asserted this way ON PURPOSE. The first version asserted "the insets do not become 0",
    // which passes in jsdom whether or not the guard exists — jsdom still resolves a custom
    // property on a removed node, so the mutation check went green against the defect. The
    // observable that actually discriminates is whether a measure HAPPENED at all.
    root.style.setProperty('--ui-sa-top', '999px');
    advanceManual(1000);                        // well past the throttle
    expect(getSafeAreaInsets().top, 'a detached root must not be re-measured').toBe(68);
  });

  it('picks up a NEW root after the old one detached', () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    root.remove();
    advanceManual(1000);
    expect(getSafeAreaInsets().top).toBe(68);   // stale ref dropped here

    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);
    expect(getSafeAreaInsets().top).toBe(44);
    fresh.remove();
  });

  /**
   * A detached root is released even AFTER the #592 poll budget has run out (found in review,
   * #592 follow-up) — the cleanup must not be gated by the same budget that bounds the
   * (expensive) re-measure, since checking `isConnected` is a cheap DOM flag read, not a forced
   * layout. Without this, a scene swap to a UI-less scene after `POLL_REFRESH_BUDGET` refreshes
   * had already been spent would hold the old scene's whole DOM subtree referenced indefinitely.
   *
   * ⚠️ Drains the budget with `drainPollBudget()` (spending it via actual reads) rather than a
   * bare `advanceManual(6000)` — #600: under a COUNT, a clock hop with no reads leaves the
   * budget untouched, so the premise "the budget has run out" needs it to be genuinely spent
   * while the root is still connected, not just a lot of simulated time to pass.
   */
  it('releases a detached root even once the poll budget has run out', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    await drainPollBudget();                      // budget spent — no refresh would fire
    root.remove();                                // the viewport that registered it goes away

    let isConnectedChecked = false;
    Object.defineProperty(root, 'isConnected', {
      configurable: true,
      get() { isConnectedChecked = true; return false; },
    });
    getSafeAreaInsets();
    expect(isConnectedChecked, 'the detached-root check must run even past the spent budget').toBe(true);

    // And the release actually took effect — a fresh registration after this must NOT trip the
    // stale-callback-identity guard against the old (now-null) root.
    root.style.setProperty('--ui-sa-top', '999px');
    Object.defineProperty(root, 'isConnected', { configurable: true, value: false });
    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);
    expect(getSafeAreaInsets().top, 'the fresh root registers cleanly after the stale one was released').toBe(44);
    fresh.remove();
  });

  /**
   * A NEWER registration replacing `root` WHILE a deferred refresh for the OLD one is still
   * queued must not be clobbered by that stale callback landing late (found in review, #579
   * follow-up) — the editor's two-viewport case the surrounding code already names: closing one
   * viewport's UIRenderer and opening another can interleave with an in-flight throttle window.
   */
  it('a newer root registered before a queued refresh fires is not clobbered by it', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);                 // seeds root, lastMeasuredAt = 0
    advanceManual(300);                           // past the throttle
    getSafeAreaInsets();                          // schedules a deferred refresh FOR `root`

    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);                 // a newer registration lands before the flush
    expect(getSafeAreaInsets().top, 'the newer registration is immediately live').toBe(44);

    await flushRaf();                             // the STALE callback (for `root`) fires now
    expect(getSafeAreaInsets().top, 'must still be the newer root — not re-pointed to the stale one').toBe(44);

    // And the newer root's OWN throttle must be unaffected — it still self-refreshes normally.
    fresh.style.setProperty('--ui-sa-top', '99px');
    advanceManual(300);
    getSafeAreaInsets();
    await flushRaf();
    expect(getSafeAreaInsets().top).toBe(99);

    root.remove();
    fresh.remove();
  });

  /**
   * #600: a consumer that STOPS READING for a while must not have its self-refresh silently
   * starved by that — Court's `boardSafeAreaInsets()` (`games/court/runtime/systems.ts`)
   * deliberately skips this accessor for the whole duration of a live touch gesture, and a
   * gesture can run longer than the poll used to stay armed.
   *
   * Under the OLD wall-clock window (`pollArmedUntil`, #592), the window is spent by TIME
   * passing whether or not anything was measured — so ~10s of frames with NO read at all (this
   * test's shape) burned the entire 5s window on zero probes, and the read that finally happens
   * once reading resumes lands past an already-closed window and schedules nothing: the stale
   * 48 would stick forever, not just until the next mount/resize/resume. A refresh BUDGET is
   * spent only by an actual re-measure, so a suppressed reader's budget is untouched by however
   * long it went unread, and its first read on resuming still finds budget to schedule with.
   */
  it('a consumer that stops reading does not burn its budget — it catches up when reads resume (#600)', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-bottom', '48px');
    measureSafeAreaInsets(root);                  // arms the budget

    // Simulate Court's gesture gate: ~10s of frames with getSafeAreaInsets() never called at
    // all — the bars hide mid-gesture (i === 300), the way #273's Android transition actually
    // behaves, but nothing here is reading to notice. No assertion inside this loop on purpose:
    // any read here would itself be a read, and the point is that NOTHING reads for the whole
    // suppressed span.
    for (let i = 0; i < 625; i += 1) {
      advanceManual(16);
      if (i === 300) root.style.setProperty('--ui-sa-bottom', '0px');
    }

    // The gesture ends; reads resume per-frame, the way production drives it.
    for (let i = 0; i < 5; i += 1) {
      advanceManual(16);
      getSafeAreaInsets();
      await flushRaf();
    }
    expect(getSafeAreaInsets().bottom, 'catches up on the very next read — the budget was never spent').toBe(0);
  });

  /**
   * The self-refresh is BOUNDED to a refresh BUDGET after a registration, not indefinite (#592).
   * The Android bar-hide it exists for (#273) settles once, shortly after mount — polling
   * forever after that is pure ongoing forced-layout cost for zero remaining benefit.
   *
   * ⚠️ Driven the way PRODUCTION actually drives it — a per-frame caller reading every
   * simulated frame, the way Court's chrome-sync systems do — not a single hop past the
   * budget. A single `advanceManual(6000)` with no intervening reads cannot tell "the budget
   * bounds the poll" from "the budget gets re-armed by every refresh and never really runs out":
   * nothing ever crosses the throttle inside it, so no refresh - armed or not - ever fires
   * either way (this is also exactly why the #600 test above drives NO reads during its
   * suppressed span, but reads every frame here — the two tests probe opposite failure modes).
   * This shape is also what caught a real regression in review: an earlier version of this fix
   * re-armed the budget from the self-refresh's OWN re-measure, so the poll ran at its original
   * ~4x/sec forever — invisible to a test that never drove a frame loop through the budget at all.
   */
  it('stops self-refreshing once the poll budget is spent, keeping the last-good value (#592)', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-bottom', '48px');
    measureSafeAreaInsets(root);                  // arms the budget at POLL_REFRESH_BUDGET (20)
    let appends = 0;
    const originalAppend = root.appendChild.bind(root);
    root.appendChild = ((node: Node) => { appends += 1; return originalAppend(node); }) as typeof root.appendChild;

    // A per-frame caller, ~60fps, across ~11.2s — comfortably enough frames to exhaust the
    // budget. The bars hide ~1s in (i === 60), the way the #273 Android transition actually
    // behaves.
    for (let i = 0; i < 700; i += 1) {
      advanceManual(16);
      if (i === 60) root.style.setProperty('--ui-sa-bottom', '0px');
      getSafeAreaInsets();
      await flushRaf();
    }
    // The throttle allows a probe roughly every REFRESH_MS (250ms), so the 20-refresh budget is
    // spent after ~5000ms of reads; NOT the ~11200/250 = ~44 an unbounded (or self-re-arming)
    // poll would produce over the same span.
    expect(appends, 'probes happened while budget remained').toBeGreaterThan(0);
    expect(appends, 'bounded to the budget, not the ~44 an indefinite/self-re-arming poll would reach').toBeLessThan(30);
    expect(getSafeAreaInsets().bottom, 'the bars hid while budget remained and WERE picked up').toBe(0);

    // Now prove the budget actually RAN OUT: keep reading every frame for another ~1.6s and
    // confirm not one further probe fires — the discriminating assertion. Under the pre-fix
    // (self-re-arming) behaviour this count would keep climbing instead of staying at 0.
    appends = 0;
    root.style.setProperty('--ui-sa-bottom', '999px');   // if it re-measured, this WOULD be picked up
    for (let i = 0; i < 100; i += 1) {
      advanceManual(16);
      getSafeAreaInsets();
      await flushRaf();
    }
    expect(appends, 'no further probes once the budget is spent, however long reads continue').toBe(0);
    expect(getSafeAreaInsets().bottom, 'still the stale value — nothing measured the 999 change').toBe(0);
  });

  /**
   * A `visibilitychange` resume re-arms the budget (#592) — the other moment (besides mount)
   * the Android bars can re-hide, per the issue's own reasoning. Platform-agnostic on purpose:
   * this file takes no Capacitor dependency, so it listens for the DOM event rather than
   * threading `App.addListener('resume', ...)` through an otherwise L0 module.
   *
   * ⚠️ **Closes the budget with `drainPollBudget()`, not a bare `advanceManual(6000)` — that is
   * itself the #600 change.** A clock hop with no intervening reads spends nothing under a
   * COUNT: the throttle is never crossed by a read that never happens, so the budget sits at 20
   * whatever the elapsed time, and this test would stop discriminating "resume re-arms it" from
   * "nothing ever closed it in the first place". Only actually spending the budget (one
   * throttle-crossing read per iteration) reproduces "closed, then resumed".
   */
  it('a visibilitychange resume re-arms the poll budget (#592)', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-bottom', '48px');
    measureSafeAreaInsets(root);
    await drainPollBudget();                      // spend the budget — self-refresh has stopped
    root.style.setProperty('--ui-sa-bottom', '0px');
    expect(getSafeAreaInsets().bottom, 'budget spent, still stale before the resume').toBe(48);

    document.dispatchEvent(new Event('visibilitychange'));   // app resumes (jsdom defaults to visible)

    advanceManual(300);                            // past the throttle, now inside the reopened budget
    getSafeAreaInsets();                            // crosses the throttle — schedules the deferred refresh
    await flushRaf();
    expect(getSafeAreaInsets().bottom, 'the resume re-armed the budget, so it refreshes again').toBe(0);
  });

  /**
   * The re-arm is gated on becoming VISIBLE, not on every `visibilitychange` firing (#592) —
   * unguarded, backgrounding the app would also re-open the budget, which is not what "resume"
   * means and is not pinned by the resume test above (jsdom defaults `visibilityState` to
   * `'visible'`, so that test alone cannot tell a `=== 'visible'` check from no check at all).
   *
   * ⚠️ Same #600 reason as the resume test above for using `drainPollBudget()` here: under a
   * COUNT, a bare `advanceManual(6000)` with no reads leaves the budget still full at 20, so the
   * assertion below would pass whether or not the hidden event re-arms anything — the test's own
   * premise ("the budget was closed") would be false, not merely unproven.
   */
  it('a visibilitychange to HIDDEN does not re-arm the budget', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-bottom', '48px');
    measureSafeAreaInsets(root);
    await drainPollBudget();                      // budget spent
    root.style.setProperty('--ui-sa-bottom', '0px');
    expect(getSafeAreaInsets().bottom, 'stale before the event').toBe(48);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));   // backgrounding, not a resume
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); // restore for later tests

    advanceManual(300);
    getSafeAreaInsets();
    await flushRaf();
    expect(getSafeAreaInsets().bottom, 'a hide event must not re-open the poll budget').toBe(48);
  });

  /**
   * The `visibilitychange` listener is wired at MOST ONCE per module instance, and
   * `resetSafeAreaInsets` actually removes it (#592) — found in review as a standing-leak
   * risk: an unconditional import-time `addEventListener` (the first version of this fix) adds
   * a new listener on every Vite HMR re-evaluation of this module with nothing ever removing
   * the old one, each one a silent no-op write to a `refreshesLeft` nothing reads anymore.
   * Wiring lazily from a registration, guarded by a flag, and unwiring on reset is what keeps
   * it to exactly one live listener per module instance.
   */
  it('wires the visibilitychange listener at most once, and reset actually removes it (#592)', () => {
    let addCalls = 0;
    let removeCalls = 0;
    const originalAdd = document.addEventListener.bind(document);
    const originalRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'visibilitychange') addCalls += 1;
      return (originalAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'visibilitychange') removeCalls += 1;
      return (originalRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;

    measureSafeAreaInsets(root);                  // first registration — wires it
    const other = document.createElement('div');
    document.body.appendChild(other);
    measureSafeAreaInsets(other);                 // a second registration must NOT add a second listener
    expect(addCalls, 'wired once, not once per registration').toBe(1);
    expect(removeCalls, 'nothing torn down yet').toBe(0);

    resetSafeAreaInsets();
    expect(removeCalls, 'reset removes the listener it wired').toBe(1);

    measureSafeAreaInsets(other);                 // registering again after a reset re-wires it
    expect(addCalls, 'a fresh listener for the fresh module lifetime').toBe(2);

    document.addEventListener = originalAdd;
    document.removeEventListener = originalRemove;
    other.remove();
  });

  /**
   * `resetSafeAreaInsets` must cancel a REAL in-flight `requestAnimationFrame`, not merely clear
   * the flag that gates scheduling a new one — found in review (#579 follow-up). The flag-only
   * version left `refreshQueued` stuck `true` forever (no test could ever schedule another
   * refresh again in the SAME process) and left the stale callback able to fire later against
   * whatever registers next.
   */
  it('resetSafeAreaInsets cancels a queued refresh, and a fresh registration can schedule its own', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);
    advanceManual(300);
    getSafeAreaInsets();                          // queues a refresh
    expect(cancelCount, 'nothing cancelled yet').toBe(0);

    resetSafeAreaInsets();                        // teardown while the refresh is in flight
    expect(cancelCount, 'the real callback must be cancelled, not just flagged').toBe(1);

    // A fresh registration, immediately after reset, must be able to queue ITS OWN refresh —
    // proof `refreshQueued` did not get stuck `true` by the reset.
    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '30px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);
    fresh.style.setProperty('--ui-sa-top', '77px');
    advanceManual(300);
    getSafeAreaInsets();
    await flushRaf();
    expect(getSafeAreaInsets().top, 'the fresh registration refreshes normally after a reset').toBe(77);
    fresh.remove();
  });

  /**
   * The decrement's PLACEMENT relative to the stale-identity check is load-bearing, and nothing
   * above pins it (found in review, #600): moving `refreshesLeft -= 1` ABOVE `if (root !== target)
   * return;` still leaves the whole suite green, because every other test drains a budget that
   * was armed for the SAME root it reads back from — a bailed callback's phantom spend is
   * invisible unless something registers a SECOND root and then checks the second root's OWN
   * budget.
   *
   * Reachable in production: `UIRenderer.tsx:100` calls `measureSafeAreaInsets` from a
   * ResizeObserver, and the editor mounts two UIRenderers (SceneView + GameView) — a root swap
   * between one's throttle-crossing read and its deferred flush is real, not contrived (the
   * "newer root registered..." test above already establishes this exact interleaving).
   *
   * ⚠️ Under the mutation, A's bailed callback still runs `refreshesLeft -= 1` before reaching the
   * identity check, so it silently spends ONE of B's budget even though it forced no layout for
   * A. B's own drain would then produce one FEWER probe than its budget — this test's whole point
   * is to notice that.
   */
  it('a callback that bails on the stale-identity check spends no budget', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);                  // root A registered
    advanceManual(300);                            // past the throttle
    getSafeAreaInsets();                          // schedules a deferred refresh FOR A

    const fresh = document.createElement('div');
    fresh.style.setProperty('--ui-sa-top', '44px');
    document.body.appendChild(fresh);
    measureSafeAreaInsets(fresh);                 // root B registers BEFORE A's refresh flushes —
    // arms B's own budget fresh, and makes A's still-queued callback stale.

    await flushRaf();                              // A's callback fires now, finds root !== target, bails

    // B's budget must be completely UNTOUCHED by A's bailed callback — drain it and count the
    // probes: under the current (correct) placement this is the full budget; under the mutation
    // it is one short, because A's bail silently spent one of B's.
    const spentAfterBail = await drainPollBudget(fresh);

    // Compared against a CONTROL rather than against a literal `20`. Hardcoding the budget here
    // would re-introduce the very shadowing constant `drainPollBudget`'s own doc was rewritten to
    // remove — and this assertion needs a one-probe difference, so it cannot be loosened into an
    // inequality either. A third root registered with nothing stale in flight re-arms the same
    // module-level budget and drains it cleanly, so its count IS "a full budget" whatever
    // `POLL_REFRESH_BUDGET` is set to.
    const control = document.createElement('div');
    control.style.setProperty('--ui-sa-top', '55px');
    document.body.appendChild(control);
    measureSafeAreaInsets(control);
    const spentClean = await drainPollBudget(control);

    expect(spentAfterBail, "B's full budget must be intact — A's bailed callback must not have spent any of it")
      .toBe(spentClean);
    root.remove();
    fresh.remove();
    control.remove();
  });

  /**
   * The decrement must happen BEFORE `applyMeasurement`, not after it (found in review, #600) —
   * nothing above pins this either, because nothing above makes a measurement THROW.
   * `getComputedStyle` is not guaranteed exception-free (a detached/exotic node can throw in some
   * environments), and `applyMeasurement` appends its probe and calls `getComputedStyle` inside a
   * `try { … } finally { probe.remove(); }` with no `catch` — an exception there propagates out of
   * the deferred rAF callback. A real browser does not let one rAF callback's exception stop the
   * NEXT frame's callback from running (the spec reports it to the global error handler and
   * continues); the fake `requestAnimationFrame` below is overridden LOCALLY, for this test only,
   * to match that contract — so this test can observe "did the poll stay bounded", not "did the
   * whole suite crash on the first throw".
   *
   * ⚠️ Under the "decrement AFTER `applyMeasurement`" mutation, the throw aborts the callback
   * before that later statement ever runs, so `refreshesLeft` never drops and the poll retries
   * every 250ms FOREVER — exactly the unbounded forced-layout cost #592 exists to stop, now
   * reintroduced for any device/browser where the measurement itself can throw.
   */
  it('a throwing measurement still spends budget, so the poll stays bounded', async () => {
    setManualNow(0);
    root.style.setProperty('--ui-sa-top', '68px');
    measureSafeAreaInsets(root);                  // arms the budget at POLL_REFRESH_BUDGET (20)

    let appends = 0;
    const originalAppend = root.appendChild.bind(root);
    root.appendChild = ((node: Node) => { appends += 1; return originalAppend(node); }) as typeof root.appendChild;

    const originalGetComputedStyle = globalThis.getComputedStyle;
    (globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle =
      () => { throw new Error('simulated getComputedStyle failure'); };
    // Match a real browser's rAF contract (see this test's own doc): one callback throwing must
    // not stop the next frame's callback from running, so this loop can keep driving reads.
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame = (cb) => setTimeout(() => {
        try { cb(0); } catch { /* swallowed here, the way a browser's own rAF driver would */ }
      }, 0) as unknown as number;

    try {
      // Far more per-frame reads than the budget allows.
      for (let i = 0; i < 30; i += 1) {
        advanceManual(300);
        getSafeAreaInsets();
        await flushRaf();
      }
    } finally {
      root.appendChild = originalAppend;
      globalThis.getComputedStyle = originalGetComputedStyle;
    }

    // Compared against a CONTROL drain rather than a literal `20`, for the same reason as the
    // stale-identity test above: a hardcoded budget here is the shadowing constant this file
    // already fixed once. A fresh root whose measurements SUCCEED spends its budget normally, so
    // its probe count is what "bounded to the budget" means at whatever `POLL_REFRESH_BUDGET`
    // currently is — and the throwing run above must match it exactly. Under the mutation the
    // throwing run instead probes once per iteration (30), never spending anything.
    const control = document.createElement('div');
    control.style.setProperty('--ui-sa-top', '55px');
    document.body.appendChild(control);
    measureSafeAreaInsets(control);
    const spentClean = await drainPollBudget(control);
    control.remove();

    expect(appends, 'bounded to the budget even though every measurement threw').toBe(spentClean);
  });
});
