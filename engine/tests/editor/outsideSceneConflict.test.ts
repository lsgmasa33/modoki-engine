/** #1879 part 3 (owner ruling 2026-09-30, amends #1164 for the dirty case): an outside write to a scene with unsaved
 *  edits ASKS "Reload / Keep mine" instead of letting the disk win. The two paths of #1878 that still split an Apply
 *  after #1873 R1 — both measured on main at 4f4e55caf (#1878 re-verify comment):
 *    (a) the saved scene has an added Kid under P1; Apply it; an outside scene write → the disk won, and P1 held 2 Kids;
 *    (b) Apply Kid; Cmd+S; Cmd+Z; an outside scene write → the disk won, and Kid was gone (0).
 *  Each must now ask, and Keep mine keeps Kid exactly once through Save and reopen.
 *
 *  Driven on the prefab fuzzer's harness: the real editor, Apply/undo, watcher handler, hold and release. The resolver is
 *  the production one (`makeSceneConflictResolver`) with only its dialog played by the test.
 *  Mutations, measured: the resolver's dirty test forced false (`dirty = false`) → the five dirty cases of the first
 *  run go red (the old splits; the contrast because no question is recorded), the clean case stays green; the agent's
 *  `keep` ignored in `decideSceneConflict` → "(a) agent", "keep, released under a world hold" and (b) Keep go red (the
 *  change stays held); the decision not carried onto the change (read from the release only) → the four agent-answer
 *  cases here and `agentBridgeReloadHoldsWorld`'s undo-step case; the watcher's listener applying at once instead of
 *  holding (`handleSceneChanged` for `holdOutsideChange` in `initAgentBridge`) → "the watcher holds".
 *  The close-out review's findings, each measured the same way: the `_awaitingDecision` pre-registration removed →
 *  Reload, later and F4 go red; `answerSceneConflict`'s reload branch removed → Reload and F4; the scene-file debt
 *  raised early for a scene in the open chain (F3) → the debt case; the resolver's open-dialog check removed (F4) → F4;
 *  the parked asset not marked at the hold (F1) → the park case.
 *  The second review's, measured: both decision clears removed (the release's `decision: opts.decision` for every
 *  change AND the put-back strip — either alone holds it) → "#1"; a park made after the hold not marked
 *  (`outsideChangeStands` in `markAssetDirty`) → "a park made AFTER the hold"; the superseded skip removed → "after
 *  Overwrite and Save"; the replay's per-change `.catch` removed → "U3"; deferred changes left out of
 *  `pendingOutsideChanges` → "U4/#4" alone (its hold now ends in a `finally`, so one failure cannot cascade).
 *  The third review's: the superseded check reading `writeEpoch` (bumped by a refused write too) instead of the landed
 *  count → "Cancel on the conflict"; `endOutsideChangeHold` removed → "once the release applied"; the replay's closing
 *  `notifyPending` removed → "U4/#4".
 *  #1906: the open-dialog check made unconditional again (ahead of the dirty test, as it was) → both "#1906" cases go
 *  red, the other 23 stay green.
 *  #1924, each measured alone against the 37 tests here and in `choiceModalSignal.test.ts`: the change-applied branch
 *  of the moot check removed (`applied = false`) → "a load applied the change" alone (the clean branch still closes the
 *  dialog, but logs a change waiting that is not); the clean branch removed → "the scene saved under it" alone; the
 *  clean put-back deferred one microtask → "#1906: the scene saved" alone (`settled synchronously`); the modal's abort
 *  listener removed → its "an abort closes the dialog" alone. The close-out review's, the same way: the saved-over
 *  branch removed → "the scene saved under it" alone (F2: the change put back, reloaded over the editor's own save);
 *  `answerSceneConflict`'s put-back ignoring a pending newer change → "undone back to its save point" alone, and the
 *  release taking the hold before filling its deferred list → the same test alone (F1); each `stop()` removed — the
 *  moot check's → the load and save cases, the answer path's → F4 (F3: a 500 ms poll left running per dialog). The
 *  re-review's: the save point not re-read on a re-ask → "#1924 re-review" 1 alone; the open-primary qualifier removed →
 *  its 2 alone. The
 *  production `watch` (pending list + 500 ms poll in `agentEditorOps.ts`) is played by hand here; it is verified live
 *  (issue #1924's close comment). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, flushWatcher, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { getAllEntities, getTraitByName, readTraitData, setRunMode } from '@modoki/engine/runtime';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree, setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undoStep, beginWorldBoundOperation, pushAction, undo, canRedo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { saveAll, saveScene, loadSceneReporting, unsavedChangeCauses, hasUnsavedChanges, captureWorldDirtyBaseline, getCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { owedSceneFileChanges } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { markAssetDirty, peekDirtyAsset, flushDirtyAssets, discardDirtyAssets, overwriteParkedAsset, CHANGED_OUTSIDE_BASELINE } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import {
  setSceneConflictResolver, answerSceneConflict, releaseOutsideChanges, pendingOutsideChanges, _setEditorFocusedForTests,
  _resetOutsideChangesForTests, deferredOutsideChanges, onPendingOutsideChanges, runAgentOp, awaitingSceneDecisions, heldOutsideChanges,
} from '../../app/debug/agentBridge';
import { makeSceneConflictResolver } from '../../app/editor/outsideRefresh';
import { readAssetDocFresh } from '../../packages/modoki/src/editor/panels/assetDocLoad';
import { addDirtyListener } from '../../packages/modoki/src/runtime/core/renderDirty';
import { setParticleEffect, getParticleEffect, normalizeParticleDef } from '../../packages/modoki/src/runtime/loaders/particleCache';

const be = makeFuzzBackend();
/** Called with every URL fetched, before it is served: a test can act in the middle of a release. */
const onFetch = { fn: null as null | ((url: string) => void) };
vi.stubGlobal('fetch', (input: string | URL, init?: { method?: string; body?: string }) => {
  onFetch.fn?.(String(input));
  return be.fetch(input, init);
});
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The human's dialog: what they will press, and every scene they were asked about. `open` keeps it up until the test
 *  answers it (`answer`), as a human who has walked away does. */
const dialog = {
  choice: 'keep' as 'reload' | 'keep' | 'later', asked: [] as string[], open: false,
  answer: null as null | ((v: 'reload' | 'keep' | 'later') => void),
  /** The open dialog's signal: aborted = closed from code as moot (#1924), as `openChoiceModal` closes on it. */
  signal: null as AbortSignal | null,
  /** The production poll's tick (`agentEditorOps.ts` polls every 500 ms while a question is open), run by hand. */
  poll: null as null | (() => void),
};
const realResolver = makeSceneConflictResolver({
  causes: unsavedChangeCauses,
  ask: async (urlPath, signal) => {
    dialog.asked.push(urlPath);
    dialog.signal = signal;
    if (!dialog.open) return dialog.choice;
    return new Promise((resolve) => {
      dialog.answer = resolve;
      signal.addEventListener('abort', () => resolve('later'), { once: true });
    });
  },
  answer: answerSceneConflict,
  awaiting: awaitingSceneDecisions,
  watch: (check) => {
    const off = onPendingOutsideChanges(() => check());
    dialog.poll = check;
    return () => { off(); dialog.poll = null; };
  },
  savedAt: () => captureWorldDirtyBaseline().savedAt,
  isOpenPrimary: (urlPath) => getCurrentScenePath() === urlPath,
});
setSceneConflictResolver(realResolver);

let pGuid = '';
const p1 = () => getAllEntities().find((x) => { const pi = piOf(x.id); return !!pi && pi.rootInstanceId === x.id && pi.source === pGuid && x.parentId === 0; })!;
const kids = () => getAllEntities().filter((e) => e.name === 'Kid' && e.parentId === p1().id).length;
const plainX = () => (readTraitData(getAllEntities().find((e) => e.name === 'Plain')!.id, getTraitByName('Transform')!) as { x: number }).x;

beforeEach(() => {
  dialog.choice = 'keep';
  dialog.asked.length = 0;
  dialog.open = false;
  dialog.answer = null;
  dialog.signal = null;
  dialog.poll = null;
  _setEditorFocusedForTests(() => false);
  _resetOutsideChangesForTests();
  onFetch.fn = null;
});

/** Kid added under P1 (saved first when `saveFirst`), then applied to P. */
async function kidApplied(key: string, saveFirst: boolean): Promise<Fixture> {
  const f = await startRun(be, async () => {}, key);
  pGuid = f.prefabs.P.guid;
  const { specs } = emptySpecs(p1().id);
  createEntityWithUndo('Create Kid', p1().id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Kid' } } : s)), () => {});
  await settle();
  if (saveFirst) expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  const root = p1().id;
  await preloadNestedPrefabsForSubtree(root);
  const keys = collectInstanceOverrideKeys(root, getCachedPrefabSync(piOf(root)!.source) as never);
  const sel = new Set([...keys.all].filter((k) => k.includes('+')));
  expect(sel.size, `the added Kid's key among ${[...keys.all].join(', ')}`).toBe(1);
  const preview = await previewApply(root, new Set(sel));
  const r = await applyToPrefabWithUndo(root, sel, undefined, { expect: preview.fingerprint });
  expect(r.applied, String(r.refused)).toBe(true);
  await settle();
  return f;
}

/** A hand edit of the scene file (another entity's value), raised by the watcher and held. */
async function outsideSceneWrite(f: Fixture): Promise<void> {
  be.marked.clear(); // the editor's own writes above were flushed by the host's watcher long ago
  const before = be.snapshot();
  const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
  doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 9;
  be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
  expect(await flushWatcher(be, before)).toEqual([f.scenePath]);
}

async function saveAndReopen(f: Fixture): Promise<void> {
  expect((await saveAll({ allowDialog: false })).saved).toBe(true);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
}

describe('#1878 (a): the saved scene has an added Kid, Apply, then an outside scene write', () => {
  it('nobody focused: the write stays pending and the world is untouched', async () => {
    const f = await kidApplied('c-a-held', true);
    await outsideSceneWrite(f); // the harness's flush releases, as an unfocused refresh without `scene` does
    expect(pendingOutsideChanges()).toEqual([f.scenePath]);
    expect(kids()).toBe(1);
    expect(dialog.asked).toEqual([]);
  });

  it('a human with the editor focused is asked; Keep mine keeps Kid exactly once through Save and reopen', async () => {
    const f = await kidApplied('c-a-human', true);
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    const r = await releaseOutsideChanges(); // the focus gain
    await settle();
    expect(dialog.asked).toEqual([f.scenePath]);
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'asking' }]);
    expect(pendingOutsideChanges(), 'answered: nothing pending').toEqual([]);
    expect(kids()).toBe(1);
    await saveAndReopen(f);
    expect(kids()).toBe(1);
  });

  it('an agent (nobody focused) answers keep: Kid exactly once through Save and reopen', async () => {
    const f = await kidApplied('c-a-agent', true);
    await outsideSceneWrite(f);
    const r = await releaseOutsideChanges({ decision: 'keep' });
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'kept' }]);
    expect(pendingOutsideChanges()).toEqual([]);
    await saveAndReopen(f);
    expect(kids()).toBe(1);
  });
});

describe('the human\'s answers (review F3, F4, and the untested Reload and later)', () => {
  it('Reload takes the disk: the old split, chosen', async () => {
    const f = await kidApplied('c-h-reload', true);
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    dialog.choice = 'reload';
    await releaseOutsideChanges();
    await settle();
    expect(dialog.asked).toEqual([f.scenePath]);
    expect(kids(), 'the reloaded file\'s added Kid beside the applied member').toBe(2);
    expect(hasUnsavedChanges()).toBe(false);
    expect(pendingOutsideChanges()).toEqual([]);
  });

  it('later (Escape) puts the change back: pending, the world untouched', async () => {
    const f = await kidApplied('c-h-later', true);
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    dialog.choice = 'later';
    await releaseOutsideChanges();
    await settle();
    expect(pendingOutsideChanges()).toEqual([f.scenePath]);
    expect(kids()).toBe(1);
  });

  it('Keep mine keeps the undo history: no scene-file debt is raised (F3)', async () => {
    const f = await kidApplied('c-h-debt', true);
    await outsideSceneWrite(f);
    expect(owedSceneFileChanges(), 'held, unfocused, no answer: nothing owed yet').toEqual([]);
    await releaseOutsideChanges({ decision: 'keep' });
    expect(owedSceneFileChanges()).toEqual([]);
  });

  it('a dialog left open keeps the question; its Reload still works after an unfocused release (F4)', async () => {
    const f = await kidApplied('c-h-open', true);
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer, 'the dialog is up').not.toBeNull();
    _setEditorFocusedForTests(() => false); // the human walks away; the file changes again, and an agent answers keep
    be.marked.clear();
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 11;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' }); // the watcher, with no release of its own
    const r = await releaseOutsideChanges({ decision: 'keep' });
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'asking' }]);
    expect(pendingOutsideChanges()).toEqual([f.scenePath]);
    dialog.answer!('reload');
    await settle();
    expect(dialog.poll, 'an answered question unsubscribes its watch (#1924 review F3)').toBeNull();
    expect(kids(), 'the human\'s Reload did reload').toBe(2);
    expect(pendingOutsideChanges()).toEqual([]);
  });

  // #1906: the dialog's question is about unsaved work. Once the scene is clean under it, a NEWER outside write reloads as
  // any write to a clean scene does, instead of parking behind the stale dialog, whose Keep mine then dropped it.
  async function newerWriteAfterClean(f: Fixture, makeClean: () => Promise<void>): Promise<void> {
    await outsideSceneWrite(f); // Plain.x = 9 on disk
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer, 'the dialog is up').not.toBeNull();
    await makeClean();
    expect(hasUnsavedChanges(), 'clean under the open dialog').toBe(false);
    be.marked.clear();
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 13;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' }); // the watcher, with no release of its own
    // #1924: the moot question is settled inside that notify, before any release can take the newer change. A put-back
    // a few microtasks later parked the OLDER change in the hold the release had just emptied (measured).
    expect(awaitingSceneDecisions(), 'settled synchronously').toEqual([]);
    const r = await releaseOutsideChanges(); // the focus gain, the stale dialog still up
    await settle();
    expect(r.sceneConflicts, 'a clean scene is not a conflict').toEqual([]);
    expect(r.applied).toEqual([f.scenePath]);
    expect(plainX(), 'the newer write reloaded').toBe(13);
    expect(dialog.asked, 'asked once, for the dirty scene only').toEqual([f.scenePath]);
    expect(dialog.signal!.aborted, 'the stale dialog closed itself (#1924)').toBe(true);
    dialog.answer!('keep'); // a click racing the close
    await settle();
    expect(plainX(), 'it drops nothing').toBe(13);
    expect(pendingOutsideChanges()).toEqual([]);
  }

  it('#1906: the scene saved under the open dialog — a newer write reloads, and the stale Keep mine drops nothing', async () => {
    const f = await kidApplied('c-h-saved', true);
    await newerWriteAfterClean(f, async () => { expect((await saveAll({ allowDialog: false })).saved).toBe(true); });
  });

  it('#1906: the scene reloaded by a load under the open dialog (#1899) — the same', async () => {
    const f = await kidApplied('c-h-loaded', true);
    await newerWriteAfterClean(f, async () => {
      expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
      await settle();
      expect(pendingOutsideChanges(), 'the load covered the asked-about change').toEqual([]);
    });
  });
});

// #1924: a dialog whose question went moot closed only when clicked. It told the human a clean scene had unsaved
// changes, kept `modal: scene-conflict` in the editor state, and its Keep mine logged "kept mine" over nothing.
describe('#1924: a Reload / Keep mine dialog closes itself once its question is moot', () => {
  const answerLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]))
    .filter((l) => /kept mine|reloading from disk|asked again/.test(l));

  async function dialogUp(key: string): Promise<Fixture> {
    const f = await kidApplied(key, true);
    await outsideSceneWrite(f); // Plain.x = 9 on disk
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer, 'the dialog is up').not.toBeNull();
    expect(awaitingSceneDecisions()).toEqual([f.scenePath]);
    return f;
  }

  it('a load applied the change (the observed repro): the dialog closes, nothing is answered, and a new conflict asks again', async () => {
    const f = await dialogUp('c-m-load');
    const log = vi.spyOn(console, 'log');
    try {
      expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
      await settle();
      expect(dialog.signal!.aborted, 'closed by the load').toBe(true);
      expect(dialog.poll, 'its watch unsubscribed (review F3: else a 500 ms poll per dialog, forever)').toBeNull();
      expect(hasUnsavedChanges()).toBe(false);
      expect(plainX(), 'the load read the disk').toBe(9);
      expect(pendingOutsideChanges()).toEqual([]);
      expect(answerLogs(log), 'no answer logged — in particular no false "kept mine"').toEqual([]);
      expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('question is moot')),
        'says what happened: applied, not "waits for the next refresh"').toEqual([
        `[agentBridge] ${f.scenePath}: the Reload / Keep mine question is moot — the change it asked about was applied; closed it`,
      ]);
    } finally { log.mockRestore(); }
    // The question is closed for good: the next outside write over new unsaved work is asked about afresh.
    const { specs } = emptySpecs(p1().id);
    createEntityWithUndo('Create Kid2', p1().id, specs, () => {});
    await settle();
    expect(hasUnsavedChanges()).toBe(true);
    be.marked.clear();
    const before = be.snapshot();
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 21;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
    expect(await flushWatcher(be, before)).toEqual([f.scenePath]);
    await releaseOutsideChanges();
    expect(dialog.asked, 'asked a second time').toEqual([f.scenePath, f.scenePath]);
    expect(dialog.signal!.aborted, 'the new dialog is up').toBe(false);
  });

  it('the scene saved under it: open while dirty, closed at the next poll, and the save superseded the change (review F2)', async () => {
    const f = await dialogUp('c-m-save');
    const x0 = plainX();
    dialog.poll!();
    expect(dialog.signal!.aborted, 'still dirty: the question stands').toBe(false);
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(dialog.signal!.aborted, 'a save fires nothing; the poll finds it').toBe(false);
    const log = vi.spyOn(console, 'log');
    try {
      dialog.poll!();
      await settle();
      expect(dialog.signal!.aborted, 'closed: the scene is clean').toBe(true);
      expect(dialog.poll, 'its watch unsubscribed').toBeNull();
      expect(answerLogs(log)).toEqual([]);
    } finally { log.mockRestore(); }
    // The save wrote the editor's version over the outside one: nothing is left to apply, and nothing reloads over the
    // editor's own bytes. Put back instead, the release below reloaded the scene and dropped the undo history.
    expect(awaitingSceneDecisions()).toEqual([]);
    expect(pendingOutsideChanges(), 'superseded, not put back').toEqual([]);
    const r = await releaseOutsideChanges();
    await settle();
    expect(r.applied, 'nothing to reload').toEqual([]);
    expect(plainX()).toBe(x0);
    expect(dialog.asked, 'asked once').toEqual([f.scenePath]);
    expect((await undoStep('undo')).did, 'the undo history survives the save, as Keep mine keeps it').toBe(true);
  });

  it('undone back to its save point: the change goes back to the hold — and not behind a newer one a release took (review F1)', async () => {
    // A plain scene edit on a freshly loaded scene, so one undo lands back on the state the file holds.
    const f = await startRun(be, async () => {}, 'c-m-undo');
    pGuid = f.prefabs.P.guid;
    const { specs } = emptySpecs(p1().id);
    createEntityWithUndo('Create Kid', p1().id, specs, () => {});
    await settle();
    expect(hasUnsavedChanges()).toBe(true);
    await outsideSceneWrite(f); // Plain.x = 9 on disk
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer, 'the dialog is up').not.toBeNull();
    // A newer write lands while the scene is still dirty: held, the question stands.
    be.marked.clear();
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 17;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' }); // the watcher, with no release of its own
    expect(heldOutsideChanges()).toEqual([f.scenePath]);
    expect(dialog.signal!.aborted, 'still dirty').toBe(false);
    expect((await undoStep('undo')).did).toBe(true); // the create undone: back at the state the file held
    expect(hasUnsavedChanges(), 'clean without a save').toBe(false);
    // The focus gain lands before the next poll: the question goes moot inside the release itself.
    const r = await releaseOutsideChanges();
    await settle();
    expect(dialog.signal!.aborted, 'closed').toBe(true);
    expect(r.applied).toEqual([f.scenePath]);
    expect(plainX(), 'the newer write reloaded').toBe(17);
    expect(pendingOutsideChanges(), 'the older change is not parked behind it').toEqual([]);
  });
});

// The re-review of the F2 fix: "the save point moved" is not "this file was saved over" unless it moved after the
// change now asked about arrived, and while the scene is still the open primary. Either gap dropped a change still on disk.
describe('#1924 re-review: a moot question drops its change only when THIS file was saved over it', () => {
  const writeX = (f: Fixture, x: number) => {
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = x;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
  };

  it('1: a save, then a newer write re-asked, then an undo to the save — the newer change, still on disk, reaches the editor', async () => {
    const f = await kidApplied('c-r-1', true);
    await outsideSceneWrite(f); // x = 9, asked about
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer).not.toBeNull();
    expect((await saveAll({ allowDialog: false })).saved).toBe(true); // over x = 9; no poll sees it
    const { specs } = emptySpecs(0);
    createEntityWithUndo('Create Late', 0, specs, () => {});
    await settle();
    expect(hasUnsavedChanges()).toBe(true);
    be.marked.clear();
    writeX(f, 17); // a NEW outside write, after the save
    bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' });
    await releaseOutsideChanges(); // dirty, the question open: re-asked about the new change
    await settle();
    expect(awaitingSceneDecisions()).toEqual([f.scenePath]);
    expect(dialog.signal!.aborted).toBe(false);
    expect((await undoStep('undo')).did).toBe(true); // back to the save point: clean, with no save since the new change
    expect(hasUnsavedChanges()).toBe(false);
    dialog.poll!();
    await settle();
    expect(dialog.signal!.aborted).toBe(true);
    expect(pendingOutsideChanges(), 'put back, not dropped').toEqual([f.scenePath]);
    await releaseOutsideChanges();
    await settle();
    expect(plainX(), 'the outside write made after the save reaches the editor').toBe(17);
  });

  it('2: undone to clean, then another scene loaded before the poll — the change goes back, and its debt is paid on reopen', async () => {
    const f = await startRun(be, async () => {}, 'c-r-2');
    pGuid = f.prefabs.P.guid;
    const yPath = f.scenePath.replace(/([^/]+)$/, 'Other.scene.json');
    const yGuid = 'abababab-0000-4000-8000-000000000002';
    const ydoc = JSON.parse(be.read(f.scenePath)!) as { id: string };
    ydoc.id = yGuid;
    be.write(yPath, `${JSON.stringify(ydoc, null, 2)}\n`);
    registerAsset(yGuid, yPath, 'scene');
    const { specs } = emptySpecs(p1().id);
    createEntityWithUndo('Create Kid', p1().id, specs, () => {});
    await settle();
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    dialog.open = true;
    await releaseOutsideChanges();
    expect(dialog.answer).not.toBeNull();
    expect((await undoStep('undo')).did).toBe(true);
    expect(hasUnsavedChanges()).toBe(false);
    expect((await loadSceneReporting(yPath)).outcome).toBe('loaded');
    await settle();
    dialog.poll?.();
    await settle();
    expect(dialog.signal!.aborted).toBe(true);
    expect(pendingOutsideChanges(), 'a scene switch wrote nothing: the change goes back').toEqual([f.scenePath]);
    await releaseOutsideChanges();
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(plainX()).toBe(9);
    expect(canRedo(), 'a stack recorded over the old bytes must not come back (#1744)').toBe(false);
  });
});

describe('the second close-out review', () => {
  it('#1: an agent answer the human sent back ("later") does not fire at a later plain release', async () => {
    const f = await kidApplied('c-r2-later', true);
    await outsideSceneWrite(f);
    _setEditorFocusedForTests(() => true);
    dialog.choice = 'later';
    await releaseOutsideChanges({ decision: 'reload' }); // focused: the human is asked, and sends it back
    await settle();
    _setEditorFocusedForTests(() => false);
    const r = await releaseOutsideChanges(); // a later refresh with no answer
    await settle();
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'held' }]);
    expect(kids(), 'the unsaved work is still there').toBe(1);
  });

  it('U3: one change that throws does not drop the rest of the batch', async () => {
    const f = await startRun(be, async () => {}, 'c-r2-throw');
    pGuid = f.prefabs.P.guid;
    const { specs } = emptySpecs(0);
    createEntityWithUndo('Create Dirt', 0, specs, () => {}); // dirty, so the scene change reaches the resolver
    await settle();
    setSceneConflictResolver(async () => { throw new Error('resolver down'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      be.marked.clear();
      const scene = JSON.parse(be.read(f.scenePath)!) as { name: string };
      scene.name = 'Changed';
      be.write(f.scenePath, `${JSON.stringify(scene, null, 2)}\n`);
      const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: { name: string; traits: { Transform: { x: number } } }[] };
      pDoc.entities.find((e) => e.name === 'A')!.traits.Transform.x = 7;
      be.write(f.prefabs.P.path, `${JSON.stringify(pDoc, null, 2)}\n`);
      bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' });
      bridge.emit('scene-changed', { urlPath: f.prefabs.P.path, kind: 'prefab' });
      await releaseOutsideChanges();
      await settle();
    } finally { errors.mockRestore(); setSceneConflictResolver(realResolver); }
    const a = getAllEntities().find((e) => e.name === 'A' && e.parentId === p1().id)!;
    expect((readTraitData(a.id, getTraitByName('Transform')!) as { x: number }).x, 'the prefab change after the throwing scene one').toBe(7);
  });

  it('U4/#4: a change deferred at its release stays pending, with the reason, until it replays', async () => {
    const f = await kidApplied('c-r2-deferred', true);
    await outsideSceneWrite(f);
    const heard: string[][] = [];
    const off = onPendingOutsideChanges((p) => heard.push(p));
    const endHold = beginWorldBoundOperation();
    try {
      await releaseOutsideChanges({ decision: 'keep' });
      expect(pendingOutsideChanges()).toEqual([f.scenePath]);
      expect(deferredOutsideChanges().paths).toEqual([f.scenePath]);
      expect(deferredOutsideChanges().reason).toMatch(/undo step|prefab write/);
    } finally { endHold(); } // a failure here must not leave the next case's world held
    await settle();
    off();
    expect(pendingOutsideChanges()).toEqual([]);
    expect(heard.at(-1), 'the backend is told once the replay has applied it (review 3, #4)').toEqual([]);
  });
});

describe('a parked asset under a held outside write (review F1)', () => {
  it('Save before the refresh refuses as a conflict instead of writing the park over the change', async () => {
    const f = await startRun(be, async () => {}, 'c-park');
    const path = `${f.root}/fx/p.particle.json`;
    be.write(path, `${JSON.stringify({ id: 'eeeeeeee-0000-4000-8000-0000000018f1', version: 1, maxParticles: 1 }, null, 2)}\n`);
    markAssetDirty(path, 'particle', { id: 'eeeeeeee-0000-4000-8000-0000000018f1', version: 1, maxParticles: 5 }, 'panel');
    be.write(path, `${JSON.stringify({ id: 'eeeeeeee-0000-4000-8000-0000000018f1', version: 1, maxParticles: 99 }, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' }); // the watcher: held
    await settle();
    expect(pendingOutsideChanges()).toEqual([path]);
    expect(peekDirtyAsset(path)?.ifMatch).toBe(CHANGED_OUTSIDE_BASELINE);
    const r = await flushDirtyAssets(); // Cmd+S's asset half, before any refresh
    expect(r.failed, JSON.stringify(r.failed)).toEqual([expect.objectContaining({ path, conflict: true })]);
    expect(JSON.parse(be.read(path)!).maxParticles, 'the outside write survives').toBe(99);
    discardDirtyAssets([path]);
  });

  const particle = (maxParticles: number) => ({ id: 'eeeeeeee-0000-4000-8000-0000000018f2', version: 1, maxParticles });
  const heldParticle = async (key: string) => {
    const f = await startRun(be, async () => {}, key);
    const path = `${f.root}/fx/q.particle.json`;
    be.write(path, `${JSON.stringify(particle(1), null, 2)}\n`);
    return { f, path };
  };

  it('Cancel on the conflict keeps the park until the release, which drops it: disk wins (review 3, #2)', async () => {
    const { path } = await heldParticle('c-park-cancel');
    markAssetDirty(path, 'particle', particle(5), 'panel');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    expect((await flushDirtyAssets()).failed).toEqual([expect.objectContaining({ path, conflict: true })]); // Cancel: no Overwrite
    expect(peekDirtyAsset(path), 'kept until the release').not.toBeNull();
    await releaseOutsideChanges();
    await settle();
    expect(peekDirtyAsset(path), 'a refused Save is no editor write: the outside change applies').toBeNull();
    expect(JSON.parse(be.read(path)!).maxParticles).toBe(99);
  });

  it('once the release applied the change, a new park is ordinary (review 3, #3)', async () => {
    const { path } = await heldParticle('c-park-ended');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    await releaseOutsideChanges();
    await settle();
    markAssetDirty(path, 'particle', particle(5), 'panel');
    expect(peekDirtyAsset(path)?.ifMatch).toBeUndefined();
    discardDirtyAssets([path]);
  });

  it('a park made AFTER the hold starts conflicted too (review 2, #2)', async () => {
    const { path } = await heldParticle('c-park-after');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    markAssetDirty(path, 'particle', particle(5), 'panel'); // a panel edit while the change is held
    expect(peekDirtyAsset(path)?.ifMatch).toBe(CHANGED_OUTSIDE_BASELINE);
    const r = await flushDirtyAssets();
    expect(r.failed).toEqual([expect.objectContaining({ path, conflict: true })]);
    expect(JSON.parse(be.read(path)!).maxParticles).toBe(99);
    discardDirtyAssets([path]);
  });

  it('after Overwrite and Save, the release applies nothing and keeps the edits made since (review 2, #3)', async () => {
    const { path } = await heldParticle('c-park-overwrite');
    markAssetDirty(path, 'particle', particle(5), 'panel');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    expect((await flushDirtyAssets()).failed).toEqual([expect.objectContaining({ path, conflict: true })]);
    expect(overwriteParkedAsset(path)).toBe(true); // the human chose Overwrite
    expect((await flushDirtyAssets()).saved).toEqual([path]);
    expect(JSON.parse(be.read(path)!).maxParticles).toBe(5);
    markAssetDirty(path, 'particle', particle(7), 'panel'); // and kept editing
    expect(peekDirtyAsset(path)?.ifMatch, 'the file is the human\'s own save now: no conflict').toBeUndefined();
    await releaseOutsideChanges(); // the focus gain
    await settle();
    expect((peekDirtyAsset(path)?.data as { maxParticles: number } | undefined)?.maxParticles, 'the edit made after the save').toBe(7);
    expect(pendingOutsideChanges()).toEqual([]);
    discardDirtyAssets([path]);
  });
});

describe('a save records the state it serialized, not the one after its awaits (#1904 close-out review F3)', () => {
  // `serializeScene` reads the entity list, then awaits a prefab source that missed the cache; an entity created there moved
  // the world's structure under it, so it reads the scene again (#2001 S8b: before, the entity missed the bytes, and the
  // ids it had read could name other entities by then). The save point is still the one taken before the serialize, so
  // the scene reads unsaved, which is conservative now that the bytes hold the entity. Mutations: drop the re-read in
  // `serializeScene` (the save is refused as superseded); move `captureSavePoint()` below the serialize (it reads saved).
  it('an entity created during the serialize\'s prefab fetch is in the bytes, read again, and the scene stays unsaved', async () => {
    const f = await startRun(be, async () => {}, 'f3-save-point');
    for (const k of ['Q', 'P', 'O', 'H'] as const) { setPrefabCache(f.prefabs[k].guid, null); setPrefabCache(f.prefabs[k].path, null); }
    let created = false;
    onFetch.fn = (url) => {
      if (created || !url.includes('.prefab.json')) return;
      created = true;
      const { specs } = emptySpecs(0);
      createEntityWithUndo('Add', 0, specs.map((sp) => (sp.name === 'EntityAttributes' ? { ...sp, data: { ...sp.data, name: 'MidSave' } } : sp)), () => {});
    };
    try {
      expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    } finally { onFetch.fn = null; }
    expect(created, 'precondition: the serialize fetched a prefab source').toBe(true);
    expect(JSON.stringify(JSON.parse(be.read(f.scenePath)!)).includes('MidSave'), 'the serialize read the scene again').toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
  });
});

describe('a save settles its point once the serialize is done (#1904 close-out, fourth review, finding 2)', () => {
  // An edit landing in the prefab fetch moves the world after the capture, and may be in the bytes: undoing it must not
  // read saved against a file that might hold it. Mutation: drop the `settleSavePoint(savedAt)` line in `saveScene`.
  it("an edit during the serialize's prefab fetch: undoing it still reads unsaved", async () => {
    const f = await startRun(be, async () => {}, 'settle-save-point');
    for (const k of ['Q', 'P', 'O', 'H'] as const) { setPrefabCache(f.prefabs[k].guid, null); setPrefabCache(f.prefabs[k].path, null); }
    let pushed = false;
    onFetch.fn = (url) => {
      if (pushed || !url.includes('.prefab.json')) return;
      pushed = true;
      pushAction({ label: 'mid-save edit', undo: () => {}, redo: () => {} });
    };
    try {
      expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    } finally { onFetch.fn = null; }
    expect(pushed, 'precondition: the serialize fetched a prefab source').toBe(true);
    await undo();
    expect(hasUnsavedChanges()).toBe(true);
  });
});

describe("an asset editor's read of the file applies its held change (#1902)", () => {
  const particle = (maxParticles: number) => ({ id: 'eeeeeeee-0000-4000-8000-000000001902', version: 1, maxParticles });
  const heldParticle = async (key: string) => {
    const f = await startRun(be, async () => {}, key);
    const path = `${f.root}/fx/r.particle.json`;
    be.write(path, `${JSON.stringify(particle(1), null, 2)}\n`);
    return { f, path };
  };
  // The edit-loss case: the panel opens on the NEW bytes while the change is still held, the user edits, and the release
  // then discarded that edit as "stale". Mutation: drop `read.landed()` in `readAssetDocFresh` — still pending, the park
  // starts conflicted, and the release discards it.
  it('the open drops the hold: a park made on what it showed is ordinary, and the release leaves it alone', async () => {
    const { path } = await heldParticle('c-read-applies');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    expect(pendingOutsideChanges(), 'precondition: held').toEqual([path]);
    expect((await readAssetDocFresh(path) as { maxParticles: number }).maxParticles, 'the panel shows the file').toBe(99);
    expect(pendingOutsideChanges()).toEqual([]);
    markAssetDirty(path, 'particle', particle(5), 'panel'); // the user edits what the panel showed
    expect(peekDirtyAsset(path)?.ifMatch, 'no conflict: the edit was made on the file').toBeUndefined();
    await releaseOutsideChanges(); // the focus gain
    await settle();
    expect((peekDirtyAsset(path)?.data as { maxParticles: number } | undefined)?.maxParticles, 'the edit survives').toBe(5);
    expect((await flushDirtyAssets()).saved).toEqual([path]);
    expect(JSON.parse(be.read(path)!).maxParticles).toBe(5);
  });

  // Mutation: end no notes in `beginFreshFileRead`'s `landed` (the bridge still drops) — the park starts conflicted.
  it("the note ends with the hold: Save does not ask Overwrite/Cancel over the change the user was looking at", async () => {
    const { path } = await heldParticle('c-read-note');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    await readAssetDocFresh(path);
    markAssetDirty(path, 'particle', particle(5), 'panel');
    expect((await flushDirtyAssets()).failed).toEqual([]);
  });

  // The runtime half of the apply: what is playing the effect follows the file the panel shows. Mutation: skip the
  // invalidator in `outsideFileReadLanded` — nothing wakes, and the cached def stays the pre-change one.
  it('the runtime cache is dropped and every surface woken, as the release would', async () => {
    const { path } = await heldParticle('c-read-cache');
    be.write(path, `${JSON.stringify(particle(99), null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    setParticleEffect(path, normalizeParticleDef(particle(1))); // what an entity playing it cached before the change
    expect(getParticleEffect(path, { load: false }), 'precondition: cached').not.toBeNull();
    const woke = vi.fn();
    const off = addDirtyListener(woke);
    try { await readAssetDocFresh(path); } finally { off(); }
    expect(getParticleEffect(path, { load: false }), 'the stale def is gone: the next use reads the file').toBeNull();
    expect(woke).toHaveBeenCalled();
  });

  // A sibling of the panel read (#1902 close-out sweep): an agent keying a clip nothing has loaded reads the file on a
  // cache miss and parks its edit on those bytes. Mutation: drop `read.landed()` in `anim-add-key`'s cache-miss branch —
  // still pending, and the park starts conflicted.
  it("an agent op's cache-miss read applies the held change too, so its park is ordinary", async () => {
    const f = await startRun(be, async () => {}, 'c-read-anim');
    const path = `${f.root}/anim/k.anim.json`;
    const clip = { id: 'eeeeeeee-0000-4000-8000-000000001907', version: 1, name: 'k', duration: 1, tracks: [] };
    be.write(path, `${JSON.stringify(clip, null, 2)}\n`);
    be.write(path, `${JSON.stringify({ ...clip, duration: 2 }, null, 2)}\n`); // the outside change
    bridge.emit('scene-changed', { urlPath: path, kind: 'animation' });
    await settle();
    expect(pendingOutsideChanges(), 'precondition: held').toEqual([path]);
    const r = await runAgentOp('anim-add-key', { clipPath: path, trait: 'Transform', field: 'x', time: 0, value: 1 }) as { ok?: boolean };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(pendingOutsideChanges()).toEqual([]);
    expect(peekDirtyAsset(path)?.ifMatch, 'the edit was made on the file').toBeUndefined();
    expect((peekDirtyAsset(path)?.data as { duration: number }).duration, 'on the NEW bytes').toBe(2);
    discardDirtyAssets([path]);
  });

  // The accept side: a read that failed applied nothing. Mutation: call `landed()` before the parse — the hold drops
  // a change the panel never showed.
  it('a read that fails to parse leaves the change held', async () => {
    const { path } = await heldParticle('c-read-fails');
    be.write(path, '{ not json');
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    await expect(readAssetDocFresh(path)).rejects.toThrow();
    expect(pendingOutsideChanges()).toEqual([path]);
  });
});

describe('each change ends its OWN hold, right after it is applied (#1889 close-out reviews)', () => {
  const particle = (maxParticles: number) => ({ id: 'eeeeeeee-0000-4000-8000-0000000019f2', version: 1, maxParticles });
  const body = (n: number) => `${JSON.stringify(particle(n), null, 2)}\n`;

  it('a change Play deferred, replayed at Stop, leaves a NEWER held write of the file standing', async () => {
    const f = await startRun(be, async () => {}, 'c-own-hold');
    const path = `${f.root}/fx/f1.particle.json`;
    be.write(path, body(1));
    be.write(path, body(50)); // A
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    await settle();
    setRunMode('playing');
    try {
      expect((await releaseOutsideChanges()).deferred, 'precondition: Play defers A').toEqual([path]);
      be.write(path, body(60)); // B, held during Play
      bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
      for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); // `settle` waits on the deferral
    } finally { setRunMode('stopped'); }
    await settle();
    expect(pendingOutsideChanges(), 'precondition: A replayed, B still held').toEqual([path]);
    markAssetDirty(path, 'particle', particle(5), 'panel'); // a park while B is held
    expect(peekDirtyAsset(path)?.ifMatch, 'B stands: the park starts conflicted').toBe(CHANGED_OUTSIDE_BASELINE);
    const saved = await flushDirtyAssets();
    expect(saved.saved).toEqual([]);
    expect(JSON.parse(be.read(path)!).maxParticles, 'Save did not write over B').toBe(60);
    discardDirtyAssets([path]);
  });

  it('a shader BODY change replacing a held descriptor change ends the descriptor\'s note with it', async () => {
    const f = await startRun(be, async () => {}, 'c-own-sibling');
    const path = `${f.root}/fx/s.shader.json`;
    const shader = (label: string) => ({ id: 'eeeeeeee-0000-4000-8000-0000000019f3', version: 1, label });
    be.write(path, `${JSON.stringify(shader('a'), null, 2)}\n`);
    be.write(path, `${JSON.stringify(shader('b'), null, 2)}\n`); // the descriptor itself, written outside: noted
    bridge.emit('scene-changed', { urlPath: path, kind: 'shader' });
    await settle();
    bridge.emit('scene-changed', { urlPath: path, kind: 'shader', viaSibling: true }); // then its .wgsl: replaces it, notes nothing
    await settle();
    expect(pendingOutsideChanges(), 'precondition: one change held').toEqual([path]);
    await releaseOutsideChanges();
    await settle();
    markAssetDirty(path, 'shader', shader('mine'), 'panel');
    expect(peekDirtyAsset(path)?.ifMatch, 'nothing held: the park is ordinary').not.toBe(CHANGED_OUTSIDE_BASELINE);
    discardDirtyAssets([path]);
  });

  it('a park made while a LATER change of the same release is still loading is ordinary', async () => {
    const f = await startRun(be, async () => {}, 'c-own-window');
    const path = `${f.root}/fx/w.particle.json`;
    be.write(path, body(1));
    // A git pull: the particle and prefab P change outside, both held.
    be.write(path, body(99));
    const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: { name: string; traits: { Transform: { x: number } } }[] };
    pDoc.entities.find((e) => e.name === 'A')!.traits.Transform.x = 7;
    be.write(f.prefabs.P.path, `${JSON.stringify(pDoc, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: path, kind: 'particle' });
    bridge.emit('scene-changed', { urlPath: f.prefabs.P.path, kind: 'prefab' });
    await settle();
    expect(pendingOutsideChanges().sort()).toEqual([path, f.prefabs.P.path].sort());
    let parked = 0;
    const pFile = f.prefabs.P.path.split('/').pop()!;
    onFetch.fn = (url) => {
      if (parked || !url.includes(pFile)) return;
      parked++; // the particle's change is applied already (the prefab replays last): a panel edit now
      markAssetDirty(path, 'particle', particle(5), 'panel');
    };
    await releaseOutsideChanges();
    await settle();
    onFetch.fn = null;
    expect(parked, 'precondition: the release fetched P after applying the particle').toBe(1);
    expect(peekDirtyAsset(path)?.ifMatch, 'the park is over the file as the editor loaded it').not.toBe(CHANGED_OUTSIDE_BASELINE);
    const r = await flushDirtyAssets();
    expect(r.failed).toEqual([]);
    expect(JSON.parse(be.read(path)!).maxParticles).toBe(5);
  });
});

describe('an agent answer given while the world is held', () => {
  // A release under an undo step, Play or any world hold is DEFERRED and replays after it, outside the release. The
  // agent's `scene` answer rides on the change (`SceneChangedMsg.decision`); kept on the release only, it was gone by the
  // replay and the change went back to pending (found by the verify gate, `agentBridgeReloadHoldsWorld`).
  it('keep, released under a world hold, is carried out when the hold ends', async () => {
    const f = await kidApplied('c-held-keep', true);
    await outsideSceneWrite(f);
    const endHold = beginWorldBoundOperation();
    try {
      const r = await releaseOutsideChanges({ decision: 'keep' });
      expect(r.deferred).toEqual([f.scenePath]);
    } finally { endHold(); }
    await settle();
    expect(pendingOutsideChanges(), 'the answer was carried out at the replay').toEqual([]);
    await saveAndReopen(f);
    expect(kids()).toBe(1);
  });
});

describe('#1878 (b): Apply, Cmd+S, Cmd+Z, then an outside scene write', () => {
  it('asks; Keep mine keeps Kid exactly once through Save and reopen, where Reload loses it', async () => {
    const f = await kidApplied('c-b-keep', false);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(kids(), 'premise: the undo put Kid back as an added node').toBe(1);
    await outsideSceneWrite(f);
    expect(pendingOutsideChanges(), 'held: nobody focused, no answer').toEqual([f.scenePath]);
    const r = await releaseOutsideChanges({ decision: 'keep' });
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'kept' }]);
    expect(kids()).toBe(1);
    await saveAndReopen(f);
    expect(kids()).toBe(1);
  });

  it('the contrast: an agent answering reload takes the disk, and Kid is gone (the split #1878 measured)', async () => {
    const f = await kidApplied('c-b-reload', false);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await undoStep('undo');
    await settle();
    await outsideSceneWrite(f);
    const r = await releaseOutsideChanges({ decision: 'reload' });
    await settle();
    expect(r.sceneConflicts).toEqual([{ urlPath: f.scenePath, answer: 'reload' }]);
    expect(kids()).toBe(0);
  });
});

describe('the hold (#1879 parts 1-2)', () => {
  it('the watcher holds: an outside write to a clean scene applies only when released', async () => {
    const f = await startRun(be, async () => {}, 'c-hold');
    pGuid = f.prefabs.P.guid;
    const doc = JSON.parse(be.read(f.scenePath)!) as { entities: { traits?: { EntityAttributes?: { name?: string }; Transform?: { x: number } } }[] };
    doc.entities.find((e) => e.traits?.EntityAttributes?.name === 'Plain')!.traits!.Transform!.x = 7;
    be.write(f.scenePath, `${JSON.stringify(doc, null, 2)}\n`);
    bridge.emit('scene-changed', { urlPath: f.scenePath, kind: 'scene' }); // the watcher, with no release after it
    await settle();
      expect(pendingOutsideChanges()).toEqual([f.scenePath]);
    expect(plainX(), 'held: the world still shows the old file').toBe(0);
    const r = await releaseOutsideChanges();
    await settle();
    expect(r.applied).toEqual([f.scenePath]);
    expect(pendingOutsideChanges()).toEqual([]);
    expect(plainX()).toBe(7);
  });
});

describe('a clean scene', () => {
  it('reloads from disk as before, asking nobody', async () => {
    const f = await startRun(be, async () => {}, 'c-clean');
    pGuid = f.prefabs.P.guid;
    _setEditorFocusedForTests(() => true);
    await outsideSceneWrite(f); // the flush's release, with a human focused: a clean scene is not a question
    const plain = getAllEntities().find((e) => e.name === 'Plain')!;
    expect(dialog.asked).toEqual([]);
    expect(pendingOutsideChanges()).toEqual([]);
    expect((readTraitData(plain.id, getTraitByName('Transform')!) as { x: number }).x, 'the live world took the disk').toBe(9);
  });
});
