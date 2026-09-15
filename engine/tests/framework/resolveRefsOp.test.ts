/** resolve-refs op — the batched "ref → entity name" second hop that keeps names OUT of the
 *  journal stream. Covers the dense branching that had zero coverage: numeric-string coercion,
 *  live-world-wins-over-side-table precedence + the `alive` flag, side-table resolution AFTER
 *  despawn (by the guid the synthesized exit carries, #1225), the `unresolved` list,
 *  the empty-name-is-unresolved guard, and the empty-refs early return. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, EntityAttributes, entityRef } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type Reply = { resolved: Record<string, { name: string; alive: boolean }>; unresolved?: (string | number)[] };
const resolve = (refs: (string | number)[]) => runAgentOp('resolve-refs', { refs }) as Promise<Reply>;

describe('resolve-refs: live-world resolution', () => {
  it('resolves a live entity by GUID, numeric id, AND numeric string — all alive:true', async () => {
    game = createTestWorld();
    const e = game.spawn(EntityAttributes({ guid: 'g-alpha', name: 'Alpha' }));
    const id = e.id();
    const r = await resolve(['g-alpha', id, String(id)]);
    expect(r.resolved['g-alpha']).toEqual({ name: 'Alpha', alive: true });
    expect(r.resolved[String(id)]).toEqual({ name: 'Alpha', alive: true }); // numeric + numeric-string collapse to one key
  });

  it('an unknown ref lands in `unresolved`, not `resolved`', async () => {
    game = createTestWorld();
    const r = await resolve(['no-such-guid', 999999]);
    expect(r.resolved).toEqual({});
    expect(r.unresolved).toEqual(expect.arrayContaining(['no-such-guid', 999999]));
  });

  it('empty refs → { resolved: {} } with no world walk crash', async () => {
    game = createTestWorld();
    const r = await resolve([]);
    expect(r).toEqual({ resolved: {} });
  });
});

describe('resolve-refs: side-table resolution after despawn (the headline case)', () => {
  it('names a despawned GUID entity by its guid, alive:false', async () => {
    game = createTestWorld();
    const e = game.spawn(EntityAttributes({ guid: 'g-bolt', name: 'Bolt' }));
    entityRef(e); // a contact emit would do this while alive → seeds the side-table
    e.destroy();
    game.step(1);

    const r = await resolve(['g-bolt']);
    // Live lookup misses (dead), so it falls through to the side-table. A despawn-exit carries this
    // same guid (the ref cached while alive, #1225), so the guid is the only key it needs.
    expect(r.resolved['g-bolt']).toEqual({ name: 'Bolt', alive: false });
    expect(r.unresolved).toBeUndefined();
  });

  it('a live name wins over the side-table (alive:true) for a still-present entity', async () => {
    game = createTestWorld();
    const e = game.spawn(EntityAttributes({ guid: 'g-live', name: 'LiveName' }));
    entityRef(e); // seed side-table too — the live value must still win
    const r = await resolve(['g-live']);
    expect(r.resolved['g-live']).toEqual({ name: 'LiveName', alive: true });
  });
});
