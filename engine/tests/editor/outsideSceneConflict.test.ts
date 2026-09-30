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
 *  `notifyPending` removed → "U4/#4". */
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
import { getAllEntities, getTraitByName, readTraitData } from '@modoki/engine/runtime';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undoStep, beginWorldBoundOperation } from '../../packages/modoki/src/editor/undo/undoManager';
import { saveAll, saveScene, loadSceneReporting, unsavedChangeCauses, hasUnsavedChanges } from '../../packages/modoki/src/editor/scene/serialize';
import { owedSceneFileChanges } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { markAssetDirty, peekDirtyAsset, flushDirtyAssets, discardDirtyAssets, overwriteParkedAsset, CHANGED_OUTSIDE_BASELINE } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import {
  setSceneConflictResolver, answerSceneConflict, releaseOutsideChanges, pendingOutsideChanges, _setEditorFocusedForTests,
  _resetOutsideChangesForTests, deferredOutsideChanges, onPendingOutsideChanges,
} from '../../app/debug/agentBridge';
import { makeSceneConflictResolver } from '../../app/editor/outsideRefresh';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The human's dialog: what they will press, and every scene they were asked about. `open` keeps it up until the test
 *  answers it (`answer`), as a human who has walked away does. */
const dialog = {
  choice: 'keep' as 'reload' | 'keep' | 'later', asked: [] as string[], open: false,
  answer: null as null | ((v: 'reload' | 'keep' | 'later') => void),
};
const realResolver = makeSceneConflictResolver({
  causes: unsavedChangeCauses,
  ask: async (urlPath) => {
    dialog.asked.push(urlPath);
    if (!dialog.open) return dialog.choice;
    return new Promise((resolve) => { dialog.answer = resolve; });
  },
  answer: answerSceneConflict,
});
setSceneConflictResolver(realResolver);

let pGuid = '';
const p1 = () => getAllEntities().find((x) => { const pi = piOf(x.id); return !!pi && pi.rootInstanceId === x.id && pi.source === pGuid && x.parentId === 0; })!;
const kids = () => getAllEntities().filter((e) => e.name === 'Kid' && e.parentId === p1().id).length;

beforeEach(() => {
  dialog.choice = 'keep';
  dialog.asked.length = 0;
  dialog.open = false;
  dialog.answer = null;
  _setEditorFocusedForTests(() => false);
  _resetOutsideChangesForTests();
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
    expect(kids(), 'the human\'s Reload did reload').toBe(2);
    expect(pendingOutsideChanges()).toEqual([]);
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
    const plainX = () => (readTraitData(getAllEntities().find((e) => e.name === 'Plain')!.id, getTraitByName('Transform')!) as { x: number }).x;
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
