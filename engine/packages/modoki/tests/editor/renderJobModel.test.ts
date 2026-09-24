/** The render progress card's decisions (#1488): the title, the bar, the ETA and the warnings drawn
 *  from `render.json`. */

import { describe, it, expect } from 'vitest';
import { describeRenderJob, resultWarnings, type RenderJobWire } from '../../src/editor/recorder/renderJobModel';

const T0 = 1_000_000;
const job = (patch: Partial<RenderJobWire> = {}): RenderJobWire => ({
  id: 1, take: '/p/t.take.json', status: 'running', stage: 'starting', frame: 0, total: 435, size: null, video: null,
  startedAt: T0, stageStartedAt: T0, finishedAt: null, cancelRequested: false, result: null, error: null, log: [], ...patch,
});
const result = (patch: Partial<NonNullable<RenderJobWire['result']>> = {}): NonNullable<RenderJobWire['result']> => ({
  video: '/p/t/t.mp4', reportFile: '/p/t/render.json', size: { width: 810, height: 1440 }, frames: 435, renderSeconds: 53,
  undispatchedEvents: 0, unsettled: [], pageErrors: 0, pageErrorSample: [], replay: { status: 'matched' }, ...patch,
});

describe('describeRenderJob', () => {
  it('has no measurable progress while the server starts and the game boots', () => {
    for (const stage of ['starting', 'server', 'boot'] as const) {
      expect(describeRenderJob(job({ stage }), T0 + 3000).progress).toBeNull();
    }
    expect(describeRenderJob(job({ stage: 'boot' }), T0 + 3000).detail).toBe('0:03 elapsed');
  });

  it('shows frame N / total and an ETA from THIS stage\'s rate', () => {
    // 100 frames in the 20 s since frames began (the boot before it does not count) → 335 left at 5/s.
    const m = describeRenderJob(job({ stage: 'frames', frame: 100, stageStartedAt: T0 + 10_000 }), T0 + 30_000);
    expect(m.title).toBe('Rendering frames');
    expect(m.progress).toBeCloseTo(100 / 435, 9);
    expect(m.detail).toBe('frame 100 / 435 · 0:30 elapsed · ~1:07 left');
    expect(m.canCancel).toBe(true);
  });

  it('shows the encode as its own progress', () => {
    const m = describeRenderJob(job({ stage: 'encode', frame: 200, stageStartedAt: T0 + 60_000 }), T0 + 70_000);
    expect(m.detail).toMatch(/^encoded 200 \/ 435/);
  });

  it('says it is cancelling once asked, and offers no second cancel', () => {
    const m = describeRenderJob(job({ stage: 'frames', frame: 5, cancelRequested: true }), T0 + 1000);
    expect(m.title).toBe('Cancelling…');
    expect(m.canCancel).toBe(false);
  });

  it('summarises a finished render, clocked to when it finished', () => {
    const m = describeRenderJob(job({ status: 'done', stage: 'done', finishedAt: T0 + 53_000, result: result() }), T0 + 999_000);
    expect(m.detail).toBe('810×1440 · 435 frames in 0:53');
    expect(m.progress).toBe(1);
    expect(m.canCancel).toBe(false);
  });

  it('shows the failure\'s reason', () => {
    const m = describeRenderJob(job({ status: 'error', stage: 'error', finishedAt: T0 + 1, error: 'ffmpeg failed (exit 1)' }), T0 + 5);
    expect(m.title).toBe('Render failed');
    expect(m.detail).toBe('ffmpeg failed (exit 1)');
  });
});

describe('resultWarnings', () => {
  it('has nothing to say about a clean render', () => {
    expect(resultWarnings(result())).toEqual([]);
  });

  it('warns first that the replay did not do what was played', () => {
    const w = resultWarnings(result({ replay: { status: 'diverged', counts: [{ type: 'court.heart.lost', played: 1, replayed: 2 }], details: [] }, pageErrors: 1, pageErrorSample: ['boom'] }));
    expect(w[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('"court.heart.lost" 1× played, 2× replayed') });
    expect(w[1].text).toMatch(/1 page error\(s\), e\.g\. boom/);
  });

  it('names the differing fields as information, not an alarm, when every event still happened', () => {
    const w = resultWarnings(result({ replay: { status: 'differs', counts: [], details: [{ type: 'court.gesture', occurrence: 1, fields: [{ path: 'travelPx', played: 334, replayed: 312 }] }] } }));
    expect(w).toEqual([{ level: 'info', text: expect.stringContaining('"court.gesture" travelPx 334→312') }]);
  });

  it('tells a give-up during boot from one mid-video', () => {
    const w = resultWarnings(result({ unsettled: [{ videoFrame: 0, duringBoot: true, pending: ['fonts'] }, { videoFrame: 40, duringBoot: false, pending: ['1 fetch'] }] }));
    expect(w.map((x) => x.text)).toEqual([
      expect.stringMatching(/fonts while booting — the whole video/),
      expect.stringMatching(/1 fetch at frame 40/),
    ]);
  });

  it('warns that assets the take uses changed since it was recorded, naming them (#1509)', () => {
    const w = resultWarnings(result({ assets: { status: 'changed', checked: 12, changed: ['scenes/main.scene.json', 'textures/a.png', 'b', 'c', 'd'], added: ['materials/new.material.json'] } }));
    expect(w).toEqual([{ level: 'warn', text: expect.stringMatching(/^6 asset\(s\) this take uses changed since you recorded it/) }]);
    expect(w[0].text).toMatch(/scenes\/main\.scene\.json, textures\/a\.png, b, c, \+2 more/);
  });

  it('says nothing about assets that did not change, or a take that predates the check', () => {
    expect(resultWarnings(result({ assets: { status: 'unchanged', checked: 7 } }))).toEqual([]);
    expect(resultWarnings(result({ assets: { status: 'unchecked', reason: 'old take' } }))).toEqual([]);
  });

  it('notes an unchecked replay quietly', () => {
    expect(resultWarnings(result({ replay: { status: 'unchecked' } }))).toEqual([{ level: 'info', text: expect.stringMatching(/Replay not checked/) }]);
  });
});
