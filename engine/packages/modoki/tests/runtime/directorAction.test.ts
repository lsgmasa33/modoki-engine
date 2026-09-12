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

/** #1112 — a Director SLAVED to a parent's `subdirector` clip.
 *
 *  ⚠️ **These do NOT assert a frozen playhead, and that is the point.** The issue as filed proposed
 *  "pause the child, step, assert the playhead did not advance" — an assertion that can only pass
 *  under a semantics the engine cannot represent. The child's time is RECOMPUTED from the parent's
 *  every in-span frame (`driveSubdirector`: `time = parentTime − clip.start`), so a paused child
 *  would have to carry an offset from its parent's clip position, which is exactly the
 *  single-authority invariant nesting rests on. The fix therefore REFUSES the write; the playhead
 *  keeps following the parent, correctly, and the test below pins that too so nobody "fixes" it
 *  back into an offset. */
const PARENT_PATH = 'director-action-parent.timeline.json';
const CHILD_PATH = 'director-action-child.timeline.json';
const PARENT_GUID = 'dir-parent-0001';
const CHILD_GUID = 'dir-child-0001';

/** Parent (6 s) with a subdirector clip at start=2 targeting "Child"; Child (3 s), playing. In-span
 *  from global t=2, so the child's local time is `parentTime − 2`. `muted: true` un-slaves it. */
function setupNested(opts: { muted?: boolean } = {}) {
  registerEngineActions();
  tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
  setTimeline(PARENT_PATH, normalizeTimeline({
    id: 'p', name: 'Parent', duration: 6, frameRate: 30,
    tracks: [{
      id: 'ctl', name: 'Sub', target: 'Child', type: 'control', muted: opts.muted === true,
      clips: [{ start: 2, subdirector: true }],
    }],
  }));
  setTimeline(CHILD_PATH, normalizeTimeline({ id: 'c', name: 'Child', duration: 3, frameRate: 30, tracks: [] }));
  const parent = tw!.spawn(EntityAttributes({ name: 'Parent', guid: PARENT_GUID }), Director({ timeline: PARENT_PATH }));
  const child = tw!.spawn(
    EntityAttributes({ name: 'Child', guid: CHILD_GUID, parentId: parent.id() }),
    Director({ timeline: CHILD_PATH, playing: true }),
  );
  return { parent, child };
}

describe('engine.director — a slaved sub-director refuses transport (#1112)', () => {
  it('refuses pause: the flag is UNCHANGED, not written-then-ignored', () => {
    const { child } = setupNested();
    tw!.step(75); // global t = 2.5 → parent in span, child local ≈ 0.5
    expect(timeOf(child)).toBeGreaterThan(0.4);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    dispatchUIAction('engine.director', { targetGuid: CHILD_GUID, params: { action: 'pause' } });

    // Before the fix this was `false` — the write landed, and the playhead kept moving anyway.
    expect(dir(child).playing).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DRIVEN by a parent's subdirector clip"));
    // The message must carry the address of the thing that CAN be driven, or the caller is stuck.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Parent'));
  });

  it('keeps the playhead following the parent after the refusal — a refusal is not a freeze', () => {
    const { child } = setupNested();
    tw!.step(75);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchUIAction('engine.director', { targetGuid: CHILD_GUID, params: { action: 'pause' } });

    const before = timeOf(child);
    tw!.step(15); // +0.5 s of parent time
    expect(timeOf(child)).toBeCloseTo(before + 0.5, 2);
  });

  it('refuses EVERY verb, not only pause — including a bare seek and a speed change', () => {
    const { child } = setupNested();
    tw!.step(75);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = { ...(child.get(Director) as object) } as Record<string, unknown>;

    // No stepping between dispatches: anything that changes here was changed by the ACTION.
    for (const params of [
      { action: 'play' }, { action: 'pause' }, { action: 'toggle' }, { action: 'restart' },
      { time: 0.25 }, { speed: 0.5 }, { action: 'restart', time: 1 },
    ]) {
      dispatchUIAction('engine.director', { targetGuid: CHILD_GUID, params });
    }

    expect({ ...(child.get(Director) as object) }).toEqual(before);
  });

  it('ACCEPT SIDE: a MUTED subdirector track does not slave, so pause still works there', () => {
    // The guard must not over-refuse into "has a parent with a control track". Muting means the
    // parent stops driving, so the child runs on its OWN clock and is drivable like any Director.
    const { child } = setupNested({ muted: true });
    tw!.step(15);
    const selfRan = timeOf(child);
    expect(selfRan).toBeGreaterThan(0); // proves the mute really un-slaved it

    dispatchUIAction('engine.director', { targetGuid: CHILD_GUID, params: { action: 'pause' } });
    expect(dir(child).playing).toBe(false);
    tw!.step(15);
    expect(timeOf(child)).toBeCloseTo(selfRan, 5); // held — the pause was honoured
  });

  it('ACCEPT SIDE: pausing the PARENT is the way that works, and it freezes the child with it', () => {
    const { parent, child } = setupNested();
    tw!.step(75);
    const pAt = timeOf(parent);
    const cAt = timeOf(child);

    dispatchUIAction('engine.director', { targetGuid: PARENT_GUID, params: { action: 'pause' } });
    tw!.step(30);

    expect(timeOf(parent)).toBeCloseTo(pAt, 5);
    expect(timeOf(child)).toBeCloseTo(cAt, 5);
  });
});
