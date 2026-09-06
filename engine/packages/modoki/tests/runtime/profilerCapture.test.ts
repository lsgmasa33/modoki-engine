/** Frame capture (profiler plan P6) — `runtime/core/profilerCapture.ts`.
 *
 *  The assertion that matters most is the DEEP COPY. The live marker tree reuses its nodes
 *  across frames — that reuse is what makes the steady state allocation-free — so a capture that
 *  retained references would hand back N entries that are all the same object showing the latest
 *  frame's numbers. It would look perfectly plausible and be entirely wrong, which is the exact
 *  failure mode this whole plan is written against. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setProfilerEnabled, beginProfilerSample, endProfilerSample, beginProfilerFrame,
  endProfilerFrame, resetProfilerMarkers,
} from '../../src/runtime/core/profilerMarkers';
import {
  startCapture, stopCapture, isCapturing, captureFrame, getCapture, clearCapture,
  exportCapture, getWorstCapturedFrame, MAX_CAPTURE_FRAMES,
} from '../../src/runtime/core/profilerCapture';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

/** Build one frame whose `ecs` span costs `ms`, then hand it to the capture. */
function frame(ms: number) {
  beginProfilerFrame();
  beginProfilerSample('ecs');
  advanceManual(ms);
  endProfilerSample();
  endProfilerFrame();
  captureFrame(ms, ms);
}

beforeEach(() => {
  resetProfilerMarkers();
  clearCapture();
  setProfilerEnabled(true);
  setManualNow(0);
});

afterEach(() => {
  setProfilerEnabled(false);
  resetProfilerMarkers();
  clearCapture();
  restoreRealClock();
});

describe('profilerCapture — lifecycle', () => {
  it('records nothing until started', () => {
    frame(5);
    expect(getCapture().frames).toHaveLength(0);
    expect(isCapturing()).toBe(false);
  });

  it('records frames while capturing and stops on request', () => {
    startCapture();
    frame(5); frame(6);
    stopCapture();
    frame(7);
    const c = getCapture();
    expect(c.frames).toHaveLength(2);
    expect(c.capturing).toBe(false);
  });

  it('a new capture DISCARDS the previous one', () => {
    // A capture is a deliberate act with a question behind it; appending to an older one would
    // silently answer a different question.
    startCapture(); frame(5); frame(5); stopCapture();
    startCapture(); frame(9);
    expect(getCapture().frames).toHaveLength(1);
  });

  it('stops itself at the cap, and says so', () => {
    startCapture();
    for (let i = 0; i < MAX_CAPTURE_FRAMES + 10; i++) frame(1);
    const c = getCapture();
    expect(c.frames).toHaveLength(MAX_CAPTURE_FRAMES);
    expect(c.capturing).toBe(false);
    // Stopping rather than wrapping is the point: you press record because something is about
    // to happen, so the BEGINNING is the interesting part, not a ring that discarded it.
    expect(c.stoppedByCap).toBe(true);
    expect(c.frames[0].index).toBe(0);
  });

  it('does not record while markers are disabled', () => {
    setProfilerEnabled(false);
    startCapture();
    frame(5);
    expect(getCapture().frames).toHaveLength(0);
  });
});

describe('profilerCapture — the trees are independent', () => {
  it('DEEP-COPIES each frame, so captured frames do not all alias the live tree', () => {
    // The live tree reuses its nodes across frames. Retaining references would give every
    // captured entry the same object, all showing the last frame's numbers — plausible and
    // completely wrong.
    startCapture();
    frame(5);
    frame(50);
    frame(500);
    const f = getCapture().frames;
    const ecsOf = (i: number) => f[i].tree.children.find((c) => c.name === 'ecs')!.totalMs;
    expect(ecsOf(0)).toBe(5);
    expect(ecsOf(1)).toBe(50);
    expect(ecsOf(2)).toBe(500);
    expect(f[0].tree).not.toBe(f[1].tree);
  });

  it('a later frame cannot mutate an earlier captured tree', () => {
    startCapture();
    frame(5);
    const first = getCapture().frames[0].tree.children[0].totalMs;
    frame(999);
    expect(getCapture().frames[0].tree.children[0].totalMs).toBe(first);
  });
});

describe('profilerCapture — finding the hitch', () => {
  it('reports the worst frame by total frame time', () => {
    startCapture();
    frame(5); frame(200); frame(6);
    const worst = getWorstCapturedFrame()!;
    expect(worst.frameMs).toBe(200);
    expect(worst.index).toBe(1);
  });

  it('returns null with nothing captured', () => {
    expect(getWorstCapturedFrame()).toBeNull();
  });

  it('timestamps frames so "the hitch at ~1.2s" is locatable', () => {
    startCapture();
    frame(10); frame(10); frame(10);
    const f = getCapture().frames;
    expect(f[0].atMs).toBe(0);
    expect(f[2].atMs).toBe(20);
  });
});

describe('profilerCapture — export', () => {
  it('produces plain JSON-serialisable data', () => {
    startCapture();
    frame(5); frame(7);
    const exported = exportCapture();
    expect(exported.frameCount).toBe(2);
    expect('version' in exported).toBe(false);
    // Plain JSON on purpose — diffable, attachable to an issue, and readable by an agent, which
    // Unity's binary captures are not.
    const round = JSON.parse(JSON.stringify(exported));
    expect(round.frames[1].tree.children[0].name).toBe('ecs');
    expect(round.frames[1].tree.children[0].totalMs).toBe(7);
  });

  it('clearCapture empties it', () => {
    startCapture(); frame(5);
    clearCapture();
    expect(getCapture().frames).toHaveLength(0);
    expect(isCapturing()).toBe(false);
  });
});
