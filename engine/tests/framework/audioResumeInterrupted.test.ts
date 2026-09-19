/**
 * #1428 — music stayed dead after an iOS background/foreground whenever WebKit left the shared
 * AudioContext in its non-standard `'interrupted'` state: `resume()` only ever resumed a
 * `'suspended'` one, so the foreground re-arm and every tap were no-ops for it.
 *
 * Three mechanisms, each pinned separately so deleting any one goes red here:
 *  1. `resume()` resumes any context that is not running/closed — `'interrupted'` included.
 *  2. A stream whose re-kick was refused while the context was still interrupted is kicked again
 *     once `ctx.resume()` settles.
 *  3. A context WebKit brings back to `running` by itself (a `statechange`, no gesture and no
 *     foreground event) re-kicks a paused stream — wired once per context, not per graph rebuild.
 *
 * The fake media element REFUSES `play()` while the context is not running, which is what makes
 * (2) distinguishable from the synchronous kick `resume()` already did before this fix. That
 * refusal is a MODELLED WebKit behaviour, not one observed on a device — (2) is belt-and-braces.
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
  listeners: Record<string, Array<() => void>> = {};
  createGain() { return fakeNode(); }
  createMediaElementSource() { return fakeNode(); }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  resume(): Promise<void> {
    this.resumeCalls++;
    return Promise.resolve().then(() => { this.state = 'running'; });
  }
  close(): Promise<void> { return Promise.resolve(); }
  /** What WebKit does when an interruption ends on its own. */
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

class FakeAudio {
  paused = true;
  loop = false;
  playbackRate = 1;
  crossOrigin = '';
  onended: (() => void) | null = null;
  src: string;
  constructor(src: string) { this.src = src; elements.push(this); }
  play(): Promise<void> {
    if (ctxInstance.state !== 'running') return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
}

let audioService: typeof import('../../packages/modoki/src/runtime/audio/audioService');
const g = globalThis as unknown as { AudioContext?: unknown; Audio?: unknown };

beforeEach(async () => {
  elements = [];
  // A constructor function returning the instance records it without aliasing `this`.
  g.AudioContext = function RecordingAudioContext() { ctxInstance = new FakeAudioContext(); return ctxInstance; };
  g.Audio = FakeAudio;
  vi.resetModules();
  audioService = await import('../../packages/modoki/src/runtime/audio/audioService');
  audioService.setAudioRecordMode(false);
});

afterEach(() => {
  audioService.dispose();
  delete g.AudioContext;
  delete g.Audio;
});

/** Start a streamed music bed, then simulate the OS backgrounding the app: the context goes to
 *  `state` and WebKit pauses the element. */
async function startBedThenBackground(state: string): Promise<FakeAudio> {
  audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });
  await Promise.resolve();
  const el = elements[0];
  expect(el.paused).toBe(false); // it really was playing before the background
  ctxInstance.state = state;
  el.pause();
  return el;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("#1428 — resume() recovers an iOS 'interrupted' AudioContext", () => {
  it("resumes a context left 'interrupted', and the streamed bed plays again", async () => {
    const el = await startBedThenBackground('interrupted');
    audioService.resume();
    expect(ctxInstance.resumeCalls).toBe(1);
    await flush();
    expect(ctxInstance.state).toBe('running');
    expect(el.paused).toBe(false);
  });

  it("still resumes a plain 'suspended' context (#489's case)", async () => {
    const el = await startBedThenBackground('suspended');
    audioService.resume();
    await flush();
    expect(ctxInstance.resumeCalls).toBe(1);
    expect(el.paused).toBe(false);
  });

  it('accept side: a running or closed context is not resumed', async () => {
    audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });
    audioService.resume();
    ctxInstance.state = 'closed';
    audioService.resume();
    await flush();
    expect(ctxInstance.resumeCalls).toBe(0);
  });

  it('a WebKit self-resume (statechange → running) re-kicks a paused stream', async () => {
    const el = await startBedThenBackground('interrupted');
    ctxInstance.state = 'running';
    ctxInstance.fire('statechange');
    await flush();
    expect(el.paused).toBe(false);
  });

  it('a statechange → running while the page is HIDDEN does not start the bed in the background', async () => {
    const el = await startBedThenBackground('interrupted');
    const d = globalThis as unknown as { document?: unknown };
    d.document = { visibilityState: 'hidden' };
    try {
      ctxInstance.state = 'running';
      ctxInstance.fire('statechange');
      await flush();
      expect(el.paused).toBe(true);
    } finally {
      delete d.document;
    }
  });

  it('a statechange to anything but running does not un-pause', async () => {
    const el = await startBedThenBackground('interrupted');
    ctxInstance.fire('statechange');
    await flush();
    expect(el.paused).toBe(true);
  });

  it('a deliberately paused stream stays paused through a statechange', async () => {
    const h = audioService.play({ clip: 'bed', url: 'bed.m4a', bus: 'music', loop: true });
    await Promise.resolve();
    h.pause();
    ctxInstance.fire('statechange');
    await flush();
    expect(elements[0].paused).toBe(true);
  });

  it('the statechange listener is wired once per context, not once per graph rebuild', () => {
    audioService.setBusVolume('music', 1); // builds the graph
    audioService.dispose();
    audioService.setBusVolume('music', 1); // rebuilds it on the SAME shared context
    expect(ctxInstance.listeners.statechange).toHaveLength(1);
  });
});
