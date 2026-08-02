/** Phase 2b (mcp-persistence.md) — the `apply-scene-ops` agent op: the
 *  live-world twin of sceneMutate.ts's file-based `applyOps`, wired through the Phase 2a
 *  composite primitive so an N-op call lands as ONE undo entry. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, getPlayState, findEntityByGuid, Transform,
  applyOps, parentWorldTrs, worldToLocalTrs, mergeTrs, type MutableScene,
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

describe('apply-scene-ops reports what it CREATED (S3.12)', () => {
  it('an addEntity op returns {op, id, guid, name} — addressable without a re-find', async () => {
    // The live twin of applyOps' `created`. Without it, `changed:1` was the whole answer and the
    // agent had to look its own entity back up by name, which this surface refuses when the name
    // is ambiguous.
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'S312Live', parentId: 0, traits: { Transform: {} } }],
    }) as { created?: Array<{ op: number; id: number; guid: string; name: string }> };
    expect(r.created).toHaveLength(1);
    const c = r.created![0];
    expect(c).toMatchObject({ op: 0, name: 'S312Live' });
    expect(c.id).toBeGreaterThan(0);
    // The guid must be the LIVE entity's own — i.e. resolvable, not invented.
    expect(findEntityByGuid(c.guid)?.id()).toBe(c.id);
  });

  it('omits `created` when nothing was added', async () => {
    const a = await createBox();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: a.guid }, trait: 'Transform', fields: { x: 2 } }],
    }) as { created?: unknown };
    expect(r.created).toBeUndefined();
  });
});

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

/** Addressing by NAME, and what happens when the name is not unique.
 *
 *  The live resolver used `.find()`, so with two entities called "Enemy" a `setTrait {name:'Enemy'}`
 *  moved ONE of them and returned `{ok:true, changed:1, errors:[], warnings:[]}`. MEASURED on
 *  `games/3d-test` with two `DUP_probe` entities: one moved to (7,7,7), the other untouched, nothing
 *  said so. Two reasons that is the wrong behaviour, not a shortcut:
 *
 *  - The FILE path (`sceneMutate.ts`'s `resolveEntity`) has always refused ambiguity ("use 'id' or
 *    'guid' to disambiguate"), and the entity-aimed INPUT path refuses it too
 *    (`entityResolve.ts`) — so the live path was the one surface that silently guessed.
 *  - Inside a `modoki_batch` there is no intermediate response in which to notice.
 *
 *  Worth recording WHY it survived: the live path was unreachable until the `canGoLive` fix earlier
 *  the same day (every agent mutate went to the file, whose resolver was correct). Un-deadening a
 *  path surfaces the bugs it was hiding. */
describe('resolving an entity ref by name', () => {
  const named = async (name: string) => {
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name, parentId: 0, traits: { Transform: {}, EntityAttributes: { name } } }],
    }) as { changed: number };
    expect(r.changed).toBe(1);
    return r;
  };

  it('resolves a UNIQUE name', async () => {
    await named('Solo');
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { name: 'Solo' }, trait: 'Transform', fields: { x: 3 } }],
    }) as { changed: number; errors: string[] };
    expect(r.errors).toEqual([]);
    expect(r.changed).toBe(1);
  });

  it('REFUSES an ambiguous name instead of moving one of them', async () => {
    await named('Twin');
    await named('Twin');
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { name: 'Twin' }, trait: 'Transform', fields: { x: 3 } }],
    }) as { changed: number; errors: string[]; unresolved: unknown[] };
    expect(r.changed).toBe(0);
    expect(r.errors[0]).toMatch(/2 LIVE entities are named "Twin"/);
    // The error must carry the way OUT, not just the complaint.
    expect(r.errors[0]).toMatch(/address by guid/);
    // Reported as unresolved, so a caller scanning that field sees it too.
    expect(r.unresolved).toHaveLength(1);
  });

  it('refuses an ambiguous name for removeEntity too — deleting the wrong one is worse', async () => {
    await named('Pair');
    await named('Pair');
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'removeEntity', entity: { name: 'Pair' } }],
    }) as { changed: number; errors: string[] };
    expect(r.changed).toBe(0);
    expect(r.errors[0]).toMatch(/2 LIVE entities are named "Pair"/);
  });

  it('distinguishes "no such name" from "ambiguous name" — different fixes', async () => {
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { name: 'Ghost' }, trait: 'Transform', fields: { x: 1 } }],
    }) as { errors: string[] };
    expect(r.errors[0]).toMatch(/no LIVE entity named "Ghost"/);
  });

  it('an unresolvable parent GUID warns and falls back to the root, rather than failing the op', async () => {
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'Orphan', parentId: 'not-a-real-guid', traits: { Transform: {}, EntityAttributes: { name: 'Orphan' } } }],
    }) as { changed: number; warnings: string[] };
    expect(r.changed).toBe(1);
    expect(r.warnings[0]).toMatch(/parented to the scene root instead/);
  });

  // The numeric form was taken LITERALLY with no check, so the same mistake was loud as a guid and
  // silent as an id — and produced an entity whose parentId pointed at nothing.
  it('an unresolvable parent ID warns and falls back too — not a silent orphan', async () => {
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'Orphan2', parentId: 99999, traits: { Transform: {}, EntityAttributes: { name: 'Orphan2' } } }],
    }) as { changed: number; warnings: string[] };
    expect(r.changed).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/parent id 99999 matched no live entity/);
    expect(r.warnings.join(' ')).toMatch(/parented to the scene root instead/);
  });

  it('parentId 0 still means ROOT and is never resolved', async () => {
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'AtRoot', parentId: 0, traits: { Transform: {}, EntityAttributes: { name: 'AtRoot' } } }],
    }) as { changed: number; warnings: string[] };
    expect(r.changed).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('a REAL parent id is honoured (the fix must not reject valid ids)', async () => {
    const parent = await createBox();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'addEntity', name: 'Child', parentId: parent.id, traits: { Transform: {}, EntityAttributes: { name: 'Child' } } }],
    }) as { changed: number; warnings: string[] };
    expect(r.changed).toBe(1);
    expect(r.warnings).toEqual([]);
  });
});

describe('create-entity / reparent-entity: a bad parent is REFUSED, never an orphan', () => {
  // Measured live 2026-07-30: create-entity {parentId:99999} returned {id:141, name:'Cube', guid:…}
  // — a clean success — and produced an entity whose EntityAttributes.parentId pointed at nothing.
  // parentGuid was validated; parentId was not. Runtime ids are reassigned on every scene reload,
  // so a stale parentId is not exotic input — it is what an agent holds after any hot-reload.
  it('create-entity refuses a parentId that matches no live entity', async () => {
    await expect(runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: 99999 }))
      .rejects.toThrow(/id 99999 matched no live entity/);
  });

  it('create-entity still accepts a REAL parentId, and 0 (root)', async () => {
    const parent = await createBox();
    const child = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: parent.id }) as { id: number };
    expect(child.id).toBeGreaterThan(0);
    const atRoot = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: 0 }) as { id: number };
    expect(atRoot.id).toBeGreaterThan(0);
  });

  it('reparent-entity refuses a parentId that matches no live entity', async () => {
    const box = await createBox();
    await expect(runAgentOp('reparent-entity', { guid: box.guid, parentId: 99999 }))
      .rejects.toThrow(/id 99999 matched no live entity/);
  });
});

describe("setTrait {space:'world'} on the LIVE path — the branch most agent edits take", () => {
  /** The file path has its own conversion (sceneMutate's `worldFieldsToLocal`); this is the live
   *  twin, using the runtime's parent-chain helpers. Both must agree, because which one runs
   *  depends only on whether the editor happens to have the scene open — a difference there would
   *  be exactly the mode-dependent inconsistency this audit exists to remove. */
  async function parentAndChild() {
    const parent = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number; guid: string };
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { id: parent.id }, trait: 'Transform', fields: { x: 200, y: 247 } }],
    });
    const child = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: parent.id }) as { id: number; guid: string };
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { id: child.id }, trait: 'Transform', fields: { x: 623, y: 679 } }],
    });
    markSceneSaved(); clearHistory();
    return { parent, child };
  }

  const localOf = async (guid: string) => {
    const e = findEntityByGuid(guid)!;
    return e.get(Transform) as unknown as Record<string, number>;
  };

  it("writing the child's OWN world position is a NO-OP (the measured bug, inverted)", async () => {
    const { child } = await parentAndChild();
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: child.guid }, trait: 'Transform', space: 'world', fields: { x: 823, y: 926 } }],
    }) as { errors: string[] };
    expect(r.errors).toEqual([]);
    const t = await localOf(child.guid);
    expect(t.x).toBeCloseTo(623, 4);
    expect(t.y).toBeCloseTo(679, 4);
  });

  it("space:'world' places the child at the world point asked for", async () => {
    const { child } = await parentAndChild();
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: child.guid }, trait: 'Transform', space: 'world', fields: { x: 0, y: 0 } }],
    });
    const t = await localOf(child.guid);
    expect(t.x).toBeCloseTo(-200, 4);
    expect(t.y).toBeCloseTo(-247, 4);
  });

  /** THE PARITY THE COMMENT ABOVE ONLY CLAIMED (independent review, 2026-07-30; convention decided
   *  by the owner 2026-07-31).
   *
   *  "Both must agree" was asserted in prose and by NO test, and they did not agree. The live path
   *  inverted the raw composed parent matrix (exact even under shear) while the file path composes
   *  the chain and decomposes ONCE — so on a hierarchy mixing non-uniform scale with a rotation
   *  below it, the same op landed the entity in two different places depending only on whether an
   *  editor happened to have the scene open. Measured: world (10,0,0) requested → (10,0,0) live vs
   *  (12.638, 0.270, 0) headless.
   *
   *  TRS is the convention (a sheared parent is not a legal state, as in Unity's Transform), so the
   *  LIVE path was the outlier and now decomposes too — matching the file path AND what dragging
   *  the 3D gizmo in that hierarchy writes. This runs the identical op through both and compares.
   *
   *  The hierarchy is chosen to be the one that USED to diverge; on a translation-only chain the
   *  two agree trivially and the test would prove nothing. */
  it('the LIVE and FILE conversions agree on a chain that mixes rotation with non-uniform scale', async () => {
    // G (scale 2,1,1) → P (rotated 45° about Z) → C. Composed, that parent is SHEARED.
    const g = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { id: number; guid: string };
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { id: g.id }, trait: 'Transform', fields: { sx: 2, sy: 1, sz: 1 } }],
    });
    const pE = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: g.id }) as { id: number; guid: string };
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { id: pE.id }, trait: 'Transform', fields: { rz: Math.PI / 4 } }],
    });
    const c = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentId: pE.id }) as { id: number; guid: string };
    markSceneSaved(); clearHistory();

    const WANT = { x: 10, y: 0, z: 0 };

    // ── LIVE path: through the real agent op.
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: c.guid }, trait: 'Transform', space: 'world', fields: WANT }],
    });
    const live = await localOf(c.guid);

    // ── FILE path: the same op shape, over a scene object, through the file conversion.
    const scene: MutableScene = {
      entities: [
        { id: 1, traits: { Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 2, sy: 1, sz: 1 }, EntityAttributes: { name: 'G', guid: 'g-G' } } },
        { id: 2, traits: { Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: Math.PI / 4, sx: 1, sy: 1, sz: 1 }, EntityAttributes: { name: 'P', guid: 'g-P', parentId: 'g-G' } } },
        { id: 3, traits: { Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, EntityAttributes: { name: 'C', guid: 'g-C', parentId: 'g-P' } } },
      ],
    } as unknown as MutableScene;
    applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-C' }, trait: 'Transform', space: 'world', fields: WANT }] as never);
    const file = (scene.entities[2].traits as Record<string, Record<string, number>>).Transform;

    // The two authoring paths must produce the SAME local transform for the same request.
    for (const k of ['x', 'y', 'z'] as const) {
      expect(live[k], `live/file disagree on ${k} (live ${live[k]} vs file ${file[k]})`).toBeCloseTo(file[k], 6);
    }

    // …and that shared answer is the TRS convention's, i.e. what a gizmo drag writes — NOT the
    // exact-inverse answer the live path used to give. Computed here from the same primitives the
    // gizmo uses, so the expectation is derived rather than a copied magic number.
    const expected = worldToLocalTrs(
      mergeTrs({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, WANT),
      parentWorldTrs(scene.entities as never, scene.entities[2] as never),
    );
    expect(live.x).toBeCloseTo(expected.x, 6);
    expect(live.y).toBeCloseTo(expected.y, 6);
  });

  it('without `space`, fields are written verbatim as LOCAL (unchanged behaviour)', async () => {
    const { child } = await parentAndChild();
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: child.guid }, trait: 'Transform', fields: { x: 823 } }],
    });
    expect((await localOf(child.guid)).x).toBeCloseTo(823, 4);
  });

  it('is a no-op for a ROOT entity — no conversion, no float drift on untouched axes', async () => {
    const root = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { guid: string };
    await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: root.guid }, trait: 'Transform', space: 'world', fields: { x: 42 } }],
    });
    const t = await localOf(root.guid);
    expect(t.x).toBe(42);   // exact, not close-to
    expect(t.y).toBe(0);
  });

  it("REFUSES `space` on a non-Transform trait rather than ignoring it", async () => {
    const root = await runAgentOp('create-entity', { spec: { kind: 'empty' } }) as { guid: string };
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: root.guid }, trait: 'EntityAttributes', space: 'world', fields: { name: 'x' } }],
    }) as { errors: string[]; changed: number };
    expect(r.errors.join(' ')).toMatch(/'space' applies only to trait 'Transform'/);
    expect(r.changed).toBe(0);
  });
});

describe('create-entity validates the primitive vocabulary (S2.15)', () => {
  // `mesh`/`shape` were free strings, so {kind:'primitive', mesh:'pyramid'} returned a clean
  // {id,name:'Pyramid',guid} and produced an entity whose renderer resolves to NOTHING — invisible,
  // with no error anywhere. An agent then debugs a rendering problem that is really a typo.
  it('refuses an unknown primitive mesh and names the valid ones', async () => {
    await expect(runAgentOp('create-entity', { spec: { kind: 'primitive', mesh: 'pyramid' } }))
      .rejects.toThrow(/unknown primitive mesh "pyramid"[\s\S]*Valid: .*sphere/);
  });

  it('refuses an unknown 2D shape and points at the sprite-GUID route', async () => {
    await expect(runAgentOp('create-entity', { spec: { kind: '2d', shape: 'star' } }))
      .rejects.toThrow(/unknown 2D shape "star"[\s\S]*circle, square, triangle/);
  });

  it('still accepts every REAL primitive (the guard must not reject valid input)', async () => {
    for (const mesh of ['cube', 'box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule']) {
      const r = await runAgentOp('create-entity', { spec: { kind: 'primitive', mesh } }) as { id: number };
      expect(r.id, mesh).toBeGreaterThan(0);
    }
    for (const shape of ['circle', 'square', 'triangle']) {
      const r = await runAgentOp('create-entity', { spec: { kind: '2d', shape } }) as { id: number };
      expect(r.id, shape).toBeGreaterThan(0);
    }
  });

  it('omitting mesh/shape still uses the documented default', async () => {
    const r = await runAgentOp('create-entity', { spec: { kind: 'primitive' } }) as { id: number };
    expect(r.id).toBeGreaterThan(0);
  });
});

describe('play_control transitions have PRECONDITIONS, refused rather than silently done (S2.29)', () => {
  // `resume` from STOPPED ran a full enterPlay() — a fresh snapshot + run, i.e. what `play` does —
  // so an agent meaning "carry on from where we paused" silently restarted the game and lost the
  // state it was inspecting. `pause` from stopped was a plain no-op reported as success. `step`
  // has guarded its precondition since it was written; these two now match it.
  it('resume from STOPPED is refused, and says it would have been a full Play', async () => {
    setPlayState('stopped');
    const r = await runAgentOp('resume', {}) as { ok?: boolean; error?: string; hint?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires the PAUSED state/);
    expect(r.error).toMatch(/full Play/);
    expect(r.hint).toMatch(/action:'play'/);
    expect(getPlayState()).toBe('stopped');   // and it did NOT start anything
  });

  it('pause from STOPPED is refused rather than reported as a freeze', async () => {
    setPlayState('stopped');
    const r = await runAgentOp('pause', {}) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires the PLAYING state/);
    expect(getPlayState()).toBe('stopped');
  });

  it('pause from PLAYING still works — the guard must not block the real transition', async () => {
    setPlayState('playing');
    const r = await runAgentOp('pause', {}) as { playState?: string };
    expect(getPlayState()).toBe('paused');
    expect(r.playState).toBe('paused');
  });
});
