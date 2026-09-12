/** `engine.director` (#1093) — the Director's runtime affordance.
 *
 *  Driven through `dispatchUIAction`, not by calling the handler directly: the registration IS the
 *  seam (an action that exists but never registers is reachable by nothing), and it is the same
 *  path `modoki_dispatch_action` / `device_dispatch_action` take.
 *
 *  ⚠️ Every transport assertion here checks the PLAYHEAD, not the `playing` flag. Asserting the
 *  field the action just wrote proves only that a write happened; the question is whether the
 *  timeline system then honours it, and only stepping the simulation answers that. */

import { describe, it, expect, afterEach, vi } from 'vitest';
// Side-effect only: wires core provider slots so the real timeline cache below resolves.
import '../../src/runtime/loaders/registerProviders';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { timelineSystem } from '../../src/runtime/timeline/timelineSystem';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import { registerEngineActions } from '../../src/runtime/actions/engineActions';
import { dispatchUIAction, getUIActionNames } from '../../src/runtime/core/actionRegistry';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'director-action.timeline.json';
const DT = 1 / 30;
const GUID = 'dir-guid-0001';

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearTimelineCache(); vi.restoreAllMocks(); });

/** A world with one Director on a 4s timeline, plus the engine actions registered. */
function setup(dir: Partial<Record<string, unknown>> = {}) {
  registerEngineActions();
  tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
  setTimeline(PATH, normalizeTimeline({
    id: 'd', name: 'Dir', duration: 4, frameRate: 30, tracks: [],
  }));
  const root = tw.spawn(
    EntityAttributes({ name: 'root', guid: GUID }),
    Director({ timeline: PATH, ...dir }),
  );
  return root;
}

const timeOf = (e: { get(t: unknown): unknown }) => (e.get(Director) as { time: number }).time;
const dir = (e: { get(t: unknown): unknown }) => e.get(Director) as { time: number; playing: boolean; started: boolean; speed: number };

describe('engine.director — transport', () => {
  it('is registered, so a binding or an agent can reach it at all', () => {
    registerEngineActions();
    expect(getUIActionNames()).toContain('engine.director');
  });

  it('pause STOPS the playhead advancing, not merely the flag', () => {
    const root = setup();
    tw!.step(15);
    const moved = timeOf(root);
    expect(moved).toBeGreaterThan(0);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'pause' } });
    tw!.step(30);
    // The assertion that fails if the system ignores `playing` — or if the action wrote nothing.
    expect(timeOf(root)).toBeCloseTo(moved, 6);
  });

  it('play RESUMES a paused playhead', () => {
    const root = setup({ playing: false });
    tw!.step(15);
    expect(timeOf(root)).toBe(0);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'play' } });
    tw!.step(15);
    expect(timeOf(root)).toBeGreaterThan(0);
  });

  it('toggle flips whichever way the Director is currently running', () => {
    const root = setup();
    tw!.step(10);
    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'toggle' } });
    expect(dir(root).playing).toBe(false);
    const held = timeOf(root);
    tw!.step(10);
    expect(timeOf(root)).toBeCloseTo(held, 6);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'toggle' } });
    expect(dir(root).playing).toBe(true);
    tw!.step(10);
    expect(timeOf(root)).toBeGreaterThan(held);
  });

  it('defaults to toggle when no action is given, so a bare button still works', () => {
    const root = setup();
    tw!.step(5);
    dispatchUIAction('engine.director', { targetGuid: GUID });
    expect(dir(root).playing).toBe(false);
  });

  it('applies speed, and the playhead advances at the new rate', () => {
    const root = setup();
    tw!.step(30);
    const atNormal = timeOf(root);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'play', speed: 0.5 } });
    tw!.step(30);
    const advancedAtHalf = timeOf(root) - atNormal;
    expect(advancedAtHalf).toBeCloseTo(atNormal / 2, 4);
  });
});

describe('engine.director — restart vs seek, which is the whole design', () => {
  it('restart re-fires the once-only sequence-start fan-out', () => {
    const root = setup();
    tw!.step(30);
    expect(tw!.events({ type: '@sequence' }).filter((e) => (e.payload as { phase: string }).phase === 'start')).toHaveLength(1);
    expect(dir(root).started).toBe(true);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'restart' } });
    expect(dir(root).time).toBe(0);
    // MUTATION TARGET: drop `next.started = false` from the restart branch and this stays at 1 —
    // the sequence replays with its start events silently missing, which is the defect the
    // `started` reset exists to prevent.
    tw!.step(30);
    const starts = tw!.events({ type: '@sequence' }).filter((e) => (e.payload as { phase: string }).phase === 'start');
    expect(starts).toHaveLength(2);
  });

  it('a plain SEEK does not re-fire the start fan-out — scrubbing is not a new playthrough', () => {
    const root = setup();
    tw!.step(30);
    expect(dir(root).started).toBe(true);

    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'play', time: 0 } });
    expect(dir(root).time).toBe(0);
    expect(dir(root).started).toBe(true);   // still the same playthrough
    tw!.step(30);
    const starts = tw!.events({ type: '@sequence' }).filter((e) => (e.payload as { phase: string }).phase === 'start');
    expect(starts).toHaveLength(1);
  });

  it('seek wins over the transport action, so {restart, time} starts the playthrough over FROM that time', () => {
    const root = setup();
    tw!.step(30);
    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'restart', time: 2 } });
    expect(dir(root).time).toBe(2);
    expect(dir(root).started).toBe(false);  // restart's re-arm survives the seek
  });

  /** ⚠️ Review finding. `timelineSystem` calls reverse playback explicitly deferred, and its
   *  `crossed()` edge test returns false for every tick where `advanced <= 0` — so a negative rate
   *  rewinds the playhead while markers, audio cues, activation edges, skeletal triggers and
   *  `@sequence` all stay silent, and anything latched on the way forward stays latched. An
   *  authored rewind button would look like it worked and leave the scene wrong. */
  it('clamps a negative SPEED to 0 and warns — reverse playback is not supported', () => {
    const root = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw!.step(30);
    const held = timeOf(root);
    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'play', speed: -1 } });
    expect(dir(root).speed).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reverse playback is not supported'));
    tw!.step(30);
    // Held, not rewound — the playhead must not walk backwards with every edge suppressed.
    expect(timeOf(root)).toBeCloseTo(held, 6);
  });

  it('clamps a negative seek to 0 rather than driving the playhead below zero', () => {
    const root = setup();
    tw!.step(30);
    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'play', time: -5 } });
    expect(dir(root).time).toBe(0);
  });
});

describe('engine.director — refusals', () => {
  it('warns and changes nothing when the target carries no Director', () => {
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    tw.spawn(EntityAttributes({ name: 'plain', guid: 'no-director-guid' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => dispatchUIAction('engine.director', {
      targetGuid: 'no-director-guid', params: { action: 'pause' },
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Director trait'));
  });

  it('warns on an unknown action instead of silently treating it as a toggle', () => {
    const root = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchUIAction('engine.director', { targetGuid: GUID, params: { action: 'rewind' } });
    // The dangerous failure is not the warning — it is falling through to a transport change the
    // caller never asked for.
    expect(dir(root).playing).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown action'));
  });
});
