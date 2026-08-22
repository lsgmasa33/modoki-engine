/** makeBaseSceneUndo (#308) — the base-scene set/clear undo entry.
 *
 *  This site used to discard `write()`'s boolean in both directions. The issue filed it
 *  as "discards it entirely"; on inspection that overstates it — `write` already logs the
 *  /api/scene-mutate failure AND skips its own `setBaseScene`, so UI and disk stay
 *  consistent. The real gap was that the entry pops and Cmd+Z reads as done with nothing
 *  saying the UNDO did nothing. These tests pin that report, and pin that a backend
 *  failure does NOT toast (only a 409-style collision does, and this route has none). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBaseSceneUndo } from '../../src/editor/panels/assetViews/baseSceneUndo';
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

const build = (write: (v: string) => Promise<boolean>) =>
  makeBaseSceneUndo({ path: '/scenes/level.scene.json', old: '/scenes/base.scene.json', next: '', write });

describe('makeBaseSceneUndo', () => {
  it('labels by DIRECTION of the edit — clearing reads "Clear base scene"', () => {
    expect(build(async () => true).label).toBe('Clear base scene');
    expect(makeBaseSceneUndo({ path: '/p', old: '', next: '/b', write: async () => true }).label).toBe('Set base scene');
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
    await build(async () => false).redo();
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
});
