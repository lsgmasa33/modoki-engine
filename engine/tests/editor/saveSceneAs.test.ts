/** `saveScene({ path })` naming another file than the open scene's is an agent Save As (#1414).
 *
 *  Before the fix it wrote the open scene's OWN id into the copy with a plain `/api/write-file`,
 *  and the dev scanner's heal then re-minted one of the two files — the committed original, when
 *  the copy sorted first. Now the copy goes through `/api/scene-save-as`, which stamps a fresh id and
 *  re-mints the entity guids (its own test: tests/plugins/sceneSaveAsRoute.test.ts), and the ORIGINAL
 *  file is never written. The accept side matters as much: saving to the open scene's own path —
 *  including a case-variant spelling (#1273) — must stay a plain save that keeps its id. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset, getGuidForPath, resolveGuidToPath } from '@modoki/engine/runtime';
import {
  clearHistory, clearDirtyAssets, saveScene, saveAll, setCurrentScenePath, markSceneSaved, getCurrentScenePath, hasUnsavedChanges,
} from '@modoki/engine/editor';
import { classifyExplicitSceneSave } from '../../packages/modoki/src/editor/scene/sceneFileName';
import { markSceneDirty, clearAllSceneDirty, isSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { swapHistory, forgetHistory, undoDepth, pushAction } from '../../packages/modoki/src/editor/undo/undoManager';
import { sceneManager, type LoadedSceneEntry } from '@modoki/engine/runtime';
import { noteAuthoredWriteWhileStopped, clearAuthoredWritesWhileStopped } from '../../packages/modoki/src/runtime/core/ecs/authoredWrites';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { found } from '@modoki/engine/testing/inOrder';

const OPEN_PATH = '/assets/scenes/Level.scene.json';
const OPEN_ID = '00000031-0000-4000-8000-000000000031';
const COPY_PATH = '/assets/scenes/copy.scene.json';
const COPY_ID = '00000032-0000-4000-8000-000000000032';
const REPLACED_ID = '00000033-0000-4000-8000-000000000033';

registerAllTraits();

let game: TestWorld | undefined;
let calls: { url: string; body: { path?: string; content?: string; openPath?: string } }[] = [];
/** Per-test override of the /api/scene-save-as answer and of what happens during that request. */
let saveAsAnswer: () => Response;
let duringSaveAs: () => void;
let writeFileOk: (path: string) => boolean;

beforeEach(() => {
  registerAsset(OPEN_ID, OPEN_PATH, 'scene');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  setCurrentScenePath(OPEN_PATH);
  markSceneSaved();
  calls = [];
  clearAllSceneDirty();
  saveAsAnswer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, guid: COPY_ID, path: COPY_PATH }) }) as unknown as Response;
  duringSaveAs = () => {};
  writeFileOk = () => true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url: u, body });
    if (u.includes('/api/scene-save-as')) { duringSaveAs(); return saveAsAnswer(); }
    if (u.includes('/api/write-file')) { const ok = writeFileOk(body.path); return { ok, json: async () => ({ ok }) } as unknown as Response; }
    // Anything else — the reopen's scene fetch — fails, so the copy is NOT reopened here. The
    // reopen itself needs a real SceneManager load and is covered by the live smoke case.
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
});

afterEach(() => {
  game?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The reopen's own fetch of the copy — anything that is not an /api/ call and names the copy. */
const reopenFetches = () => calls.filter((c) => !c.url.includes('/api/') && c.url.includes('copy.scene.json'));

const writes = () => calls.filter((c) => c.url.includes('/api/write-file'));
const saveAsCalls = () => calls.filter((c) => c.url.includes('/api/scene-save-as'));

describe('classifyExplicitSceneSave', () => {
  const base = { currentPath: OPEN_PATH, openSceneId: OPEN_ID, targetGuid: undefined, loadedPaths: [OPEN_PATH] };
  it('the open scene\'s own path is `same`, in any case', () => {
    expect(classifyExplicitSceneSave(OPEN_PATH, base)).toBe('same');
    expect(classifyExplicitSceneSave(OPEN_PATH.toLowerCase(), base)).toBe('same');
  });
  it('a path the manifest registers under the open scene\'s id is `same`', () => {
    expect(classifyExplicitSceneSave('/@fs/x/Level.scene.json', { ...base, targetGuid: OPEN_ID })).toBe('same');
  });
  it('another file is `save-as`', () => {
    expect(classifyExplicitSceneSave(COPY_PATH, base)).toBe('save-as');
    expect(classifyExplicitSceneSave(COPY_PATH, { ...base, targetGuid: REPLACED_ID })).toBe('save-as');
  });
  it('another LOADED scene (a base) is `target-loaded`', () => {
    expect(classifyExplicitSceneSave('/assets/scenes/Base.scene.json', { ...base, loadedPaths: [OPEN_PATH, '/assets/scenes/Base.scene.json'] })).toBe('target-loaded');
  });
  it('with nothing open under a path it is `untitled`', () => {
    expect(classifyExplicitSceneSave(COPY_PATH, { ...base, currentPath: null })).toBe('untitled');
  });
});

describe('saveScene — explicit path', () => {
  it('Save As sends the scene to /api/scene-save-as and never writes the original', async () => {
    const r = await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(saveAsCalls()).toHaveLength(1);
    expect(saveAsCalls()[0].body.path).toBe(COPY_PATH);
    expect(writes()).toHaveLength(0);
    expect(r.saved).toBe(true);
    expect(r.path).toBe(COPY_PATH);
    expect(r.savedAs?.from).toBe(OPEN_PATH);
    // The reopen failed here (see the fetch stub), so the editor stays on the original, which is
    // still unsaved — and says so, rather than claiming the scene moved.
    expect(r.savedAs?.reopened).toBe(false);
    expect(getCurrentScenePath()).toBe(OPEN_PATH);
    // The copy is registered under the id the BACKEND minted; the original keeps its own.
    expect(getGuidForPath(COPY_PATH)).toBe(COPY_ID);
    expect(getGuidForPath(OPEN_PATH)).toBe(OPEN_ID);
  });

  it('Save As over an existing scene drops the replaced scene\'s old id', async () => {
    registerAsset(REPLACED_ID, COPY_PATH, 'scene');
    expect(resolveGuidToPath(REPLACED_ID)).toBe(COPY_PATH);
    await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(getGuidForPath(COPY_PATH)).toBe(COPY_ID);
    // The accepted consequence (owner, 2026-09-18): what referenced the replaced scene no longer
    // resolves — rather than silently resolving to the copy through a stale manifest entry.
    expect(resolveGuidToPath(REPLACED_ID)).toBeUndefined();
  });

  it('saving to the open scene\'s own path is a plain save that keeps its id', async () => {
    const r = await saveScene({ path: OPEN_PATH, allowDialog: false });
    expect(saveAsCalls()).toHaveLength(0);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.path).toBe(OPEN_PATH);
    expect(JSON.parse(writes()[0].body.content!).id).toBe(OPEN_ID);
    expect(r.savedAs).toBeUndefined();
  });

  it('a case-variant spelling of the open path writes the ORIGINAL spelling, keeping the id', async () => {
    await saveScene({ path: OPEN_PATH.toLowerCase(), allowDialog: false });
    expect(saveAsCalls()).toHaveLength(0);
    expect(writes()[0].body.path).toBe(OPEN_PATH);
    expect(JSON.parse(writes()[0].body.content!).id).toBe(OPEN_ID);
    expect(getCurrentScenePath()).toBe(OPEN_PATH);
  });
});

describe('saveScene — Save As, the review findings (#1414 close-out)', () => {
  it('the backend answering sameFile (another spelling of the open file) turns into a PLAIN save of the original, keeping its id', async () => {
    saveAsAnswer = () => ({ ok: false, status: 409, json: async () => ({ sameFile: true }) }) as unknown as Response;
    const r = await saveScene({ path: '/assets/scenes/./Level.scene.json', allowDialog: false });
    expect(saveAsCalls()[0].body.openPath).toBe(OPEN_PATH);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.path).toBe(OPEN_PATH);
    expect(JSON.parse(writes()[0].body.content!).id).toBe(OPEN_ID);
    expect(r).toMatchObject({ saved: true, path: OPEN_PATH });
    expect(r.savedAs).toBeUndefined();
    expect(getGuidForPath(OPEN_PATH)).toBe(OPEN_ID);
  });

  it('with no edit during the write, the copy IS reopened (the control for the next test)', async () => {
    await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(reopenFetches().length).toBeGreaterThan(0);
  });

  it('an edit landing during the copy write keeps the editor on the original — no reopen, and the note says why', async () => {
    duringSaveAs = () => pushAction({ label: 'edit mid-save', undo: () => {}, redo: () => {} });
    const r = await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(reopenFetches()).toHaveLength(0);
    expect(r.savedAs).toMatchObject({ reopened: false });
    expect(r.savedAs?.note).toMatch(/edit landed/);
  });

  describe('with a dirty BASE loaded under the open scene', () => {
    const BASE_PATH = '/assets/scenes/Base.scene.json';
    const BASE_ID = '00000034-0000-4000-8000-000000000034';
    beforeEach(() => {
      vi.spyOn(sceneManager, 'getLoadedScenes').mockReturnValue(new Map([
        [OPEN_ID, { guid: OPEN_ID, path: OPEN_PATH, role: 'primary' } as unknown as LoadedSceneEntry],
        [BASE_ID, { guid: BASE_ID, path: BASE_PATH, role: 'base' } as unknown as LoadedSceneEntry],
      ]) as never);
      markSceneDirty(BASE_ID);
    });

    it('the base is written BEFORE the copy — the reopen reloads it from disk', async () => {
      const r = await saveScene({ path: COPY_PATH, allowDialog: false });
      const baseAt = found(calls.findIndex((c) => c.url.includes('/api/write-file') && c.body.path === BASE_PATH), 'the base write');
      const copyAt = found(calls.findIndex((c) => c.url.includes('/api/scene-save-as')), 'the copy write');
      expect(baseAt).toBeLessThan(copyAt);
      expect(r.extraSaved).toEqual([{ path: BASE_PATH, guid: BASE_ID }]);
      expect(isSceneDirty(BASE_ID)).toBe(false);
    });

    it('the same-file fallback still reports the base it wrote first', async () => {
      saveAsAnswer = () => ({ ok: false, status: 409, json: async () => ({ sameFile: true }) }) as unknown as Response;
      const r = await saveScene({ path: '/assets/scenes/./Level.scene.json', allowDialog: false });
      expect(r).toMatchObject({ saved: true, path: OPEN_PATH });
      expect(r.extraSaved).toEqual([{ path: BASE_PATH, guid: BASE_ID }]);
    });

    it('the loaded paths go to the backend, so it can refuse a base under another spelling', async () => {
      saveAsAnswer = () => ({ ok: false, status: 409, json: async () => ({ targetLoaded: true }) }) as unknown as Response;
      const r = await saveScene({ path: '/assets/scenes/./Base.scene.json', allowDialog: false });
      expect((saveAsCalls()[0].body as { loadedPaths?: string[] }).loadedPaths).toEqual([OPEN_PATH, BASE_PATH]);
      expect(r).toMatchObject({ saved: false, reason: 'target-loaded' });
      expect(writes().filter((c) => c.body.path !== BASE_PATH)).toHaveLength(0);
    });

    it('a base dirtied again during the copy write is written twice but reported ONCE (saveAll)', async () => {
      duringSaveAs = () => markSceneDirty(BASE_ID);
      const r = await saveAll({ path: COPY_PATH, allowDialog: false });
      expect(calls.filter((c) => c.url.includes('/api/write-file') && c.body.path === BASE_PATH)).toHaveLength(2);
      expect(r.extraSaved).toEqual([{ path: BASE_PATH, guid: BASE_ID }]);
    });

    it('a base that fails to write means NO copy, and the failure is reported', async () => {
      writeFileOk = (pth) => pth !== BASE_PATH;
      const r = await saveScene({ path: COPY_PATH, allowDialog: false });
      expect(saveAsCalls()).toHaveLength(0);
      expect(r).toMatchObject({ saved: false, reason: 'write-failed' });
      expect(r.failed?.[0]?.path).toBe(BASE_PATH);
      expect(isSceneDirty(BASE_ID)).toBe(true);
    });
  });
});

describe('forgetHistory', () => {
  it('drops a kept stack, so the next visit to that key starts empty', () => {
    swapHistory('/a.scene.json');
    pushAction({ label: 'edit on a', undo: () => {}, redo: () => {} });
    swapHistory('/b.scene.json');
    forgetHistory('/a.scene.json');
    swapHistory('/a.scene.json');
    expect(undoDepth()).toBe(0);
  });

  it('keeps the stack when not asked to (the control)', () => {
    swapHistory('/c.scene.json');
    pushAction({ label: 'edit on c', undo: () => {}, redo: () => {} });
    swapHistory('/d.scene.json');
    swapHistory('/c.scene.json');
    expect(undoDepth()).toBe(1);
  });

  it('a Save As over a file forgets that file\'s kept stack before reopening it', async () => {
    swapHistory(COPY_PATH);
    pushAction({ label: 'old edit on the target', undo: () => {}, redo: () => {} });
    swapHistory(OPEN_PATH);
    await saveScene({ path: COPY_PATH, allowDialog: false });
    swapHistory(COPY_PATH);
    expect(undoDepth()).toBe(0);
  });
});

describe('saveScene — Save As, the second review (#1414 close-out)', () => {
  it('a scene load landing during the round trip is NOT overwritten by the same-file fallback', async () => {
    const OTHER = '/assets/scenes/other.scene.json';
    duringSaveAs = () => setCurrentScenePath(OTHER);
    saveAsAnswer = () => ({ ok: false, status: 409, json: async () => ({ sameFile: true }) }) as unknown as Response;
    const r = await saveScene({ path: '/assets/scenes/./Level.scene.json', allowDialog: false });
    expect(writes()).toHaveLength(0);
    expect(r).toMatchObject({ saved: false, reason: 'superseded', path: OPEN_PATH });
  });

  it('the edit-landed stay path forgets the overwritten file\'s kept undo stack too', async () => {
    swapHistory(COPY_PATH);
    pushAction({ label: 'old edit on the target', undo: () => {}, redo: () => {} });
    swapHistory(OPEN_PATH);
    duringSaveAs = () => pushAction({ label: 'edit mid-save', undo: () => {}, redo: () => {} });
    const r = await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(r.savedAs?.reopened).toBe(false);
    swapHistory(COPY_PATH);
    expect(undoDepth()).toBe(0);
  });

  it('the #124 authored-writes warning is printed BEFORE the reopen, which clears its records', async () => {
    clearAuthoredWritesWhileStopped();
    noteAuthoredWriteWhileStopped(1, 'Probe', 'Transform', 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveScene({ path: COPY_PATH, allowDialog: false });
    expect(warn.mock.calls.some(([m]) => String(m).includes('Probe.Transform.x'))).toBe(true);
    clearAuthoredWritesWhileStopped();
  });
});

describe('writePrimaryScene — a load landing during the write (#1414 close-out review)', () => {
  it('the new scene keeps its path and its unsaved state', async () => {
    const OTHER = '/assets/scenes/other.scene.json';
    writeFileOk = () => { setCurrentScenePath(OTHER); return true; };
    pushAction({ label: 'unsaved edit in the scene that is about to load', undo: () => {}, redo: () => {} });
    const r = await saveScene({ allowDialog: false });
    expect(r).toMatchObject({ saved: true, path: OPEN_PATH });
    expect(getCurrentScenePath()).toBe(OTHER);
    expect(hasUnsavedChanges()).toBe(true);
  });
});
