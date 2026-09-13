/** #1148 — undo/redo and the scene-reload suppressor refuse whenever the live world is not the
 *  authored one: Play, Pause, AND a scrub/preview envelope.
 *
 *  Every gate here used to read the 3-value `playState` shim, which collapses `scrub` and `preview`
 *  into `'stopped'` — so each of them said "safe" inside an envelope. The run modes are driven with
 *  `setRunMode` directly, because the shim is exactly the thing that could not tell them apart:
 *  a test that entered a preview through `getPlayState()` would be blind the same way.
 *
 *  Covered, one symptom each: `undo()`/`redo()` themselves (the seam every entry point shares — the
 *  panel buttons reached it directly), `runUndoCommand` (what the human's chord, menu and buttons
 *  call, and the only thing that says WHY), the agent `undo`/`redo` ops (ungated even during Play
 *  before this), and the reload suppressor.
 *
 *  Inside an envelope the gate is ENTRY-AWARE (owner's ruling): an asset-document edit
 *  (`_isFileDirect`) and a selection step are allowed, a scene-world edit is refused. The re-pose
 *  sequence below is why — a clip undo re-opens the envelope, so refusing everything left one undo
 *  per ⏹ Exit. */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  pushAction, clearHistory, canUndo, canRedo, undo, redo, undoStep, undoRefusedReason, useEditorStore,
  setPreviewUndoSession, dropPreviewSceneEdits,
} from '@modoki/engine/editor';
import { runUndoCommand } from '../../packages/modoki/src/editor/undo/undoCommand';
import { setRunMode, getRunMode, createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp, sceneReloadSuppressedReason } from '../../app/debug/agentBridge';
import { opReplyFor } from '../../app/debug/opRefusal';

registerAllTraits();
registerEditorAgentOps();

type Mode = { name: string; set: () => void; mentions: string; reload: string };
/** Every non-authoring state. `paused` is Play frozen, a different `advancing`, not a fourth mode. */
const REFUSING: Mode[] = [
  { name: 'scrub', set: () => setRunMode('scrub'), mentions: 'scrub', reload: 'in scrub mode' },
  { name: 'preview', set: () => setRunMode('preview'), mentions: 'preview', reload: 'in preview mode' },
  { name: 'paused preview', set: () => setRunMode('preview', { advancing: false }), mentions: 'preview', reload: 'in preview mode' },
  { name: 'playing', set: () => setRunMode('playing'), mentions: 'Play', reload: 'game is playing' },
  { name: 'paused', set: () => setRunMode('playing', { advancing: false }), mentions: 'Play', reload: 'game is paused' },
];

let calls: string[];
/** An undoable entry that records which closure ran — "the stack did not move" alone cannot tell a
 *  refused undo from one that popped and re-pushed. */
function pushProbe(label = 'Probe'): void {
  pushAction({ label, undo: () => { calls.push(`undo ${label}`); }, redo: () => { calls.push(`redo ${label}`); } });
}
/** An asset-document edit shaped like the Animation/Timeline panels' clip entries: file-direct, and
 *  its closures RE-POSE — which opens a scrub envelope when none is held (`poseClipAtTime`). */
function pushClipEdit(label: string): void {
  const repose = () => { if (getRunMode() === 'stopped') setRunMode('scrub'); };
  pushAction({
    label, _isFileDirect: true,
    undo: () => { calls.push(`undo ${label}`); repose(); },
    redo: () => { calls.push(`redo ${label}`); repose(); },
  });
}

let game: TestWorld | undefined;
// Installed through `setState`, not `vi.spyOn(getState(), …)`: zustand spreads the spied function
// into the NEXT state object on any `set`, so a spy outlives `restoreAllMocks` and carries its calls
// into the following test.
const realShowToast = useEditorStore.getState().showToast;
type ShowToast = ReturnType<typeof useEditorStore.getState>['showToast'];
let toast: Mock<ShowToast>;
beforeEach(() => {
  toast = vi.fn<ShowToast>();
  useEditorStore.setState({ showToast: toast });
  game = createTestWorld({});
  setRunMode('stopped');
  clearHistory();
  calls = [];
});
afterEach(() => {
  setPreviewUndoSession(null);
  useEditorStore.setState({ showToast: realShowToast });
  setRunMode('stopped');
  game?.dispose(); game = undefined;
  vi.restoreAllMocks();
});

describe('undo()/redo() refuse outside the authoring mode', () => {
  for (const m of REFUSING) {
    it(`refuses in ${m.name}: no closure runs and neither stack moves`, async () => {
      pushProbe();
      m.set();
      expect(await undo()).toBe(false);
      expect(calls).toEqual([]);
      expect(canUndo()).toBe(true);
      expect(canRedo()).toBe(false);
      expect(undoRefusedReason()).toContain(m.mentions);

      // The redo side needs an entry on the redo stack, which only a permitted undo can put there.
      setRunMode('stopped');
      expect(await undo()).toBe(true);
      calls = [];
      m.set();
      expect(await redo()).toBe(false);
      expect(calls).toEqual([]);
      expect(canRedo()).toBe(true);
    });
  }

  it('runs in stopped — the accept side, so a gate that refused everything would fail here', async () => {
    pushProbe();
    expect(undoRefusedReason()).toBeNull();
    expect(await undo()).toBe(true);
    expect(await redo()).toBe(true);
    expect(calls).toEqual(['undo Probe', 'redo Probe']);
  });

  it('decides when the step RUNS, not when it was queued', async () => {
    // Serialized behind an in-flight undo: a mode entered after the call but before its turn must
    // still stop it. An async closure holds the first step open while the mode flips.
    let release!: () => void;
    pushProbe();
    pushAction({ label: 'Slow', undo: () => new Promise<void>((r) => { release = r; }), redo: () => {} });
    const first = undo();
    const second = undo(); // queued behind `first`
    await Promise.resolve();
    setRunMode('scrub');
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('inside an envelope the gate reads the ENTRY on top', () => {
  for (const mode of ['scrub', 'preview'] as const) {
    it(`${mode}: an asset-document edit undoes and redoes; a scene edit beneath it is refused`, async () => {
      pushProbe('Move');           // a scene-world edit
      pushClipEdit('clip key');    // an asset-document edit on top of it
      setRunMode(mode);
      expect(undoRefusedReason('undo')).toBeNull();
      expect(await undoStep('undo')).toEqual({ did: true, refused: null });
      expect(await undoStep('redo')).toEqual({ did: true, refused: null });
      expect(await undoStep('undo')).toEqual({ did: true, refused: null });
      // Now the scene edit is on top.
      const r = await undoStep('undo');
      expect(r.did).toBe(false);
      expect(r.refused).toContain('scene edit');
      expect(r.refused).toContain('"Move"');
      expect(calls).toEqual(['undo clip key', 'redo clip key', 'undo clip key']);
      expect(canUndo()).toBe(true);
    });
  }

  it('a selection step on top is allowed — it moves no world state', async () => {
    pushAction({ label: 'Select Cube', _isSelection: true, undo: () => { calls.push('undo select'); }, redo: () => {} });
    setRunMode('scrub');
    expect(await undo()).toBe(true);
    expect(calls).toEqual(['undo select']);
  });

  it('Play still refuses an asset-document edit — only the envelope is entry-aware', async () => {
    pushClipEdit('clip key');
    setRunMode('playing');
    const r = await undoStep('undo');
    expect(r).toEqual({ did: false, refused: expect.stringContaining('Play') });
    expect(calls).toEqual([]);
  });

  it('redo reads the REDO stack top, not the undo stack', async () => {
    pushClipEdit('clip key');      // stays on the undo stack
    pushProbe('Move');
    await undo();                  // Move → redo stack (stopped)
    setRunMode('scrub');
    expect(undoRefusedReason('undo')).toBeNull();              // clip edit on the undo top
    expect(undoRefusedReason('redo')).toContain('"Move"');     // scene edit on the redo top
    expect((await undoStep('redo')).did).toBe(false);
  });

  it('an empty stack is not a refusal', async () => {
    setRunMode('scrub');
    expect(undoRefusedReason('undo')).toBeNull();
    expect(await undoStep('undo')).toEqual({ did: false, refused: null });
  });

  it('the re-pose sequence: three clip undos in a row, though the first one opens the envelope', async () => {
    // The review's finding against the first ruling: a clip undo re-poses, a pose opens the envelope,
    // and refusing everything inside it made the SECOND undo — and every one after — need an Exit.
    pushClipEdit('k1'); pushClipEdit('k2'); pushClipEdit('k3');
    for (let i = 0; i < 3; i++) expect((await undoStep('undo')).did).toBe(true);
    expect(getRunMode()).toBe('scrub');
    expect(calls).toEqual(['undo k3', 'undo k2', 'undo k1']);
  });
});

describe('a scene edit made DURING the preview session (record mode, a delete inside the envelope)', () => {
  it('undoes inside the envelope; a scene edit from before the session is still refused', async () => {
    pushProbe('Before');             // authored, pre-preview
    setPreviewUndoSession(7);
    setRunMode('scrub');
    pushProbe('Record y');           // record mode: the field edit…
    pushClipEdit('animation record'); // …then the key on top, as notifyFieldEdited → commit pushes them
    expect((await undoStep('undo')).did).toBe(true);
    expect((await undoStep('undo')).did).toBe(true);   // the recorded field edit — refused before this rule
    const r = await undoStep('undo');
    expect(r.did).toBe(false);
    expect(r.refused).toContain('"Before"');
    expect(calls).toEqual(['undo animation record', 'undo Record y']);
  });

  it('an entry from an EARLIER session is refused in a later one', async () => {
    setPreviewUndoSession(1);
    setRunMode('scrub');
    pushProbe('Old session');
    setPreviewUndoSession(2);        // a later envelope whose restore did not drop it (e.g. ended without restore)
    expect(undoRefusedReason('undo')).toContain('"Old session"');
  });

  it('dropPreviewSceneEdits removes that session\'s scene entries from BOTH stacks and keeps the rest', async () => {
    pushProbe('Before');
    setPreviewUndoSession(3);
    setRunMode('scrub');
    pushProbe('Move A');
    // A file-direct entry that does NOT re-pose — a re-posing one would reopen scrub below and
    // (correctly) refuse 'Before', which is a different test.
    pushAction({ label: 'clip key', _isFileDirect: true, undo: () => { calls.push('undo clip key'); }, redo: () => {} });
    pushProbe('Move B');
    pushAction({ label: 'Select', _isSelection: true, undo: () => {}, redo: () => {} });
    await undo();                    // Select → redo
    await undo();                    // Move B → redo stack: a scene entry on the REDO side must go too
    setPreviewUndoSession(null);
    setRunMode('stopped');
    expect(dropPreviewSceneEdits(3)).toBe(2);           // Move A (undo stack) + Move B (redo stack)
    expect(canRedo()).toBe(true);                      // Select stays on the redo stack
    calls = [];
    expect(await undo()).toBe(true);                   // clip key — kept
    expect(await undo()).toBe(true);                   // Before — untouched
    expect(await undo()).toBe(false);
    expect(calls).toEqual(['undo clip key', 'undo Before']);
  });

  it('a coalescing chain does not absorb an edit across the session boundary', async () => {
    const edit = (label: string) => pushAction({ label, coalesceKey: 'Transform.y', undo: () => { calls.push(`undo ${label}`); }, redo: () => {} });
    edit('y=1');                     // authored chain starts
    setPreviewUndoSession(4);
    setRunMode('scrub');
    edit('y=2');                     // same key, inside the window — must be its own entry
    expect(dropPreviewSceneEdits(4)).toBe(1);
    setRunMode('stopped');
    expect(await undo()).toBe(true);
    expect(calls).toEqual(['undo y=1']);
  });
});

describe('a refusal decided when the step RUNS is still reported, not read as an empty stack', () => {
  // Both calls are made while stopped, so a pre-check would pass for both. The clip undo ahead
  // re-poses and opens the envelope, which refuses the scene edit queued behind it.
  function queueSceneEditBehindClipUndo(): void {
    pushProbe('Move');
    pushClipEdit('clip key');
  }

  it('undoStep reports it', async () => {
    queueSceneEditBehindClipUndo();
    const [first, second] = await Promise.all([undoStep('undo'), undoStep('undo')]);
    expect(first).toEqual({ did: true, refused: null });
    expect(second.did).toBe(false);
    expect(second.refused).toContain('"Move"');
  });

  it('runUndoCommand toasts it', async () => {
    queueSceneEditBehindClipUndo();
    const [, second] = await Promise.all([runUndoCommand('undo'), runUndoCommand('undo')]);
    expect(second).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('"Move"');
  });

  it('the agent op answers REFUSED_BY_OP, not did:false', async () => {
    queueSceneEditBehindClipUndo();
    const [first, second] = await Promise.all([
      opReplyFor(() => runAgentOp('undo', {})), opReplyFor(() => runAgentOp('undo', {})),
    ]) as Array<{ result: { did?: boolean; ok?: boolean; code?: string } }>;
    expect(first.result.did).toBe(true);
    expect(second.result).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
  });
});

describe('runUndoCommand — the human path says WHY', () => {
  it('toasts the refusal and touches nothing inside an envelope', async () => {
    pushProbe();
    setRunMode('scrub');
    expect(await runUndoCommand('undo')).toBe(false);
    expect(calls).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('scrub');
    expect(toast.mock.calls[0][1]).toBe('warn');
  });

  it('undoes and redoes without a toast when stopped', async () => {
    pushProbe();
    expect(await runUndoCommand('undo')).toBe(true);
    expect(await runUndoCommand('redo')).toBe(true);
    expect(calls).toEqual(['undo Probe', 'redo Probe']);
    expect(toast.mock.calls).toEqual([]);
  });
});

describe('agent undo/redo ops answer a coded refusal, not did:false', () => {
  for (const m of REFUSING) {
    it(`refuses in ${m.name} with REFUSED_BY_OP naming the mode`, async () => {
      pushProbe();
      pushProbe('Redoable');
      await undo();          // stopped: Redoable → the redo stack (a push would clear it), Probe stays on top of undo
      calls = [];
      m.set();
      // Through `opReplyFor`, the seam both editor transports share — what the agent actually gets.
      const reply = await opReplyFor(() => runAgentOp('undo', {})) as { result: { ok?: boolean; code?: string; error?: string } };
      expect(reply.result.ok).toBe(false);
      expect(reply.result.code).toBe('REFUSED_BY_OP');
      expect(reply.result.error).toContain(m.mentions);
      expect(calls).toEqual([]);
      expect(canUndo()).toBe(true);
      await expect(runAgentOp('redo', {})).rejects.toThrow(m.mentions);
    });
  }

  it('undoes when stopped and reports did:true', async () => {
    pushProbe();
    const r = await runAgentOp('undo', {}) as { did?: boolean };
    expect(r.did).toBe(true);
    expect(calls).toEqual(['undo Probe']);
  });
});

describe('scene hot-reload is suppressed inside an envelope, not just Play', () => {
  for (const m of REFUSING) {
    it(`suppresses in ${m.name}`, () => {
      m.set();
      expect(sceneReloadSuppressedReason()).toContain(m.reload);
    });
  }

  it('lets the reload through when stopped', () => {
    expect(sceneReloadSuppressedReason()).toBeNull();
  });
});
