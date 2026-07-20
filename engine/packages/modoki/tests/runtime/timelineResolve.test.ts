import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { Director } from '../../src/runtime/traits/Director';
import { applyTimelineState, resolveTimelineAt } from '../../src/runtime/systems/timelineSystem';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline, type TimelineDef } from '../../src/runtime/timeline/types';

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearTimelineCache(); });

/** A root with an Animator child "Alien" and an activation child "Prop". */
function scene(tw: TestWorld) {
  const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: '' }));
  const alien = tw.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), Animator({ clips: '[]' }));
  const prop = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));
  return { root, alien, prop };
}

const DEF: TimelineDef = normalizeTimeline({
  id: 'tl', name: 'seq', duration: 6, frameRate: 30,
  tracks: [
    { id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 2, clip: 'Walk' }, { start: 2, duration: 2, clip: 'Run' }] },
    { id: 'p', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 3 }] },
  ],
});

describe('applyTimelineState — idempotent pose at absolute time', () => {
  it('scrubs the Animator to the active clip + exact local time', () => {
    tw = createTestWorld();
    const { root, alien } = scene(tw);

    applyTimelineState(tw.world, root.id(), DEF, 0.5);
    let a = tw.trait<Record<string, unknown>>(Animator, alien);
    expect(a.clip).toBe('Walk');
    expect(a.activeClip).toBe('Walk');   // pre-set to suppress animationSystem's clip-switch reset
    expect(a.time).toBeCloseTo(0.5, 9);
    expect(a.playing).toBe(false);       // scrub, not advance

    applyTimelineState(tw.world, root.id(), DEF, 2.5);
    a = tw.trait<Record<string, unknown>>(Animator, alien);
    expect(a.clip).toBe('Run');
    expect(a.time).toBeCloseTo(0.5, 9);  // 2.5 - clip.start(2)
  });

  it('toggles activation isActive on the span edges', () => {
    tw = createTestWorld();
    const { root, prop } = scene(tw);
    applyTimelineState(tw.world, root.id(), DEF, 0.5);
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(false); // before span
    applyTimelineState(tw.world, root.id(), DEF, 2.0);
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(true);  // inside [1,3)
    applyTimelineState(tw.world, root.id(), DEF, 3.0);
    expect(tw.trait<Record<string, unknown>>(EntityAttributes, prop).isActive).toBe(false); // end is exclusive
  });

  it('leaves the Animator untouched past the last clip (no active clip)', () => {
    tw = createTestWorld();
    const { root, alien } = scene(tw);
    applyTimelineState(tw.world, root.id(), DEF, 1.0); // Walk
    applyTimelineState(tw.world, root.id(), DEF, 5.5); // past Run's end (4) → no scrub write
    expect(tw.trait<Record<string, unknown>>(Animator, alien).clip).toBe('Walk'); // retains last
  });

  it('a missing target name-path resolves to nothing (no throw)', () => {
    tw = createTestWorld();
    const { root } = scene(tw);
    const bad = normalizeTimeline({ id: 'x', duration: 2, tracks: [{ id: 'a', name: 'A', target: 'Ghost', type: 'animation', clips: [{ start: 0, clip: 'Z' }] }] });
    expect(() => applyTimelineState(tw!.world, root.id(), bad, 0.5)).not.toThrow();
  });
});

describe('resolveTimelineAt — Director entry point', () => {
  it('resolves the Director\'s timeline GUID via the cache and poses at t', () => {
    tw = createTestWorld();
    const { root, alien } = scene(tw);
    setTimeline('path/seq.timeline.json', DEF);            // seed cache by path (non-GUID key)
    root.set(Director, { ...(root.get(Director) as object), timeline: 'path/seq.timeline.json' });

    resolveTimelineAt(tw.world, root, 2.5);
    const a = tw.trait<Record<string, unknown>>(Animator, alien);
    expect(a.clip).toBe('Run');
    expect(a.time).toBeCloseTo(0.5, 9);
  });
});
