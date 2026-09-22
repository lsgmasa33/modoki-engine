/** #1455: the audio path must record WHY a music bed went silent.
 *
 *  The owner reported Weaveling losing its music after a long background and could give no repro
 *  steps — correctly, because the app recorded nothing: not `ctx.state`, not whether a resume was
 *  attempted, not how long it had been away. A REJECTED resume was swallowed by a bare
 *  `catch {}`, which is the single line that made this class undiagnosable from a report.
 *
 *  These pin the trace, not the recovery. The recovery is #1428's and is unchanged — a test here
 *  that went red by changing what `resume()` DOES would be testing the wrong thing.
 *
 *  Harness deliberately mirrors `audioResumeInterrupted.test.ts` (#1428): a fake `AudioContext`
 *  whose `state` is writable, so the iOS-only `'interrupted'` state — which no headless runtime
 *  produces — can be driven directly. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeNode() {
  return { gain: { value: 1 }, connect() { /* noop */ }, disconnect() { /* noop */ } };
}

let ctxInstance: FakeAudioContext;
let elements: FakeAudio[];
/** What `resume()` does when called. `'ok'` resolves to running; `'reject'` models WebKit refusing
 *  a resume outside a user gesture — the outcome that used to vanish into the bare catch. */
let resumeBehaviour: 'ok' | 'reject' = 'ok';
/** Force every element `play()` to reject, INDEPENDENTLY of `ctx.state`.
 *
 *  ⚠️ Load-bearing, and its absence made a test pass for the wrong reason (caught by the mutation
 *  check in this change's close-out). Driving a refusal by setting `ctx.state = 'interrupted'`
 *  does not survive a `resume()`: the fake's `resume()` sets the state back to `running`, so a
 *  loop of ten re-kicks refused on the first and SUCCEEDED on the other nine. The test asserting
 *  "one entry per episode, not one per tap" therefore stayed green with the per-episode guard
 *  deleted — it had never seen a second refusal to suppress. */
let refusePlay = false;

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  listener = {};
  listeners: Record<string, Array<() => void>> = {};
  createGain() { return fakeNode(); }
  createMediaElementSource() { return fakeNode(); }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  resume(): Promise<void> {
    if (resumeBehaviour === 'reject') return Promise.reject(new Error('NotAllowedError'));
    return Promise.resolve().then(() => { this.state = 'running'; this.fire('statechange'); });
  }
  close(): Promise<void> { return Promise.resolve(); }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

class FakeAudio {
  paused = true;
  loop = false;
  playbackRate = 1;
  crossOrigin = '';
  /** Distinct per element, in creation order, so a test can tell WHICH voices a snapshot kept.
   *  Giving every fake the same value made the stream-cap test vacuous — it passed whichever four
   *  were retained (caught by the mutation check). */
  currentTime = 12 + elements.length;
  duration = 240;
  readyState = 4;
  error: { code: number } | null = null;
  onended: (() => void) | null = null;
  src: string;
  constructor(src: string) { this.src = src; elements.push(this); }
  play(): Promise<void> {
    if (refusePlay || ctxInstance.state !== 'running') return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
}

let audioService: typeof import('../../packages/modoki/src/runtime/audio/audioService');
let audioHealth: typeof import('../../packages/modoki/src/runtime/audio/audioHealth');
const g = globalThis as unknown as { AudioContext?: unknown; Audio?: unknown };

beforeEach(async () => {
  elements = [];
  resumeBehaviour = 'ok';
  refusePlay = false;
  g.AudioContext = function RecordingAudioContext() { ctxInstance = new FakeAudioContext(); return ctxInstance; };
  g.Audio = FakeAudio;
  vi.resetModules();
  audioService = await import('../../packages/modoki/src/runtime/audio/audioService');
  audioHealth = await import('../../packages/modoki/src/runtime/audio/audioHealth');
  audioService.setAudioRecordMode(false);
});

afterEach(() => {
  audioService.dispose();
  audioHealth.clearAudioHealthTrace();
  vi.restoreAllMocks();
  delete g.AudioContext;
  delete g.Audio;
});

/** Start a streamed bed, then put the context in `state` the way a background does. */
function startBed(state?: string) {
  audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });
  if (state !== undefined) ctxInstance.state = state;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const entriesOf = (kind: string) => audioHealth.getAudioHealthTrace().filter((e) => e.kind === kind);

describe('#1455 — the trace records what the OS left behind', () => {
  it('a foreground records the state BEFORE the resume, with the duration', async () => {
    startBed('interrupted');
    audioHealth.clearAudioHealthTrace();

    audioService.noteForeground(1_800_000);

    const [fg] = entriesOf('foreground');
    // `interrupted`, NOT `running`: a note taken after the recovery would say nothing.
    expect(fg.state).toBe('interrupted');
    expect(fg.backgroundedMs).toBe(1_800_000);
  });

  it('a resolved resume records its outcome and the state it reached', async () => {
    startBed('interrupted');
    audioHealth.clearAudioHealthTrace();

    audioService.resume();
    await flush();

    const resumes = entriesOf('resume');
    expect(resumes.map((e) => e.outcome)).toContain('resolved');
    expect(resumes.find((e) => e.outcome === 'resolved')!.state).toBe('interrupted');
    expect(resumes.find((e) => e.outcome === 'resolved')!.stateAfter).toBe('running');
  });

  it('a REJECTED resume is recorded and warned, where it used to be swallowed', async () => {
    // The regression case. Against the old bare `catch {}` the app went silent with nothing of
    // ours having noticed — no entry, no log line, nothing to put in a bug report.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resumeBehaviour = 'reject';
    startBed('interrupted');
    audioHealth.clearAudioHealthTrace();

    audioService.resume();
    await flush();

    expect(entriesOf('resume').map((e) => e.outcome)).toContain('rejected');
    expect(warn).toHaveBeenCalled();
  });

  it('accept side: an already-running context records skipped-running, not a phantom resume', async () => {
    // Without this, a trace full of `resolved` entries on a healthy app would be indistinguishable
    // from one that had to fight for every recovery.
    startBed();
    audioHealth.clearAudioHealthTrace();

    audioService.resume();
    await flush();

    expect(entriesOf('resume').map((e) => e.outcome)).toEqual(['skipped-running']);
  });

  it('a CLOSED context records skipped-closed — the outcome that means the audio is gone', async () => {
    // Never observed on a device (measured to a 30-minute background, 2026-09-22), and the reason
    // it is traced anyway: a closed context cannot be resumed and nothing replaces one, so this
    // entry would be the only evidence it ever happened.
    startBed('closed');
    audioHealth.clearAudioHealthTrace();

    audioService.resume();
    await flush();

    expect(entriesOf('resume').map((e) => e.outcome)).toEqual(['skipped-closed']);
  });

  it('statechange is traced on the LOSS edge, not only the recovery', async () => {
    startBed();
    audioHealth.clearAudioHealthTrace();

    ctxInstance.state = 'interrupted';
    ctxInstance.fire('statechange');

    expect(entriesOf('statechange').map((e) => e.state)).toEqual(['interrupted']);
  });

  it('a stream the GAME paused is distinguishable from one the OS killed', async () => {
    // Both read `paused: true`. Without `deliberatelyPaused` the trace cannot tell a correctly
    // paused bed from the failure it exists to catch.
    startBed();
    const handle = audioService.play({ clip: 'bed2', url: 'bed2.m4a', bus: 'music', loop: true });
    handle.pause();
    audioHealth.clearAudioHealthTrace();

    audioService.noteForeground(0);

    const streams = entriesOf('foreground')[0].streams!;
    expect(streams.some((s) => s.deliberatelyPaused)).toBe(true);
    expect(streams.some((s) => !s.deliberatelyPaused)).toBe(true);
  });

  it('the trace is bounded, and keeps the MOST RECENT entries', async () => {
    // The entry that matters is the newest foreground — the one being complained about — so a
    // full ring must drop from the front, not refuse to record.
    for (let i = 0; i < 100; i++) audioService.noteForeground(i);

    const fg = entriesOf('foreground');
    // Reads the bound, does not restate it: lowering MAX_ENTRIES to 8 must not leave this green
    // while the trace silently stops covering the cycles the docblock promises.
    expect(fg.length).toBeLessThanOrEqual(audioHealth.MAX_ENTRIES);
    expect(fg.length).toBe(audioHealth.MAX_ENTRIES);
    expect(fg[fg.length - 1].backgroundedMs).toBe(99);
  });

  it('when the stream cap fires it keeps the OLDEST — the music bed, not the newest SFX', async () => {
    // `active` is insertion-ordered and a looping bed starts at scene load and never leaves, so it
    // is always first. Keeping the newest would discard exactly the voice being diagnosed.
    startBed();                       // the bed: elements[0]
    for (let i = 0; i < audioHealth.MAX_STREAMS + 2; i++) {
      audioService.play({ clip: `s${i}`, url: `s${i}.m4a`, bus: 'sfx', loop: true });
    }
    await flush();
    audioHealth.clearAudioHealthTrace();

    audioService.noteForeground(0);

    const streams = entriesOf('foreground')[0].streams!;
    expect(streams).toHaveLength(audioHealth.MAX_STREAMS);
    // The bed is element 0, so `currentTime` 12; keeping the NEWEST four would start at an SFX.
    expect(streams[0].currentTime).toBe(12);
    expect(streams.map((s) => s.currentTime)).toEqual([12, 13, 14, 15]);
  });

  it('the ring is big enough for the several cycles the docblock promises', () => {
    // The bound is read, not restated, everywhere else — which correctly makes those assertions
    // immune to the bound CHANGING. That leaves one hole nothing else covers: shrinking
    // MAX_ENTRIES to 2 keeps every other test green while the trace stops covering the
    // background/foreground cycles it exists to hold. Each cycle costs a `foreground` plus at
    // least one `statechange` and one `resume`.
    expect(audioHealth.MAX_ENTRIES).toBeGreaterThanOrEqual(16);
    expect(audioHealth.MAX_STREAMS).toBeGreaterThanOrEqual(2);
  });

  it('a reader cannot mutate the record it is reading', async () => {
    audioService.noteForeground(5);

    const first = audioHealth.getAudioHealthTrace();
    first[0].backgroundedMs = 999;
    first[0].streams?.pop();

    expect(audioHealth.getAudioHealthTrace()[0].backgroundedMs).toBe(5);
  });

  it('a run of taps on a HEALTHY context records one entry, not one per tap', async () => {
    // The defect this change nearly shipped. `resume()` runs on every pointerdown, so without
    // collapsing, 32 taps evict every foreground and statechange entry and the trace records only
    // that the player was tapping — the ring full of the one outcome that means nothing.
    startBed();
    audioHealth.clearAudioHealthTrace();

    for (let i = 0; i < 40; i++) { audioService.resume(); await flush(); }

    expect(entriesOf('resume')).toHaveLength(1);
    expect(entriesOf('resume')[0].outcome).toBe('skipped-running');
  });

  it('a repeatedly REFUSED resume collapses too, warning once rather than per tap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resumeBehaviour = 'reject';
    startBed('interrupted');
    audioHealth.clearAudioHealthTrace();

    for (let i = 0; i < 20; i++) { ctxInstance.state = 'interrupted'; audioService.resume(); await flush(); }

    expect(entriesOf('resume').filter((e) => e.outcome === 'rejected')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('collapsing keeps TRANSITIONS — a changed outcome still records', async () => {
    // The accept side. Collapse everything and the trace says nothing at all; the rule must drop
    // only a repeat of the SAME outcome.
    startBed();
    audioHealth.clearAudioHealthTrace();

    audioService.resume();                 // skipped-running
    await flush();
    ctxInstance.state = 'interrupted';
    audioService.resume();                 // resolved — a different outcome
    await flush();

    expect(entriesOf('resume').map((e) => e.outcome)).toEqual(['skipped-running', 'resolved']);
  });

  it('a REFUSED re-kick is recorded — the half a context-only trace cannot see', async () => {
    // #1455's candidate (2): the context comes back `running` and the bed stays silent. Before the
    // close-out sweep this rejection was swallowed by a bare catch, so the trace showed a healthy
    // resume and nothing else — indistinguishable from a bed that actually restarted.
    startBed();
    const el = elements[0];
    await flush();
    el.pause();
    refusePlay = true;                   // WebKit refusing the element, context healthy
    audioHealth.clearAudioHealthTrace();

    audioService.resume();
    await flush();

    const refusals = entriesOf('play-refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toBe('re-kick');
    // The context was NEVER unhealthy here — which is the whole point of this case.
    expect(refusals[0].state).toBe('running');
  });

  it('a wedged bed records ONE entry per episode, not one per tap', async () => {
    // `resumeActiveMedia()` runs on every `resume()`, and `resume()` fires on every pointerdown.
    // Without the per-handle flag a stuck bed would write an entry per tap and evict the
    // foreground entries — from a ring that holds 32 — which is the opposite of the point.
    startBed();
    const el = elements[0];
    await flush();
    refusePlay = true;                   // stays refusing across all ten, unlike ctx.state
    audioHealth.clearAudioHealthTrace();

    for (let i = 0; i < 10; i++) { el.pause(); audioService.resume(); await flush(); }

    // Precondition: all ten really were ATTEMPTED and refused. Without this the assertion below
    // is satisfied just as well by nine attempts that never happened — the exact way this test
    // passed with the guard deleted before the mutation check caught it.
    expect(el.paused).toBe(true);
    expect(entriesOf('play-refused')).toHaveLength(1);
  });

  it('...and a NEW episode records again after a success clears the flag', async () => {
    // The accept side of the flag. Latched forever, it would hide the second failure — and the
    // second failure is the one someone is reporting.
    startBed();
    const el = elements[0];
    await flush();
    refusePlay = true;                   // episode 1: wedged
    el.pause();
    audioService.resume();
    await flush();

    refusePlay = false;                  // recovered — this success must clear the flag
    el.pause();
    audioService.resume();
    await flush();
    expect(el.paused).toBe(false);       // precondition: it really did recover
    audioHealth.clearAudioHealthTrace();

    refusePlay = true;                   // episode 2: wedged again
    el.pause();
    audioService.resume();
    await flush();

    expect(entriesOf('play-refused')).toHaveLength(1);
  });

  it('record mode records nothing — headless stays deterministic', async () => {
    audioService.setAudioRecordMode(true);
    audioHealth.clearAudioHealthTrace();

    audioService.noteForeground(1_000);

    expect(audioHealth.getAudioHealthTrace()).toEqual([]);
  });
});
