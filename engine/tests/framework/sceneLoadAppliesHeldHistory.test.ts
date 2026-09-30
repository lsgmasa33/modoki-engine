// @vitest-environment jsdom
/** #1899 close-out review F1/F2, at the seam production drives: `serialize.ts`'s real scene load, the real bridge hold
 *  and observer, the real adoption owner and undo manager — only `SceneManager.loadScene` is stubbed (a real load needs
 *  a renderer). A load that reads an outside change the hold still lists applies it, so the scene's undo stack — recorded
 *  over the OLD bytes — must end with that load (#1744: undoing a delete then made a second entity with the same guid).
 *
 *  The first cut raised the file's debt from `sceneFileLoadBegins`, inside the load's already-registered route, so its
 *  own adopt could not pay it (`paySceneFileDebt` pays only debts raised before the route registered): the stale stack
 *  survived the load, and the NEXT adopt of the scene dropped whatever was recorded over the new bytes. Measured by the
 *  reviewer with this seam; pinned here.
 *
 *  Mutations, each measured red here and restored: `freshIncoming` not passed for a covered change → "ends the stack";
 *  the debt raised again from `sceneFileLoadBegins` → "leaves no debt" (both cases); `sceneFileLoaded` dropping every
 *  entry of the file rather than the covered holds → "only in its local batch". */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getCurrentWorld, sceneManager } from '@modoki/engine/runtime';
import { pushAction, canUndo, undoLabel, markSceneSaved } from '@modoki/engine/editor';
import { swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { loadScene, setSceneFileLoadObserver, setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { isWorldReplacementInFlight } from '../../packages/modoki/src/editor/scene/authoringSettle';
import { registerAllTraits } from '../../app/ecs/registerTraits';

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
registerAllTraits();

const bridge = await import('../../app/debug/agentBridge');
const { captureAdoption, adoptionsSettled, recordSceneFileChanged, owedSceneFileChanges, _resetSceneAdoptionForTests } =
  await import('../../packages/modoki/src/editor/scene/sceneAdoption');

const SCENE = '/assets/scenes/a.scene.json';
const noop = () => {};
let game: TestWorld | undefined;

beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  _resetSceneAdoptionForTests();
  _resetHistoryContexts();
  bridge.enableOutsideChangeHold(true);
  bridge.setSceneAdoptionHooks({ capture: captureAdoption, settled: () => adoptionsSettled() === null, sceneFileChanged: recordSceneFileChanged });
  setSceneFileLoadObserver({ begins: bridge.sceneFileLoadBegins, loaded: bridge.sceneFileLoaded });
  setCurrentScenePath(SCENE);
  swapHistory(SCENE);
  pushAction({ label: 'Delete Entity', undo: noop, redo: noop });
  markSceneSaved();
});

afterEach(() => {
  setSceneFileLoadObserver(null);
  bridge.setSceneAdoptionHooks(null);
  bridge.setSceneReloadSuppressor(null);
  bridge.setSceneConflictResolver(null);
  bridge.enableOutsideChangeHold(false);
  bridge._resetOutsideChangesForTests();
  setCurrentScenePath(null);
  game?.dispose();
  vi.restoreAllMocks();
});

const loads = () => vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: getCurrentWorld(), keptBaseGuids: new Set<string>() }));

describe('a load that applies a held scene change ends the stack recorded over the old bytes (#1899 F1)', () => {
  it('control — no held change: reopening the clean scene keeps its own stack', async () => {
    loads();
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(undoLabel()).toBe('Delete Entity');
  });

  it('a held change: the load ends the stack itself and leaves no debt for a later adopt to pay', async () => {
    loads();
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(canUndo()).toBe(false);
    expect(owedSceneFileChanges()).toEqual([]);
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });

  it('a load that FAILS applied nothing: the stack stays, the change stays held, and no debt is owed (F2)', async () => {
    vi.spyOn(sceneManager, 'loadScene').mockRejectedValueOnce(new Error('malformed'));
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    expect(await loadScene(SCENE, undefined, { probing: true })).toBe('failed');
    expect(undoLabel()).toBe('Delete Entity');
    expect(bridge.pendingOutsideChanges()).toEqual([SCENE]);
    expect(owedSceneFileChanges()).toEqual([]);
  });

  // Close-out re-review (measured with this rig): a release takes its batch into a local list and awaits each change in
  // turn, so while an earlier one is handled a later one is in NONE of the hold's lists. A load of that scene beginning
  // then covers nothing, so it must not drop the change either: the change replays and reloads, ending the stack then.
  // A `heldSeq <= mark` bound dropped it at the adopt instead, and the stack recorded over the old bytes survived with
  // nothing left pending to ever reload the scene.
  it('a change a release holds only in its local batch is not the load\'s: it stays pending, to reload', async () => {
    const BASE = '/assets/scenes/base.scene.json';
    bridge.setSceneReloadSuppressor(() => (isWorldReplacementInFlight() ? 'a scene load is still landing' : null));
    vi.spyOn(sceneManager, 'getLoadedScenes').mockReturnValue(new Map([
      ['a', { path: SCENE, role: 'primary', guid: 'a' }],
      ['b', { path: BASE, role: 'base', guid: 'b' }],
    ]) as never);
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE } as never);
    let gate!: () => void;
    const gated = new Promise<void>((r) => { gate = r; });
    vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => {
      await gated;
      return { world: getCurrentWorld(), keptBaseGuids: new Set<string>() };
    });
    let begun!: () => void;
    const begunP = new Promise<void>((r) => { begun = r; });
    const covered: (readonly number[])[] = [];
    setSceneFileLoadObserver({
      begins: (p) => { const c = bridge.sceneFileLoadBegins(p); covered.push(c); begun(); return c; },
      loaded: bridge.sceneFileLoaded,
    });
    let loadP: Promise<unknown> | undefined;
    // Stands in for any await while the release handles the earlier change (a clean reload's fetch, a parked write's drop).
    bridge.setSceneConflictResolver(async (c) => {
      if (c.urlPath === BASE) { loadP = loadScene(SCENE); await begunP; return 'kept'; }
      return 'clean';
    });
    bridge.holdOutsideChange({ urlPath: BASE, kind: 'scene' });
    bridge.holdOutsideChange({ urlPath: SCENE, kind: 'scene' });
    await bridge.releaseOutsideChanges();
    gate();
    expect(await loadP).toBe('loaded');
    expect(covered).toEqual([[]]);
    expect(bridge.pendingOutsideChanges()).toContain(SCENE);
  });
});
