/** #1216 C-12 / #1223 D6 — a field write on a trait the entity lacks ADDS the trait, and every surface
 *  that does so now says it: the device's `set-traits` and the editor's live `apply-scene-ops` (the
 *  file-direct `applyOps` twin is pinned in packages/modoki/tests/runtime/sceneMutate.test.ts).
 *
 *  Both added the trait and answered only `changed:1`, which cannot tell a field edit from a new
 *  component — so a typo'd trait name that happens to be registered reads as a successful edit. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, Renderable3DPrimitive, setPlayState, findEntityByGuid, getTraitByName, guidOfEntityId,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

type Added = Array<{ id?: number; op?: number; guid: string | null; trait: string }>;

let game: TestWorld;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
});
afterEach(() => game.dispose());

const has = (guid: string, trait: string) => findEntityByGuid(guid)!.has(getTraitByName(trait)!.trait);

describe('device set-traits', () => {
  // Mutation: drop the `addedTraits` spread from applyLiveMutate's reply.
  it('lists the trait a field write added, once per entity even for two fields of it', async () => {
    const a = game.spawn(Transform(), EntityAttributes({ guid: 'da', name: 'A' })).id();
    const r = await runAgentOp('set-traits', { guid: 'da', set: { 'Renderable3DPrimitive.size': 2, 'Renderable3DPrimitive.mesh': 'cube', 'Transform.x': 1 } }) as { addedTraits?: Added };
    expect(r.addedTraits).toEqual([{ id: a, guid: 'da', trait: 'Renderable3DPrimitive' }]);
    expect(has('da', 'Renderable3DPrimitive')).toBe(true);
  });

  // Mutation: compute `lacking` without the `w.field !== null` filter.
  it('an edit of a trait it has, and a tag write, list nothing', async () => {
    game.spawn(Transform(), EntityAttributes({ guid: 'db', name: 'B' }), Renderable3DPrimitive());
    const r = await runAgentOp('set-traits', { guid: 'db', set: { 'Renderable3DPrimitive.size': 3, Persistent: true } }) as { addedTraits?: Added };
    expect(r).not.toHaveProperty('addedTraits');
  });

  // Mutation: compute `lacking` AFTER the writes.
  it('a dry run names what it WOULD add, and adds nothing', async () => {
    game.spawn(Transform(), EntityAttributes({ guid: 'dc', name: 'C' }));
    const r = await runAgentOp('set-traits', { guid: 'dc', set: { 'Renderable3DPrimitive.size': 2 }, dryRun: true }) as { addedTraits?: Added };
    expect(r.addedTraits?.map((x) => x.trait)).toEqual(['Renderable3DPrimitive']);
    expect(has('dc', 'Renderable3DPrimitive')).toBe(false);
  });

  // Mutation: drop the `addedTraitsTotal` spread, or push past `limit`.
  it('rows are capped at limit, and the cap is said', async () => {
    for (const g of ['e1', 'e2', 'e3']) game.spawn(Transform(), EntityAttributes({ guid: g, name: 'Many' }));
    const r = await runAgentOp('set-traits', { guid: ['e1', 'e2', 'e3'], set: { 'Renderable3DPrimitive.size': 2 }, limit: 2 }) as { addedTraits?: Added; addedTraitsTotal?: number };
    expect(r.addedTraits).toHaveLength(2);
    expect(r.addedTraitsTotal).toBe(3);
  });
});

describe('editor apply-scene-ops (live)', () => {
  // Mutation: drop the `addedTraits.push` in applySceneOpsLive's add-seeded branch.
  it('lists the trait a setTrait with fields added, by op', async () => {
    const e = game.spawn(Transform(), EntityAttributes({ guid: 'ea', name: 'EA' })).id();
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'setTrait', entity: { guid: 'ea' }, trait: 'Transform', fields: { x: 1 } },
      { op: 'setTrait', entity: { guid: 'ea' }, trait: 'Renderable3DPrimitive', fields: { size: 2 } },
      { op: 'setTrait', entity: { guid: 'ea' }, trait: 'Persistent' },
    ] }) as { addedTraits?: Added };
    expect(r.addedTraits).toEqual([{ op: 1, id: e, guid: 'ea', trait: 'Renderable3DPrimitive' }]);
  });

  // Review asked whether a code-spawned entity's row carries a runtime guid (which a file-direct op refuses).
  // It does not: the add's undo action mints a durable one first. This pins that outcome; a mutation of the
  // row's own guid read (ensureGuid → liveGuidOf) does NOT turn it red, because the undo action already minted.
  it('names a code-spawned entity by a durable guid', async () => {
    const e = game.spawn(Transform(), EntityAttributes({ name: 'Rt' })).id();
    expect(guidOfEntityId(e)).toMatch(/^00000000-/);
    const r = await runAgentOp('apply-scene-ops', { ops: [
      { op: 'setTrait', entity: { guid: guidOfEntityId(e)! }, trait: 'Renderable3DPrimitive', fields: { size: 2 } },
    ] }) as { addedTraits?: Added };
    expect(r.addedTraits?.[0].guid).not.toMatch(/^00000000-/);
    expect(findEntityByGuid(r.addedTraits![0].guid!)?.id()).toBe(e);
  });
});
