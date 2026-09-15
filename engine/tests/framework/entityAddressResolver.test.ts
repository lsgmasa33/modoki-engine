/** The ONE live entity-address resolver (`app/debug/entityRef.ts`, #1223), against a real world.
 *
 *  One case per rule, then one per DEVICE-surface seam that now resolves through it (the editor ops are
 *  `tests/editor/entityAddressEditorOps.test.ts`, because registering them replaces these device ops in
 *  the same registry). Each case names the mutation that turns it red. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes, getCurrentWorld, setCurrentWorld, classifyRuntimeGuidMiss, destroyEntity } from '@modoki/engine/runtime';
import { createWorld } from 'koota';
import { isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { resolveEntityAddress } from '../../app/debug/entityRef';
import { runAgentOp } from '../../app/debug/agentBridge';
import { OpRefusal, opReplyFor } from '../../app/debug/opRefusal';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

const guidOf = (e: { get(t: unknown): unknown }) => (e.get(EntityAttributes) as { guid: string }).guid;
const L = { label: 't' };

describe('resolveEntityAddress — the rules', () => {
  // Mutation: count `''` as given in givenAddressKeys.
  it('an empty string is ABSENT, so {guid:"", id} is one address, not a refused pair', () => {
    game = createTestWorld({});
    const bare = game.spawn(Transform());
    bare.remove(EntityAttributes); // the one entity {id} may name (#1248)
    expect(resolveEntityAddress({ guid: '', id: bare.id() }, L)).toMatchObject({ ok: true, id: bare.id(), guid: null });
    expect(resolveEntityAddress({ guid: '', name: '' }, L)).toMatchObject({ ok: false, error: expect.stringContaining('no entity address') });
  });

  // Mutation: delete the `given.length > 1` refusal (the first key then wins by precedence).
  it('two addresses are refused AMBIGUOUS, even when both name the same entity (D1)', () => {
    game = createTestWorld({});
    const a = game.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game.spawn(Transform(), EntityAttributes({ name: 'B' }));
    // The dangerous case: a stale id beside a guid names a DIFFERENT entity.
    expect(resolveEntityAddress({ guid: guidOf(a), id: b.id() }, L)).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(resolveEntityAddress({ guid: guidOf(a), name: 'A' }, L)).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });

  // Mutation: drop the `if (guid)` refusal in the id branch.
  it('{id} for an entity that has a guid is refused with that guid as the one option; a guid-less entity resolves (D2)', () => {
    game = createTestWorld({});
    const a = game.spawn(Transform(), EntityAttributes({ name: 'A' }));
    expect(resolveEntityAddress({ id: a.id() }, L)).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: [guidOf(a)] });
    a.remove(EntityAttributes);
    expect(resolveEntityAddress({ id: a.id() }, L)).toMatchObject({ ok: true, id: a.id() });
    expect(resolveEntityAddress({ id: 987654 }, L)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  // Close-out review: koota's own world entity is id 0 — unregistered, no EntityAttributes, so no guid — and
  // `findEntity`'s fallback scan found it. Mutation: use `findEntity` instead of `findEntityById` in the id branch.
  it('{id:0} is NOT_FOUND: koota\'s world entity is not a registered entity, whatever its missing guid says', async () => {
    game = createTestWorld({});
    expect(getCurrentWorld().entities.some((e) => e.id() === 0)).toBe(true); // it IS in koota's raw list
    expect(resolveEntityAddress({ id: 0 }, L)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const r = await runAgentOp('set-traits', { id: 0, set: { 'Transform.x': 4 } }) as { ok?: boolean; code?: string };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  // Mutation: make the name comparison case-insensitive (the device `set-traits` copy was).
  it('a name is exact and case-sensitive; several matches are refused with their guids', () => {
    game = createTestWorld({});
    const p1 = game.spawn(Transform(), EntityAttributes({ name: 'Pair' }));
    const p2 = game.spawn(Transform(), EntityAttributes({ name: 'Pair' }));
    expect(resolveEntityAddress({ name: 'pair' }, L)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(resolveEntityAddress({ name: 'Pair' }, L)).toMatchObject({ ok: false, code: 'AMBIGUOUS', options: [guidOf(p1), guidOf(p2)] });
  });

  // Mutation: drop the `stale` spread from the guid-miss refusal.
  it('a despawned runtime guid misses NOT_FOUND with stale:"despawned" (D4)', () => {
    game = createTestWorld({});
    const shot = game.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    expect(isRuntimeGuid(guid)).toBe(true);
    destroyEntity(shot); // the production despawn: unregisterEntity drops the address row
    expect(resolveEntityAddress({ guid }, L)).toMatchObject({ ok: false, code: 'NOT_FOUND', stale: 'despawned' });
  });

  // Mutation: in classifyRuntimeGuidMiss, return null when the generation is not the current world's.
  it('a runtime guid from an earlier world misses with stale:"world-swapped"', () => {
    game = createTestWorld({});
    const shot = game.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    const world = getCurrentWorld();
    setCurrentWorld(createWorld()); // a scene load's swap
    try {
      expect(resolveEntityAddress({ guid }, L)).toMatchObject({ ok: false, code: 'NOT_FOUND', stale: 'world-swapped' });
    } finally { setCurrentWorld(world); }
  });

  // Accept side of both classifications: no stale field for what cannot be placed.
  it('a durable miss, and a runtime guid this page never issued, carry no stale', () => {
    game = createTestWorld({});
    const durable = resolveEntityAddress({ guid: 'c0ffee00-0000-4000-8000-000000000000' }, L);
    expect(durable).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect('stale' in durable).toBe(false);
    const invented = '00000000-7777-7777-0000-000000000001';
    expect(classifyRuntimeGuidMiss(invented)).toBeNull();
    expect('stale' in resolveEntityAddress({ guid: invented }, L)).toBe(false);
    // …and a live one is a hit, never "stale".
    const live = game.spawn(Transform(), EntityAttributes({ name: 'Live' }));
    expect(classifyRuntimeGuidMiss(guidOf(live))).toBeNull();
  });
});

describe('the relay carries `stale` (D4)', () => {
  // Mutation: drop the `stale` spread in opReplyFor.
  it('an OpRefusal with stale reaches the reply body beside its code', async () => {
    const reply = await opReplyFor(() => { throw new OpRefusal('NOT_FOUND', 'gone', { stale: 'world-swapped' }); });
    expect(reply).toEqual({ result: { ok: false, code: 'NOT_FOUND', error: 'gone', stale: 'world-swapped' } });
  });
});

describe('device-surface seams resolve through it', () => {
  // Mutation: in createEntityLive, resolve `parentGuid` alone (the old precedence).
  it('device create-entity refuses parentGuid beside a non-zero parentId, and creates nothing', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = game.spawn(Transform(), EntityAttributes({ name: 'B' }));
    const before = getCurrentWorld().entities.length;
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guidOf(a), parentId: b.id() }) as { ok?: boolean; code?: string };
    expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(getCurrentWorld().entities.length).toBe(before);
  });

  // Mutation: in liveMutate's guid-list branch, drop `stale ??= r.stale`.
  it('device set-traits on a despawned runtime guid refuses NOT_FOUND with stale', async () => {
    game = createTestWorld({});
    const shot = game.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    destroyEntity(shot); // the production despawn: unregisterEntity drops the address row
    const r = await runAgentOp('set-traits', { guid, set: { 'Transform.x': 1 } }) as { ok?: boolean; code?: string; stale?: string; error?: string };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND', stale: 'despawned' });
    expect(r.error).toContain(`${guid} (despawned)`);
  });

  // Close-out review: a LIST element is not an optional address. Mutation: filter '' out of guidList again.
  it('device set-traits refuses an EMPTY guid inside a list instead of dropping it, and writes nothing', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'A' }));
    const r = await runAgentOp('set-traits', { guid: [guidOf(a), ''], set: { 'Transform.x': 5 } }) as { ok?: boolean; code?: string; error?: string };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.error).toContain('1 of 2 guid(s)');
    expect((a.get(Transform) as { x: number }).x).toBe(0);
  });

  // Mutation: drop `stale ??= r.stale` (or the code) from deleteEntitiesLive's missing refusal.
  it('device delete-entities on a despawned runtime guid refuses NOT_FOUND with stale, and deletes nothing', async () => {
    game = createTestWorld({});
    const keep = game.spawn(Transform(), EntityAttributes({ name: 'Keep' }));
    const shot = game.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = guidOf(shot);
    destroyEntity(shot);
    const r = await runAgentOp('delete-entities', { guids: [guidOf(keep), guid] }) as { ok?: boolean; code?: string; stale?: string };
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND', stale: 'despawned' });
    expect(keep.isAlive()).toBe(true);
  });

  // Mutation: in liveMutate's id/name branch, return `{ ids: [r.id] }` without checking r.ok.
  it('device set-traits by id refuses an entity that has a guid, and writes nothing', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'A' }));
    const r = await runAgentOp('set-traits', { id: a.id(), set: { 'Transform.x': 5 } }) as { ok?: boolean; code?: string; options?: string[] };
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: [guidOf(a)] });
    expect((a.get(Transform) as { x: number }).x).toBe(0);
  });

  // The op capture_gesture's host route now asks. Mutation: return `{ok:true}` from 'resolve-entity' without resolving.
  it('resolve-entity follows the shared rules and hands back the resolved guid', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform(), EntityAttributes({ name: 'A' }));
    expect(await runAgentOp('resolve-entity', { guid: guidOf(a) })).toMatchObject({ ok: true, id: a.id(), guid: guidOf(a), name: 'A' });
    expect(await runAgentOp('resolve-entity', { guid: guidOf(a), id: a.id() })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(await runAgentOp('resolve-entity', { id: a.id() })).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: [guidOf(a)] });
  });
});
