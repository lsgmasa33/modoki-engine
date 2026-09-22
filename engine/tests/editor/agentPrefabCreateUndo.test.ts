/** The AGENT `prefab create` op must put back the links the tree already had, on undo (#1278).
 *
 *  Its undo calls `untagEntityTreeAsInstance`, which strips `PrefabInstance` off the WHOLE
 *  subtree. That was survivable while tagging retagged the whole subtree too — undo simply
 *  returned it to "no links". It stopped being survivable when #1278 made tagging deliberately
 *  LEAVE a held nested instance linked to its own child prefab: undo then destroyed a link the
 *  create had never touched, and the op recorded nothing to restore it.
 *
 *  The human path (`assetOps.createPrefabFromEntity`) has carried a snapshot since #1264 and its
 *  wiring is pinned in `packages/modoki/tests/editor/createPrefabUndo.test.ts`. The agent path —
 *  which is where close-out review FOUND this — had no equivalent, and the fix could be deleted
 *  with the whole gate staying green. This is that equivalent.
 *
 *  Driven the way production drives it: `runAgentOp` on the registered editor ops, with the real
 *  undo stack. Only the backend write is stubbed. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, PrefabInstance,
  deriveInstanceMemberGuids, getCurrentWorld, Transient, UIAction,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, undo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const CHILD_GUID = 'dddddddd-0000-4000-8000-00000000c001';
const CHILD_PATH = '/assets/prefabs/Child.prefab.json';
const NEW_PATH = '/assets/prefabs/Made.prefab.json';

/** A two-entity child prefab: root 'Hull' with a member 'Bolt'. */
const childPrefab = {
  id: CHILD_GUID, version: 3 as const, name: 'Child', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Hull', traits: { Transform: {}, EntityAttributes: { name: 'Hull', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Bolt', traits: { Transform: {}, EntityAttributes: { name: 'Bolt', parentId: 1, guid: '' } } },
  ],
};

let game: TestWorld | undefined;
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  registerAsset(CHILD_GUID, CHILD_PATH, 'prefab');
  setPrefabCache(CHILD_GUID, childPrefab as never);
  origFetch = globalThis.fetch;
  // Test stub — every backend call succeeds; the op's IO is not what is under test here.
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ ok: true, files: [] }), text: async () => '' } as Response)) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  game?.dispose(); game = undefined;
});

describe('agent prefab create — undo restores the links the tree already had (#1278)', () => {
  it('a held nested instance is still linked to its own prefab after undo', async () => {
    // R ── Hull (a live instance of Child) ── Bolt
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-agent-r' }));
    const hull = game!.spawn(Transform(), EntityAttributes({ name: 'Hull', parentId: r.id(), guid: 'g-agent-hull' }));
    const bolt = game!.spawn(Transform(), EntityAttributes({ name: 'Bolt', parentId: hull.id(), guid: 'g-agent-bolt' }));
    hull.add(PrefabInstance({ source: CHILD_GUID, localId: 1, rootInstanceId: hull.id() }));
    bolt.add(PrefabInstance({ source: CHILD_GUID, localId: 2, rootInstanceId: hull.id() }));

    const res = await runAgentOp('prefab', { action: 'create', entityGuid: 'g-agent-r', path: NEW_PATH }) as { ok: boolean };
    expect(res.ok).toBe(true);

    // Tagging leaves the held instance on its OWN prefab (that is the #1278 behaviour).
    expect((hull.get(PrefabInstance) as { source: string }).source).toBe(CHILD_GUID);

    await undo();

    // THE defect: undo strips the whole subtree, so without a snapshot+reattach the nested
    // instance comes back plain and the next save writes it as unlinked entities.
    expect(hull.has(PrefabInstance), 'Hull lost its prefab link on undo').toBe(true);
    expect((hull.get(PrefabInstance) as { source: string }).source).toBe(CHILD_GUID);
    expect(bolt.has(PrefabInstance), 'Bolt lost its prefab link on undo').toBe(true);
    expect((bolt.get(PrefabInstance) as { rootInstanceId: number }).rootInstanceId).toBe(hull.id());

    // The root was plain before the create, and must be plain again after undo — otherwise the
    // assertions above would also pass with "undo restored nothing and tagging never ran".
    expect(r.has(PrefabInstance), 'R was plain before the create').toBe(false);
  });

  /** #1272 as reported. Once the tree is a prefab, the held instance is OWNED-nested, so
   *  `serialize.ts` writes no scene entry for it — its guid never reaches disk and a reload
   *  re-mints it from the new root. The undo snapshot is GUID-keyed, so its ref misses.
   *
   *  The reload is driven, not mimicked: blanking the members' guids and running the REAL
   *  `deriveInstanceMemberGuids` is exactly what `loadSceneFile` does at the end of a load. A test
   *  that hand-wrote a different guid would prove only that a different string fails to resolve.
   *
   *  ⚠️ **#1461 removed the re-mint from this flow**, and this test caught it: Create Prefab now
   *  stamps each member with the guid the reload derives, so blanking and re-deriving is IDEMPOTENT
   *  and the premise this test used to assert ("the guid is NOT the one the snapshot captured") is
   *  false here. Both guarantees are still pinned, separately, because they fail for different
   *  reasons: the idempotence below is #1461's, and the surviving link after a guid DOES diverge is
   *  #1272's. The divergence is hand-written now, with the caveat above answered — what it models is
   *  a tree whose members were never stamped (a scene authored before #1461, or any other path that
   *  re-mints), and what it proves is that the scoped untag never strips the held link in the first
   *  place, so the reattach is not asked to resolve it. */
  it('the derive is idempotent after the create (#1461), and the link survives a guid that diverges anyway (#1272)', async () => {
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-reload-r' }));
    const hull = game!.spawn(Transform(), EntityAttributes({ name: 'Hull', parentId: r.id(), guid: 'g-reload-hull' }));
    const bolt = game!.spawn(Transform(), EntityAttributes({ name: 'Bolt', parentId: hull.id(), guid: 'g-reload-bolt' }));
    hull.add(PrefabInstance({ source: CHILD_GUID, localId: 1, rootInstanceId: hull.id() }));
    bolt.add(PrefabInstance({ source: CHILD_GUID, localId: 2, rootInstanceId: hull.id() }));

    await runAgentOp('prefab', { action: 'create', entityGuid: 'g-reload-r', path: NEW_PATH });

    // ── Play → Stop: the world is rebuilt from the snapshot, and the nested instance comes back
    // with no serialized guid, so the loader derives one off the new root.
    const before = (hull.get(EntityAttributes) as { guid: string }).guid;
    for (const e of [hull, bolt]) {
      e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), guid: '' });
    }
    deriveInstanceMemberGuids(getCurrentWorld());
    const after = (hull.get(EntityAttributes) as { guid: string }).guid;
    // #1461: the create already gave it the guid the reload derives, so the round trip is a no-op.
    // Mutation: drop the stamp from tagEntityTreeAsInstance and this goes red (it did, before the fix).
    expect(after, 'the create must leave the derive nothing to change').toBe(before);
    expect(after).toBeTruthy();

    // Now force the divergence #1272 was reported against — see the caveat in the docblock.
    for (const e of [hull, bolt]) {
      e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), guid: `stale-${(e.get(EntityAttributes) as { name: string }).name}` });
    }

    await undo();

    // Before the fix the untag stripped this link and the guid-keyed reattach could not find it.
    expect(hull.has(PrefabInstance), 'Hull lost its link to its own prefab across the reload').toBe(true);
    expect((hull.get(PrefabInstance) as { source: string }).source).toBe(CHILD_GUID);
    // A row this prefab owned is no longer owned by anything once the owner is removed.
    expect((hull.get(PrefabInstance) as { parentLocalId: number }).parentLocalId).toBe(0);
    expect(r.has(PrefabInstance), 'the created prefab tag must still be gone').toBe(false);
  });

  /** #1461's undo half. The create STAMPS each member with the guid the reload will derive, so undo
   *  owes two things: the original guids back, and every ref that followed the rename back with them.
   *
   *  Mutation: drop `unstampMemberGuids(guidRemap)` — red.
   *
   *  ⚠️ The ORDER of the un-rename against `reattachPrefabInstance` is not pinned HERE — it is pinned in
   *  `packages/modoki/tests/editor/createPrefabUndo.test.ts`, whose mock records the call sequence and
   *  asserts `['unstamp', 'untag', 'reattach']`. An earlier version of this comment claimed nothing
   *  pinned it, on a mutation run with `--config engine/vite.config.ts` — which, per CLAUDE.md § Tests,
   *  is NOT the package suite, so the guard was simply absent from what was measured. */
  it('undo puts the members\' original guids back, and every ref with them (#1461)', async () => {
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-undo-r' }));
    const a = game!.spawn(Transform(), EntityAttributes({ name: 'A', parentId: r.id(), guid: 'g-undo-a' }));
    // A ref from OUTSIDE the tree, aimed at the entity that is about to become a member.
    const x = game!.spawn(Transform(), EntityAttributes({ name: 'X', guid: 'g-undo-x' }),
      UIAction({ bindings: [{ event: 'click', kind: 'call' as const, action: 'noop', target: 'g-undo-a' }] }));
    const targetOfX = () => ((x.get(UIAction) as { bindings: { target: string }[] }).bindings)[0].target;

    await runAgentOp('prefab', { action: 'create', entityGuid: 'g-undo-r', path: NEW_PATH });

    const stamped = (a.get(EntityAttributes) as { guid: string }).guid;
    expect(stamped, 'the member takes the guid the reload derives').not.toBe('g-undo-a');
    expect(targetOfX(), 'and the ref follows it').toBe(stamped);

    await undo();

    expect((a.get(EntityAttributes) as { guid: string }).guid).toBe('g-undo-a');
    expect(targetOfX()).toBe('g-undo-a');
  });

  /** The report must not fire on the flow the fix makes WORK (close-out review F1).
   *
   *  `priorLinks` is a `strip: false` snapshot, so it also holds the entities the scoped untag
   *  deliberately KEEPS — whose guids the reload re-mints. Counting unresolved REFS therefore
   *  announced "2 prefab links could not be put back" over a completely correct undo, which is
   *  worse than the silence it replaced: it sends the next reader hunting a phantom. */
  it('says nothing when the undo actually restored everything, across a reload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-quiet-r' }));
      const hull = game!.spawn(Transform(), EntityAttributes({ name: 'Hull', parentId: r.id(), guid: 'g-quiet-hull' }));
      const bolt = game!.spawn(Transform(), EntityAttributes({ name: 'Bolt', parentId: hull.id(), guid: 'g-quiet-bolt' }));
      hull.add(PrefabInstance({ source: CHILD_GUID, localId: 1, rootInstanceId: hull.id() }));
      bolt.add(PrefabInstance({ source: CHILD_GUID, localId: 2, rootInstanceId: hull.id() }));

      await runAgentOp('prefab', { action: 'create', entityGuid: 'g-quiet-r', path: NEW_PATH });
      for (const e of [hull, bolt]) e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), guid: '' });
      deriveInstanceMemberGuids(getCurrentWorld());
      await undo();

      // Precondition: the undo really did restore them — otherwise silence proves nothing.
      expect((hull.get(PrefabInstance) as { source: string }).source).toBe(CHILD_GUID);
      const unresolved = warn.mock.calls.map(String).filter((m) => m.includes('could not be put back'));
      expect(unresolved, `a correct undo must not report a failure: ${unresolved.join(' | ')}`).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});

/** The agent op is the one consumer that CANNOT fall back to the renderer console — it reads the
 *  response and nothing else — and it was the one call site of the runtime-exclusion report with no
 *  test at all (close-out re-review finding 5): deleting the `warnings.push` left every suite green.
 *  Same lesson as #1258, which is why the inert-size warnings ride in this response too. */
describe('agent prefab create — runtime entities left out are REPORTED in the response (#1306)', () => {
  it('names them in warnings when the selection contained a generated subtree', async () => {
    const r = game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-warn-r' }));
    const kept = game!.spawn(Transform(), EntityAttributes({ name: 'Kept', parentId: r.id(), guid: 'g-warn-kept' }));
    // A pooled row's shape: the region root plus a member, both tagged, as a system tick spawns them.
    const pooled = game!.spawn(Transform(), EntityAttributes({ name: 'PooledRow', parentId: r.id(), guid: 'g-warn-pooled' }));
    const pooledChild = game!.spawn(Transform(), EntityAttributes({ name: 'RowLabel', parentId: pooled.id(), guid: 'g-warn-pooled-child' }));
    pooled.add(Transient); pooledChild.add(Transient);

    const res = await runAgentOp('prefab', { action: 'create', entityGuid: 'g-warn-r', path: NEW_PATH }) as { ok: boolean; warnings?: string[] };
    expect(res.ok).toBe(true);
    expect(res.warnings?.join(' ') ?? '').toContain('2 runtime entities were left out of the prefab');
    // The object of the sentence matters here more than anywhere: this reader has no other context.
    expect(res.warnings?.join(' ') ?? '').toContain('of the prefab');
    expect(kept.has(EntityAttributes)).toBe(true); // fixture sanity: the authored sibling is still there
  });

  it('says nothing when the selection lost nothing', async () => {
    game!.spawn(Transform(), EntityAttributes({ name: 'R', guid: 'g-quiet-r' }));
    const res = await runAgentOp('prefab', { action: 'create', entityGuid: 'g-quiet-r', path: NEW_PATH }) as { ok: boolean; warnings?: string[] };
    expect(res.ok).toBe(true);
    expect((res.warnings ?? []).join(' ')).not.toContain('runtime entit');
  });
});
