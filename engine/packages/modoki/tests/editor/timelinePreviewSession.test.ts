/** Timeline preview SESSION controller (Phase 6, T1 backfill) — the snapshot/restore half of
 *  "▶ Preview plays the cutscene for real". A full serialize→loadScene round-trip isn't loadable
 *  headlessly yet, so we stub serialize/SceneManager/openAssetInEditor and pin the controller's
 *  branching against the REAL runtime singletons (preview flag, skeletal seeks, control spawns):
 *   - begin() snapshots ONCE (idempotent across pause/resume),
 *   - end({restore}) reverts to that FIRST snapshot,
 *   - the scene-path guard refuses to clobber a DIFFERENT scene loaded since the snapshot,
 *   - end always clears the active flag + skeletal seeks + control spawns,
 *   - end returns the caller's re-resolved root (entity ids change on the restore reload).
 *
 *  The session now backs BOTH preview panels (Timeline + Animation), so the rebind is a callback
 *  supplied by the caller rather than a timeline path. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scenePath: 'A.json' as string | null,
  snapshots: [] as unknown[],
  loadCalls: [] as { path: string; preloaded: unknown }[],
  resolvedRoot: 42 as number | null,
  failSerialize: false,
  loadGate: null as Promise<void> | null,
  loadGates: [] as Promise<void>[],
  serializeGate: null as Promise<void> | null,
}));

vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: async () => {
    if (h.serializeGate) await h.serializeGate;
    if (h.failSerialize) throw new Error('serialize failed');
    const s = { snap: h.snapshots.length }; h.snapshots.push(s); return s;
  },
  getCurrentScenePath: () => h.scenePath,
  sceneLoadGeneration: () => 0,
  isSceneLoadInFlight: () => false,
}));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async (path: string, opts: { preloaded: unknown }) => {
      h.loadCalls.push({ path, preloaded: opts.preloaded });
      if (h.loadGate) await h.loadGate;
      const gate = h.loadGates.shift();
      if (gate) await gate;
      return { keptBaseGuids: new Set<string>() };
    },
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrent: () => ({ path: h.scenePath }),
  },
}));
// NOTE: no openAssetInEditor mock — the controller no longer resolves a root itself; each panel
// passes its own `rebind`, which is what `h.resolvedRoot` stands in for below.

import {
  beginTimelinePreviewSession, endTimelinePreviewSession, hasTimelinePreviewSession,
} from '../../src/editor/scene/timelinePreview';
import { isTimelinePreviewActive, setTimelinePreviewActive } from '../../src/runtime/core/timelinePreview';
import type { Entity } from 'koota';
import { requestSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../../src/runtime/core/skeletalSeek';
import { setControlSpawn, hasControlSpawn, clearControlSpawns } from '../../src/runtime/timeline/controlSpawnRegistry';
import {
  pushAction, undo, redo, canUndo, canRedo, clearHistory, undoLabel, undoRefusedReason, undoStep,
  subscribeUndo, beginPreviewRestore, finishPreviewRestore,
} from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';
import { onAuthoringSettled } from '../../src/editor/scene/authoringSettle';
import { openPreviewSessionThen, reopenPreviewAfterRestore } from '../../src/editor/scene/openPreviewSession';
import { capturePreviewGesture, whenPreviewRestoresLanded } from '../../src/editor/scene/timelinePreview';
import { createTeardownToken } from '../../src/runtime/core/liveness';
import { enterScrubMode, exitPreviewMode, aSceneSwapIsHappening, stopPlay, enterPlay } from '../../src/editor/scene/playMode';
import { getPlayState } from '../../src/runtime/core/playState';
import { getRunMode } from '../../src/runtime/core/playState';

afterEach(async () => {
  // End any dangling session so the module-level snapshot doesn't leak to the next test.
  if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: false });
  setTimelinePreviewActive(false);
  clearSkeletalSeeks();
  clearControlSpawns();
  h.scenePath = 'A.json'; h.snapshots = []; h.loadCalls = []; h.resolvedRoot = 42;
  h.failSerialize = false; h.loadGate = null; h.loadGates = []; h.serializeGate = null;
  setRunMode('stopped');
});

describe('timeline preview session controller', () => {
  it('snapshots ONCE — begin is idempotent across pause/resume, and restore reverts the first snapshot', async () => {
    await beginTimelinePreviewSession();
    await beginTimelinePreviewSession(); // resume after a pause must NOT re-snapshot the mutated world
    expect(h.snapshots).toHaveLength(1);
    expect(hasTimelinePreviewSession()).toBe(true);

    await endTimelinePreviewSession({ restore: true });
    expect(h.loadCalls).toHaveLength(1);
    expect(h.loadCalls[0].preloaded).toBe(h.snapshots[0]); // reverts to the authored snapshot
    expect(hasTimelinePreviewSession()).toBe(false);
  });

  it('restore NO-OPS when the scene changed since the snapshot (path guard) — does not clobber the new scene', async () => {
    h.scenePath = 'A.json';
    await beginTimelinePreviewSession();
    h.scenePath = 'B.json'; // user loaded a different scene mid-preview
    const root = await endTimelinePreviewSession({ restore: true, rebind: () => h.resolvedRoot });
    expect(h.loadCalls).toHaveLength(0);
    expect(root).toBeNull();
  });

  it('end ALWAYS clears the preview flag, skeletal seeks, and control spawns', async () => {
    setTimelinePreviewActive(true);
    requestSkeletalSeek(7 as unknown as Entity, [{ clip: 'x', time: 0, weight: 1 }]);
    setControlSpawn('dir:trk:0', 9);
    await beginTimelinePreviewSession();

    await endTimelinePreviewSession({ restore: false });
    expect(isTimelinePreviewActive()).toBe(false);
    expect(hasSkeletalSeeks()).toBe(false);
    expect(hasControlSpawn('dir:trk:0')).toBe(false);
  });

  it("returns the caller's RE-RESOLVED root after a restore (entity ids change on the reload)", async () => {
    h.scenePath = 'A.json';
    h.resolvedRoot = 123;
    await beginTimelinePreviewSession();
    const root = await endTimelinePreviewSession({ restore: true, rebind: () => h.resolvedRoot });
    expect(root).toBe(123);
  });

  // A scrub drag calls begin() once per pointermove and serializeScene() is async, so without an
  // in-flight guard the SECOND call serialized an already-posed world and overwrote the authored
  // snapshot with it — Exit would then "revert" to the pose. Concurrent begins must share one.
  it('collapses CONCURRENT begins into one snapshot (a scrub drag fires begin per pointermove)', async () => {
    await Promise.all([
      beginTimelinePreviewSession(),
      beginTimelinePreviewSession(),
      beginTimelinePreviewSession(),
    ]);
    expect(h.snapshots).toHaveLength(1);
    await endTimelinePreviewSession({ restore: true });
    expect(h.loadCalls[0].preloaded).toBe(h.snapshots[0]); // the AUTHORED snapshot, not a re-serialize
  });

  // #1148: the restore discards the scene edits made while the session was held, so their undo
  // entries go with it — an undo after Exit would otherwise write a posed value into the authored
  // scene, or respawn an entity the restore already brought back (a duplicate guid).
  describe('undo entries pushed during the session', () => {
    const scene = (label: string) => ({ label, undo: () => {}, redo: () => {} });
    /** Let queued undo/redo steps START — a step called in the same tick as an end has not begun yet,
     *  and one that has not begun is refused by the restore, which is a different test. */
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const asset = (label: string) => ({ label, _isFileDirect: true, undo: () => {}, redo: () => {} });

    it('a RESTORE drops the session\'s scene edits and keeps its asset edits and the authored history', async () => {
      clearHistory();
      setRunMode('stopped');
      pushAction(scene('authored'));
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      pushAction(scene('recorded field'));
      pushAction(asset('animation record'));
      await endTimelinePreviewSession({ restore: true });
      setRunMode('stopped');
      expect(undoLabel()).toBe('animation record');
      await undo();
      expect(undoLabel()).toBe('authored');
      await undo();
      expect(canUndo()).toBe(false);
    });

    it('an edit landing WHILE the snapshot is being taken is marked too — dropping it costs an undo, keeping it corrupts', async () => {
      clearHistory();
      setRunMode('scrub');
      const begun = beginTimelinePreviewSession();   // serializeScene() is awaiting…
      pushAction(scene('during serialize'));          // …when this edit lands
      await begun;
      await endTimelinePreviewSession({ restore: true });
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
    });

    it('an undo/redo still RUNNING at Exit finishes before the restore, and its entry is dropped rather than pushed back', async () => {
      // A step pops its entry, then awaits its closure (a prefab re-instantiate respawns async). A
      // restore in between found the entry on neither stack, and the step then pushed it back and
      // applied its edit to the RESTORED, authored world.
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let release!: () => void;
      const order: string[] = [];
      pushAction({ label: 'Instantiate P', undo: () => {}, redo: () => new Promise<void>((r) => { release = () => { order.push('redo applied'); r(); }; }) });
      await undo();
      const redoing = redo();
      await flush();                                  // the step is now RUNNING (its closure is awaiting)
      const ending = endTimelinePreviewSession({ restore: true });
      try {
        await Promise.resolve(); await Promise.resolve();
        expect(h.loadCalls).toHaveLength(0);        // the restore waits for the redo
      } finally {
        release();                                  // never leave the undo chain blocked for the next test
        await ending; await redoing;
      }
      order.push(`restored (${h.loadCalls.length})`);
      expect(order).toEqual(['redo applied', 'restored (1)']);
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(false);
    });

    /** A session with one scene entry whose REDO is held open until `release()`, already undone. */
    async function sessionWithHeldRedo(label: string) {
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let release!: () => void;
      pushAction({ label, undo: () => {}, redo: () => new Promise<void>((r) => { release = r; }) });
      await undo();
      return { release: () => release() };
    }

    it('an undo/redo queued AFTER Exit began is refused, so it cannot outlast the swap and come back', async () => {
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let releaseHeld!: () => void;
      let queuedRan = false;
      pushAction({ label: 'held', undo: () => {}, redo: () => new Promise<void>((r) => { releaseHeld = r; }) });
      pushAction({ label: 'queued', undo: () => {}, redo: async () => { queuedRan = true; } });
      await undo(); await undo();                      // redo stack, top first: held, queued
      const running = redo();                          // 'held' is running…
      await flush();
      const ending = endTimelinePreviewSession({ restore: true });
      const queued = redo();                           // …and 'queued' is asked for after the restore began
      try {
        await Promise.resolve(); await Promise.resolve();
      } finally {
        releaseHeld();
        await Promise.all([running, ending, queued]);
      }
      setRunMode('stopped');
      expect(queuedRan).toBe(false);
      expect(canUndo()).toBe(false);                   // 'held' finished before the swap and was dropped
      expect(canRedo()).toBe(false);                   // 'queued' was refused, then dropped with the session
    });

    it('a scene opened while Exit waits for a running undo is NOT overwritten by the old snapshot', async () => {
      const held = await sessionWithHeldRedo('slow');
      const redoing = redo();
      await flush();
      h.scenePath = 'A.json';
      const ending = endTimelinePreviewSession({ restore: true });
      h.scenePath = 'B.json';                          // the user opens another scene during the wait
      held.release();
      await Promise.all([redoing, ending]);
      setRunMode('stopped');
      expect(h.loadCalls).toHaveLength(0);
    });

    it('a second end during the first one\'s restore does not clear the mark the first still needs', async () => {
      // Held on loadScene, NOT on a running undo: pushAction ignores pushes while an undo closure is
      // executing, which would make the edit below never land and this test pass for nothing.
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let open!: () => void;
      h.loadGate = new Promise<void>((r) => { open = r; });
      const first = endTimelinePreviewSession({ restore: true });
      await flush();                                    // inside loadScene
      await endTimelinePreviewSession({ restore: true }); // e.g. ⏹ pressed twice — takes the early return
      pushAction(scene('posed edit'));                  // lands in the world the first restore discards
      expect(undoLabel()).toBe('posed edit');           // it really is on the stack
      open();
      await first;
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
    });

    it('a begin DURING a restore opens nothing, so the restore drops only its own session\'s edits (#1167)', async () => {
      // This used to seat a second session over the still-posed world (the overlapping-restores
      // shape `_restoringSessions` still tolerates). The begin is refused now, so the edit pushed
      // after it is still marked with the RESTORING session and goes with that restore's drop.
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let open!: () => void;
      h.loadGate = new Promise<void>((r) => { open = r; });
      const ending = endTimelinePreviewSession({ restore: true });
      await flush();                                       // inside loadScene
      pushAction(scene('posed during restore'));
      expect(await beginTimelinePreviewSession()).toBe(false);
      pushAction(scene('posed after the refused begin'));
      open(); await ending;
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
    });

    it('the Edit menu hears a restore START and FINISH, even one that drops nothing', () => {
      let bumps = 0;
      const off = subscribeUndo(() => { bumps++; });
      let finished = false;
      try {
        beginPreviewRestore(9001);
        expect(bumps).toBe(1);
        finishPreviewRestore(9001, { drop: true });      // nothing marked 9001 → drops nothing
        finished = true;
        expect(bumps).toBe(2);
      } finally {
        if (!finished) finishPreviewRestore(9001, { drop: false }); // never leave a restore open for the next test
        off();
      }
    });

    it('an EMPTY stack during a restore is "nothing to undo", not a refusal', async () => {
      clearHistory();
      beginPreviewRestore(9002);
      try {
        expect(undoRefusedReason('undo')).toBeNull();
        expect(await undoStep('undo')).toEqual({ did: false, refused: null });
        pushAction(scene('something'));
        expect(undoRefusedReason('undo')).toContain('closing');
      } finally { finishPreviewRestore(9002, { drop: false }); }
    });

    it('an edit pushed WHILE the restore is awaiting is still dropped — the mark outlives the swap', async () => {
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let open!: () => void;
      h.loadGate = new Promise<void>((r) => { open = r; });
      const ending = endTimelinePreviewSession({ restore: true });
      await new Promise((r) => setTimeout(r, 0));   // now inside loadScene
      expect(h.loadCalls).toHaveLength(1);
      pushAction(scene('Move X during restore'));   // lands in the posed world the swap discards
      open();
      await ending;
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
    });

    it('a begin whose snapshot FAILS leaves no mark — later edits are authored, and refused inside a later envelope', async () => {
      clearHistory();
      h.failSerialize = true;
      await expect(beginTimelinePreviewSession()).rejects.toThrow('serialize failed');
      expect(hasTimelinePreviewSession()).toBe(false);
      setRunMode('scrub');
      pushAction(scene('after the failed begin'));
      // Unmarked, so it is an edit from "before" any session: refused. A leftover mark would allow it.
      expect(undoRefusedReason('undo')).toContain('after the failed begin');
      setRunMode('stopped');
    });

    it('an end WITHOUT restore keeps them — the world still holds those edits', async () => {
      clearHistory();
      setRunMode('stopped');
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      pushAction(scene('kept edit'));
      await endTimelinePreviewSession({ restore: false });
      setRunMode('stopped');
      expect(undoLabel()).toBe('kept edit');
    });

    it('a restore the path guard SKIPS keeps them too — nothing was reverted', async () => {
      clearHistory();
      setRunMode('stopped');
      h.scenePath = 'A.json';
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      pushAction(scene('edit in A'));
      h.scenePath = 'B.json';
      await endTimelinePreviewSession({ restore: true });
      setRunMode('stopped');
      expect(undoLabel()).toBe('edit in A');
    });

    it('the Timeline ▶ order: session begun BEFORE the mode enters preview still marks the preview\'s edits', async () => {
      clearHistory();
      setRunMode('stopped');
      await beginTimelinePreviewSession();   // TimelineEditor ▶: await begin, THEN enterPreviewMode
      setRunMode('preview');
      pushAction(scene('edit during playback'));
      await endTimelinePreviewSession({ restore: true });
      setRunMode('stopped');
      expect(canUndo()).toBe(false);
    });
  });
});

// #1164: a panel ends the session WITHOUT awaiting and flips the run mode to 'stopped' on the next line
// (TimelineEditor.tsx). The hot-reload replay listens for "authoring settled", and it loads the scene —
// so if that flip counted as settled, the replay's load would start under the restore below and one
// would supersede the other. The end must hold a replacement token until its restore has landed.
describe('ending a session holds the world-replacement token until the restore lands (#1164)', () => {
  it('the un-awaited end + immediate stopped flip settles only AFTER the restore load resolves', async () => {
    setRunMode('scrub');
    await beginTimelinePreviewSession();
    let openGate!: () => void;
    h.loadGate = new Promise<void>((r) => { openGate = r; });
    let gateOpened = false;
    const seen: boolean[] = [];
    const unsubscribe = onAuthoringSettled(() => { seen.push(gateOpened); });
    try {
      const ending = endTimelinePreviewSession({ restore: true });
      setRunMode('stopped'); // exactly what the panel does, synchronously after the un-awaited call
      expect(seen, 'the stopped flip settled while the restore was still loading').toEqual([]);
      await vi.waitFor(() => expect(h.loadCalls).toHaveLength(1));
      expect(seen).toEqual([]);
      gateOpened = true;
      openGate();
      await ending;
      expect(seen, 'one settle, fired by the token release once the restore load resolved').toEqual([true]);
    } finally {
      unsubscribe();
    }
  });
});

/** #1167 — a begin while a session's restore is landing must not snapshot the still-posed world. */
describe('a begin during a restore is refused (#1167)', () => {
  const holdRestore = async () => {
    await beginTimelinePreviewSession();
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const ending = endTimelinePreviewSession({ restore: true });
    await new Promise((r) => setTimeout(r, 0));             // inside loadScene: _snap is already null
    expect(h.loadCalls).toHaveLength(1);
    return { open, ending };
  };

  it('resolves false, serializes nothing and seats nothing — the next Exit has no pose to restore', async () => {
    const { open, ending } = await holdRestore();
    // MUTATION TARGET: drop the `_restoresInFlight > 0` refusal and this is true, with a SECOND
    // snapshot taken of the posed world the swap is about to throw away.
    expect(await beginTimelinePreviewSession()).toBe(false);
    expect(h.snapshots).toHaveLength(1);
    expect(hasTimelinePreviewSession()).toBe(false);
    open(); await ending;
    expect(hasTimelinePreviewSession()).toBe(false);
    await endTimelinePreviewSession({ restore: true });
    expect(h.loadCalls, 'a later Exit restores nothing — no session was seated over the pose').toHaveLength(1);
  });

  it('ACCEPT SIDE: once the restore lands, a begin opens normally from the restored world', async () => {
    const { open, ending } = await holdRestore();
    open(); await ending;
    // MUTATION TARGET: never release the count and this is false for the rest of the editor's life.
    expect(await beginTimelinePreviewSession()).toBe(true);
    expect(h.snapshots).toHaveLength(2);
  });

  it('ACCEPT SIDE: a restore whose load THROWS still releases the refusal', async () => {
    await beginTimelinePreviewSession();
    h.loadGates = [Promise.reject(new Error('load failed'))];
    await expect(endTimelinePreviewSession({ restore: true })).rejects.toThrow('load failed');
    expect(await beginTimelinePreviewSession()).toBe(true);
  });

  it('Play sees a preview restore as a world swap, including the wait BEFORE its load starts', async () => {
    // `sceneManager.getNext()` is null here (the mock never has a pending load), which is exactly the
    // `whenUndoIdle` wait in production: only the restore count can say the posed world is going away.
    expect(aSceneSwapIsHappening()).toBe(false);
    const { open, ending } = await holdRestore();
    // MUTATION TARGET: drop `isPreviewRestoreInFlight()` from aSceneSwapIsHappening and Play snapshots
    // the posed world here, which Stop then restores as the authored one.
    expect(aSceneSwapIsHappening()).toBe(true);
    open(); await ending;
    expect(aSceneSwapIsHappening()).toBe(false);
  });

  it('a begin made AFTER an Exit cancelled an in-flight begin opens its OWN session (close-out review)', async () => {
    let release!: () => void;
    h.serializeGate = new Promise<void>((r) => { release = r; });
    const cancelled = beginTimelinePreviewSession();
    await endTimelinePreviewSession({ restore: true });    // Exit mid-snapshot: nothing seated, nothing restored
    const later = beginTimelinePreviewSession();           // a fresh ruler click, while the dead serialize still runs
    release();
    // Pinned on purpose: `true` answers "a session is held" — the later click's. `false` would make the
    // cancelled click's caller hand back the SAME owner's mode, knocking the later click to 'stopped'
    // while its pose lands. Its own pose landing first is harmless: the later pose overwrites it and the
    // session reverts both.
    expect(await cancelled).toBe(true);
    // MUTATION TARGET: join `_pending` without checking `_pendingLive()` and this is false — a click refused
    // for an envelope nobody closed.
    expect(await later).toBe(true);
    await endTimelinePreviewSession({ restore: true });
    expect(h.loadCalls[0].preloaded, 'the session restores ITS snapshot, not the cancelled one').toBe(h.snapshots[1]);
  });

  it('a begin that JOINED an in-flight begin resolves false when an Exit invalidates it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.serializeGate = gate;
    const first = beginTimelinePreviewSession();
    const joined = beginTimelinePreviewSession();
    await endTimelinePreviewSession({ restore: true });    // no snapshot seated yet → no restore
    release();
    expect(await first).toBe(false);
    expect(await joined).toBe(false);
    expect(hasTimelinePreviewSession()).toBe(false);
  });
});

describe('openPreviewSessionThen — a pose runs only inside a held session (#1167)', () => {
  it('refused → the pose does not run and the claimed scrub mode is handed back', async () => {
    await beginTimelinePreviewSession();
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const ending = endTimelinePreviewSession({ restore: true });
    await new Promise((r) => setTimeout(r, 0));
    enterScrubMode('timeline');
    const pose = vi.fn();
    // MUTATION TARGET: call `pose()` regardless of `opened` and it runs against the world being replaced.
    expect(await openPreviewSessionThen('timeline', pose)).toBe(false);
    expect(pose).not.toHaveBeenCalled();
    // MUTATION TARGET: drop the `exitPreviewMode(owner)` and this stays 'scrub' with no session — Cmd+S blocked.
    expect(getRunMode()).toBe('stopped');
    open(); await ending;
  });

  it('a THROWN snapshot hands the mode back too, instead of an unhandled rejection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.failSerialize = true;
    enterScrubMode('timeline');
    const pose = vi.fn();
    expect(await openPreviewSessionThen('timeline', pose)).toBe(false);
    expect(pose).not.toHaveBeenCalled();
    expect(getRunMode()).toBe('stopped');
    expect(err).toHaveBeenCalled();
  });

  it('ACCEPT SIDE: opened → the pose runs inside the session and the mode stays claimed', async () => {
    enterScrubMode('timeline');
    const pose = vi.fn(() => { expect(hasTimelinePreviewSession()).toBe(true); });
    expect(await openPreviewSessionThen('timeline', pose)).toBe(true);
    expect(pose).toHaveBeenCalledTimes(1);
    expect(getRunMode()).toBe('scrub');
    exitPreviewMode('timeline');
  });
});

/** #1167 close-out review — the Timeline's "grab the playhead while ▶ is playing" chain: restore the
 *  forward run, then reopen a scrub session. `holdChain` drives it the way `TimelineEditor.scrub` does. */
describe('reopenPreviewAfterRestore — the grab-while-playing chain (#1167 review)', () => {
  const holdChain = async () => {
    await beginTimelinePreviewSession();
    enterScrubMode('timeline');                               // scrub() claims before starting the restore
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const token = createTeardownToken();
    const pose = vi.fn(() => { expect(hasTimelinePreviewSession()).toBe(true); });
    const chain = reopenPreviewAfterRestore('timeline', endTimelinePreviewSession({ restore: true }), token.capture(), pose);
    await new Promise((r) => setTimeout(r, 0));             // inside loadScene
    return { open, token, pose, chain };
  };

  it('a drag move refused DURING the restore does not leave the reopened session posing under stopped', async () => {
    const { open, pose, chain } = await holdChain();
    expect(await openPreviewSessionThen('timeline', vi.fn())).toBe(false); // the next pointermove: refused, mode handed back
    expect(getRunMode()).toBe('stopped');
    open();
    expect(await chain).toBe(true);
    expect(pose).toHaveBeenCalledTimes(1);
    // MUTATION TARGET: drop the chain's `enterScrubMode(owner)` and this is 'stopped' with a session held and
    // the world posed — Inspector edits allowed, and the next scene save bakes the pose.
    expect(getRunMode()).toBe('scrub');
    exitPreviewMode('timeline');
  });

  it('an Exit pressed during the restore is NOT undone by the reopen', async () => {
    const { open, token, pose, chain } = await holdChain();
    token.invalidateAll();                                    // TimelineEditor.exitPreview
    await endTimelinePreviewSession({ restore: true });       // finds no snapshot: restores nothing
    exitPreviewMode('timeline');
    open();
    // MUTATION TARGET: drop the `isLive()` check and this is true, with a fresh session posed after the Exit.
    expect(await chain).toBe(false);
    expect(pose).not.toHaveBeenCalled();
    expect(hasTimelinePreviewSession()).toBe(false);
    expect(getRunMode()).toBe('stopped');
  });

  it('a restore that THROWS hands the mode back instead of escaping unhandled', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await beginTimelinePreviewSession();
    enterScrubMode('timeline');
    h.loadGates = [Promise.reject(new Error('load failed'))];
    const pose = vi.fn();
    // MUTATION TARGET: let the rejection through and this rejects, with the mode pinned at 'scrub'.
    expect(await reopenPreviewAfterRestore('timeline', endTimelinePreviewSession({ restore: true }), () => true, pose)).toBe(false);
    expect(pose).not.toHaveBeenCalled();
    expect(getRunMode()).toBe('stopped');
    expect(err).toHaveBeenCalled();
  });

  it('toolbar STOP during the restore cancels the chain and ends stopped, with no session reopened', async () => {
    await beginTimelinePreviewSession();
    enterScrubMode('timeline');
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const pose = vi.fn();
    const chain = reopenPreviewAfterRestore('timeline', endTimelinePreviewSession({ restore: true }), capturePreviewGesture(), pose);
    await new Promise((r) => setTimeout(r, 0));             // inside loadScene: no session, mode 'scrub'
    const stopping = stopPlay();
    open();
    await stopping;
    // MUTATION TARGET: drop `cancelPreviewGestures()` from stopPlay and this is true — the chain re-poses
    // over a Stop the user pressed.
    expect(await chain).toBe(false);
    expect(pose).not.toHaveBeenCalled();
    expect(hasTimelinePreviewSession()).toBe(false);
    // MUTATION TARGET: drop stopPlay's restore-landing branch and this stays 'scrub' with nothing held.
    expect(getRunMode()).toBe('stopped');
  });

  it('a Stop pressed while PLAY starts up over a preview session is still queued, not swallowed (#470)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await beginTimelinePreviewSession();
    enterScrubMode('timeline');
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const playing = enterPlay();                              // ends the session with a restore first
    await new Promise((r) => setTimeout(r, 0));              // inside that restore: same state as a grab chain
    const stopping = stopPlay();
    open();
    await stopping; await playing;
    await new Promise((r) => setTimeout(r, 0));
    // MUTATION TARGET: drop `!_entering &&` from stopPlay's restore-landing branch and Play starts anyway.
    expect(getPlayState()).toBe('stopped');
    void warn;
  });

  it('whenPreviewRestoresLanded resolves only once the restore has landed', async () => {
    await expect(whenPreviewRestoresLanded()).resolves.toBeUndefined(); // none in flight: immediate
    await beginTimelinePreviewSession();
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => { open = r; });
    const ending = endTimelinePreviewSession({ restore: true });
    await new Promise((r) => setTimeout(r, 0));
    let landed = false;
    const waiting = whenPreviewRestoresLanded().then(() => { landed = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(landed).toBe(false);
    open(); await ending; await waiting;
    // MUTATION TARGET: never flush `_restoreWaiters` and this never resolves (the test times out).
    expect(landed).toBe(true);
  });
});
