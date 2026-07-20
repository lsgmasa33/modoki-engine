/** previewTimelineStep — the Timeline panel's forward-preview step (Phase 6). Unlike the silent
 *  state-only scrub (previewTimelineAt), it edge-fires signals/audio/OnSequence over (prevT,curT],
 *  gated on the preview-active flag so those effects run with the sim STOPPED. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { OnSequence } from '../../src/runtime/traits/OnSequence';
import { timelineSystem, previewTimelineStep, previewControlAt } from '../../src/runtime/systems/timelineSystem';
import { setTimelinePreviewActive } from '../../src/runtime/systems/timelinePreview';
import { setPlayState } from '../../src/runtime/systems/playState';
import { takeParticleControl, resetScrubParticleReflect } from '../../src/runtime/systems/particleControlRegistry';
import { timelineEvents } from '../../src/runtime/managers/TimelineEvents';
import { setTimeline, getTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { drainAudioCues } from '../../src/runtime/audio/audioCues';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'preview.timeline.json';

let tw: TestWorld | undefined;
afterEach(() => {
  setTimelinePreviewActive(false);
  resetScrubParticleReflect();
  if (tw) { timelineEvents.__clear(tw.world); tw.dispose(); tw = undefined; }
  clearTimelineCache();
});

function setup() {
  const cameraMove = vi.fn();
  const playClip = vi.fn();
  const onStart = vi.fn();
  const onEnd = vi.fn();
  tw = createTestWorld({
    dt: 1 / 30,
    systems: [TIMELINE],
    actions: {
      'demo.cameraMove': cameraMove,
      'engine.playClip': (ctx) => playClip((ctx.params as { clip: string }).clip),
      'demo.begin': onStart,
      'demo.done': onEnd,
    },
  });
  setTimeline(PATH, normalizeTimeline({
    id: 'cut', name: 'Cutscene', duration: 3, frameRate: 30,
    tracks: [
      { id: 'ship', name: 'Ship', target: 'Ship', type: 'animation', clips: [{ start: 0.5, clip: 'Warp' }] }, // skeletal (no Animator)
      { id: 'sig', name: 'Sig', target: '', type: 'signal', markers: [{ t: 1.5, action: 'demo.cameraMove' }] },
      { id: 'aud', name: 'Audio', target: '', type: 'audio', cues: [{ t: 1.5, clip: 'guid-hit' }] },
    ],
  }));
  const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, playing: false }), OnSequence({ onStart: 'demo.begin', onEnd: 'demo.done' }));
  tw.spawn(EntityAttributes({ name: 'Ship', parentId: root.id() })); // skeletal target, no Animator
  drainAudioCues(tw.world); // clear any residue
  return { root, cameraMove, playClip, onStart, onEnd };
}

describe('previewTimelineStep', () => {
  it('gate closed (flag off) → the dispatch/action stays inert while stopped', () => {
    const { root, cameraMove, playClip, onStart } = setup();
    setPlayState('stopped'); // editor: sim is not running
    const def = getTimeline(PATH)!;

    setTimelinePreviewActive(false);
    previewTimelineStep(tw!.world, root.id(), def, 0, 1.6, { justStarted: true });
    expect(cameraMove).not.toHaveBeenCalled(); // signal action blocked by the gate
    expect(onStart).not.toHaveBeenCalled();    // OnSequence action blocked too
    expect(playClip).not.toHaveBeenCalled();   // skeletal is seeked, never triggered, in preview
  });

  it('gate open (flag on) → fires signals + audio + OnSequence forward, sim STOPPED', () => {
    const { root, cameraMove, playClip, onStart, onEnd } = setup();
    setPlayState('stopped');
    const def = getTimeline(PATH)!;

    setTimelinePreviewActive(true);

    // Step 0 → 1.6: crosses the marker + cue at 1.5, fires sequence start (justStarted).
    previewTimelineStep(tw!.world, root.id(), def, 0, 1.6, { justStarted: true });
    expect(onStart).toHaveBeenCalledTimes(1);                 // OnSequence.onStart
    expect(cameraMove).toHaveBeenCalledTimes(1);              // signal marker @1.5
    expect(drainAudioCues(tw!.world).map((c) => c.clip)).toContain('guid-hit'); // audio cue @1.5
    expect(playClip).not.toHaveBeenCalled();                 // skeletal NOT triggered in preview
    const seq = tw!.events({ type: '@sequence' }).map((e) => (e.payload as { phase: string }).phase);
    expect(seq).toEqual(['start']);
    expect(tw!.events({ type: '@marker' })).toHaveLength(1);
    expect(tw!.events({ type: '@cue' })).toHaveLength(1);

    // Step 1.6 → 3.0 (end): no re-fire of the past marker; sequence end fires once.
    previewTimelineStep(tw!.world, root.id(), def, 1.6, 3.0, { justEnded: true });
    expect(cameraMove).toHaveBeenCalledTimes(1);              // not re-fired
    expect(onEnd).toHaveBeenCalledTimes(1);                   // OnSequence.onEnd
    expect(tw!.events({ type: '@sequence' }).map((e) => (e.payload as { phase: string }).phase)).toEqual(['start', 'end']);
  });

  it('a scrub can PAUSE an emitter left running by a paused forward preview (review C8)', () => {
    tw = createTestWorld({ dt: 1 / 30, systems: [] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH, playing: false }));
    const emitter = tw.spawn(EntityAttributes({ name: 'Fx', parentId: root.id() }));
    const def = normalizeTimeline({
      id: 'c', name: 'C', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: 'Fx', type: 'control', clips: [{ start: 1, duration: 2, particle: true }] }],
    });
    setTimeline(PATH, def);
    setPlayState('stopped'); setTimelinePreviewActive(true);

    // Forward-preview across the particle clip START (1.0) and PAUSE mid-span (t=1.5) — the emitter is
    // left running. Drain the restart the render layer would consume.
    previewTimelineStep(tw.world, root.id(), def, 0, 1.5, { justStarted: true });
    expect(takeParticleControl(emitter.id())).toBe('restart');

    // SCRUB out of the span. Before C8, previewTimelineStep wiped the reflect memory every forward step,
    // so the scrub read 'off' and never paused the still-running emitter. Now it pauses it.
    previewControlAt(tw.world, root.id(), def, 3.5);
    expect(takeParticleControl(emitter.id())).toBe('pause');
  });
});
