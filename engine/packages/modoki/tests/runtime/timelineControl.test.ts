/** Control track (Phase C) — prefab spawn at a clip's start, despawn at its end, edge-detected on
 *  the exact tick and journaled as @control. The prefab isn't loaded headlessly, so the spawn is a
 *  no-op but still journals (like an audio cue) — which is what we assert on. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { timelineSystem } from '../../src/runtime/systems/timelineSystem';
import { clearControlSpawns } from '../../src/runtime/systems/controlSpawnRegistry';
import { takeParticleControl, hasParticleControls, clearParticleControls } from '../../src/runtime/systems/particleControlRegistry';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'control.timeline.json';
const DT = 1 / 30;

let tw: TestWorld | undefined;
afterEach(() => { clearControlSpawns(); clearParticleControls(); if (tw) { tw.dispose(); tw = undefined; } clearTimelineCache(); });

describe('control track', () => {
  it('journals @control spawn at start and despawn at end, once each', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'prefab-guid-x' }] }],
    }));
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    void root;

    // t ≈ 0.9 — before the clip: nothing.
    tw.step(27);
    expect(tw.events({ type: '@control' })).toHaveLength(0);

    // t ≈ 1.1 — crossed start: exactly one spawn.
    tw.step(6); // 33/30 = 1.1
    let ev = tw.events({ type: '@control' });
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { phase: string; prefab: string }).phase).toBe('spawn');
    expect((ev[0].payload as { prefab: string }).prefab).toBe('prefab-guid-x');

    // t ≈ 2.1 — crossed end (start+duration=2): a despawn, and no second spawn.
    tw.step(30); // 63/30 = 2.1
    ev = tw.events({ type: '@control' });
    const phases = ev.map((e) => (e.payload as { phase: string }).phase);
    expect(phases).toEqual(['spawn', 'despawn']);
  });

  it('is deterministic — two identical runs journal identically', () => {
    const run = () => {
      const w = createTestWorld({ dt: DT, systems: [TIMELINE] });
      setTimeline(PATH, normalizeTimeline({
        id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
        tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'p' }] }],
      }));
      w.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
      w.step(90);
      const trace = w.events({ type: '@control' }).map((e) => `${e.tick}:${(e.payload as { phase: string }).phase}`);
      w.dispose(); clearTimelineCache(); clearControlSpawns();
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it('normalizeTimeline drops a control clip with an empty prefab', () => {
    const def = normalizeTimeline({
      id: 'c', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, prefab: '' }, { start: 2, prefab: 'ok' }] } as never],
    });
    const track = def.tracks[0];
    expect(track.type).toBe('control');
    expect(track.type === 'control' && track.clips).toEqual([{ start: 2, duration: undefined, prefab: 'ok' }]);
  });

  // ── Particle-restart control clips (Phase E) ──────────────────────────────────────────────────

  it('journals @control particle/particle-pause at the exact ticks and requests restart→pause on the target', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: 'Emitter', type: 'control', clips: [{ start: 1, duration: 1, particle: true }] }],
    }));
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const emitter = tw.spawn(EntityAttributes({ name: 'Emitter', parentId: root.id() }));

    tw.step(27); // t ≈ 0.9 — before the clip
    expect(tw.events({ type: '@control' })).toHaveLength(0);
    expect(hasParticleControls()).toBe(false);

    tw.step(6); // t ≈ 1.1 — crossed start → restart
    let ev = tw.events({ type: '@control' });
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { phase: string }).phase).toBe('particle');
    expect(takeParticleControl(emitter.id())).toBe('restart');

    tw.step(30); // t ≈ 2.1 — crossed end (start+duration=2) → pause
    ev = tw.events({ type: '@control' });
    expect(ev.map((e) => (e.payload as { phase: string }).phase)).toEqual(['particle', 'particle-pause']);
    expect(takeParticleControl(emitter.id())).toBe('pause');
  });

  it('particle control is deterministic — two identical runs journal identically', () => {
    const run = () => {
      const w = createTestWorld({ dt: DT, systems: [TIMELINE] });
      setTimeline(PATH, normalizeTimeline({
        id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
        tracks: [{ id: 'ctl', name: 'FX', target: 'Emitter', type: 'control', clips: [{ start: 1, duration: 1, particle: true }] }],
      }));
      const root = w.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
      w.spawn(EntityAttributes({ name: 'Emitter', parentId: root.id() }));
      w.step(90);
      const trace = w.events({ type: '@control' }).map((e) => `${e.tick}:${(e.payload as { phase: string }).phase}`);
      w.dispose(); clearTimelineCache(); clearControlSpawns(); clearParticleControls();
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it('normalizeTimeline keeps prefab/particle/subdirector clips, drops one that is none', () => {
    const def = normalizeTimeline({
      id: 'c', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [
        { start: 1, particle: true },       // kept — particle restart
        { start: 2 },                        // dropped — none of the three
        { start: 3, prefab: 'ok' },          // kept — prefab spawn
        { start: 4, subdirector: true },     // kept — nested sub-director
      ] } as never],
    });
    const track = def.tracks[0];
    expect(track.type === 'control' && track.clips).toEqual([
      { start: 1, duration: undefined, particle: true },
      { start: 3, duration: undefined, prefab: 'ok' },
      { start: 4, duration: undefined, subdirector: true },
    ]);
  });
});
