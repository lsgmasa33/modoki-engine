/** #1793 defence in depth (hub, 2026-09-29): two lines no current gesture reaches, each built here from its bad input.
 *
 *  - `instantiatePrefab` handed a raw parent id no live entity holds REFUSES before it spawns anything. #1793's thrown
 *    redo was exactly that id, recycled by koota during the call's own first pass, so the root was parented under its
 *    own member. And a parent that stops being the same entity during the spawn refuses at the second pass, with what the
 *    call spawned taken back out.
 *  - `subtreePaths` (the instantiate undo's guid capture) REFUSES on a parent cycle, naming the entity, where it recursed
 *    until `Maximum call stack size exceeded`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

/** Runs once, inside `instantiatePrefab`'s first pass (the migration every row goes through): where a spawn could
 *  change the world under the call. */
const hook = vi.hoisted(() => ({ during: null as null | (() => void) }));
vi.mock('../../packages/modoki/src/runtime/loaders/uiAnchorZIndexMigration', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/runtime/loaders/uiAnchorZIndexMigration')>();
  return {
    ...real,
    migrateUIAnchorZIndexStructured: (...a: Parameters<typeof real.migrateUIAnchorZIndexStructured>) => {
      const f = hook.during; hook.during = null; f?.();
      return real.migrateUIAnchorZIndexStructured(...a);
    },
  };
});

import { getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, writeTraitField, destroyEntity, spawnEntity } from '@modoki/engine/runtime';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { instantiatePrefab, instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { makePrefabInstantiateAction } from '../../packages/modoki/src/editor/undo/prefabInstantiateUndo';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const row = (localId: number, name: string, parentId: number) => ({
  localId, name, nodeGuid: `eeeeeeee-0000-4000-8000-00000017930${localId}`,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** R → A, B. */
const doc = (): PrefabFile => ({ id: 'cccccccc-0000-4000-8000-000000017930', version: 6, name: 'R', rootLocalId: 1,
  entities: [row(1, 'R', 0), row(2, 'A', 1), row(3, 'B', 1)] } as unknown as PrefabFile);

const ea = () => getTraitByName('EntityAttributes')!;
const spawnNamed = (name: string, parentId = 0): number => {
  const e = spawnEntity(getCurrentWorld());
  const id = e.id();
  writeTraitField(id, ea(), 'name', name);
  writeTraitField(id, ea(), 'parentId', parentId);
  return id;
};
const names = () => getAllEntities().map((e) => e.name).sort();

beforeEach(() => {
  setCurrentWorld(createWorld());
  setRunMode('stopped');
  hook.during = null;
});

describe('instantiatePrefab refuses a raw parent id that is not the live entity it was handed (#1793)', () => {
  // Mutation: remove the entry check (`parentId > 0 && !findEntity(parentId)`) — the call spawns R under a dead id.
  it('a dead id refuses before anything is spawned', () => {
    const x = spawnNamed('X');
    destroyEntity(findEntity(x));
    const before = names();
    let thrown: unknown;
    try { instantiatePrefab(doc(), x); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(UndoRefusedError);
    expect(String((thrown as Error).message)).toMatch(new RegExp(`under entity ${x}: no live entity holds that id`));
    expect(names()).toEqual(before);
  });

  it('(accept) a live parent takes the instance root', () => {
    const x = spawnNamed('X');
    const root = instantiatePrefab(doc(), x);
    expect(root).toBeGreaterThan(0);
    expect(readTraitData(root, ea())?.parentId).toBe(x);
    expect(names()).toEqual(['A', 'B', 'R', 'X']);
  });

  // Mutation: remove the second-pass check (`sameParent && !sameParent()`) — R is parented under Y, the entity that
  // took X's recycled id mid-spawn.
  it('a parent destroyed and its id recycled during the spawn refuses at the second pass, taking the spawned rows back out', () => {
    const x = spawnNamed('X');
    let y = 0;
    hook.during = () => {
      destroyEntity(findEntity(x));
      y = spawnNamed('Y');
      expect(y, 'premise: koota recycled the freed index').toBe(x);
    };
    let thrown: unknown;
    try { instantiatePrefab(doc(), x); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(UndoRefusedError);
    expect(String((thrown as Error).message)).toMatch(/is not the entity the instantiate was handed any more/);
    expect(names()).toEqual(['Y']);
    expect(readTraitData(y, ea())?.parentId).toBe(0);
  });
});

describe('a placement resolves its parent AFTER the instantiate\'s awaits (#1793 review)', () => {
  // A parent resolved before `instantiatePrefabInstance`'s awaits names, after a world rebuilt during them, whatever
  // entity holds that number in the new world — usually live, so the entry check cannot tell. The read token is asked
  // after those awaits, so the parent must be asked after it. Mutation: resolve `parent` at the top of
  // `instantiatePrefabInstance` — 'parent' comes first.
  it('the parent resolver runs after the read check, right before the spawn', async () => {
    const x = spawnNamed('X');
    const order: string[] = [];
    const root = await instantiatePrefabInstance(doc(), '/assets/prefabs/R.prefab.json', () => { order.push('parent'); return x; }, () => { order.push('read'); return true; });
    expect(order).toEqual(['read', 'parent']);
    expect(readTraitData(root, ea())?.parentId).toBe(x);
  });
});

describe('the instantiate undo\'s subtree walk refuses a parent cycle (#1793)', () => {
  const action = (initialId: number) => makePrefabInstantiateAction({ label: 'Instantiate "R"', initialId, respawn: async () => null, remove: () => {} });

  // Mutation: remove the visited set's throw in `subtreePaths` — the walk recurses until the stack overflows.
  it('a cycle refuses, naming the entity, instead of overflowing the stack', () => {
    const a = spawnNamed('Cyc A');
    const b = spawnNamed('Cyc B', a);
    writeTraitField(a, ea(), 'parentId', b);
    let thrown: unknown;
    try { action(a); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(UndoRefusedError);
    expect(String((thrown as Error).message)).toMatch(/"Cyc A" \(entity \d+\) is its own ancestor — a parent cycle/);
  });

  it('(accept) a tree with no cycle records its guids as before', () => {
    const a = spawnNamed('Tree A');
    spawnNamed('Tree B', a);
    expect(() => action(a)).not.toThrow();
  });
});
