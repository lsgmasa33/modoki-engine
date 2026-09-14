/** #868 — `entityPin`: UI state resolves to the entity it was taken for, or to nothing.
 *
 *  The Apply/Revert Prefab dialog, Hierarchy's inline rename and the debug World tab hold an entity
 *  id across user time. In between, the entity can be deleted (by an agent, an undo, a Play/Stop
 *  rebuild) and koota can hand its index to another entity — which a bare id would then act on. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type Entity, type World } from 'koota';
import { pinEntityAt, livePinnedId } from '../../src/runtime/core/ecs/entityPin';
import { subjectGoneNotice, runOnPinnedSubject } from '../../src/editor/panels/prefabDialogSubject';
import { renameCommitTarget } from '../../src/editor/panels/renamePin';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.destroy(); });

function worldWithIndex() {
  const world = createWorld(); worlds.push(world);
  const byId = new Map<number, Entity>();
  const spawn = () => { const e = world.spawn(); byId.set(e.id(), e); return e; };
  const destroy = (e: Entity) => { byId.delete(e.id()); e.destroy(); };
  return { world, spawn, destroy, lookup: (id: number) => byId.get(id) };
}

describe('entityPin', () => {
  it('resolves to the root id while the entity it was opened for is alive', () => {
    const { world, spawn, lookup } = worldWithIndex();
    const root = spawn();
    const subject = pinEntityAt(root.id(), lookup, world);
    expect(livePinnedId(subject, lookup, world)).toBe(root.id());
  });

  it('resolves to nothing once that entity is gone, even when another entity holds its index', () => {
    const { world, spawn, destroy, lookup } = worldWithIndex();
    const root = spawn();
    const subject = pinEntityAt(root.id(), lookup, world);

    destroy(root);
    expect(livePinnedId(subject, lookup, world)).toBeNull();

    const squatter = spawn();
    expect(squatter.id()).toBe(root.id());
    expect(livePinnedId(subject, lookup, world)).toBeNull();
  });

  it('resolves to nothing after a world rebuild that puts an entity back on the same id', () => {
    const a = worldWithIndex();
    const root = a.spawn();
    const subject = pinEntityAt(root.id(), a.lookup, a.world);

    const b = worldWithIndex();
    const rebuilt = b.spawn();
    expect(rebuilt.id()).toBe(root.id());
    expect(livePinnedId(subject, b.lookup, b.world)).toBeNull();
  });

  it('pins nothing for an id with no entity, and a null subject never resolves', () => {
    const { world, lookup } = worldWithIndex();
    expect(pinEntityAt(12345, lookup, world)).toBeNull();
    expect(livePinnedId(null, lookup, world)).toBeNull();
  });

  it('resolves to nothing in a later world even when koota reuses the pinned world\'s id and packed value', () => {
    // SceneManager's order: create the next world, then destroy the old one — koota then hands the
    // freed world id to the world after that, so an entity there can carry the pinned PACKED value.
    const w1 = worldWithIndex();
    const root = w1.spawn();
    const subject = pinEntityAt(root.id(), w1.lookup, w1.world);
    const w2 = worldWithIndex();
    worlds.splice(worlds.indexOf(w1.world), 1); w1.world.destroy();
    const w3 = worldWithIndex();
    const alias = w3.spawn();
    void w2;
    expect(alias.valueOf()).toBe(subject!.packed); // the aliasing this test exists for

    expect(livePinnedId(subject, w3.lookup, w3.world)).toBeNull();
  });

  it('the dialog acts on a live subject, and closes with a notice instead of acting once it is gone', async () => {
    const { world, spawn, destroy, lookup } = worldWithIndex();
    const root = spawn();
    const subject = pinEntityAt(root.id(), lookup, world);
    const acted: number[] = []; const gone: string[] = [];
    const run = () => runOnPinnedSubject({ subject, lookup, world, mode: 'apply', act: async (id) => { acted.push(id); }, onGone: (n) => gone.push(n) });

    expect(await run()).toBe(true);
    destroy(root); spawn(); // a squatter on the index
    expect(await run()).toBe(false);
    expect(acted).toEqual([root.id()]);
    expect(gone).toEqual([subjectGoneNotice('apply')]);
  });

  it('a rename commits only onto the entity it was started for', () => {
    const { world, spawn, destroy, lookup } = worldWithIndex();
    const row = spawn();
    const pin = pinEntityAt(row.id(), lookup, world);
    expect(renameCommitTarget(pin, row.id(), lookup, world)).toBe(row.id());
    expect(renameCommitTarget(pin, row.id() + 1, lookup, world)).toBeNull(); // a different row's input
    destroy(row); spawn();
    expect(renameCommitTarget(pin, row.id(), lookup, world)).toBeNull();
  });

  it('the prefab dialog\'s notice names what did not happen, per mode', () => {
    expect(subjectGoneNotice('apply')).toMatch(/nothing was applied/i);
    expect(subjectGoneNotice('revert')).toMatch(/nothing was reverted/i);
  });
});
