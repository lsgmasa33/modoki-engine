/** set-traits op (#166) — live-world trait mutation, the write the device surface was missing.
 *
 *  The rules being pinned here are the ones that make a write TRUSTWORTHY on an agent surface
 *  (docs/mcp-tool-conventions.md): a no-op is a failure when the caller asked for a change (§8), a
 *  provably-wrong field refuses the WHOLE call with nothing applied (§8), an ambiguous `name` is
 *  refused rather than first-matched (§3), and the reply carries the readback that verifies it.
 *
 *  Registered in agentBridge (runtime), NOT agentEditorOps — which is what gets it onto the device
 *  and into both eval APIs. See docs/plans/device-authoring-parity-plan.md. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type Reply = {
  ok?: boolean; error?: string; options?: string[]; matched?: number; changed?: number;
  saved?: boolean; savedNote?: string; dryRun?: boolean; hint?: string;
  entities?: Array<{ id: number; guid: string; name: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  detailTruncated?: boolean;
};

const call = (params: unknown) => runAgentOp('set-traits', params) as Promise<Reply>;

/** Read every entity that HAS a Transform. The `trait:` filter is a targeting query, so it
 *  deliberately keeps resource entities too (the Time singleton) — and those carry no Transform,
 *  which is why this filters rather than indexing every row. */
async function transforms() {
  const all = await runAgentOp('scene-state', { trait: 'Transform', full: true }) as
    { entities: Array<{ guid: string; traits: Record<string, Record<string, number>> }> };
  return all.entities.filter((e) => e.traits.Transform);
}

describe('set-traits: it actually writes, and says so verifiably', () => {
  it('writes a field by guid and returns before/after readback', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1, y: 2 }), EntityAttributes({ guid: 'a', name: 'Alpha' }));

    const r = await call({ guid: 'a', set: { 'Transform.x': 42 } });

    expect(r.ok).not.toBe(false);
    expect(r.matched).toBe(1);
    expect(r.changed).toBe(1);
    expect(r.entities?.[0].before['Transform.x']).toBe(1);
    expect(r.entities?.[0].after['Transform.x']).toBe(42);
    // The write must be readable from where it landed, not just reported.
    const back = await runAgentOp('scene-state', { guid: 'a', full: true }) as { entities: Array<{ traits: Record<string, Record<string, unknown>> }> };
    expect(back.entities[0].traits.Transform.x).toBe(42);
  });

  it('states persistence rather than staying silent (§8) — live only, relaunch is the undo', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'Alpha' }));
    const r = await call({ guid: 'a', set: { 'Transform.x': 5 } });
    expect(r.saved).toBe(false);
    expect(r.savedNote).toMatch(/relaunch is the undo/i);
  });

  it('a guid ARRAY mutates the whole set — the shape the eval read→filter→write loop needs', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C' }));

    const r = await call({ guid: ['a', 'c'], set: { 'Transform.x': 9 } });

    expect(r.matched).toBe(2);
    expect(r.changed).toBe(2);
    const byGuid = Object.fromEntries((await transforms()).map((e) => [e.guid, e.traits.Transform.x]));
    expect([byGuid.a, byGuid.b, byGuid.c]).toEqual([9, 0, 9]);
  });

  it('`where` selects plurally — the same expression scene-state filters with', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1, y: 10 }), EntityAttributes({ guid: 'a', name: 'A' }));
    game.spawn(Transform({ x: 5, y: 10 }), EntityAttributes({ guid: 'b', name: 'B' }));
    game.spawn(Transform({ x: 9, y: 10 }), EntityAttributes({ guid: 'c', name: 'C' }));

    const r = await call({ where: 'Transform.x > 3', set: { 'Transform.y': 0 } });

    expect(r.matched).toBe(2);
    expect(r.changed).toBe(2);
  });
});

describe('set-traits: every "did not happen" is a surfaced failure', () => {
  it('a selector matching NOTHING is ok:false, never a quiet changed:0 (§8)', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const r = await call({ where: 'Transform.x > 999', set: { 'Transform.y': 1 } });
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(0);
    expect(r.error).toMatch(/matched no entities/i);
    // The refusal must name the next move, not just the failure (§5).
    expect(r.error).toMatch(/scene-state/);
  });

  it('an unknown FIELD refuses the whole call with nothing applied (§8), listing the real fields', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ guid: 'a', set: { 'Transform.x': 7, 'Transform.nope': 1 } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing was applied/i);
    expect(r.options?.some((o) => o === 'Transform.x')).toBe(true);
    // The VALID sibling write in the same call must not have landed — that half-applied shape is
    // exactly what conventions §8 forbids.
    const back = await runAgentOp('scene-state', { guid: 'a', full: true }) as { entities: Array<{ traits: Record<string, Record<string, unknown>> }> };
    expect(back.entities[0].traits.Transform.x).toBe(1);
  });

  it('an unknown TRAIT refuses and lists the registered traits', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const r = await call({ guid: 'a', set: { 'Nonsense.x': 1 } });
    expect(r.ok).toBe(false);
    expect(r.options).toContain('Transform');
  });

  it('a stale guid refuses the whole call rather than mutating the survivors', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ guid: ['a', 'ghost'], set: { 'Transform.x': 8 } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
    const back = await runAgentOp('scene-state', { guid: 'a', full: true }) as { entities: Array<{ traits: Record<string, Record<string, unknown>> }> };
    expect(back.entities[0].traits.Transform.x).toBe(1);
  });

  it('an AMBIGUOUS name is refused, never first-matched (§3)', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'Dup' }));
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'b', name: 'Dup' }));

    const r = await call({ name: 'Dup', set: { 'Transform.x': 3 } });

    expect(r.ok).toBe(false);
    expect(r.matched).toBe(2);
    expect(r.error).toMatch(/matched 2 entities/i);
    expect((await transforms()).every((e) => e.traits.Transform.x === 1)).toBe(true);
  });

  it('no selector, and more than one selector, are both refused', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    expect((await call({ set: { 'Transform.x': 1 } })).ok).toBe(false);
    expect((await call({ guid: 'a', where: 'Transform.x > 0', set: { 'Transform.x': 1 } })).ok).toBe(false);
  });

  it('an empty or missing `set` is refused', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    expect((await call({ guid: 'a' })).ok).toBe(false);
    expect((await call({ guid: 'a', set: {} })).ok).toBe(false);
  });

  it('a bad `where` expression is refused with the parse reason, not silently unfiltered', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ where: 'Transform.x >> 3', set: { 'Transform.y': 1 } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing was applied/i);
    // The dangerous failure would be treating an unparseable filter as "match everything".
    const back = await runAgentOp('scene-state', { guid: 'a', full: true }) as { entities: Array<{ traits: Record<string, Record<string, unknown>> }> };
    expect(back.entities[0].traits.Transform.y).toBe(0);
  });
});

describe('set-traits: dryRun changes nothing', () => {
  it('reports the matched set and leaves the world untouched', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    game.spawn(Transform({ x: 2 }), EntityAttributes({ guid: 'b', name: 'B' }));

    const r = await call({ where: 'Transform.x > 0', set: { 'Transform.x': 100 }, dryRun: true });

    expect(r.ok).not.toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.matched).toBe(2);
    expect((await transforms()).map((e) => e.traits.Transform.x).sort()).toEqual([1, 2]);
  });
});

describe('set-traits: summary stays exact when detail is capped (§6)', () => {
  it('matched/changed count every entity even when only `limit` rows are detailed', async () => {
    game = createTestWorld({});
    for (let i = 0; i < 8; i++) game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: `g${i}`, name: `E${i}` }));

    const r = await call({ where: 'Transform.x == 1', set: { 'Transform.y': 3 }, limit: 2 });

    expect(r.matched).toBe(8);
    expect(r.changed).toBe(8);
    expect(r.entities?.length).toBe(2);
    expect(r.detailTruncated).toBe(true);
  });
});

describe('set-traits: an already-correct world is reported, not mistaken for a failed write', () => {
  it('changed:0 with a hint explaining every match already held the value', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 5 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ guid: 'a', set: { 'Transform.x': 5 } });

    expect(r.ok).not.toBe(false);
    expect(r.changed).toBe(0);
    expect(r.hint).toMatch(/already held/i);
  });
});

// ── Close-out review findings (#166). Each of these failed before its fix. ──

describe('set-traits: findings from the close-out review', () => {
  it('a DUPLICATE guid counts the entity ONCE — matched is exact per entity, not per ref', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ guid: ['a', 'a'], set: { 'Transform.x': 9 } });

    // Before the fix: matched:2 (one entity counted twice) AND changed:1, because the second pass
    // re-read `before` after the first write — which reads as "half my writes were ignored".
    expect(r.matched).toBe(1);
    expect(r.changed).toBe(1);
    expect(r.entities?.length).toBe(1);
  });

  it('refuses a SELF-parent write — the cycle that used to hang the subtree walk', async () => {
    game = createTestWorld({});
    const e = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));

    const r = await call({ guid: 'a', set: { 'EntityAttributes.parentId': e.id() } });

    expect(r.ok).toBe(false);
    // The 1-cycle and the longer cycle are named DIFFERENTLY on purpose (P7 shared the rule with
    // the editor's reparent, which distinguishes them) — "its own parent" is the more useful
    // sentence when you did exactly that.
    expect(r.error).toMatch(/its own parent/i);
  });

  it('refuses a parentId write that would close a LONGER cycle (A under its own descendant)', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const b = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B', parentId: a.id() }));

    // B is already A's child; making A a child of B closes the loop.
    const r = await call({ guid: 'a', set: { 'EntityAttributes.parentId': b.id() } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/its own ancestor/i);
  });

  it('refuses a parentId pointing at a dead entity rather than orphaning', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const r = await call({ guid: 'a', set: { 'EntityAttributes.parentId': 999999 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/matched no live entity/i);
  });

  it('still ALLOWS a legal re-parent — the guard must not refuse everything', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const p = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p', name: 'P' }));

    const r = await call({ guid: 'a', set: { 'EntityAttributes.parentId': p.id() } });

    expect(r.ok).not.toBe(false);
    expect(r.changed).toBe(1);
  });
});

describe('set-traits: a value of the WRONG TYPE is refused, because writes are stored raw', () => {
  it('a numeric field given a string is refused — it used to be stored AS a string', async () => {
    game = createTestWorld({});
    const p = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p', name: 'P' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C' }));

    const r = await call({ guid: 'c', set: { 'EntityAttributes.parentId': String(p.id()) } });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected a number, got string/i);
  });

  it('and THAT is why: a string parentId made the child invisible to the subtree walk', async () => {
    game = createTestWorld({});
    const p = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p', name: 'P' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C' }));

    // The refusal above is what prevents this. With the string accepted (as it was), the link is
    // real to a human reading scene-state but invisible to every `===` comparison — so duplicating
    // the parent reported success while silently dropping the child.
    await call({ guid: 'c', set: { 'EntityAttributes.parentId': p.id() } });   // the CORRECT type
    const dup = await runAgentOp('duplicate-entity', { guid: 'p' }) as { entitiesPerCopy?: number };
    expect(dup.entitiesPerCopy).toBe(2);   // parent + child, because the link is a real number
  });

  it('null is refused for a numeric field rather than coerced to 0 ("reparent to root")', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const r = await call({ guid: 'a', set: { 'EntityAttributes.parentId': null } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected a number, got null/i);
  });

  it('NaN and Infinity pass typeof but are refused — they poison every consumer', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'a', name: 'A' }));
    expect((await call({ guid: 'a', set: { 'Transform.x': NaN } })).error).toMatch(/finite number/i);
    expect((await call({ guid: 'a', set: { 'Transform.x': Infinity } })).error).toMatch(/finite number/i);
    const back = await runAgentOp('scene-state', { guid: 'a', full: true }) as { entities: Array<{ traits: Record<string, Record<string, unknown>> }> };
    expect(back.entities[0].traits.Transform.x).toBe(1);
  });

  it('a string field given a number is refused too — the rule is the schema, not a parentId patch', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const r = await call({ guid: 'a', set: { 'EntityAttributes.name': 42 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected a string, got number/i);
  });

  it('the CORRECT types still write — the guard must not refuse everything', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    expect((await call({ guid: 'a', set: { 'Transform.x': 3.5 } })).changed).toBe(1);
    expect((await call({ guid: 'a', set: { 'EntityAttributes.name': 'Renamed' } })).changed).toBe(1);
  });
});
