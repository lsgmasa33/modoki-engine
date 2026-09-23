/**
 * #1455 — a fullscreen ad holds the engine's audio, and the release checks the clock.
 *
 * Measured on the iPhone Air (2026-09-23): after an interstitial the shared context reported
 * `running` while its clock never advanced again, and our music had been playing UNDER the ad the
 * whole time. Mechanisms pinned here, each separately:
 *  1. hold pauses a playing stream WITHOUT marking it deliberately paused, and suspends the context;
 *  2. while held, `resume()` (a tap, a foreground edge) and a WebKit `statechange` stand down;
 *  3. release resumes the context and re-kicks the stream;
 *  4. release samples the clock; a frozen one is traced, retried once (suspend→resume), re-sampled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeNode() {
  return { gain: { value: 1 }, connect() { /* noop */ }, disconnect() { /* noop */ } };
}

let ctxInstance: FakeAudioContext;
let elements: FakeAudio[];

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  listener = {};
  resumeCalls = 0;
  suspendCalls = 0;
  bufferStarts = 0;
  /** When set, `suspend()` settles only when this does — the window a fast release lands in. */
  suspendGate: Promise<void> | null = null;
  /** When true, `resume()` rejects like WebKit's "Failed to start the audio device". */
  failResume = false;
  /** When set, `resume()` settles only when this does — a tap's resume still in flight. */
  resumeGate: Promise<void> | null = null;
  listeners: Record<string, Array<() => void>> = {};
  createGain() { return fakeNode(); }
  createMediaElementSource() { return fakeNode(); }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  /** A real context runs its resume/suspend control messages IN ORDER: a suspend issued while a
   *  resume is pending lands after it. Modelled, because F1's fix depends on exactly that. */
  private ops: Promise<unknown> = Promise.resolve();
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.failResume) return Promise.reject(new Error('InvalidStateError: Failed to start the audio device'));
    const gate = this.resumeGate;
    const p = this.ops.then(() => gate).then(() => { this.state = 'running'; });
    this.ops = p.catch(() => {});
    return p;
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    const gate = this.suspendGate;
    const p = this.ops.then(() => gate).then(() => { this.state = 'suspended'; });
    this.ops = p.catch(() => {});
    return p;
  }
  createBufferSource() {
    return {
      buffer: null as unknown, loop: false, playbackRate: { value: 1 }, onended: null as unknown,
      connect() { /* noop */ }, disconnect() { /* noop */ },
      start: () => { this.bufferStarts++; }, stop() { /* noop */ },
    };
  }
  close(): Promise<void> { return Promise.resolve(); }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

class FakeAudio {
  paused = true;
  loop = false;
  playbackRate = 1;
  crossOrigin = '';
  currentTime = 0;
  onended: (() => void) | null = null;
  src: string;
  playCalls = 0;
  constructor(src: string) { this.src = src; elements.push(this); }
  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
}

let audioService: typeof import('../../packages/modoki/src/runtime/audio/audioService');
let health: typeof import('../../packages/modoki/src/runtime/audio/audioHealth');
const g = globalThis as unknown as { AudioContext?: unknown; Audio?: unknown };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  elements = [];
  g.AudioContext = function RecordingAudioContext() { ctxInstance = new FakeAudioContext(); return ctxInstance; };
  g.Audio = FakeAudio;
  vi.resetModules();
  audioService = await import('../../packages/modoki/src/runtime/audio/audioService');
  health = await import('../../packages/modoki/src/runtime/audio/audioHealth');
  audioService.setAudioRecordMode(false);
  health.clearAudioHealthTrace();
});

afterEach(() => {
  audioService.holdForFullscreenAd(false);
  audioService.dispose();
  delete g.AudioContext;
  delete g.Audio;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startBed(): Promise<FakeAudio> {
  audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });
  await Promise.resolve();
  const el = elements[0];
  expect(el.paused).toBe(false);
  return el;
}

const kinds = () => health.getAudioHealthTrace().map((e) => e.kind);
const clockChecks = () => health.getAudioHealthTrace().filter((e) => e.kind === 'clock-check');

describe('holdForFullscreenAd (#1455)', () => {
  it('hold pauses the bed and suspends the context; release resumes both', async () => {
    const el = await startBed();
    audioService.holdForFullscreenAd(true);
    expect(el.paused).toBe(true);
    expect(ctxInstance.suspendCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.state).toBe('suspended');

    const playsBefore = el.playCalls;
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.resumeCalls).toBe(1);
    expect(ctxInstance.state).toBe('running');
    expect(el.playCalls, 'the release re-kicks the paused bed').toBeGreaterThan(playsBefore);
    expect(el.paused).toBe(false);
    expect(kinds()).toEqual(expect.arrayContaining(['ad-hold', 'ad-release']));
  });

  it('while held, a tap/foreground resume() and a WebKit statechange do NOT bring the audio back', async () => {
    const el = await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    const playsHeld = el.playCalls;

    audioService.resume();
    ctxInstance.state = 'running';          // WebKit bringing it back on its own…
    ctxInstance.fire('statechange');        // …must not restart the bed under the ad
    await vi.advanceTimersByTimeAsync(0);

    expect(ctxInstance.resumeCalls).toBe(0);
    expect(el.playCalls).toBe(playsHeld);
    expect(el.paused).toBe(true);
    const resumes = health.getAudioHealthTrace().filter((e) => e.kind === 'resume');
    expect(resumes.at(-1)?.outcome).toBe('skipped-held');
  });

  it('release samples the clock: a clock that advances is recorded once, with no retry', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(300);   // settle → first sample
    ctxInstance.currentTime += 0.7;           // the clock runs across the window
    await vi.advanceTimersByTimeAsync(700);
    const checks = clockChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0].advanced).toBeCloseTo(0.7);
    expect(checks[0].retried).toBe(false);
    expect(ctxInstance.suspendCalls, 'no retry for a healthy clock').toBe(1);
  });

  it('a FROZEN clock after release is traced, retried once with suspend→resume, and re-sampled', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(1000);  // running, but currentTime never moves
    expect(clockChecks()[0]).toMatchObject({ advanced: 0, retried: false });
    expect(ctxInstance.suspendCalls, 'the hold + the retry').toBe(2);
    expect(ctxInstance.resumeCalls, 'the release + the retry').toBe(2);

    await vi.advanceTimersByTimeAsync(1000);  // the retry's own sample — still frozen
    expect(clockChecks()).toHaveLength(2);
    expect(clockChecks()[1]).toMatchObject({ advanced: 0, retried: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(clockChecks(), 'one retry, not a loop').toHaveLength(2);
    expect(ctxInstance.suspendCalls).toBe(2);
  });

  it('a new ad before the check runs cancels it — nothing sampled against a held context', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(100);
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clockChecks()).toHaveLength(0);
  });

  it('back-to-back ads leave ONE clock check, not a stale one from the first release as well', async () => {
    // The stale chain is what the cancel on hold exists for: the in-callback "held?" guard alone
    // cannot stop it once the second release has cleared the hold again.
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(100);
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(100);
    audioService.holdForFullscreenAd(false);
    for (let i = 0; i < 20; i++) {           // a running clock, so no retry muddies the count
      ctxInstance.currentTime += 0.1;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(clockChecks()).toHaveLength(1);
  });

  it('a release landing BEFORE the hold\'s suspend settles still resumes — never left suspended in silence', async () => {
    await startBed();
    let open!: () => void;
    ctxInstance.suspendGate = new Promise<void>((r) => { open = r; });
    audioService.holdForFullscreenAd(true);
    audioService.holdForFullscreenAd(false);   // e.g. the SDK refused the show within a round-trip
    expect(ctxInstance.state, 'the suspend has not landed yet').toBe('running');
    open();
    ctxInstance.suspendGate = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.resumeCalls).toBe(1);
    expect(ctxInstance.state).toBe('running');
  });

  it('a stream started, or un-paused by the game, DURING the hold stays paused and starts on release', async () => {
    const bed = await startBed();
    const handle = audioService.play({ clip: 'b2', url: 'b2.m4a', bus: 'music', loop: true });
    await Promise.resolve();
    handle.pause();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    const late = audioService.play({ clip: 'b3', url: 'b3.m4a', bus: 'music', loop: true });
    handle.resume();                            // the game un-pausing under the ad
    await vi.advanceTimersByTimeAsync(0);
    const lateEl = elements[2];
    expect(lateEl.playCalls, 'not started under the ad').toBe(0);
    expect(elements[1].paused, 'not un-paused under the ad').toBe(true);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateEl.paused).toBe(false);
    expect(elements[1].paused).toBe(false);
    expect(bed.paused).toBe(false);
    late.stop();
  });

  it('a REJECTED resume after release (context left suspended) is still clock-checked and retried once', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    ctxInstance.failResume = true;
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clockChecks()[0]).toMatchObject({ state: 'suspended', advanced: 0, retried: false });
    expect(ctxInstance.resumeCalls, 'the release + the retry').toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clockChecks()).toHaveLength(2);
    expect(clockChecks()[1]).toMatchObject({ state: 'suspended', retried: true });
  });

  it('a new ad mid-retry: the retry does not bring the context up under it, nor schedule another check', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    let open!: () => void;
    await vi.advanceTimersByTimeAsync(999);
    ctxInstance.suspendGate = new Promise<void>((r) => { open = r; });
    await vi.advanceTimersByTimeAsync(1);       // frozen → the retry's suspend is now in flight
    expect(clockChecks()).toHaveLength(1);
    const resumesBefore = ctxInstance.resumeCalls;
    audioService.holdForFullscreenAd(true);     // a second ad goes up mid-retry
    open();
    ctxInstance.suspendGate = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctxInstance.resumeCalls, 'no resume under the new ad').toBe(resumesBefore);
    expect(clockChecks(), 'no check scheduled by the orphaned retry').toHaveLength(1);
  });

  it('a whole second ad inside the retry window leaves ONE live check chain, not the orphaned retry\'s as well', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    let open!: () => void;
    await vi.advanceTimersByTimeAsync(999);
    ctxInstance.suspendGate = new Promise<void>((r) => { open = r; });
    await vi.advanceTimersByTimeAsync(1);       // frozen → the retry's suspend is in flight
    audioService.holdForFullscreenAd(true);     // a second ad goes up…
    audioService.holdForFullscreenAd(false);    // …and comes down before the retry settles
    open();
    ctxInstance.suspendGate = null;
    await vi.advanceTimersByTimeAsync(1000);    // the new release's own first check
    // Old chain: 1 entry. New release: 1 entry (frozen, retried:false). An orphaned retry would
    // have added a retried:true entry here as well.
    expect(clockChecks().map((c) => c.retried)).toEqual([false, false]);
  });

  it('a hold landing while a RESUME is still in flight still suspends — the resume cannot land under the ad', async () => {
    await startBed();
    ctxInstance.state = 'suspended';          // e.g. after a background, before the tap's resume settles
    let open!: () => void;
    ctxInstance.resumeGate = new Promise<void>((r) => { open = r; });
    audioService.resume();                    // the tap on "watch ad"
    expect(ctxInstance.state, 'the resume has not landed yet').toBe('suspended');
    audioService.holdForFullscreenAd(true);   // the show's first native call
    open();
    ctxInstance.resumeGate = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.suspendCalls, 'suspended despite reading "suspended" at hold time').toBe(1);
    expect(ctxInstance.state).toBe('suspended');
  });

  it('a dispose between release and the hold\'s suspend landing cancels the deferred resume', async () => {
    await startBed();
    let open!: () => void;
    ctxInstance.suspendGate = new Promise<void>((r) => { open = r; });
    audioService.holdForFullscreenAd(true);
    audioService.holdForFullscreenAd(false);
    audioService.dispose();                   // realm shutdown: ads.cleanup() then audioDispose()
    open();
    ctxInstance.suspendGate = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctxInstance.resumeCalls).toBe(0);
  });

  it('no clock check (and no false "frozen" warning) for a context that was not running when the ad took it', async () => {
    await startBed();
    ctxInstance.state = 'suspended';          // never gesture-unlocked, e.g. an app-open ad
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    ctxInstance.failResume = true;            // autoplay gating still refuses it
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(clockChecks()).toHaveLength(0);
  });

  it('a SLOW hold-suspend does not eat the clock window: the check starts after the resume, and reads healthy', async () => {
    await startBed();
    let open!: () => void;
    ctxInstance.suspendGate = new Promise<void>((r) => { open = r; });
    audioService.holdForFullscreenAd(true);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(1500);  // the suspend has still not landed; nothing advances
    open();
    ctxInstance.suspendGate = null;
    await vi.advanceTimersByTimeAsync(0);     // suspend lands, then the chained resume
    for (let i = 0; i < 10; i++) {            // a healthy clock from here on
      ctxInstance.currentTime += 0.1;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(clockChecks()).toHaveLength(1);
    expect(clockChecks()[0].retried).toBe(false);
    expect(clockChecks()[0].advanced).toBeGreaterThan(0.05);
  });

  it('a release long after the hold\'s suspend landed resumes at once — a dispose in the same tick cannot swallow it', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(30_000);   // the suspend landed long ago
    audioService.holdForFullscreenAd(false);
    audioService.dispose();                      // ads.cleanup() then audioDispose(), one tick
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.resumeCalls).toBe(1);
  });

  it('back-to-back ads: ad 2 holding while ad 1\'s resume is in flight still gets its clock check', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    let open!: () => void;
    ctxInstance.resumeGate = new Promise<void>((r) => { open = r; });
    audioService.holdForFullscreenAd(false);     // ad 1 down; its resume is pending
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxInstance.state).toBe('suspended');
    audioService.holdForFullscreenAd(true);      // ad 2 up inside that window
    open();
    ctxInstance.resumeGate = null;
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);     // ad 2 down
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) { ctxInstance.currentTime += 0.1; await vi.advanceTimersByTimeAsync(100); }
    expect(clockChecks()).toHaveLength(1);
  });

  it('a non-loop BUFFER play() under the hold still starts — only the cue bus drops one-shots', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.play({ clip: 'src', buffer: {} as AudioBuffer, bus: 'sfx' });
    expect(ctxInstance.bufferStarts).toBe(1);
  });
});

describe('dead-audio detection after a FOREGROUND (#1455)', () => {
  const deadEntries = () => health.getAudioHealthTrace().filter((e) => e.kind === 'audio-dead');

  it('a context running at hide, frozen after the foreground resume and after the retry, is declared dead once', async () => {
    await startBed();
    const dead = vi.fn();
    const off = audioService.onAudioDead(dead);
    audioService.noteBackground();
    ctxInstance.state = 'interrupted';           // what the OS leaves
    audioService.noteForeground(20_000);
    audioService.resume();                       // the rearm's resume, right after
    await vi.advanceTimersByTimeAsync(1000);     // first sample: frozen → retry
    expect(clockChecks()[0]).toMatchObject({ after: 'foreground', retried: false, advanced: 0 });
    await vi.advanceTimersByTimeAsync(1000);     // retry's sample: still frozen → dead
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledWith('foreground');
    expect(deadEntries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dead).toHaveBeenCalledTimes(1);
    off();
  });

  it('a healthy foreground (clock advances) is checked once and NOT declared dead', async () => {
    await startBed();
    const dead = vi.fn();
    const off = audioService.onAudioDead(dead);
    audioService.noteBackground();
    audioService.noteForeground(20_000);
    for (let i = 0; i < 20; i++) { ctxInstance.currentTime += 0.1; await vi.advanceTimersByTimeAsync(100); }
    expect(clockChecks()).toHaveLength(1);
    expect(dead).not.toHaveBeenCalled();
    off();
  });

  it('no check when the context was NOT running at hide (never unlocked) — no false death', async () => {
    await startBed();
    ctxInstance.state = 'suspended';
    const dead = vi.fn();
    const off = audioService.onAudioDead(dead);
    audioService.noteBackground();
    audioService.noteForeground(20_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clockChecks()).toHaveLength(0);
    expect(dead).not.toHaveBeenCalled();
    off();
  });

  it('a hide caused by an AD is the ad\'s to check, not the foreground\'s', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    audioService.noteBackground();               // the ad view hides the page before the suspend lands
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);     // the ad closes…
    audioService.noteForeground(5_000);          // …then the page comes back
    for (let i = 0; i < 20; i++) { ctxInstance.currentTime += 0.1; await vi.advanceTimersByTimeAsync(100); }
    expect(clockChecks().map((c) => c.after)).toEqual(['ad']);
  });

  it('a frozen clock after an AD release is declared dead too, as after: "ad"', async () => {
    await startBed();
    const dead = vi.fn();
    const off = audioService.onAudioDead(dead);
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(dead).toHaveBeenCalledWith('ad');
    off();
  });

  it('a context still NOT running after the retry (a live call, Siri) is traced but NOT declared dead — a reload cannot help it', async () => {
    await startBed();
    const dead = vi.fn();
    const off = audioService.onAudioDead(dead);
    audioService.noteBackground();
    ctxInstance.state = 'interrupted';
    ctxInstance.failResume = true;
    audioService.noteForeground(20_000);
    audioService.resume();
    await vi.advanceTimersByTimeAsync(3000);
    expect(clockChecks().map((c) => c.state)).toEqual(['interrupted', 'interrupted']);
    expect(dead).not.toHaveBeenCalled();
    expect(deadEntries()).toHaveLength(0);
    off();
  });

  it('the background is traced with the state the foreground check will key on', async () => {
    await startBed();
    audioService.noteBackground();
    const bg = health.getAudioHealthTrace().filter((e) => e.kind === 'background');
    expect(bg).toHaveLength(1);
    expect(bg[0].state).toBe('running');
  });

  it('a release + dispose in one tick (realm shutdown) leaves no stale flag to check the NEXT, never-running ad', async () => {
    await startBed();
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);     // sets the release-in-flight flag…
    audioService.dispose();                      // …and the check that would clear it is cancelled
    await vi.advanceTimersByTimeAsync(0);
    audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });   // realm survived; graph rebuilds
    ctxInstance.state = 'suspended';             // never unlocked this time
    ctxInstance.failResume = true;
    audioService.holdForFullscreenAd(true);
    await vi.advanceTimersByTimeAsync(0);
    audioService.holdForFullscreenAd(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(clockChecks()).toHaveLength(0);
  });

  it('isAudioStillDead: true for running + frozen, false once the clock moves, false when not running', async () => {
    await startBed();
    const frozen = audioService.isAudioStillDead(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await frozen).toBe(true);
    const moving = audioService.isAudioStillDead(500);
    ctxInstance.currentTime += 0.5;
    await vi.advanceTimersByTimeAsync(500);
    expect(await moving).toBe(false);
    ctxInstance.state = 'suspended';
    expect(await audioService.isAudioStillDead(500)).toBe(false);
  });
});

