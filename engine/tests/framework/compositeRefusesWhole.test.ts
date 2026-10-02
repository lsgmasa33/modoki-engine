/** #2010 — a composite undo entry (one agent call's N ops) is ONE step: it refuses as a whole, before any change, when
 *  any sub-action would refuse (rule 8; I19 / ruling R; Unity's undo group). It used to run the subs one by one, so a
 *  sub whose target was gone refused after the subs before it had applied: the entry half-applied, then was dropped.
 *
 *  The accept side matters as much: the pre-pass reads each sub's check against what the EARLIER subs of the pass bring
 *  back (`stepCheck.ts`), so a batch whose targets are all present, including ones its own subs respawn, still undoes and
 *  redoes in full. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, setPlayState, findEntityByGuid, getTraitByName,
  deleteEntity, readTraitData, spawnEntity, getCurrentWorld,
} from '@modoki/engine/runtime';
import {
  markSceneSaved, pushAction, runAsCompositeAction, createEntityWithUndo, writeTraitFieldWithUndo, deleteEntitiesWithUndo,
  setActionCallback, ensureGuid,
} from '@modoki/engine/editor';
import { undoStep, canUndo, canRedo, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();
setActionCallback(pushAction);

let game: TestWorld;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  game = createTestWorld({}); setPlayState('stopped'); _resetHistoryContexts(); markSceneSaved();
  useEditorStore.setState({ showToast: vi.fn() } as never);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { consoleError.mockRestore(); game.dispose(); });

const transform = () => getTraitByName('Transform')!;
const xOf = (guid: string) => (readTraitData(findEntityByGuid(guid)!.id(), transform()) as { x: number }).x;
const spawnNamed = (guid: string, name: string, x = 0) => game.spawn(Transform({ x }), EntityAttributes({ guid, name })).id();
/** Take an entity out of the world past the undo stack, as a world swap or a saved prefab edit does. */
const removeOutside = (guid: string) => deleteEntity(findEntityByGuid(guid)!.id());

type OpsReply = { created?: Array<{ guid: string }> };

describe('an agent call\'s entry refuses whole (#2010)', () => {
  // Mutation: drop `precheck(reversed, 'undo')` from composeUndoActions' undo → A's x goes back to 0 (half-applied), and
  // the result is a CompositeStepError, not a refusal.
  it('undo: one op\'s target gone → refused, and the other op is NOT undone', async () => {
    spawnNamed('p', 'P');
    spawnNamed('a', 'A');
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'setTrait', entity: { guid: 'a' }, trait: 'Transform', fields: { x: 5 } },
      { op: 'addEntity', name: 'Kid', parentId: 'p' },
    ] }) as OpsReply;
    const kid = r.created![0].guid;
    removeOutside(kid);

    const step = await undoStep('undo');
    expect(step.failed?.refused).toBe(true);
    expect(step.failed?.error).toContain('is no longer in the scene');
    expect(xOf('a')).toBe(5); // nothing in the batch was undone
    expect(canUndo()).toBe(false); // dropped, as any refused step (#310)
    expect(canRedo()).toBe(false);
  });

  // Mutation: drop `precheck(subs, 'redo')` → Kid is respawned before A's write refuses.
  it('redo: one op\'s target gone → refused, and the other op is NOT redone', async () => {
    spawnNamed('p', 'P');
    spawnNamed('a', 'A');
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'addEntity', name: 'Kid', parentId: 'p' },
      { op: 'setTrait', entity: { guid: 'a' }, trait: 'Transform', fields: { x: 5 } },
    ] }) as OpsReply;
    const kid = r.created![0].guid;
    expect((await undoStep('undo')).did).toBe(true);
    expect(findEntityByGuid(kid)).toBeUndefined();
    removeOutside('a');

    const step = await undoStep('redo');
    expect(step.failed?.refused).toBe(true);
    expect(findEntityByGuid(kid)).toBeUndefined(); // nothing in the batch was redone
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('every target present → the same call undoes and redoes in full', async () => {
    spawnNamed('p', 'P');
    spawnNamed('a', 'A');
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'setTrait', entity: { guid: 'a' }, trait: 'Transform', fields: { x: 5 } },
      { op: 'addEntity', name: 'Kid', parentId: 'p' },
    ] }) as OpsReply;
    const kid = r.created![0].guid;
    expect((await undoStep('undo')).failed).toBeNull();
    expect(xOf('a')).toBe(0);
    expect(findEntityByGuid(kid)).toBeUndefined();
    expect((await undoStep('redo')).failed).toBeNull();
    expect(xOf('a')).toBe(5);
    expect(findEntityByGuid(kid)).toBeDefined();
  });
});

describe('the pre-pass reads what earlier subs bring back (accept side)', () => {
  /** create K under P, write K.x, write X.x, delete X: K is needed by its write on redo before it exists, and X by its
   *  write on undo before the delete's undo has brought it back. */
  async function batch(): Promise<{ k: string }> {
    const p = spawnNamed('p', 'P');
    const x = spawnNamed('x', 'X', 1);
    let k = '';
    await runAsCompositeAction({ label: 'Batch' }, () => {
      const kid = createEntityWithUndo('Kid', p, [{ name: 'Transform' }, { name: 'EntityAttributes', data: { name: 'K', parentId: p } }], () => {})!;
      k = ensureGuid(kid);
      writeTraitFieldWithUndo(kid, transform(), 'x', 3);
      writeTraitFieldWithUndo(x, transform(), 'x', 7);
      deleteEntitiesWithUndo([x]);
    });
    return { k };
  }

  // Mutation: make `arrive` a no-op → the undo refuses on X's write (X is gone at the start of the pass), and the redo on
  // K's (K is gone at the start of the pass).
  it('a batch that creates, edits and deletes undoes and redoes in full', async () => {
    const { k } = await batch();
    expect(findEntityByGuid('x')).toBeUndefined();
    expect(xOf(k)).toBe(3);

    expect((await undoStep('undo')).failed).toBeNull();
    expect(xOf('x')).toBe(1);
    expect(findEntityByGuid(k)).toBeUndefined();

    expect((await undoStep('redo')).failed).toBeNull();
    expect(findEntityByGuid('x')).toBeUndefined();
    expect(xOf(k)).toBe(3);
  });

  // Mutation: count a sub with no check as checked (drop `pass.blind = true` in `checkSubs`) → the redo refuses on Z's
  // write, which the unchecked sub before it brings back.
  it('a sub with no check ends the pre-pass: what it brings back is not judged a miss', async () => {
    const spawnZ = () => spawnEntity(getCurrentWorld(), Transform({ x: 0 }), EntityAttributes({ guid: 'z', name: 'Z' })).id();
    await runAsCompositeAction({ label: 'Opaque' }, () => {
      const z = spawnZ();
      pushAction({ label: 'Spawn Z (no check)', undo: () => { removeOutside('z'); }, redo: () => { spawnZ(); } });
      writeTraitFieldWithUndo(z, transform(), 'x', 4);
    });
    expect((await undoStep('undo')).failed).toBeNull();
    expect(findEntityByGuid('z')).toBeUndefined();
    expect((await undoStep('redo')).failed).toBeNull();
    expect(xOf('z')).toBe(4);
  });

  // Mutation: drop the composite's own `check` → the nested batch is a sub with no check, the pass goes blind at it, and
  // the outer undo deletes K before the nested write refuses.
  it('a nested batch is asked through its own check, against the same pass', async () => {
    const p = spawnNamed('p', 'P');
    const a = spawnNamed('a', 'A');
    let k = '';
    await runAsCompositeAction({ label: 'Outer' }, async () => {
      const kid = createEntityWithUndo('Kid', p, [{ name: 'Transform' }, { name: 'EntityAttributes', data: { name: 'K', parentId: p } }], () => {})!;
      k = ensureGuid(kid);
      await runAsCompositeAction({ label: 'Inner' }, () => { writeTraitFieldWithUndo(a, transform(), 'x', 9); });
    });
    removeOutside('a');
    const step = await undoStep('undo');
    expect(step.failed?.refused).toBe(true);
    expect(findEntityByGuid(k)).toBeDefined(); // the create was not undone
  });
});
