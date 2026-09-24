/** In-page driver for the gameplay recorder's REPLAY (#1479) — `window.__modokiCapture`.
 *
 *  The CLI renderer (`engine/scripts/record-take.mjs`) loads the game route in a headless Chromium
 *  with `?capture=1`, and this module takes the frame cadence away from the browser: the rAF loop
 *  is HELD (it still fires, so the watchdog sees a live chain, but runs nothing), the clock is
 *  swapped for the manual one, and each `step()` advances it by exactly one video frame and runs
 *  every frame callback once — sim, then 3D, then 2D. The renderer screenshots between steps.
 *
 *  Why a fixed step rather than recording in real time: a real-time capture drops frames whenever a
 *  screenshot is slow, and its sim time depends on the machine. Here a frame takes as long as it
 *  takes, and the video still has exactly `fps` frames per sim second.
 *
 *  Editor-scoped, like the agent bridge: stripped from a shipped game build. */

import {
  setFrameLoopHeld, stepOneFrame, setManualNow, advanceManual, restoreRealClock, rawNow,
  resetTimeBaseline, pinFreshWorldSeed, seedRng, setCaptureMode, getCurrentWorld, getTime, takeClockDelta, isNextSceneLoading,
  TakeJournalTap, isTimeHeldForLoading, sceneManager,
} from '@modoki/engine/runtime';

export interface CaptureState {
  /** Real ms spent waiting for the page to settle so far — see `settle`. */
  settleMs: number;
  /** Steps that went ahead unsettled after the timeout. */
  unsettled: number;
  /** Frames stepped since the capture began. */
  steps: number;
  /** The TAKE clock: sim seconds summed frame by frame since the capture began — see `Session.takeTime`. */
  takeTime: number;
  /** The current world's own frame counter (the journal tick) — resets on every scene load. */
  frame: number;
  /** True while the boot overlay still holds time at zero — the game is not on screen yet. */
  loading: boolean;
  /** The primary scene's path, so the renderer can check the take's scene is the one that loaded. */
  scene: string | null;
  /** The game is on screen and time moves: the next step is the take's first timed frame. */
  ready: boolean;
}

/** One journal event, with the step that emitted it — the renderer turns steps into video frames. */
export interface CapturedEvent { step: number; takeTime: number; tick: number; type: string; payload: unknown }

interface FetchCounter { inFlight: number; restore: () => void }

interface Session {
  dtMs: number;
  seed: number;
  steps: number;
  /** The take clock: `takeClockDelta(sample)` summed after every step — the function the editor recorder
   *  sums too, which is what makes a take's stamps and this clock one axis (see `core/takeClock.ts`
   *  for why it is summed, unscaled, and 0 while the loading hold is up). */
  takeTime: number;
  /** The seed goes in again the moment time first moves — see `stepCapture`. */
  seededAtStart: boolean;
  settleMs: number;
  /** Each time the settle gate GAVE UP: the step it happened at and what was still pending. One
   *  entry per give-up, not per frame — every frame from that step on may lack that content. Boot
   *  steps included: work stuck from boot is the case that most needs reporting. */
  unsettled: { step: number; pending: string[] }[];
  settleTimeoutMs: number;
  /** What the settle gate already gave up on, per kind of work. See `settle`. */
  gaveUpOn: PendingWork | null;
  fetches: FetchCounter;
  /** Journal events drained after every step, by the tap the editor recorder uses too
   *  (`runtime/core/takeJournal.ts` says why per world, and why keyed on `cap`). */
  events: CapturedEvent[];
  journal: TakeJournalTap;
}

let session: Session | null = null;

/** Default longest real wait for the page to settle before a step goes ahead anyway. A fetch that
 *  never returns must not hang a render; the step is recorded as unsettled instead. */
const SETTLE_TIMEOUT_MS = 20_000;

// ── Settling ─────────────────────────────────────────────────────────────────────────────────────
// A fixed-dt replay stops the SIM clock, not the page: a Pixi Application init, a texture fetch, a
// font load all still complete in REAL time. Stepping without waiting for them captures frames that
// are missing whatever had not arrived yet — measured on Court in headless Chromium, the board's
// Pixi surface came up ~0.5 s of real time after boot, so the first 15 frames of every take had no
// board. So each step first waits, in real time, until nothing the frame could depend on is still
// in flight. Sim time does not move while it waits, so content that took a second to load arrives
// "instantly" on the video's clock.

/** Count in-flight `fetch`es from the moment the capture begins. The count is per install, so a
 *  fetch that settles after the capture ended cannot drive the NEXT capture's count negative. */
function trackFetches(): FetchCounter {
  const original = window.fetch;
  const bound = original.bind(window);
  const counter: FetchCounter = { inFlight: 0, restore: () => { window.fetch = original; } };
  window.fetch = (...args: Parameters<typeof fetch>) => {
    counter.inFlight++;
    return bound(...args).finally(() => { counter.inFlight--; });
  };
  return counter;
}

/** What a frame captured right now could still be missing, counted per kind — empty when the page
 *  is settled. Blind spots: a fetch made inside a worker, and an `Image` not in the document. */
type PendingWork = Partial<Record<'fetch' | '2D surface init' | 'image' | 'fonts' | 'scene load', number>>;

function pendingWork(fetches: FetchCounter): PendingWork {
  const pending: PendingWork = {};
  if (fetches.inFlight > 0) pending.fetch = fetches.inFlight;
  // The 2D pool's debug handle, not an import: pulling the pool in here would bundle Pixi into a
  // project that has no 2D layer at all. A project without one simply has no handle.
  const pool = (window as unknown as { __2d?: { pool?: { pendingInits?: () => number } } }).__2d?.pool;
  const inits = pool?.pendingInits?.() ?? 0;
  if (inits > 0) pending['2D surface init'] = inits;
  const images = [...document.images].filter((img) => img.src && !img.complete).length;
  if (images > 0) pending.image = images;
  if (document.fonts && document.fonts.status !== 'loaded') pending.fonts = 1;
  // A scene load in flight: its fetches, shader prewarm and WASM are real-time work the fetch count
  // cannot all see. Waiting it out makes a mid-take load take the SAME (zero) take time on every
  // render, instead of however many frames this machine happened to step through it.
  if (sceneManager.getNext()) pending['scene load'] = 1;
  return pending;
}

const describePending = (p: PendingWork): string[] => Object.entries(p).map(([kind, n]) => `${n} ${kind}`);

/** Is everything in `pending` already covered by what the gate gave up on — the same kinds, no more
 *  of each? A stuck set that SHRINKS stays covered; a new kind, or more of one, is new work. */
function coveredBy(pending: PendingWork, gaveUp: PendingWork | null): boolean {
  if (!gaveUp) return false;
  return (Object.entries(pending) as [keyof PendingWork, number][]).every(([kind, n]) => n <= (gaveUp[kind] ?? 0));
}

/** Wait until the page settles or the timeout passes. Resolves with what the step is going ahead
 *  WITHOUT — only when this call newly gave up on it, so a stuck item is reported once, not on
 *  every later frame.
 *
 *  ⚠️ Gives up on stuck work ONCE. A Pixi init that rejected stays uninitialised in the pool
 *  forever, and a fetch that never settles never leaves the count — without the latch every later
 *  step would wait the full timeout again (a 1,400-frame take: ~8 hours). Once given up, that work
 *  (or any part of it) no longer blocks; anything new does, and a fully settled page clears the
 *  latch. Known limit: counts, not identities — a stuck fetch finishing as a new one starts reads as
 *  the same "1 fetch", and a latched `fonts` is never awaited again. */
async function settle(s: Session): Promise<string[]> {
  const deadline = performance.now() + s.settleTimeoutMs;
  for (;;) {
    const pending = pendingWork(s.fetches);
    const empty = Object.keys(pending).length === 0;
    if (empty) s.gaveUpOn = null;
    const timedOut = !empty && performance.now() > deadline;
    if (empty || coveredBy(pending, s.gaveUpOn) || timedOut) {
      if (timedOut) s.gaveUpOn = pending;
      // One more macrotask either way, so a `.then` queued by whatever just finished (Canvas2DMount
      // appends its canvas in one) has run before the frame is drawn.
      await new Promise((r) => setTimeout(r, 0));
      // …and look again after it, because that macrotask can START work — a continuation calling
      // `loadScene` is the one that matters (#1486): gone ahead with unseen, the step's frame begins
      // mid-load, adds zero take time, and the fixed `frameCountFor` budget drops the take's last dt
      // of input with nothing in `unsettled`. Returning synchronously after this check means nothing
      // can run between it and the step's own sample.
      if (!timedOut) {
        const after = pendingWork(s.fetches);
        if (Object.keys(after).length && !coveredBy(after, s.gaveUpOn)) continue;
      }
      return timedOut ? describePending(pending) : [];
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Take every kept journal event since the last drain, stamped with the step that emitted it. */
function drainJournal(s: Session, step: number): void {
  for (const e of s.journal.drain(getCurrentWorld())) s.events.push({ step, takeTime: s.takeTime, ...e });
}

function readState(): CaptureState {
  const time = getTime(getCurrentWorld());
  return {
    settleMs: Math.round(session?.settleMs ?? 0),
    unsettled: session?.unsettled.length ?? 0,
    steps: session?.steps ?? 0,
    takeTime: session?.takeTime ?? 0,
    frame: time?.frame ?? 0,
    loading: isTimeHeldForLoading(),
    scene: sceneManager.getCurrent()?.path ?? null,
    ready: isGameOnScreen(),
  };
}

/** Take the frame cadence. Called at boot when the URL asks for a capture. */
export function beginCapture(opts: { dtMs: number; seed: number; settleTimeoutMs?: number }): CaptureState {
  if (session) throw new Error('capture already running');
  if (!(opts.dtMs > 0)) throw new Error(`dtMs must be > 0 (got ${opts.dtMs})`);
  pinFreshWorldSeed(opts.seed);
  setCaptureMode('rendering');
  setFrameLoopHeld(true);
  // Freeze the clock where real time is NOW, then re-baseline so the first step yields exactly one
  // dt — not the gap since the last real frame.
  setManualNow(rawNow());
  resetTimeBaseline();
  session = {
    dtMs: opts.dtMs, seed: opts.seed, steps: 0, takeTime: 0, seededAtStart: false,
    settleMs: 0, unsettled: [], settleTimeoutMs: opts.settleTimeoutMs ?? SETTLE_TIMEOUT_MS, gaveUpOn: null,
    fetches: trackFetches(), events: [], journal: new TakeJournalTap(),
  };
  return readState();
}

/** The game's scene is loaded and the loading hold has let go — time moves from the next frame.
 *  The scene check matters: the driver starts before GameShell takes the hold, and in that gap
 *  "not held" means "not loaded yet", not "on screen". */
function isGameOnScreen(): boolean {
  return !isTimeHeldForLoading() && sceneManager.getCurrent() !== null;
}

/** One BOOT step: settle, then step only if the game is still not on screen. Returns without
 *  stepping once it is — so the first timed frame is always the take's first frame, never spent as
 *  a boot step.
 *
 *  ⚠️ The check has to come AFTER the settle, in the same synchronous run as the step. GameShell
 *  releases the hold from a raw `requestAnimationFrame` wait, which keeps firing while the frame
 *  loop is held — so it can land during the settle's await, and a check made before it (the CLI
 *  reading `state()` first) would step straight through the release. */
export async function bootStepCapture(): Promise<CaptureState> {
  const s = session;
  if (!s) throw new Error('no capture running');
  const gaveUpOn = await settle(s);
  if (session !== s) throw new Error('capture ended during a step');
  // Recorded even though no frame is drawn here: a give-up during boot latches, so every later
  // step treats that work as covered and reports nothing — this entry is the only trace of it.
  if (gaveUpOn.length) s.unsettled.push({ step: s.steps, pending: gaveUpOn });
  if (!isGameOnScreen()) advanceOne(s);
  return readState();
}

/** Advance exactly one dt and run every frame callback once. SYNCHRONOUS on purpose: whatever the
 *  caller checked just before calling it still holds when the frame runs. */
function advanceOne(s: Session): void {
  // The editor seeds the world at the Play press, right before its first timed frame; this is the
  // same instant here — the first frame the loading hold lets time move in. The boot pin alone is
  // not enough: systems run at dt 0 while the hold is up, and a system that draws every frame would
  // shift the stream by however many held frames this machine happened to take.
  if (!s.seededAtStart && isGameOnScreen()) {
    seedRng(s.seed, getCurrentWorld());
    s.seededAtStart = true;
  }
  // Sampled before the frame, as the editor recorder samples it: the frame that STARTS a load is a
  // timed frame on both halves (`core/takeClock.ts` says why).
  const loadInFlightAtStart = isNextSceneLoading();
  advanceManual(s.dtMs);
  stepOneFrame();
  s.takeTime += takeClockDelta(loadInFlightAtStart);
  drainJournal(s, s.steps);
  s.steps++;
}

/** Advance `n` frames of exactly one dt each, each one only once the page has settled. */
export async function stepCapture(n = 1): Promise<CaptureState> {
  const s = session;
  if (!s) throw new Error('no capture running');
  for (let i = 0; i < n; i++) {
    const waitStart = performance.now();
    const gaveUpOn = await settle(s);
    if (session !== s) throw new Error('capture ended during a step');
    s.settleMs += performance.now() - waitStart;
    if (gaveUpOn.length) s.unsettled.push({ step: s.steps, pending: gaveUpOn });
    advanceOne(s);
  }
  return readState();
}

/** Give the cadence back to the browser. */
export function endCapture(): void {
  const s = session;
  if (!s) return;
  session = null;
  s.fetches.restore();
  restoreRealClock();
  resetTimeBaseline();
  setFrameLoopHeld(false);
  setCaptureMode('off');
  pinFreshWorldSeed(null);
}

/** Read `?capture=1&dt=<ms>&seed=<n>` and start a capture if asked. */
export function initCaptureDriver(search: string = window.location.search): void {
  const q = new URLSearchParams(search);
  (window as unknown as { __modokiCapture: unknown }).__modokiCapture = {
    begin: beginCapture, step: stepCapture, bootStep: bootStepCapture, end: endCapture, state: readState,
    events: () => session?.events ?? [],
    unsettled: () => session?.unsettled ?? [],
    /** What the settle gate is currently NOT waiting for, having given up on it. */
    givenUp: () => (session?.gaveUpOn ? describePending(session.gaveUpOn) : []),
  };
  if (q.get('capture') !== '1') return;
  beginCapture({ dtMs: Number(q.get('dt') ?? 1000 / 30), seed: Number(q.get('seed') ?? 1) });
}
