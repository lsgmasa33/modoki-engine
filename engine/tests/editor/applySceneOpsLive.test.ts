/** Phase 2b (mcp-persistence.md) — the `apply-scene-ops` agent op: the
 *  live-world twin of sceneMutate.ts's file-based `applyOps`, wired through the Phase 2a
 *  composite primitive so an N-op call lands as ONE undo entry. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, findEntityByGuid,
} from '@modoki/engine/runtime';
import {
  getEditVersion, hasUnsavedChanges, markSceneSaved, clearHistory, canUndo, canRedo, undo, redo, undoLabel,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
});
afterEach(() => { game?.dispose(); game = undefined; });

async function createBox(): Promise<{ id: number; guid: string }> {
  const r = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number; guid: string };
  markSceneSaved();
  clearHistory();
  return r;
}

describe('apply-scene-ops: one call, one undo entry, regardless of op count', () => {
  it('a 3-op heterogeneous batch (setTrait ×2 + addEntity) is ONE undo entry that reverts all three', async () => {
    const a = await createBox();
    const b = await createBox();
    const before = getEditVersion();

    const r = await runAgentOp('apply-scene-ops', {
      ops: [
        { op: 'setTrait', entity: { guid: a.guid }, trait: 'Transform', fields: { x: 5 } },
        { op: 'setTrait', entity: { guid: b.guid }, trait: 'Transform', fields: { y: 7 } },
        { op: 'addEntity', name: 'Batched', parentId: 0, traits: { Transform: {}, EntityAttributes: { name: 'Batched' } } },
      ],
    }) as { ok: boolean; changed: number };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(3);
    expect(getEditVersion()).toBeGreaterThan(before); // exactly one bump's worth of "dirty", not three
    expect(hasUnsavedChanges()).toBe(true);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toContain('3 ops');

    // Only ONE entry: a single undo() call must revert ALL three changes.
    const entityA = findEntityByGuid(a.guid)!;
    const entityB = findEntityByGuid(b.guid)!;
    const TransformMeta = (await import('@modoki/engine/runtime')).getTraitByName('Transform')!;
    expect(entityA.get(TransformMeta.trait).x).toBe(5);
    expect(entityB.get(TransformMeta.trait).y).toBe(7);
    const batchedExists = (await import('@modoki/engine/runtime')).getAllEntities().some((e) => e.name === 'Batched');
    expect(batchedExists).toBe(true);

    const did = await undo();
    expect(did).toBe(true);
    expect(canUndo()).toBe(false); // the WHOLE batch was one entry — nothing left to undo
    expect(entityA.get(TransformMeta.trait).x).toBe(0);
    expect(entityB.get(TransformMeta.trait).y).toBe(0);
    const batchedGone = !(await import('@modoki/engine/runtime')).getAllEntities().some((e) => e.name === 'Batched');
    expect(batchedGone).toBe(true);

    // Redo re-applies all three.
    const redid = await redo();
    expect(redid).toBe(true);
    expect(canRedo()).toBe(false);
    expect(entityA.get(TransformMeta.trait).x).toBe(5);
    expect(entityB.get(TransformMeta.trait).y).toBe(7);
  });

  it('removeTrait + removeEntity also batch into one entry', async () => {
    const a = await createBox();
    const b = await createBox();
    // Give `a` a non-core trait to remove (removeTrait refuses Transform/EntityAttributes) —
    // outside the batch under test, so it doesn't count toward that batch's undo entry.
    await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: a.guid }, trait: 'Light', fields: { intensity: 1 } }] });
    markSceneSaved(); clearHistory();

    const LightMeta = (await import('@modoki/engine/runtime')).getTraitByName('Light')!;
    const r = await runAgentOp('apply-scene-ops', {
      ops: [
        { op: 'removeTrait', entity: { guid: a.guid }, trait: 'Light' },
        { op: 'removeEntity', entity: { guid: b.guid } },
      ],
    }) as { ok: boolean; changed: number };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(2);
    expect(findEntityByGuid(a.guid)!.has(LightMeta.trait)).toBe(false);
    expect(findEntityByGuid(b.guid)).toBeUndefined();
    expect(undoLabel()).toContain('2 ops');

    const did = await undo();
    expect(did).toBe(true);
    expect(canUndo()).toBe(false); // one entry — a single undo reverts BOTH ops
    expect(findEntityByGuid(a.guid)!.has(LightMeta.trait)).toBe(true);
    expect(findEntityByGuid(b.guid)).not.toBeUndefined();
  });

  it('setTrait with fields on an entity that does NOT yet have the trait ADDS it seeded with those fields (mirrors sceneMutate.ts\'s file-direct semantics) — regression: this used to silently no-op while still reporting changed:1', async () => {
    const a = await createBox();
    const LightMeta = (await import('@modoki/engine/runtime')).getTraitByName('Light')!;
    expect(findEntityByGuid(a.guid)!.has(LightMeta.trait)).toBe(false);

    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: a.guid }, trait: 'Light', fields: { intensity: 2.5 } }],
    }) as { ok: boolean; changed: number };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(1);
    const entity = findEntityByGuid(a.guid)!;
    expect(entity.has(LightMeta.trait)).toBe(true);
    expect(entity.get(LightMeta.trait).intensity).toBe(2.5);

    const did = await undo();
    expect(did).toBe(true);
    expect(findEntityByGuid(a.guid)!.has(LightMeta.trait)).toBe(false); // undo removes the ADDED trait, not just its fields
  });

  it('an unresolved entity ref is reported (not silently skipped), and does not abort the rest of the batch', async () => {
    const a = await createBox();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [
        { op: 'setTrait', entity: { guid: 'no-such-guid' }, trait: 'Transform', fields: { x: 1 } },
        { op: 'setTrait', entity: { guid: a.guid }, trait: 'Transform', fields: { x: 9 } },
      ],
    }) as { ok: boolean; changed: number; errors: string[]; unresolved: Array<{ guid?: string }> };
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(1); // the second op still applied
    expect(r.unresolved).toEqual([{ guid: 'no-such-guid' }]);
    expect(r.errors[0]).toMatch(/no LIVE entity/);
  });

  // The router (editorBackendRouter.ts) never actually routes a setBaseScene-bearing call
  // here — it keeps the whole call file-direct instead. This locks the op's OWN defense in
  // depth for any other caller.
  it('setBaseScene has no live equivalent — reported as a per-op error, not applied (mirrors an unknown op)', async () => {
    const r = await runAgentOp('apply-scene-ops', { ops: [{ op: 'setBaseScene', baseScene: 'g' }] }) as { ok: boolean; changed: number; errors: string[] };
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(0);
    expect(r.errors[0]).toMatch(/no live-world equivalent/);
    expect(canUndo()).toBe(false); // nothing changed ⇒ nothing pushed
  });

  it('a single-op batch is still wrapped as one entry (label reflects the caller\'s call, not op count)', async () => {
    const a = await createBox();
    await runAgentOp('apply-scene-ops', { ops: [{ op: 'setTrait', entity: { guid: a.guid }, trait: 'Transform', fields: { x: 3 } }] });
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toContain('1 op');
  });

  it('empty ops array is rejected up front', async () => {
    await expect(runAgentOp('apply-scene-ops', { ops: [] })).rejects.toThrow(/non-empty/);
  });
});
