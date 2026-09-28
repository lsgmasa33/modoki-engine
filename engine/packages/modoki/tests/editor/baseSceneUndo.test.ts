/** makeBaseSceneUndo (#308) — the base-scene set/clear undo entry.
 *
 *  This site used to discard `write()`'s boolean in both directions. The issue filed it
 *  as "discards it entirely"; on inspection that overstates it — `write` already logs the
 *  /api/scene-mutate failure AND skips its own `setBaseScene`, so UI and disk stay
 *  consistent. The real gap was that the entry pops and Cmd+Z reads as done with nothing
 *  saying the UNDO did nothing. These tests pin that report, and pin that a backend
 *  failure does NOT toast (only a 409-style collision does, and this route has none). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBaseSceneUndo, baseSceneHeldBy } from '../../src/editor/panels/assetViews/baseSceneUndo';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
import { markBaseSceneEdit, clearPendingBaseScenes } from '../../src/editor/scene/pendingBaseScene';
import { useEditorStore } from '../../src/editor/store/editorStore';

// Restored in afterEach, NOT inline: a failing assertion skips the rest of the body, so an
// inline restore never runs and console stays mocked for every later test.
let spies: Array<{ mockRestore: () => void }> = [];
const spyError = () => {
  const s = vi.spyOn(console, 'error').mockImplementation(() => {});
  spies.push(s);
  return s;
};
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

// `current` (#1710) is a fake scene that holds whatever the last SUCCESSFUL write left — starting at the commit's
// `next`, or `startsHolding` for a redo run on its own — so every step here passes its hold check and these tests keep pinning the reporting alone. The check
// itself is `assetDocUndo.test.ts`'s.
const build = (write: (v: string) => Promise<boolean>, fileDirect = true, startsHolding = '') => {
  let held = startsHolding;
  return makeBaseSceneUndo({
    path: '/scenes/level.scene.json', old: '/scenes/base.scene.json', next: '', fileDirect,
    write: async (v) => { const ok = await write(v); if (ok) held = v; return ok; },
    current: async () => held,
  });
};

describe('makeBaseSceneUndo', () => {
  it('labels by DIRECTION of the edit — clearing reads "Clear base scene"', () => {
    expect(build(async () => true).label).toBe('Clear base scene');
    expect(makeBaseSceneUndo({ path: '/p', old: '', next: '/b', write: async () => true, fileDirect: true, current: async () => '/b' }).label).toBe('Set base scene');
  });

  it('undo writes the OLD value and redo writes the NEXT one', async () => {
    const written: string[] = [];
    const action = build(async (v) => { written.push(v); return true; });
    await action.undo();
    await action.redo();
    expect(written).toEqual(['/scenes/base.scene.json', '']);
  });

  it('reports when undo\'s write fails, naming the scene — and does NOT toast', async () => {
    const err = spyError();
    useEditorStore.setState({ toast: null });
    await build(async () => false).undo();

    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain('Undo');
    expect(msg).toContain('/scenes/level.scene.json');
    // A rejected scene mutation is a backend failure, not a user-fixable collision.
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('reports when redo\'s write fails, and says Redo rather than Undo', async () => {
    const err = spyError();
    await build(async () => false, true, '/scenes/base.scene.json').redo(); // as if already undone
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain('Redo');
    expect(msg).not.toMatch(/\bUndo\b/);
  });

  it('stays silent when the write succeeds', async () => {
    const err = spyError();
    const action = build(async () => true);
    await action.undo();
    await action.redo();
    expect(err).not.toHaveBeenCalled();
  });

  it('keeps _isFileDirect, or undo/redo would falsely mark the ACTIVE scene dirty', () => {
    // scene-mutate writes straight to the file, so this edit is already persisted. Losing
    // the flag would self-block a follow-up scene-mutate via the "unsaved live changes"
    // guard that route carries — a silent breakage with no test of its own otherwise.
    expect(build(async () => true)._isFileDirect).toBe(true);
  });

  // `_isFileDirect` decides whether this action contributes an edit-version bump, and #831 made it
  // a PARAMETER rather than a hardcoded `true`. Both directions are pinned: a hardcode in either
  // direction breaks exactly one of these, and neither breakage is visible from the other tests.
  it('carries fileDirect through — TRUE for a parked edit on a scene the editor has not loaded', () => {
    expect(build(async () => true, true)._isFileDirect).toBe(true);
  });

  it('carries fileDirect through — FALSE for the OPEN scene, whose bump is what makes Cmd+S write', () => {
    // Applying the ref to `setCurrentBaseScene` changes live editor state and nothing else; without
    // the bump `hasUnsavedChanges()` stays false and the save has no reason to run.
    expect(build(async () => true, false)._isFileDirect).toBe(false);
  });
});

// ── #1710: the step checks the scene still holds its own side ──
describe('makeBaseSceneUndo — refuses to revert a base changed since (#1710)', () => {
  const guarded = (held: () => Promise<string | null>) => {
    const written: string[] = [];
    const action = makeBaseSceneUndo({
      path: '/scenes/level.scene.json', old: '/scenes/a.scene.json', next: '/scenes/b.scene.json', fileDirect: true,
      write: async (v) => { written.push(v); return true; }, current: held,
    });
    return { action, written };
  };

  it('undo REFUSES when the scene no longer holds the value this commit set — and writes nothing', async () => {
    const { action, written } = guarded(async () => '/scenes/c.scene.json'); // changed from elsewhere since
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(written).toEqual([]);
  });

  it('redo REFUSES when the scene no longer holds the value the undo restored', async () => {
    const { action, written } = guarded(async () => '');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(written).toEqual([]);
  });

  it('an unreadable scene is a refusal, not a guess', async () => {
    const { action, written } = guarded(async () => null);
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(written).toEqual([]);
  });

  it('accepts when the scene holds its side', async () => {
    const { action, written } = guarded(async () => '/scenes/b.scene.json');
    await action.undo();
    expect(written).toEqual(['/scenes/a.scene.json']);
  });
});

describe('baseSceneHeldBy — what the scene holds now, as the next save leaves it', () => {
  const P = '/scenes/level.scene.json';
  afterEach(() => { clearPendingBaseScenes(); });
  const deps = (o: Partial<Parameters<typeof baseSceneHeldBy>[1]> = {}) => ({
    currentScenePath: () => null, liveBaseScene: () => undefined,
    readScene: async () => ({ baseScene: '/scenes/file.scene.json' }), ...o,
  });

  it('a PARK wins — it is what the flush writes after the scene (a parked clear reads as none)', async () => {
    markBaseSceneEdit(P, '/scenes/parked.scene.json');
    expect(await baseSceneHeldBy(P, deps({ currentScenePath: () => P, liveBaseScene: () => '/scenes/live.scene.json' }))).toBe('/scenes/parked.scene.json');
    markBaseSceneEdit(P, null);
    expect(await baseSceneHeldBy(P, deps())).toBe('');
  });

  it('the OPEN scene answers from its live value, not the file', async () => {
    expect(await baseSceneHeldBy(P, deps({ currentScenePath: () => P, liveBaseScene: () => '/scenes/live.scene.json' }))).toBe('/scenes/live.scene.json');
    expect(await baseSceneHeldBy(P, deps({ currentScenePath: () => P }))).toBe('');
  });

  it('any other scene answers from its file; a missing field is none, a failed read is null', async () => {
    expect(await baseSceneHeldBy(P, deps())).toBe('/scenes/file.scene.json');
    expect(await baseSceneHeldBy(P, deps({ readScene: async () => ({}) }))).toBe('');
    expect(await baseSceneHeldBy(P, deps({ readScene: async () => { throw new Error('gone'); } }))).toBeNull();
    expect(await baseSceneHeldBy(P, deps({ readScene: async () => null }))).toBeNull();
  });
});
