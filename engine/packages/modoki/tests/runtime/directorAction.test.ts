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
import { setRunMode } from '../../src/runtime/core/playState';

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

/** #1113 — a write to `Director.time` that the timeline system did not make.
 *
 *  Owner-settled (2026-09-13): a PAUSED seek re-poses the scene and is wrapped into the timeline at
 *  write; and a seek that lands on the end of a non-looping timeline fires `@sequence end` once, on
 *  the next frame that advances.
 *
 *  ⚠️ The pose tests assert a POSE (an activation track's target), never the playhead: the playhead
 *  was always right, and reading it is exactly the check that let this ship. */
const ACT_PATH = 'director-seek.timeline.json';
const ACT_GUID = 'dir-seek-0001';

/** A 4 s timeline whose activation track shows "Prop" only inside [1, 2.5]. */
function setupPosed(dir: Partial<Record<string, unknown>> = {}) {
  registerEngineActions();
  tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
  setTimeline(ACT_PATH, normalizeTimeline({
    id: 's', name: 'Seek', duration: 4, frameRate: 30,
    tracks: [{ id: 'prop', name: 'Prop', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 2.5 }] }],
  }));
  const root = tw.spawn(EntityAttributes({ name: 'root', guid: ACT_GUID }), Director({ timeline: ACT_PATH, ...dir }));
  const prop = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));
  return { root, prop };
}

const shown = (e: { get(t: unknown): unknown }) => (e.get(EntityAttributes) as { isActive: boolean }).isActive;
const seek = (params: Record<string, unknown>, targetGuid = ACT_GUID) => dispatchUIAction('engine.director', { targetGuid, params });
const endsSoFar = () => tw!.events({ type: '@sequence' }).filter((e) => (e.payload as { phase: string }).phase === 'end').length;

describe('engine.director — a PAUSED seek re-poses the scene (#1113)', () => {
  it('poses the activation track at the seeked time while the Director stays paused', () => {
    const { root, prop } = setupPosed();
    tw!.step(15); // t = 0.5 → outside [1, 2.5]
    expect(shown(prop)).toBe(false);

    seek({ action: 'pause', time: 1.5 });
    tw!.step(1);
    // MUTATION TARGET: drop the `seekPoses` apply in timelineSystem and Prop stays hidden while the
    // playhead reads 1.5 — data-correct, pixels-wrong, which is the whole of this issue.
    expect(shown(prop)).toBe(true);
    expect(dir(root).playing).toBe(false);

    seek({ action: 'pause', time: 3 });
    tw!.step(1);
    expect(shown(prop)).toBe(false);
    expect(timeOf(root)).toBe(3); // and it did NOT advance: a re-pose is not a resume
  });

  it('poses a paused Director whose time was set DIRECTLY, not only through the action', () => {
    // The detection lives in the system for exactly this writer: game code setting the trait.
    const { root, prop } = setupPosed({ playing: false });
    tw!.step(2); // the system has now seen this Director once
    root.set(Director, { ...(root.get(Director) as object), time: 3 });
    tw!.step(1);
    expect(shown(prop)).toBe(false); // authored shown; only a pose at t=3 hides it
  });

  it('wraps a direct out-of-range write too, the frame the system sees it', () => {
    const { root } = setupPosed({ playing: false });
    tw!.step(2);
    root.set(Director, { ...(root.get(Director) as object), time: 999 });
    tw!.step(1);
    expect(timeOf(root)).toBe(4);
  });

  it('ACCEPT SIDE: a Director authored paused is NOT posed on the first frame the system meets it', () => {
    // First sight is not a write. Posing every dormant cutscene at load would flip its activation
    // targets the moment a scene opens — a behaviour change nobody asked for.
    // MUTATION TARGET: make first sight a write (`seen.get(key) ?? { t: NaN, … }`) and this turns red.
    const { prop } = setupPosed({ playing: false, time: 3 });
    tw!.step(3);
    expect(shown(prop)).toBe(true); // authored value, untouched
  });

  it('leaving Play forgets what it saw, so the next Play session starts from first sight', () => {
    // The editor restores the scene on Stop, so a remembered pre-Stop playhead would read the
    // restored authored value as a seek on the first frame of the next Play.
    const { root, prop } = setupPosed({ playing: false });
    tw!.step(2);
    setRunMode('stopped');
    setRunMode('playing');
    root.set(Director, { ...(root.get(Director) as object), time: 3 });
    tw!.step(1);
    // Prop is authored SHOWN and t=3 is outside its span, so only a pose could hide it.
    // MUTATION TARGET: drop the `onRunModeChange` clear and this poses (Prop → false).
    expect(shown(prop)).toBe(true);
  });
});

describe('engine.director — a seek is wrapped into the timeline AT WRITE (#1113)', () => {
  it('clamps past the end on a non-looping Director, readable immediately and while paused', () => {
    const root = setup();
    tw!.step(30);
    seek({ action: 'pause', time: 999 }, GUID);
    // No step: this is the read-back an agent makes straight after dispatching. It used to be 999.
    expect(timeOf(root)).toBe(4);
    tw!.step(120);
    expect(timeOf(root)).toBe(4);
  });

  it('wraps on a looping Director instead of clamping', () => {
    const root = setup({ loop: true });
    tw!.step(3);
    seek({ action: 'pause', time: 5 }, GUID);
    expect(timeOf(root)).toBeCloseTo(1, 9);
  });
});

describe('engine.director — a seek onto the end fires the end once (#1113)', () => {
  it('paused → seek past the end → resume fires @sequence end exactly once', () => {
    setup();
    tw!.step(30);
    seek({ action: 'pause', time: 999 }, GUID);
    tw!.step(30);
    expect(endsSoFar()).toBe(0); // nothing fires while paused

    seek({ action: 'play' }, GUID);
    tw!.step(1);
    // MUTATION TARGET: restore the crossing-only `prev < duration` end test and this is 0 — the
    // measured lock-up: the playhead lands on the end and the timeline never announces that it ended.
    expect(endsSoFar()).toBe(1);
    tw!.step(30);
    expect(endsSoFar()).toBe(1);
  });

  it('a seek onto the end while PLAYING fires it too — the swallowed end was never pause-only', () => {
    setup();
    tw!.step(30);
    seek({ action: 'play', time: 4 }, GUID);
    tw!.step(1);
    expect(endsSoFar()).toBe(1);
    tw!.step(30);
    expect(endsSoFar()).toBe(1);
  });

  it('holds the armed end through a frame that does not advance, then fires it', () => {
    const root = setup();
    tw!.step(30);
    seek({ action: 'play', time: 4, speed: 0 }, GUID);
    tw!.step(10);
    // MUTATION TARGET: drop `&& advanced > 0` and the end fires while frozen.
    expect(endsSoFar()).toBe(0);
    expect(timeOf(root)).toBe(4);

    seek({ action: 'play', speed: 1 }, GUID);
    tw!.step(1);
    // MUTATION TARGET: fire the end regardless of `advanced > 0` above and the count is already 1.
    expect(endsSoFar()).toBe(1);
  });

  it('ACCEPT SIDE: a later seek AWAY from the end disarms it, and the natural end still fires once', () => {
    setup();
    tw!.step(30);
    seek({ action: 'pause', time: 4 }, GUID);
    tw!.step(1);
    seek({ action: 'pause', time: 3.5 }, GUID);
    tw!.step(1);
    seek({ action: 'play' }, GUID);
    tw!.step(3); // t ≈ 3.6 — not at the end yet
    expect(endsSoFar()).toBe(0);
    tw!.step(30); // crosses 4 by playing
    expect(endsSoFar()).toBe(1);
  });

  it('ACCEPT SIDE: an end that fired by playing through is not fired again by seeking onto it', () => {
    setup();
    tw!.step(150); // past 4 s → ended once, playhead held at 4
    expect(endsSoFar()).toBe(1);
    seek({ action: 'play', time: 999 }, GUID); // lands on 4, where the system already left it
    tw!.step(10);
    expect(endsSoFar()).toBe(1);
  });

  it('ACCEPT SIDE: after a natural end, seeking back and playing through again ends AGAIN', () => {
    // The "already fired" flag must clear once the playhead leaves the end, or a replayed tail —
    // the natural thing after seeking back — would never announce its end.
    setup();
    tw!.step(150);
    expect(endsSoFar()).toBe(1);
    seek({ action: 'play', time: 3 }, GUID);
    tw!.step(60);
    // Pins the replay end through the whole mechanism rather than one line: the flag clears where it
    // is read (`wrapped >= duration`), which the PAUSED variant below isolates.
    expect(endsSoFar()).toBe(2);
  });

  it('ACCEPT SIDE: after a natural end, a PAUSED seek back then onto the end fires the end again on resume', () => {
    // Paused frames are the one place the flag is cleared by the seek itself rather than by playback.
    setup();
    tw!.step(150);
    expect(endsSoFar()).toBe(1);
    seek({ action: 'pause', time: 2 }, GUID);
    tw!.step(1);
    seek({ action: 'pause', time: 4 }, GUID);
    tw!.step(1);
    seek({ action: 'play' }, GUID);
    tw!.step(2);
    // MUTATION TARGET: `const endFired = last.endFired` (not cleared below the end) and this is 1.
    expect(endsSoFar()).toBe(2);
  });

  it('ACCEPT SIDE: a zero-length timeline still fires no end, as it never did', () => {
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({ id: 'z', name: 'Zero', duration: 0, frameRate: 30, tracks: [] }));
    tw.spawn(EntityAttributes({ name: 'root', guid: GUID }), Director({ timeline: PATH }));
    tw.step(5);
    // MUTATION TARGET: drop `duration > 0` from the end test and this is 1.
    expect(endsSoFar()).toBe(0);
  });

  it('un-slaving a sub-director the frame after it ended does not read the parent\'s write as a seek', () => {
    const { child } = setupNested();
    // Child spans global [2, 5]; step until ITS end fires, then mute the track on the very next frame.
    let guard = 0;
    while (endsSoFar() === 0 && guard++ < 400) tw!.step(1);
    expect(endsSoFar()).toBe(1);
    expect(timeOf(child)).toBe(3);

    setTimeline(PARENT_PATH, normalizeTimeline({
      id: 'p', name: 'Parent', duration: 6, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', muted: true, clips: [{ start: 2, subdirector: true }] }],
    }));
    tw!.step(5);
    // MUTATION TARGET: record `endFired: false` after driveSubdirector's read-back and the child's end
    // fires a SECOND time — un-slaved at its end, with nothing saying that end already fired.
    expect(endsSoFar()).toBe(1);
  });
});

/** #1113 close-out review — every seek made BEFORE the system's first record of a Director.
 *
 *  The first version armed the end only on a DETECTED write, and created the record only on a frame
 *  that got past every early return. So each of these lost the end (or the pose, or the wrap) — the
 *  original lock-up in its most likely production shape: a "skip the cutscene" seek at scene open. */
describe('engine.director — a seek before the system has a record of the Director (#1113 review)', () => {
  it('a seek onto the end on the very first frame still fires the end', () => {
    setupPosed();
    seek({ action: 'play', time: 999 });
    tw!.step(10);
    // MUTATION TARGET: default `endFired` to TRUE for a Director with no record and this is 0.
    expect(endsSoFar()).toBe(1);
  });

  it('a seek made while the def is still loading is wrapped, and its end fired, once the def resolves', () => {
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({ id: 's', name: 'Seek', duration: 4, frameRate: 30, tracks: [] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: ACT_GUID }), Director({ timeline: ACT_PATH }));
    tw.step(2);
    seek({ action: 'play', time: 999 });
    expect(timeOf(root)).toBe(999); // no def → the handler can only floor it
    tw.step(3);
    setTimeline(ACT_PATH, def);
    tw.step(5);
    expect(timeOf(root)).toBe(4);
    expect(endsSoFar()).toBe(1);
  });

  it('a PAUSED seek made while the def is still loading is wrapped and posed once it resolves', () => {
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: ACT_GUID }), Director({ timeline: ACT_PATH, playing: false }));
    const prop = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));
    seek({ action: 'pause', time: 999 });
    tw.step(3);
    setTimeline(ACT_PATH, normalizeTimeline({
      id: 's', name: 'Seek', duration: 4, frameRate: 30,
      tracks: [{ id: 'prop', name: 'Prop', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 2.5 }] }],
    }));
    tw.step(1);
    // MUTATION TARGET: drop `|| wrapped !== dir.time` from `written` and this stays 999, Prop shown.
    expect(timeOf(root)).toBe(4);
    expect(shown(prop)).toBe(false);
  });

  it('a Director whose root was authored INACTIVE is posed by a paused seek once activated', () => {
    const { root, prop } = setupPosed({ playing: false });
    root.set(EntityAttributes, { ...(root.get(EntityAttributes) as object), isActive: false });
    tw!.step(5); // never processed: skipped from the first frame
    root.set(EntityAttributes, { ...(root.get(EntityAttributes) as object), isActive: true });
    seek({ action: 'pause', time: 3 });
    tw!.step(2);
    // MUTATION TARGET: create the record only past the early returns and this stays shown.
    expect(shown(prop)).toBe(false);
  });

  it('a seek made WHILE a seen Director is inactive is still posed when it is reactivated', () => {
    const { root, prop } = setupPosed({ playing: false });
    tw!.step(2);
    root.set(EntityAttributes, { ...(root.get(EntityAttributes) as object), isActive: false });
    tw!.step(1);
    seek({ action: 'pause', time: 3 });
    tw!.step(3);
    root.set(EntityAttributes, { ...(root.get(EntityAttributes) as object), isActive: true });
    tw!.step(1);
    // MUTATION TARGET: drop the carry (`_playheadSeen.set(key, last)`) and the reactivated frame meets
    // the Director at 3 for the "first" time — no pose.
    expect(shown(prop)).toBe(false);
  });

  it('a not-yet-started Director frozen at speed 0 fires the end once it advances', () => {
    setupPosed({ speed: 0 });
    tw!.step(5);
    seek({ action: 'play', time: 4 });
    tw!.step(5);
    expect(endsSoFar()).toBe(0);
    seek({ action: 'play', speed: 1 });
    tw!.step(5);
    expect(endsSoFar()).toBe(1);
  });

  it('a non-finite direct write is wrapped ONCE, not re-posed every frame', () => {
    const { root, prop } = setupPosed({ playing: false });
    tw!.step(2);
    root.set(Director, { ...(root.get(Director) as object), time: Number.NaN });
    tw!.step(1);
    expect(timeOf(root)).toBe(0);
    // Something re-enables the target after that one pose; a per-frame re-pose would hide it again.
    prop.set(EntityAttributes, { ...(prop.get(EntityAttributes) as object), isActive: true });
    tw!.step(2);
    // MUTATION TARGET: drop the non-finite branch of wrapDirectorTime and NaN poses every frame.
    expect(shown(prop)).toBe(true);
  });

  it('a Director AUTHORED at the end of a non-looping timeline fires its end on the first advancing frame', () => {
    // Deliberate consequence of "the end is due while at the end and not yet fired": there is no way
    // to tell an authored end position from a seek made before the first frame. Pinned so it is a
    // decision, not a surprise.
    setupPosed({ time: 4 });
    tw!.step(3);
    expect(endsSoFar()).toBe(1);
  });
});

/** #1113 second review — the end must not re-fire when a record is LOST without a seek. */
describe('engine.director — an ended Director whose record is lost does not end again (#1113 review 2)', () => {
  it('Stop → Play after a natural end does not re-fire the end', () => {
    setup();
    tw!.step(150);
    expect(endsSoFar()).toBe(1);
    setRunMode('stopped');
    setRunMode('playing');
    tw!.step(5);
    // MUTATION TARGET: resolve a missing record's `endFired` as false (`?? false`) and this is 2.
    expect(endsSoFar()).toBe(1);
  });

  it('a Director carried into a world already ended (started, at the end) does not end again', () => {
    // What SceneManager's Persistent/base-scene snapshot produces: `time` and `started` copied, new id,
    // no record. An `onEnd` that loads a scene keeping that base would otherwise loop.
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({ id: 'd', name: 'Dir', duration: 4, frameRate: 30, tracks: [] }));
    tw.spawn(EntityAttributes({ name: 'root', guid: GUID }), Director({ timeline: PATH, time: 4, started: true }));
    tw.step(5);
    expect(endsSoFar()).toBe(0);
  });

  it('a STARTED Director carried in mid-play and skipped on arrival still ends when sought onto the end', () => {
    // Carried (time + started copied) with its root inactive: the record is created unresolved and
    // carried through the skipped frames; the seek lands before the first processed frame.
    registerEngineActions();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({ id: 'd', name: 'Dir', duration: 4, frameRate: 30, tracks: [] }));
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: GUID, isActive: false }), Director({ timeline: PATH, time: 1, started: true }));
    tw.step(10);
    root.set(EntityAttributes, { ...(root.get(EntityAttributes) as object), isActive: true });
    seek({ action: 'play', time: 999 }, GUID);
    tw.step(5);
    // MUTATION TARGET: resolve an unknown `endFired` as `dir.started` alone and this is 0.
    expect(endsSoFar()).toBe(1);
  });

  it('restart onto the end of an ended Director fires BOTH the start and the end of the new playthrough', () => {
    setup();
    tw!.step(150);
    seek({ action: 'restart', time: 999 }, GUID);
    tw!.step(3);
    const starts = tw!.events({ type: '@sequence' }).filter((e) => (e.payload as { phase: string }).phase === 'start').length;
    expect(starts).toBe(2);
    // MUTATION TARGET: drop `!restarted &&` from `endFired` and this stays 1 — restart's onStart hides
    // the HUD and its onEnd never restores it.
    expect(endsSoFar()).toBe(2);
  });

  it('repointing a PLAYING Director at a shorter timeline it is already past ends that timeline once', () => {
    // A decision, pinned: the playhead is wrapped onto the new timeline's end and that playthrough's end
    // has not fired. Before #1113 this Director sat at the end forever with no end at all.
    const root = setup();
    tw!.step(105); // t = 3.5 on the 4 s timeline
    setTimeline('director-action-short.timeline.json', normalizeTimeline({ id: 'sh', name: 'Short', duration: 3, frameRate: 30, tracks: [] }));
    root.set(Director, { ...(root.get(Director) as object), timeline: 'director-action-short.timeline.json' });
    tw!.step(5);
    expect(timeOf(root)).toBe(3);
    expect(endsSoFar()).toBe(1);
  });
});
