/** Instantiate's undo → redo brings back the SAME identities, sibling for sibling (#1831 hunt seed 5785, hub 2026-09-30).
 *
 *  The redo re-instantiates the prefab and stamps each guid the undo captured back by structural path (`name#index`,
 *  `prefabInstantiateUndo.ts`). Two siblings with one sortOrder and one name were ordered by ECS id, which is not
 *  structural: a respawn that hands ids out in another order made the two captured guids land on each other's entity,
 *  and every ref to either silently named the other. Unity: undo/redo restores the same objects, with the same
 *  identities. They are now told apart by their template identity (`entityStep`: a keyed node's key, else a member's
 *  localId).
 *
 *  Driven through the real undo step (`makePrefabInstantiateAction`: its capture and its restore). Each respawn gives
 *  the LOWER ecs id the identity the original gave the HIGHER one, whatever order the allocator hands ids out in
 *  (koota's free list is LIFO, so a respawn in reverse spawn order would get the original order back): that is the
 *  condition the fuzzer's route met (5785, in REGRESSIONS, which also covers the save → reload), forced on every
 *  redo rather than left to the allocator (close-out review). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, spawnEntity, destroyEntity, Transform, EntityAttributes, setRunMode,
} from '@modoki/engine/runtime';
import { setTemplateKey, templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { makePrefabInstantiateAction } from '../../packages/modoki/src/editor/undo/prefabInstantiateUndo';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const ROOT = 'dddddddd-0000-4000-8000-000000057851';
const LEFT = 'dddddddd-0000-4000-8000-000000057852';
const RIGHT = 'dddddddd-0000-4000-8000-000000057853';
const K1 = 'aaaaaaaa-0000-4000-8000-000000057854';
const K2 = 'aaaaaaaa-0000-4000-8000-000000057855';

type Shape = {
  name: string;
  /** Give sibling `e` identity `which` (0 or 1), and its captured guid when `guid` is set. */
  mark: (e: ReturnType<typeof spawnEntity>, root: number, which: 0 | 1) => void;
  /** Which of the two identities `e` carries. */
  which: (e: ReturnType<typeof spawnEntity>) => 0 | 1 | null;
};
const PI = () => getTraitByName('PrefabInstance')!;
/** Two MEMBERS of the instance's frame: localIds 2 and 3. */
const members: Shape = {
  name: 'Twin',
  mark: (e, root, which) => e.add(PI().trait({ source: 'p', localId: which ? 3 : 2, rootInstanceId: root })),
  which: (e) => (e.has(PI().trait) ? (((e.get(PI().trait) as { localId: number }).localId === 3) ? 1 : 0) : null),
};
/** Two template-keyed REFERENCE roots of one prefab `d`: each its own instance root (PI localId = d's root, 1), told
 *  apart only by its key (close-out review: a member-step rank tied them). */
const keyedRoots: Shape = {
  name: 'D',
  mark: (e, _root, which) => {
    e.add(PI().trait({ source: 'd', localId: 1, rootInstanceId: e.id() }));
    setTemplateKey(e, which ? K2 : K1);
  },
  which: (e) => { const k = templateKeyOf(e); return k === K1 ? 0 : k === K2 ? 1 : null; },
};

/** An instance `R → two siblings named shape.name at sortOrder 0`. `lowerGets` is the identity the LOWER ecs id takes;
 *  `guids[which]` the guid each is spawned with ('' for a respawn). Returns the root id. */
function spawnInstance(shape: Shape, lowerGets: 0 | 1, guids: [string, string], rootGuid: string): number {
  const world = getCurrentWorld();
  const root = spawnEntity(world, Transform(), EntityAttributes({ name: 'R', guid: rootGuid }), PI().trait({ source: 'p', localId: 1, rootInstanceId: 0 }));
  root.set(PI().trait, { ...(root.get(PI().trait) as object), rootInstanceId: root.id() });
  const pair = [spawnEntity(world, Transform()), spawnEntity(world, Transform())].sort((a, b) => a.id() - b.id());
  pair.forEach((e, i) => {
    const which = (i === 0 ? lowerGets : 1 - lowerGets) as 0 | 1;
    const EA = getTraitByName('EntityAttributes')!.trait;
    const attrs = { name: shape.name, parentId: root.id(), guid: guids[which] };
    if (e.has(EA)) e.set(EA, { ...(e.get(EA) as object), ...attrs }); else e.add(EntityAttributes(attrs));
    shape.mark(e, root.id(), which);
  });
  return root.id();
}
const guidsOf = (shape: Shape): Record<number, string> => {
  const EA = getTraitByName('EntityAttributes')!;
  const out: Record<number, string> = {};
  for (const e of [...getCurrentWorld().entities]) {
    const ea = e.has(EA.trait) ? e.get(EA.trait) as { name?: string; guid?: string } : undefined;
    const w = ea?.name === shape.name ? shape.which(e) : null;
    if (w !== null) out[w] = ea!.guid ?? '';
  }
  return out;
};
const removeTree = (id: number) => {
  const world = getCurrentWorld();
  const ids = new Set([id, ...getAllEntities().filter((e) => e.parentId === id).map((e) => e.id)]);
  for (const e of [...world.entities]) if (ids.has(e.id())) destroyEntity(e, world);
};

beforeEach(() => {
  setRunMode('stopped');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
});

describe('Instantiate → Undo → Redo keeps each same-named sibling on its own guid (seed 5785)', () => {
  // Mutation: break the tie by ECS id before the template identity in `subtreePaths` (the rule before) — both cases red
  // at the FIRST redo. Mutation: rank a member's step before a key (the first version) — the keyed case goes red.
  for (const shape of [members, keyedRoots]) {
    it(`${shape === members ? 'two members' : 'two keyed reference roots of one prefab'}: every redo gives each its captured guid`, async () => {
      const first = spawnInstance(shape, 0, [LEFT, RIGHT], ROOT);
      const action = makePrefabInstantiateAction({
        label: 'Instantiate "p"',
        initialId: first,
        // The original gave the lower id identity 0; every respawn gives it identity 1.
        respawn: async () => spawnInstance(shape, 1, ['', ''], ''),
        remove: removeTree,
      });
      expect(guidsOf(shape)).toEqual({ 0: LEFT, 1: RIGHT });
      await action.undo();
      expect(guidsOf(shape)).toEqual({}); // premise: the instance is gone
      await action.redo();
      expect(guidsOf(shape)).toEqual({ 0: LEFT, 1: RIGHT });
      await action.undo();
      await action.redo();
      expect(guidsOf(shape)).toEqual({ 0: LEFT, 1: RIGHT });
    });
  }
});
