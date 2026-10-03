/** B3 rules 12 and 14 on the prefab-edit side. Driven through the real router (`makeFuzzBackend`), as
 *  openSceneMove.test.ts is: the saves write the scratch directory and the move is `/api/move-file`, whose relay runs the
 *  renderer's `applyAssetPathMoves`.
 *  - #2089: entering prefab edit saves the open scene, and that save takes its turn in the save queue. Beside a save
 *    already writing, the older write could land last, and Exit reloads the scene from that file.
 *  - #2090: the agent `edit-save` takes its turn too. Beside a human Cmd+S whose Overwrite question was open, the human's
 *    older document landed over the agent's save while the agent was told it saved.
 *  - #2096: a rename of the scene prefab edit returns to moves the return path (guid-confirmed), its record bank and the
 *    persisted last scene. Before, Exit 404'd on the old path and left the editor with no scene. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

// The move lands the file at its new path, then trashes the old one; the suite's trash guard refuses a real trash.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
/** The human's Overwrite question, held open until the test answers it. */
const modal = vi.hoisted(() => ({ asked: 0, answer: null as null | ((v: boolean) => void) }));
vi.mock('../../packages/modoki/src/editor/utils/saveDialog', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  confirmInEditor: () => { modal.asked++; return new Promise<boolean>((r) => { modal.answer = r; }); },
  alertInEditor: async () => {},
}));
/** Runs once, at the start of the next `serializeScene` a module calls through its import (the open's bank does). */
const serializeHook = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (orig) => {
  const real = await orig<typeof import('../../packages/modoki/src/editor/scene/serialize')>();
  return {
    ...real,
    serializeScene: async (...args: Parameters<typeof real.serializeScene>) => {
      const run = serializeHook.run;
      serializeHook.run = null;
      if (run) await run();
      return real.serializeScene(...args);
    },
  };
});
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, type Fixture } from './prefabFuzz/harness';
import { getAllEntities, getTraitByName, readTraitDataFull, writeTraitField } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';
import { SAVE_ALL_QUEUE_WAIT_MS } from '../../app/editor/agentEditorOps';
import { runSerialisedSave } from '../../packages/modoki/src/editor/scene/saveQueue';
import { runSaveAll } from '../../packages/modoki/src/editor/scene/saveCommand';
import { openPrefabForEditing, exitPrefabEditing, isEditingPrefab } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCurrentScenePath, lastSceneKey, getScenePersistenceProject } from '../../packages/modoki/src/editor/scene/serialize';
import { takeRecordBank } from '../../packages/modoki/src/runtime/prefab/recordBank';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';

const be = makeFuzzBackend();
const realFetch = (input: string | URL, init?: { method?: string; body?: string }) => be.fetch(input, init);
/** Per-test hold on a write to one file: the write's request waits until the test releases it. */
let holdWriteOf: { path: string; released: Promise<void> } | null = null;
vi.stubGlobal('fetch', async (input: string | URL, init?: { method?: string; body?: string }) => {
  const hold = holdWriteOf;
  if (hold && String(input).includes('/api/write-file') && (JSON.parse(init?.body ?? '{}') as { path?: string }).path?.endsWith(hold.path)) {
    holdWriteOf = null; // the first write only
    await hold.released;
  }
  return realFetch(input, init);
});
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

afterEach(() => { holdWriteOf = null; modal.answer = null; modal.asked = 0; vi.useRealTimers(); });

const transform = () => getTraitByName('Transform')!;
const named = (name: string) => getAllEntities().find((e) => e.name === name);
const tick = () => new Promise((r) => setTimeout(r, 10));
const sceneX = (f: Fixture, name: string) =>
  (JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x?: number } } }[] })
    .entities.find((e) => e.traits?.EntityAttributes?.name === name)?.traits?.Transform?.x ?? 0;
const prefabRootX = (f: Fixture) =>
  (JSON.parse(be.read(f.prefabs.H.path)!) as { entities: { traits: { Transform: { x: number } } }[] }).entities[0].traits.Transform.x;
/** Holds the save queue until `release()`: what a human save sitting in its Save As panel or Overwrite question does. */
function holdQueue() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return { release, holder: runSerialisedSave(() => held) };
}
/** The open's record bank is held under the renamed scene, where Exit's load takes it, and nothing is left at the old
 *  path for a later file there. Taken here to look at it — a reload without a bank is indistinguishable from one that
 *  seated it in this fixture (no record states its list in another form), so the bank itself is what is measured. */
function expectBankMoved(from: string, to: string) {
  expect(takeRecordBank(from), 'the bank stayed at the old path').toBeUndefined();
  expect(takeRecordBank(to), 'no bank under the renamed scene for Exit to take').toBeDefined();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('entering prefab edit saves the scene in its turn (#2089)', () => {
  it('waits for a save holding the queue, then saves and enters', async () => {
    const f = await startRun(be, async () => {}, '2089-waits');
    writeTraitField(named('Plain')!.id, transform(), 'x', 42);
    const { release, holder } = holdQueue();
    const open = openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' });
    try {
      await tick();
      await settle();
      expect(sceneX(f, 'Plain'), 'the open saved the scene while another save held the queue').toBe(0);
      expect(isEditingPrefab()).toBe(false);
    } finally {
      release(); // the queue is module state: a held save left behind jams every later test's save
    }
    await holder;
    expect(await open).toBeUndefined();
    await settle();
    expect(sceneX(f, 'Plain')).toBe(42);
    expect(isEditingPrefab()).toBe(true);
  });

  it('an edit made while an agent save_all was still writing survives the round trip (the lost-edit case)', async () => {
    const f = await startRun(be, async () => {}, '2089-lost-edit');
    writeTraitField(named('Plain')!.id, transform(), 'x', 42);
    // The agent's save serializes x=42, and its write is still on the wire…
    const wire = deferred();
    holdWriteOf = { path: f.scenePath, released: wire.promise };
    const agentSave = runAgentOp('save-all', {});
    await tick();
    // …the human edits, and double-clicks a prefab.
    writeTraitField(named('Plain')!.id, transform(), 'x', 43);
    const open = openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' });
    await tick();
    wire.resolve();
    await agentSave;
    expect(await open).toBeUndefined();
    await settle();
    expect(isEditingPrefab()).toBe(true);
    expect(sceneX(f, 'Plain'), "the agent's older write landed over the open's save").toBe(43);
    await exitPrefabEditing();
    await settle();
    expect(readTraitDataFull(named('Plain')!.id, transform())?.x, 'Exit reloaded a file that lost the edit').toBe(43);
  });

  it('the agent edit-open past its wait is refused: nothing saved, nothing swapped', async () => {
    const f = await startRun(be, async () => {}, '2089-agent-refused');
    writeTraitField(named('Plain')!.id, transform(), 'x', 42);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { release, holder } = holdQueue();
    try {
      const op = runAgentOp('prefab', { action: 'edit-open', path: f.prefabs.H.path, discardUnsaved: false })
        .then(() => null, (e: unknown) => e as { code?: string; message?: string });
      await vi.advanceTimersByTimeAsync(SAVE_ALL_QUEUE_WAIT_MS + 1);
      const err = await op;
      expect(err?.code).toBe('REFUSED_BY_OP');
      expect(err?.message).toContain('NOT run');
    } finally {
      vi.useRealTimers();
      release();
    }
    await holder;
    await runSerialisedSave(async () => {}); // the queue has drained past the abandoned turn
    await settle();
    expect(sceneX(f, 'Plain'), 'the refused open saved the scene after all').toBe(0);
    expect(isEditingPrefab()).toBe(false);
    expect(getCurrentScenePath()).toBe(f.scenePath);
  });
});

describe("the agent edit-save takes its turn in the save queue (#2090)", () => {
  it("waits for the human's Overwrite question, and its save is the one the file keeps", async () => {
    const f = await startRun(be, async () => {}, '2090-overwrite');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    const root = named('HR')!;
    writeTraitField(root.id, transform(), 'x', 1); // the human's edit
    // An outside change, so the human's Cmd+S asks Overwrite — inside the queue, holding the document it serialized.
    const outside = JSON.parse(be.read(f.prefabs.H.path)!) as { entities: { traits: { Transform: Record<string, number> } }[] };
    outside.entities[0].traits.Transform.y = 99;
    be.write(f.prefabs.H.path, `${JSON.stringify(outside, null, 2)}\n`);
    const human = runSaveAll();
    let agent: Promise<unknown>;
    try {
      await tick();
      expect(modal.asked).toBe(1);
      writeTraitField(root.id, transform(), 'x', 7); // the agent's edit, while the question is up
      agent = runAgentOp('prefab', { action: 'edit-save', overwrite: true });
      await tick();
      expect(prefabRootX(f), 'the agent saved while the human Cmd+S held the queue').toBe(0);
    } finally {
      modal.answer?.(true); // an unanswered question holds the queue for every later test
    }
    await human;
    const reply = await agent as { ok?: boolean; saved?: boolean };
    await settle();
    expect(reply.saved).toBe(true);
    expect(prefabRootX(f), "the human's older document landed over the agent's reported save").toBe(7);
  });

  it('another prefab opened while it waited: refused, and neither file written (the #2088 class)', async () => {
    const f = await startRun(be, async () => {}, '2090-switched');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    writeTraitField(named('HR')!.id, transform(), 'x', 7);
    const before = { H: be.read(f.prefabs.H.path), Q: be.read(f.prefabs.Q.path) };
    const { release, holder } = holdQueue();
    let op: Promise<{ code?: string; message?: string } | null>;
    try {
      op = runAgentOp('prefab', { action: 'edit-save' }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
      await tick();
      // The human opens Q from inside H's edit world: no scene file, so that open saves nothing and does not queue.
      expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' })).toBeUndefined();
      await settle();
      expect(useEditorStore.getState().editingPrefab?.guid).toBe(f.prefabs.Q.guid);
      writeTraitField(named('QR')!.id, transform(), 'x', 5);
    } finally {
      release();
    }
    await holder;
    const err = await op!;
    expect(err?.code).toBe('REFUSED_BY_OP');
    expect(err?.message).toContain('no longer the prefab being edited');
    expect(be.read(f.prefabs.Q.path), 'the edit-save asked of H wrote Q').toBe(before.Q);
    expect(be.read(f.prefabs.H.path)).toBe(before.H);
  });

  it('outside prefab edit it is answered at once, not after a wait for an unrelated save', async () => {
    await startRun(be, async () => {}, '2090-not-editing');
    const { release, holder } = holdQueue();
    let settled: { message?: string } | null | undefined;
    try {
      void runAgentOp('prefab', { action: 'edit-save' }).then(() => { settled = null; }, (e: unknown) => { settled = e as { message?: string }; });
      await tick();
      expect(settled?.message, 'it waited for the queue (or answered something else)').toContain('NOT in prefab-edit mode');
    } finally {
      release();
    }
    await holder;
  });

  it('past its wait it is refused, and writes nothing once the queue frees', async () => {
    const f = await startRun(be, async () => {}, '2090-refused');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    writeTraitField(named('HR')!.id, transform(), 'x', 7);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { release, holder } = holdQueue();
    try {
      const op = runAgentOp('prefab', { action: 'edit-save' }).then(() => null, (e: unknown) => e as { code?: string; message?: string });
      await vi.advanceTimersByTimeAsync(SAVE_ALL_QUEUE_WAIT_MS + 1);
      const err = await op;
      expect(err?.code).toBe('REFUSED_BY_OP');
      expect(err?.message).toContain('NOTHING was written');
    } finally {
      vi.useRealTimers();
      release();
    }
    await holder;
    await runSerialisedSave(async () => {});
    await settle();
    expect(prefabRootX(f), 'the refused edit-save wrote after all').toBe(0);
  });
});

describe('a rename of the scene prefab edit returns to (#2096)', () => {
  const move = async (from: string, to: string) => {
    const res = await be.fetch('/api/move-file', { method: 'POST', body: JSON.stringify({ from, to }) });
    expect((await res.json() as { error?: string }).error).toBeUndefined();
    await settle();
  };

  it('Exit reloads the renamed scene; its bank and the last scene follow', async () => {
    const f = await startRun(be, async () => {}, '2096-exit');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    await move(f.scenePath, renamed);
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(renamed);
    expect(localStorage.getItem(lastSceneKey(getScenePersistenceProject())), 'the next launch would open the old path').toBe(renamed);
    expectBankMoved(f.scenePath, renamed);
    const errors = vi.spyOn(console, 'error');
    await exitPrefabEditing();
    await settle();
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('404'))).toEqual([]);
    expect(isEditingPrefab()).toBe(false);
    expect(getCurrentScenePath(), 'Exit stranded the editor with no scene').toBe(renamed);
    expect(named('Plain')).toBeDefined();
  });

  it("the open records the scene's guid, and a nested open keeps the outer one, so the move still follows", async () => {
    const f = await startRun(be, async () => {}, '2096-nested');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    expect(useEditorStore.getState().prefabReturnSceneGuid).toBe(f.sceneGuid);
    expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' })).toBeUndefined(); // from inside H's edit world
    await settle();
    expect(useEditorStore.getState().editingPrefab?.guid).toBe(f.prefabs.Q.guid);
    expect(useEditorStore.getState().prefabReturnSceneGuid).toBe(f.sceneGuid);
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    await move(f.scenePath, renamed);
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(renamed);
  });

  /** A move landing while the edit world LOADS (#2096 close-out review): the open's adoption seated the return path it
   *  captured before the load, over the store the move had repaired (nested) or before there was one (top level). */
  function moveDuringEditWorldLoad(from: string, to: string) {
    const orig = sceneManager.loadScene.bind(sceneManager);
    let done = false;
    vi.spyOn(sceneManager, 'loadScene').mockImplementation(async (path, opts) => {
      // The route alone, not `move`'s settle: this open's own adoption is what is still landing.
      if (!done && path.startsWith('/__prefab-edit__')) { done = true; await be.fetch('/api/move-file', { method: 'POST', body: JSON.stringify({ from, to }) }); }
      return orig(path, opts);
    });
  }

  it('a rename landing while the edit world loads: its bank follows and Exit still reloads the renamed scene', async () => {
    const f = await startRun(be, async () => {}, '2096-mid-open');
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    moveDuringEditWorldLoad(f.scenePath, renamed);
    try {
      expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
      await settle();
    } finally {
      vi.restoreAllMocks();
    }
    expect(isEditingPrefab()).toBe(true);
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(renamed);
    expectBankMoved(f.scenePath, renamed);
    await exitPrefabEditing();
    await settle();
    expect(getCurrentScenePath(), 'Exit stranded the editor with no scene').toBe(renamed);
  });

  it("a rename landing while the open banks the scene's records: the bank is made under the new path", async () => {
    const f = await startRun(be, async () => {}, '2096-mid-bank');
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    let ran = false;
    serializeHook.run = async () => {
      ran = true;
      await be.fetch('/api/move-file', { method: 'POST', body: JSON.stringify({ from: f.scenePath, to: renamed }) });
    };
    try {
      expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
      await settle();
    } finally {
      serializeHook.run = null;
    }
    expect(ran, 'the open made no bank, so this did not reach the window').toBe(true);
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(renamed);
    expectBankMoved(f.scenePath, renamed);
    await exitPrefabEditing();
    await settle();
    expect(getCurrentScenePath()).toBe(renamed);
  });

  it('a rename landing while a NESTED edit world loads: the inner adoption does not seat the old path back', async () => {
    const f = await startRun(be, async () => {}, '2096-mid-nested');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    moveDuringEditWorldLoad(f.scenePath, renamed);
    try {
      expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' })).toBeUndefined();
      await settle();
    } finally {
      vi.restoreAllMocks();
    }
    expect(useEditorStore.getState().editingPrefab?.guid).toBe(f.prefabs.Q.guid);
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(renamed);
    await exitPrefabEditing();
    await settle();
    expect(getCurrentScenePath()).toBe(renamed);
  });

  it('a move nominating the return path but not its guid leaves it', async () => {
    const f = await startRun(be, async () => {}, '2096-guid');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' })).toBeUndefined();
    await settle();
    // Another file's guid: the move names this path, but the manifest places that guid elsewhere, so it is not this file.
    useEditorStore.setState({ prefabReturnSceneGuid: f.prefabs.Q.guid });
    await move(f.scenePath, f.scenePath.replace(/\.json$/, ' renamed.json'));
    expect(useEditorStore.getState().prefabReturnScenePath).toBe(f.scenePath);
  });
});
