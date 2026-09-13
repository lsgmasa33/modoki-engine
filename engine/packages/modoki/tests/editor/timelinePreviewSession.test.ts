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
}));

vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: async () => {
    if (h.failSerialize) throw new Error('serialize failed');
    const s = { snap: h.snapshots.length }; h.snapshots.push(s); return s;
  },
  getCurrentScenePath: () => h.scenePath,
}));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async (path: string, opts: { preloaded: unknown }) => {
      h.loadCalls.push({ path, preloaded: opts.preloaded });
      if (h.loadGate) await h.loadGate;
      const gate = h.loadGates.shift();
      if (gate) await gate;
    },
  },
}));
// NOTE: no openAssetInEditor mock — the controller no longer resolves a root itself; each panel
// passes its own `rebind`, which is what `h.resolvedRoot` stands in for below.

import {
  beginTimelinePreviewSession, endTimelinePreviewSession, hasTimelinePreviewSession,
} from '../../src/editor/scene/timelinePreview';
import { isTimelinePreviewActive, setTimelinePreviewActive } from '../../src/runtime/core/timelinePreview';
import { requestSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../../src/runtime/core/skeletalSeek';
import { setControlSpawn, hasControlSpawn, clearControlSpawns } from '../../src/runtime/timeline/controlSpawnRegistry';
import {
  pushAction, undo, redo, canUndo, canRedo, clearHistory, undoLabel, undoRefusedReason, undoStep,
  subscribeUndo, beginPreviewRestore, finishPreviewRestore,
} from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';
import { onAuthoringSettled } from '../../src/editor/scene/authoringSettle';

afterEach(async () => {
  // End any dangling session so the module-level snapshot doesn't leak to the next test.
  if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: false });
  setTimelinePreviewActive(false);
  clearSkeletalSeeks();
  clearControlSpawns();
  h.scenePath = 'A.json'; h.snapshots = []; h.loadCalls = []; h.resolvedRoot = 42;
  h.failSerialize = false; h.loadGate = null; h.loadGates = [];
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
    requestSkeletalSeek(7, [{ clip: 'x', time: 0, weight: 1 }]);
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

    it('OVERLAPPING restores each drop their own session — a pose-seated second session does not erase the first\'s', async () => {
      // #1167's path: Exit 1 is inside loadScene, a pose seats session 2, Exit 2 restores it.
      clearHistory();
      await beginTimelinePreviewSession();
      setRunMode('scrub');
      let open1!: () => void; let open2!: () => void;
      h.loadGates = [new Promise<void>((r) => { open1 = r; }), new Promise<void>((r) => { open2 = r; })];
      const end1 = endTimelinePreviewSession({ restore: true });
      await flush();                                     // end 1 inside loadScene
      pushAction(scene('posed in S1'));
      await beginTimelinePreviewSession();               // a pose seats session 2 over it
      pushAction(scene('posed in S2'));
      const end2 = endTimelinePreviewSession({ restore: true });
      await flush();                                     // end 2 inside loadScene too
      open1(); await end1;
      expect(undoLabel()).toBe('posed in S2');           // S1's entry dropped by end 1 — not stranded
      open2(); await end2;
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
