/** #2069: a parked `baseScene` edit on a file that becomes the OPEN scene is never flushed file-direct — the flush would
 *  write the file, and the next save overwrite it with the stale in-memory base, both reported ok. The one check
 *  (`reconcileBaseScenePark`) runs at the two seams a path becomes the open scene:
 *   - READ from the file (a load, a hot reload — the adoption owner): the park is APPLIED to the opened document, which
 *     is left unsaved;
 *   - BOUND to it without reading it (`setCurrentScenePath`, every other writer): the park is DROPPED and reported.
 *  And the save entry points share one queue, so no flush is in flight while a save replaces a file.
 *  The #2050 routes (Save As, an untitled save over a file, the dialog's Replace) stay in saveSceneAs.test.ts and
 *  saveSceneDialogReplacePark.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset, getCurrentWorld } from '@modoki/engine/runtime';
import {
  clearHistory, clearDirtyAssets, saveAll, setCurrentScenePath, markSceneSaved, getCurrentScenePath, hasUnsavedChanges,
  adoptWorldReloadedFromDisk, newScene, runSerialisedSave, SaveQueueBusyError, runSaveAll,
} from '@modoki/engine/editor';
import { getCreatableAssets } from '../../packages/modoki/src/editor/panels/creatableAssets';
import { registerBuiltinCreatableAssets } from '../../packages/modoki/src/editor/panels/builtinCreatableAssets';
import { getCurrentBaseScene, setCurrentBaseScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps, SAVE_ALL_QUEUE_WAIT_MS } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { pushAction } from '../../packages/modoki/src/editor/undo/undoManager';
import {
  markBaseSceneEdit, getPendingBaseScenePaths, clearPendingBaseScenes, applyBaseSceneEdit, flushPendingBaseScenes,
} from '../../packages/modoki/src/editor/scene/pendingBaseScene';

const OPEN_PATH = '/assets/scenes/Level.scene.json';
const OPEN_ID = '00000061-0000-4000-8000-000000000061';
const X = '/assets/scenes/Other.scene.json';
const BASE = '/assets/scenes/Base.scene.json';

registerAllTraits();

let game: TestWorld | undefined;
let calls: { url: string; body: { path?: string } }[] = [];
/** Per-test override of /api/scene-mutate; unset, it answers ok. */
let mutateAnswer: ((path: string) => Promise<Response>) | undefined;
const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response;
const mutates = () => calls.filter((c) => c.url.includes('/api/scene-mutate')).map((c) => c.body.path);

/** Re-adopt the live world as if `path` had just been READ from disk — the adoption seam a load and a hot reload share. */
const openFromDisk = (path: string) => adoptWorldReloadedFromDisk(path, async () => ({ world: getCurrentWorld(), keptBaseGuids: new Set<string>() }) as never);

beforeEach(() => {
  registerAsset(OPEN_ID, OPEN_PATH, 'scene');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  setCurrentScenePath(OPEN_PATH);
  setCurrentBaseScene(undefined);
  markSceneSaved();
  calls = [];
  mutateAnswer = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url: u, body });
    if (u.includes('/api/scene-mutate')) return mutateAnswer ? mutateAnswer(body.path) : okResponse();
    if (u.includes('/api/write-file')) return okResponse();
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  clearPendingBaseScenes();
  game?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OPENED — the world is read from the parked file (#2069 row 5)', () => {
  it('applies the park to the opened scene, leaves it unsaved, and the next save never mutates the file', async () => {
    markBaseSceneEdit(X, BASE);
    await openFromDisk(X);
    expect(getCurrentScenePath()).toBe(X);
    expect(getCurrentBaseScene()).toBe(BASE);
    expect(getPendingBaseScenePaths()).toEqual([]);
    expect(hasUnsavedChanges(), 'the file does not hold the base yet').toBe(true);
    const r = await saveAll({ allowDialog: false });
    expect(r.saved).toBe(true);
    expect(mutates()).not.toContain(X);
    const written = calls.find((c) => c.url.includes('/api/write-file'));
    expect(JSON.parse((written!.body as { content: string }).content).baseScene, 'the scene write carries it').toBe(BASE);
  });

  it('a pending CLEAR applies as no base', async () => {
    setCurrentBaseScene(BASE); // stands in for the base the open read would load — overwritten below by the adoption
    markBaseSceneEdit(X, null);
    await openFromDisk(X);
    expect(getCurrentBaseScene()).toBeUndefined();
    expect(getPendingBaseScenePaths()).toEqual([]);
  });

  it('a park under another SPELLING of the opened file is the same park', async () => {
    markBaseSceneEdit(X.replace('Other', 'other'), BASE);
    await openFromDisk(X);
    expect(getCurrentBaseScene()).toBe(BASE);
    expect(getPendingBaseScenePaths()).toEqual([]);
  });

  it('a park on ANOTHER file is left alone, and the opened scene stays clean (the control)', async () => {
    markBaseSceneEdit(OPEN_PATH, BASE);
    await openFromDisk(X);
    expect(getCurrentBaseScene()).toBeUndefined();
    expect(getPendingBaseScenePaths()).toEqual([OPEN_PATH]);
    expect(hasUnsavedChanges(), 'only the park is unsaved').toBe(true);
    clearPendingBaseScenes();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('the in-flight version: a flush holding the park when the file is opened — applied, not re-parked, not written after', async () => {
    // The flush holds A's mutate, so X (later in its batch) has not been written when X is opened.
    const A = '/assets/scenes/A.scene.json';
    markBaseSceneEdit(A, BASE);
    markBaseSceneEdit(X, BASE);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inMutate = new Promise<void>((r) => { entered = r; });
    mutateAnswer = async (path) => { if (path === A) { entered(); await held; } return okResponse(); };
    const flushing = flushPendingBaseScenes();
    await inMutate;
    await openFromDisk(X);
    expect(getCurrentBaseScene()).toBe(BASE);
    release();
    const r = await flushing;
    expect(mutates(), 'X was opened before its turn, so its file is written by the next scene save instead').toEqual([A]);
    expect(r.saved).toEqual([A]);
    expect(getPendingBaseScenePaths()).toEqual([]);
  });
});

describe('BOUND — the world is bound to the parked file without reading it (#2069 rows 4, 6)', () => {
  it('Create Scene over X (newScene binds the path) drops X\'s park and warns', async () => {
    markBaseSceneEdit(X, BASE);
    await newScene(X);
    expect(getCurrentScenePath()).toBe(X);
    expect(getCurrentBaseScene()).toBeUndefined();
    expect(getPendingBaseScenePaths()).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls.some(([m]) => String(m).includes('baseScene edit was dropped'))).toBe(true);
  });

  it('an untitled save to another SPELLING of the parked file drops it, says so, and never mutates it (row 6)', async () => {
    registerEditorAgentOps();
    setCurrentScenePath(null);
    markBaseSceneEdit(X, BASE);
    const lower = X.replace('Other', 'other');
    const ok = await runAgentOp('save-all', { path: lower }) as { ok?: boolean; droppedBaseSceneEdit?: boolean };
    expect(ok.ok).toBe(true);
    expect(ok.droppedBaseSceneEdit).toBe(true);
    expect(mutates()).toEqual([]);
    expect(getPendingBaseScenePaths()).toEqual([]);
  });

  it('a rename-style bind of the path the world already holds drops nothing (the control: the path did not change)', () => {
    markBaseSceneEdit(X, BASE);
    expect(setCurrentScenePath(OPEN_PATH)).toEqual({});
    expect(getPendingBaseScenePaths()).toEqual([X]);
  });

  it('an ADOPTION binding the path does not drop it — the adoption applies it instead', () => {
    markBaseSceneEdit(X, BASE);
    expect(setCurrentScenePath(X, 'adopted')).toEqual({});
    expect(getPendingBaseScenePaths()).toEqual([X]);
  });
});

describe('a park cannot be MADE on the open scene under another spelling', () => {
  it('applyBaseSceneEdit takes the live route for a case-variant of the open path', () => {
    const live: (string | undefined)[] = [];
    expect(applyBaseSceneEdit(OPEN_PATH.toLowerCase(), BASE, OPEN_PATH, (b) => live.push(b))).toBe('live');
    expect(live).toEqual([BASE]);
    expect(getPendingBaseScenePaths()).toEqual([]);
  });
});

describe('saves are serialised (#2069 rows 7–8)', () => {
  it('the agent save-all waits for a save already running, then runs its own', async () => {
    registerEditorAgentOps();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const first = runSerialisedSave(async () => { await held; order.push('first'); });
    const agent = runAgentOp('save-all', {}).then(() => order.push('agent'), () => order.push('agent'));
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect(calls, 'the agent save ran while another save held the queue').toEqual([]);
    } finally {
      release(); // the queue is module state: a held save left behind jams every later test's save
    }
    await Promise.all([first, agent]);
    expect(order).toEqual(['first', 'agent']);
  });

  it('a failed save does not jam the queue', async () => {
    await expect(runSerialisedSave(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(runSerialisedSave(async () => 'next')).resolves.toBe('next');
  });
});

/** Holds the save queue until `release()` — what a human save sitting in its Save As panel does. */
function holdQueue() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const holder = runSerialisedSave(() => held);
  return { release, holder };
}

describe('the #2069 close-out review', () => {
  it('a SECOND open of the file in one flush does not re-apply the superseded entry over a newer live edit', async () => {
    const A = '/assets/scenes/A.scene.json';
    const NEWER = '/assets/scenes/Newer.scene.json';
    markBaseSceneEdit(A, BASE);
    markBaseSceneEdit(X, BASE);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inMutate = new Promise<void>((r) => { entered = r; });
    mutateAnswer = async (path) => { if (path === A) { entered(); await held; } return okResponse(); };
    const flushing = flushPendingBaseScenes();
    try {
      await inMutate;
      await openFromDisk(X); // applies BASE
      applyBaseSceneEdit(X, NEWER, getCurrentScenePath(), setCurrentBaseScene); // the human edits it live
      // A second READ of X in the same flush (a hot reload; a reopen after Discard) — the flush still holds X's old
      // entry. The world takes the FILE's base (none here: disk wins on a reload), never the entry already handed out.
      await openFromDisk(X);
      expect(getCurrentBaseScene(), 'the superseded in-flight value was applied a second time').toBeUndefined();
      expect(hasUnsavedChanges(), 'and the reopened scene was marked unsaved for it').toBe(false);
    } finally {
      release();
    }
    await flushing;
  });

  it('an open landing while its mutate is on the wire, refused by the route: not reported as still pending', async () => {
    markBaseSceneEdit(X, BASE);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inMutate = new Promise<void>((r) => { entered = r; });
    mutateAnswer = async () => { entered(); await held; return { ok: false, status: 409, json: async () => ({ ok: false, error: 'unsaved' }) } as unknown as Response; };
    const flushing = flushPendingBaseScenes();
    await inMutate;
    await openFromDisk(X);
    release();
    const r = await flushing;
    expect(r.failed, 'X is applied live, not pending — "call save_all again" would be false').toEqual([]);
    expect(getPendingBaseScenePaths()).toEqual([]);
    expect(getCurrentBaseScene()).toBe(BASE);
  });

  it('runSaveAll (the human Cmd+S) waits for a save already running', async () => {
    const { release, holder } = holdQueue();
    pushAction({ label: 'an edit to save', undo: () => {}, redo: () => {} });
    const human = runSaveAll();
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect(calls, 'Cmd+S wrote while another save held the queue').toEqual([]);
    } finally {
      release();
    }
    await holder;
    await human;
    expect(calls.some((c) => c.url.includes('/api/write-file'))).toBe(true);
  });

  it('Create Scene waits for a save already running before it binds and writes', async () => {
    registerBuiltinCreatableAssets();
    const { release, holder } = holdQueue();
    const created = getCreatableAssets().find((d) => d.id === 'scene')!.create!(X);
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect(getCurrentScenePath(), 'Create Scene bound the path while another save held the queue').toBe(OPEN_PATH);
    } finally {
      release();
    }
    await holder;
    await created;
    expect(getCurrentScenePath()).toBe(X);
  });

  it('a queued call past its maxWaitMs is rejected and its body NEVER runs, even once the queue frees', async () => {
    const { release, holder } = holdQueue();
    let ran = false;
    const late = runSerialisedSave(async () => { ran = true; }, { maxWaitMs: 20 });
    await expect(late).rejects.toBeInstanceOf(SaveQueueBusyError);
    release();
    await holder;
    await runSerialisedSave(async () => {}); // the queue has drained past the abandoned turn
    expect(ran, 'the save ran after its caller was told it did not').toBe(false);
  });

  it('the agent save-all is refused (REFUSED_BY_OP, nothing written) once its wait passes', async () => {
    registerEditorAgentOps();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { release, holder } = holdQueue();
    try {
      const op = runAgentOp('save-all', {}).then(() => null, (e: unknown) => e as { code?: string; message?: string });
      await vi.advanceTimersByTimeAsync(SAVE_ALL_QUEUE_WAIT_MS + 1);
      const err = await op;
      expect(err?.code).toBe('REFUSED_BY_OP');
      expect(err?.message).toContain('NOT run');
    } finally {
      vi.useRealTimers();
      release();
    }
    await holder;
    await runSerialisedSave(async () => {});
    expect(calls, 'the refused save ran after all').toEqual([]);
  });
});
