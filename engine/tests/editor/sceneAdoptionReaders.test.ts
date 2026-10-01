/** #1750 — readers of the world (docs/scene-loading.md § "Readers of the world: what they may assume"). A disk writer
 *  pairs the editor's scene state (the path, the prefab-edit flag) with the world's bytes, so it refuses while the two do
 *  not describe each other (R1); a reader that carries a capture across an await re-establishes, before it acts, that it
 *  is still in the same ADOPTED world (R2). Refused, never waited for and never re-targeted (owner, 2026-09-28).
 *
 *  Driven through the real `saveScene`, `newScene`, `loadScene`, `openPrefabForEditing`, `savePrefabEditReport`,
 *  `commitPrefabWrites`, `enterPlay` and adoption owner. `SceneManager` is the stub `sceneAdoption.test.ts` uses — every
 *  load PROMOTES A WORLD of its own and can be held before its swap or in its post-swap tail — plus a hold before
 *  `replaceWorldContent`'s swap (Create Scene's path-ahead window). Every disk write is recorded, none reaches a server.
 *
 *  Mutations (each goes red here, and only its own cases):
 *  - drop the `whyWorldNotAuthored` source (`registerPosedWorldSource(SCENE_SWITCH_LANDING, …)`) → every R1 refusal:
 *    the save in a load's tail, the edit-open in another's tail, the prefab-edit save, the save in newScene's windows
 *    and the save while the FIRST route is pending.
 *  - `editorStateCurrent` becomes `isWorldAdopted()` alone → the never-adopted ACCEPT side and the first route's
 *    before-swap save; drops its pending-route loop (true whenever the world is not the adopted one… i.e. always
 *    true) → every refusal in a tail.
 *  - drop `adoption.writingAhead()` in `newScene` → the path-ahead case only.
 *  - drop `refuseUnsavable` before the edit-open's save → the human-route case (its save refuses anyway, so only the
 *    discard dialog it would then ask tells them apart); drop the late one → Play pressed during that dialog.
 *  - `commitPrefabWrites` takes the bare world again (`captureAdoptionGate` → `() => true`) → its State-4 case.
 *  - drop `|| !adopted()` from Play's re-check → both #1748 cases.
 *  - register the switch source as an ordinary one (no `fallback`) → the Stop-restore case only.
 *  - `captureAdoption`'s check drops the adoption epoch → the same-world adopt case only. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';

const sm = vi.hoisted(() => ({
  path: '',
  holdBefore: new Map<string, Promise<void>>(),
  holdTail: new Map<string, Promise<void>>(),
  /** Held BEFORE `replaceWorldContent`'s swap: Create Scene has written its path, the old world is on screen. */
  holdReplaceBefore: null as Promise<void> | null,
  holdReplaceTail: null as Promise<void> | null,
  preSwap: new Set<(e: unknown) => void>(),
  minted: [] as { destroy(): void }[],
}));
const writes = vi.hoisted(() => [] as { path: string; content: string }[]);

vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const cancelPreSwap = () => { for (const abort of [...sm.preSwap]) abort(new DOMException('Aborted', 'AbortError')); };
  const promote = async () => {
    const { createWorld } = await import('koota');
    const { setCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
    return (after: () => void) => { const w = createWorld(); sm.minted.push(w); setCurrentWorld(w); after(); return w; };
  };
  return {
    ...real,
    sceneManager: {
      // A swap's copy carry (#1939): this fake world holds no scene copies.
      captureSceneCopies: () => new Map(),
      getCurrent: () => (sm.path ? { path: sm.path } : null),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: (path: string) => {
        cancelPreSwap();
        let abort!: (e: unknown) => void;
        const aborted = new Promise<never>((_, reject) => { abort = reject; });
        aborted.catch(() => {});
        sm.preSwap.add(abort);
        return (async () => {
          const swap = await promote();
          try {
            await Promise.race([Promise.resolve(), aborted]);
            const hold = sm.holdBefore.get(path);
            if (hold) await Promise.race([hold, aborted]);
          } finally {
            sm.preSwap.delete(abort);
          }
          const world = swap(() => { sm.path = path; });
          const tail = sm.holdTail.get(path);
          if (tail) await tail;
          await Promise.resolve();
          return { world, keptBaseGuids: new Set<string>() };
        })();
      },
      replaceWorldContent: async (populate: (w: unknown) => void) => {
        cancelPreSwap();
        const swap = await promote();
        if (sm.holdReplaceBefore) await sm.holdReplaceBefore;
        const world = swap(() => { sm.path = ''; });
        populate(world);
        if (sm.holdReplaceTail) await sm.holdReplaceTail;
        return world;
      },
    },
  };
});

vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => {
  const ok = (path: string, content: string) => { writes.push({ path, content }); };
  return {
    ...await importOriginal<Record<string, unknown>>(),
    writeAssetFile: async (path: string, content: string) => { ok(path, content); return { ok: true as const }; },
    writeAssetFileGuarded: async (path: string, content: string) => { ok(path, content); return { result: 'ok' as const }; },
    postWriteFile: async (path: string, content: string) => {
      ok(path, content);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' } as Response;
    },
  };
});

vi.mock('../../packages/modoki/src/editor/scene/prefabCache', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  refreshPrefabSourceForPath: async () => {},
}));
vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  rebaseStaleInstances: async () => 0,
}));

/** Holds Play's settings fetch — its last await before the re-check. */
const ai = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('../../packages/modoki/src/editor/panels/aiSettingsModel', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getCachedAiSettings: () => (ai.gate ? null : { captureContactOnLaunch: false }),
  fetchAiSettings: async () => { if (ai.gate) await ai.gate; return { captureContactOnLaunch: false }; },
}));

import { setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getCurrentWorld, setCurrentWorld, spawnEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { openPrefabForEditing, savePrefabEditReport, isPrefabEditWorld } from '../../packages/modoki/src/editor/scene/prefabEdit';
import {
  loadScene, newScene, saveScene, setCurrentScenePath, getCurrentScenePath, markSceneSaved, hasUnsavedChanges,
  adoptWorldReloadedFromDisk, isSceneLoadInFlight,
} from '../../packages/modoki/src/editor/scene/serialize';
import { commitPrefabWrites } from '../../packages/modoki/src/editor/scene/prefabCommit';
import {
  withAdoption, pendingAdoptions, editorStateCurrent, captureAdoption, adoptedWorld, _resetSceneAdoptionForTests,
} from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { whyWorldNotAuthored, registerPosedWorldSource } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { restoreAuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { toastForSave } from '../../packages/modoki/src/editor/scene/saveCommand';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { getPlayState } from '../../packages/modoki/src/runtime/core/playState';
import { swapHistory, activeHistoryKey, pushAction, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';

registerAllTraits();
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {}, clear: () => {} });

const prefab = (id: string, name: string): PrefabFile => ({
  id, version: 2, name, rootLocalId: 1,
  entities: [{ localId: 1, name, traits: { EntityAttributes: { name, parentId: 0, guid: '' } } }],
} as PrefabFile);
const E1 = { path: '/games/x/assets/prefabs/Crate.prefab.json', name: 'Crate', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1750', 'Crate') };
const E2 = { path: '/games/x/assets/prefabs/Barrel.prefab.json', name: 'Barrel', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2750', 'Barrel') };
const SCENE = '/assets/scenes/Station.json';
const OTHER = '/assets/scenes/Other.json';
const NEW = '/assets/scenes/New.json';
const OLD_UNTITLED = '/assets/scenes/Old.json';
const editWorldOf = (p: { doc: PrefabFile }) => `/__prefab-edit__/${p.doc.id}`;

const home = getCurrentWorld();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await tick();
  expect(cond(), 'the stubbed switch never got there').toBe(true);
}
const gates: (() => void)[] = [];
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  gates.push(open);
  return { promise, open };
}
const editing = () => useEditorStore.getState().editingPrefab?.path ?? null;
const names = (content: string) => (JSON.parse(content).entities as { name: string }[]).map((e) => e.name);
function spawnNamed(name: string) {
  const ea = getTraitByName('EntityAttributes')!.trait;
  spawnEntity(getCurrentWorld(), ea({ name, parentId: 0, guid: '', sortOrder: 0, isActive: true } as never));
}
/** Everything a refused operation must leave exactly as it found it. */
const editorState = () => ({ path: getCurrentScenePath(), editing: editing(), history: activeHistoryKey(), unsaved: hasUnsavedChanges(), world: getCurrentWorld() });

beforeEach(() => {
  for (const k of ['log', 'warn', 'info', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  setCurrentScenePath(null);
  markSceneSaved();
  useEditorStore.getState().closePrefabEditor();
  _resetSceneAdoptionForTests();
  sm.path = ''; sm.holdBefore.clear(); sm.holdTail.clear(); sm.holdReplaceBefore = null; sm.holdReplaceTail = null; sm.preSwap.clear();
  ai.gate = null;
  writes.length = 0;
  const fresh = createWorld(); // each case starts in a world of its own: a case that never loads spawns into it
  sm.minted.push(fresh);
  setCurrentWorld(fresh);
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async (url: string) => {
    const doc = String(url).includes('Barrel') ? E2.doc : E1.doc;
    return { ok: true, status: 200, text: async () => JSON.stringify(doc), json: async () => JSON.parse(JSON.stringify(doc)) };
  });
});
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  ai.gate = null;
  if (getPlayState() !== 'stopped') await stopPlay().catch(() => {});
  for (let i = 0; i < 50 && (isSceneLoadInFlight() || pendingAdoptions().length > 0); i++) await tick();
  await tick();
  setCurrentWorld(home);
  for (const w of sm.minted.splice(0)) w.destroy(); // koota allows 16 live worlds
  vi.restoreAllMocks();
});

describe('#1750 R1: a disk writer refuses while the editor state does not describe the world', () => {
  it('#1746 A1: Cmd+S in a load`s post-swap tail refuses and writes nothing; once the load lands it saves the new scene', async () => {
    await loadScene(SCENE);
    spawnNamed('StationWork');
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);
    await until(() => sm.path === OTHER);
    expect(getCurrentScenePath(), 'premise: the path still names the outgoing scene').toBe(SCENE);
    writes.length = 0;
    const r = await saveScene();
    expect(r).toMatchObject({ saved: false, reason: 'switching' });
    expect(writes).toEqual([]);
    // The human reads why, and what to do — not Play's advice.
    expect(toastForSave({ target: 'scene', scene: r, assets: { saved: [], failed: [] } } as never).text).toMatch(/still loading — save again once it's open/);
    tail.open();
    await load;
    // ACCEPT SIDE: the same save, once the switch has landed.
    const after = await saveScene();
    expect(after).toMatchObject({ saved: true, path: OTHER });
    expect(writes.map((w) => w.path)).toEqual([OTHER]);
  });

  it('#1746 A2: an edit-open during ANOTHER edit-open`s tail refuses, saves nothing, and changes nothing', async () => {
    await loadScene(SCENE);
    spawnNamed('StationWork');
    const tail = gate();
    sm.holdTail.set(editWorldOf(E1), tail.promise);
    const first = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(() => sm.path === editWorldOf(E1));
    writes.length = 0;
    const before = editorState();
    const second = await openPrefabForEditing({ path: E2.path, name: E2.name });
    expect(second?.refused).toMatch(/a scene is still loading/);
    expect(writes, 'E1`s edit world was written over the scene file').toEqual([]);
    expect(editorState(), 'a refused open leaves nothing half-done').toEqual(before);
    tail.open();
    await first;
    expect(editing(), 'the open already under way still lands').toBe(E1.path);
  });

  it('the human route: an edit-open in a load`s tail refuses BEFORE asking to discard work its refused save could not keep', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);
    await until(() => sm.path === OTHER);
    pushAction({ label: 'WorkInTheTail', undo: () => {}, redo: () => {} });
    expect(hasUnsavedChanges(), 'premise: there is work the dialog would ask about').toBe(true);
    const confirmDiscard = vi.fn(async () => true);
    const r = await openPrefabForEditing({ path: E1.path, name: E1.name }, { confirmDiscard });
    expect(r?.refused).toMatch(/a scene is still loading/);
    expect(confirmDiscard, 'asked to discard for an open that was then refused anyway').not.toHaveBeenCalled();
    tail.open();
    await load;
  });

  it('Play pressed while the edit-open`s discard dialog is open: the open refuses at its last check before the swap', async () => {
    await newScene(); // untitled: no file for the auto-save, so the open asks before discarding
    pushAction({ label: 'UntitledWork', undo: () => {}, redo: () => {} });
    expect(hasUnsavedChanges(), 'premise: there is work to discard').toBe(true);
    let played: string | null = null;
    const confirmDiscard = vi.fn(async () => { played = (await enterPlay()).kind; return true; });
    const r = await openPrefabForEditing({ path: E1.path, name: E1.name }, { confirmDiscard });
    expect(confirmDiscard, 'premise: the dialog was asked').toHaveBeenCalledTimes(1);
    expect(played, 'premise: Play armed while it was open').toBe('started');
    expect(r?.refused).toMatch(/run-mode is 'playing'/);
    expect(isPrefabEditWorld()).toBe(false);
  });

  it('#1747: a prefab-edit save during another prefab`s edit-open tail refuses with the reason; the commit refuses there too', async () => {
    await loadScene(SCENE);
    await openPrefabForEditing({ path: E1.path, name: E1.name });
    expect(editing()).toBe(E1.path);
    const tail = gate();
    sm.holdTail.set(editWorldOf(E2), tail.promise);
    const second = openPrefabForEditing({ path: E2.path, name: E2.name });
    await until(() => sm.path === editWorldOf(E2));
    expect(editing(), 'premise: the flag still names E1 while E2`s world is on screen').toBe(E1.path);
    writes.length = 0;
    const report = await savePrefabEditReport();
    expect(report.saved).toBe(false);
    expect(report.warnings.join(' ')).toMatch(/a scene is still loading — save again once it's open/);
    // The commit itself, reached by any other caller in the same window.
    const commit = await commitPrefabWrites([{ source: E1.doc.id!, doc: prefab(E1.doc.id!, 'Barrel'), expected: E1.doc }]);
    expect(commit).toMatchObject({ ok: false, error: expect.stringMatching(/still loading/) });
    expect(writes).toEqual([]);
    tail.open();
    await second;
    expect(editing()).toBe(E2.path);
    // ACCEPT SIDE: past the refusal once E2 is adopted (the stub's edit world has no prefab root to serialize).
    expect((await savePrefabEditReport()).warnings.join(' ')).not.toMatch(/still loading/);
  });

  it('Create Scene: a save while its path runs ahead of its swap, and in its tail, refuses; after it lands it saves', async () => {
    await loadScene(SCENE);
    spawnNamed('StationWork');
    const ahead = gate();
    const replaceTail = gate();
    sm.holdReplaceBefore = ahead.promise;
    sm.holdReplaceTail = replaceTail.promise;
    const created = newScene(NEW);
    await until(() => getCurrentScenePath() === NEW);
    expect(sm.path, 'premise: the OUTGOING world is still on screen').toBe(SCENE);
    writes.length = 0;
    expect(await saveScene(), 'the outgoing world written to the new path').toMatchObject({ saved: false, reason: 'switching' });
    ahead.open();
    await until(() => sm.path === '');
    expect(await saveScene(), 'the swap landed; the adopt has not').toMatchObject({ saved: false, reason: 'switching' });
    expect(writes).toEqual([]);
    replaceTail.open();
    await created;
    expect(await saveScene()).toMatchObject({ saved: true, path: NEW });
  });

  it('ACCEPT SIDE: an editor that never adopted a world still saves (a harness, a boot that failed to adopt)', async () => {
    setCurrentScenePath(SCENE);
    spawnNamed('Work');
    expect(editorStateCurrent()).toBe(true);
    expect(await saveScene()).toMatchObject({ saved: true, path: SCENE });
    expect(writes.map((w) => names(w.content))).toEqual([['Work']]);
  });

  it('the FIRST route (nothing adopted yet): before its swap the pair still matches and saves; in its tail it refuses', async () => {
    setCurrentScenePath(OLD_UNTITLED);
    spawnNamed('OldWork');
    const before = gate();
    const tail = gate();
    sm.holdBefore.set(SCENE, before.promise);
    sm.holdTail.set(SCENE, tail.promise);
    const load = loadScene(SCENE);
    await tick();
    expect(await saveScene(), 'before its swap: the outgoing world, to its own file').toMatchObject({ saved: true, path: OLD_UNTITLED });
    expect(writes.map((w) => [w.path, names(w.content)])).toEqual([[OLD_UNTITLED, ['OldWork']]]);
    writes.length = 0;
    before.open();
    await until(() => sm.path === SCENE);
    expect(await saveScene(), 'in its tail: the incoming world, which the path does not name').toMatchObject({ saved: false, reason: 'switching' });
    expect(writes).toEqual([]);
    tail.open();
    await load;
    expect(await saveScene()).toMatchObject({ saved: true, path: SCENE });
  });

  it('ACCEPT SIDE: the first save after a boot FALLBACK (the world populated in place and adopted) writes', async () => {
    await withAdoption('boot-fallback', async (adoption) => {
      spawnNamed('Camera');
      adoption.offer({ world: getCurrentWorld(), path: SCENE });
    });
    expect(await saveScene()).toMatchObject({ saved: true, path: SCENE });
  });
});

describe('the edit-open`s discard route (close-out review: its exemption must not reach a landing switch or Play)', () => {
  it('discardUnsaved in a load`s tail still refuses — it would supersede that switch', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);
    await until(() => sm.path === OTHER);
    const before = editorState();
    expect((await openPrefabForEditing({ path: E1.path, name: E1.name }, { discardUnsaved: true }))?.refused).toMatch(/a scene is still loading/);
    expect(editorState()).toEqual(before);
    tail.open();
    await load;
  });

  it('discardUnsaved during a Stop`s restore tail refuses too — the restore`s own reason outranks the switch reason there', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const restore = restoreAuthoredSnapshot({ key: SCENE, primary: { entities: [] } as never, bases: new Map() });
    await until(() => pendingAdoptions().includes('restore') && getCurrentWorld() !== adoptedWorld());
    expect(whyWorldNotAuthored(), 'premise: the reason string is the restore`s').toMatch(/restore is still landing/);
    expect((await openPrefabForEditing({ path: E1.path, name: E1.name }, { discardUnsaved: true }))?.refused).toMatch(/a scene is still loading/);
    expect(isPrefabEditWorld()).toBe(false);
    tail.open();
    await restore;
  });

  it('discardUnsaved with Play armed during its fetch refuses', async () => {
    await loadScene(SCENE);
    const fetchGate = gate();
    const realFetch = globalThis.fetch;
    let reached = false;
    // @ts-expect-error test stub
    globalThis.fetch = vi.fn(async (u: string) => { if (String(u) === E1.path) { reached = true; await fetchGate.promise; } return realFetch(u); });
    const open = openPrefabForEditing({ path: E1.path, name: E1.name }, { discardUnsaved: true });
    await until(() => reached);
    expect((await enterPlay()).kind).toBe('started');
    fetchGate.open();
    expect((await open)?.refused).toMatch(/run-mode is 'playing'/);
    expect(isPrefabEditWorld()).toBe(false);
  });

  it('ACCEPT SIDE: discardUnsaved over any OTHER posed-world reason swaps — the caller chose to lose what it would save', async () => {
    await loadScene(SCENE);
    let posed = true;
    registerPosedWorldSource('#1750 test pose', () => posed);
    try {
      expect((await openPrefabForEditing({ path: E1.path, name: E1.name }))?.refused, 'premise: kept edits refuse').toMatch(/#1750 test pose/);
      expect(await openPrefabForEditing({ path: E1.path, name: E1.name }, { discardUnsaved: true })).toBeUndefined();
      expect(editing()).toBe(E1.path);
    } finally { posed = false; }
  });
});

describe('accept sides and same-world adopts (close-out review)', () => {
  it('a save AFTER a route`s offer, in the rest of its body (its rebase, its repair), writes — the adopted world is current', async () => {
    await loadScene(SCENE);
    const rest = gate();
    let offered = false;
    const route = withAdoption('hot-reload', async (t) => {
      const w = createWorld(); sm.minted.push(w); setCurrentWorld(w);
      offered = t.offer({ world: w, path: SCENE, baseScene: 'none', history: { key: SCENE, keptBaseGuids: new Set() } });
      await rest.promise;
    });
    await until(() => offered);
    expect(pendingAdoptions(), 'premise: the route is still pending').toEqual(['hot-reload']);
    expect(await saveScene()).toMatchObject({ saved: true, path: SCENE });
    rest.open();
    await route;
  });

  it('a prefab commit waiting for a route that adopts the SAME world under a new path refuses — its capture went stale', async () => {
    const land = gate();
    const route = withAdoption('boot-fallback', async (t) => {
      await land.promise;
      t.offer({ world: getCurrentWorld(), path: SCENE });
    });
    const commit = commitPrefabWrites([{ source: E1.doc.id!, doc: prefab(E1.doc.id!, 'Crate2'), expected: E1.doc }]);
    await tick();
    land.open();
    await route;
    expect(await commit).toMatchObject({ ok: false, worldLeft: true });
    expect(writes).toEqual([]);
  });
});

describe('the owner`s answers, directly', () => {
  it('a Stop restore in its tail: the RESTORE`s reason is the one quoted — the switch reason is a fallback', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const restore = restoreAuthoredSnapshot({ key: SCENE, primary: { entities: [] } as never, bases: new Map() });
    await until(() => pendingAdoptions().includes('restore') && getCurrentWorld() !== adoptedWorld());
    expect(editorStateCurrent(), 'premise: the switch source is true here too').toBe(false);
    expect(whyWorldNotAuthored()).toMatch(/restore is still landing/);
    tail.open();
    await restore;
    expect(whyWorldNotAuthored()).toBeNull();
  });

  it('a capture goes stale on an adopt that keeps the world (the boot fallback populates in place, then names a path)', async () => {
    const live = captureAdoption()!;
    await withAdoption('boot-fallback', async (adoption) => { adoption.offer({ world: getCurrentWorld(), path: SCENE }); });
    expect(getCurrentScenePath(), 'premise: the pair changed, the world did not').toBe(SCENE);
    expect(live()).toBe(false);
    expect(captureAdoption()!()).toBe(true);
  });
});

describe('#1750 R2: Play re-checks the adopted world it snapshotted (#1748)', () => {
  it('C1: a hot reload that starts and ends inside Play`s startup cancels Play', async () => {
    await loadScene(SCENE);
    const settings = gate();
    ai.gate = settings.promise;
    const play = enterPlay();
    await tick();
    await adoptWorldReloadedFromDisk(SCENE, () => sceneManager.loadScene(SCENE));
    expect(pendingAdoptions(), 'premise: the reload has fully landed').toEqual([]);
    settings.open();
    expect(await play).toMatchObject({ kind: 'refused', reason: 'load-landed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('C2: a prefab edit-open that lands inside Play`s startup cancels Play', async () => {
    await loadScene(SCENE);
    const settings = gate();
    ai.gate = settings.promise;
    const play = enterPlay();
    await tick();
    expect(await openPrefabForEditing({ path: E1.path, name: E1.name })).toBeUndefined();
    expect(isPrefabEditWorld(), 'premise: the edit-open landed').toBe(true);
    settings.open();
    expect(await play).toMatchObject({ kind: 'refused', reason: 'load-landed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('ACCEPT SIDE: with nothing landing, Play starts', async () => {
    await loadScene(SCENE);
    expect((await enterPlay()).kind).toBe('started');
  });

  it('the study`s open item: Play armed while an edit-open fetched — the open refuses instead of swapping into Play', async () => {
    await loadScene(SCENE);
    const fetchGate = gate();
    const realFetch = globalThis.fetch;
    let reached = false;
    // @ts-expect-error test stub
    globalThis.fetch = vi.fn(async (u: string) => { if (String(u) === E1.path) { reached = true; await fetchGate.promise; } return realFetch(u); });
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(() => reached);
    expect((await enterPlay()).kind, 'premise: Play could arm while the open fetched').toBe('started');
    const playWorld = getCurrentWorld();
    fetchGate.open();
    expect((await open)?.refused).toMatch(/run-mode is 'playing'/);
    expect(getCurrentWorld(), 'the edit world was swapped into the Play world').toBe(playWorld);
    expect(isPrefabEditWorld()).toBe(false);
    expect(writes).toEqual([]);
  });
});

