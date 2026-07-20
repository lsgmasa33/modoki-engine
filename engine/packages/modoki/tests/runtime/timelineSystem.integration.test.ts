import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { Director } from '../../src/runtime/traits/Director';
import { timelineSystem } from '../../src/runtime/systems/timelineSystem';
import { timelineEvents } from '../../src/runtime/managers/TimelineEvents';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { drainAudioCues } from '../../src/runtime/audio/audioCues';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'cutscene.timeline.json';
// Step AT the engine's per-tick delta cap (MAX_DELTA = 1/30) so elapsed = ticks/30 exactly.
const DT = 1 / 30;

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { timelineEvents.__clear(tw.world); tw.dispose(); tw = undefined; } clearTimelineCache(); });

describe('timelineSystem — full cutscene across all four track types', () => {
  it('drives Animator scrub, activation, audio, signal, and skeletal-boundary playClip', () => {
    const cameraMove = vi.fn();
    const playClip = vi.fn();
    tw = createTestWorld({
      dt: DT,
      systems: [TIMELINE],
      actions: {
        'demo.cameraMove': cameraMove,
        // Stub the engine.playClip the skeletal branch fires (registered by the app in production).
        'engine.playClip': (ctx) => playClip((ctx.params as { clip: string }).clip),
      },
    });

    setTimeline(PATH, normalizeTimeline({
      id: 'cut', name: 'Cutscene', duration: 3, frameRate: 30,
      tracks: [
        { id: 'anim', name: 'Alien', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 1.5, clip: 'Idle' }, { start: 1.5, duration: 1.5, clip: 'Attack' }] },
        { id: 'ship', name: 'Ship', target: 'Ship', type: 'animation', clips: [{ start: 0.5, clip: 'Warp' }] }, // no Animator → engine.playClip
        { id: 'prop', name: 'Prop', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 2.5 }] },
        { id: 'sig', name: 'Sig', target: '', type: 'signal', markers: [{ t: 1.5, action: 'demo.cameraMove' }] },
        { id: 'aud', name: 'Audio', target: '', type: 'audio', cues: [{ t: 1.5, clip: 'guid-hit' }] },
      ],
    }));

    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const alien = tw.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), Animator({ clips: '[]' }));
    const ship = tw.spawn(EntityAttributes({ name: 'Ship', parentId: root.id() }));
    const prop = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));
    void ship;

    // t ≈ 0.6 — Idle scrubbing, Ship warp fired, prop still off, no marker yet.
    tw.step(18); // 18/30 = 0.6
    let a = tw.trait<Record<string, unknown>>(Animator, alien);
    expect(a.clip).toBe('Idle');
    expect(a.playing).toBe(false);          // scrub, not free-run
    expect(a.time).toBeGreaterThan(0);
    expect(playClip).toHaveBeenCalledWith('Warp'); // boundary crossed at 0.5
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(false);
    expect(cameraMove).not.toHaveBeenCalled();

    // t ≈ 1.6 — Attack scrubbing, prop on, marker + audio fired at 1.5.
    tw.step(30); // total 48/30 = 1.6
    a = tw.trait<Record<string, unknown>>(Animator, alien);
    expect(a.clip).toBe('Attack');
    expect(a.time).toBeCloseTo(0.1, 3);     // 1.6 - clip.start(1.5)
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(true);
    expect(cameraMove).toHaveBeenCalledTimes(1);
    expect(drainAudioCues(tw.world).map((c) => c.clip)).toContain('guid-hit');
    expect(playClip).toHaveBeenCalledTimes(1); // not re-fired

    // t ≈ 3.0 — sequence ends, prop back off (past its span).
    tw.step(50); // total 98/30 ≈ 3.27 (clamps at 3.0)
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(false);
    expect(tw.events({ type: '@sequence' }).map((e) => (e.payload as { phase: string }).phase)).toEqual(['start', 'end']);
    expect(tw.trait<Record<string, unknown>>(Director, root).started).toBe(true);
  });

  it('two independent Directors fire at their own ticks, even when a marker action mutates the world', () => {
    const beatA = vi.fn();
    const spawnGhost: number[] = [];
    tw = createTestWorld({
      dt: DT,
      systems: [TIMELINE],
      actions: {
        'demo.beatA': beatA,
        // A marker action that MUTATES the world (spawns an entity) — the collect-then-apply invariant
        // means this must not perturb the OTHER director's PASS-1 integration this frame.
        'demo.spawnB': () => { spawnGhost.push(tw!.spawn(EntityAttributes({ name: 'Ghost' })).id()); },
      },
    });
    setTimeline('a.tl', normalizeTimeline({
      id: 'a', name: 'A', duration: 4, frameRate: 30,
      tracks: [{ id: 'sa', name: 'SA', target: '', type: 'signal', markers: [{ t: 1, action: 'demo.beatA' }] }],
    }));
    setTimeline('b.tl', normalizeTimeline({
      id: 'b', name: 'B', duration: 4, frameRate: 30,
      tracks: [{ id: 'sb', name: 'SB', target: '', type: 'signal', markers: [{ t: 2, action: 'demo.spawnB' }] }],
    }));
    const dirA = tw.spawn(EntityAttributes({ name: 'A', guid: 'a-guid' }), Director({ timeline: 'a.tl' }));
    const dirB = tw.spawn(EntityAttributes({ name: 'B', guid: 'b-guid' }), Director({ timeline: 'b.tl' }));

    tw.step(200);
    // A's marker fires once at its own t=1; B's spawn-marker fires once at its own t=2.
    expect(beatA).toHaveBeenCalledTimes(1);
    expect(spawnGhost).toHaveLength(1);
    const markA = tw.events({ type: '@marker' }).filter((e) => (e.payload as { director: string }).director === 'a-guid');
    const markB = tw.events({ type: '@marker' }).filter((e) => (e.payload as { director: string }).director === 'b-guid');
    expect(markA.map((e) => e.tick)).toEqual([31]); // t=1
    expect(markB.map((e) => e.tick)).toEqual([61]); // t=2 — independent of A and of A's world mutation
    // Both ran their own full length: each journals exactly one start + one end.
    expect(tw.trait<Record<string, unknown>>(Director, dirA).started).toBe(true);
    expect(tw.trait<Record<string, unknown>>(Director, dirB).started).toBe(true);
  });
});
