/** #1884's rider at Apply's door — an Apply that lands nothing takes off the template keys its promotion put on
 *  (`applyToPrefabSelective`, `snapshotUnkeyed`).
 *
 *  Apply's WRITING plan promotes a scene-added node into the template, and its capture keys the live node
 *  (`addedNodeIdentity`) before the commit. When the commit then fails or conflicts, no undo is pushed and nothing linked
 *  the node to a document, so it kept a key the save drops: live and reloaded disagreed (found by the #1884 close-out
 *  review). Apply's UNDO is clean — it reloads the scene from before the Apply.
 *
 *  - a write that CONFLICTS (the prefab changed on disk since the editor read it) and one that FAILS (500): Z is unkeyed
 *    after the refusal, and equals what a save + reload gives. Mutation: drop `unkeyed.drop()` after `commitApplyPlan` —
 *    both red.
 *  - the ACCEPT side, in the same Apply: a placed O under the same root, whose Extra O's template keys `k-extra`, keeps it.
 *    Mutation: widen `unkeyedNodes` to every node of the tree — both red on Extra.
 *
 *  - an EXCEPTION after the writing plan's promotion keyed Z (a throw in the commit, before the write) takes the keys off
 *    like a failed write (`dropOnThrow`, the #1884 close-out's candidate (a)). Mutation: drop `held?.drop()` in
 *    `dropOnThrow` — red. A throw after the rebuild took the tree (in the commit's rebase) rolls back to H1's records
 *    (#2001 S8b, `instanceRollback.ts`); mutation: the rollback's restore dropped — red.
 *
 *  Not driven: the writing plan's own refusal and its conflicts (the same `drop()`), which need the world to change between
 *  the dry plan and the writing one.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches and the undo stack. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory, as prefabFuzz.test.ts does.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
// A throw at two seams of the commit, armed per test: before the write (its inert-size warning), and after the rebuild
// (the rebase of the other instances).
const thrown = vi.hoisted(() => ({ at: '' as '' | 'plan' | 'rebase' }));
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefab')>();
  return { ...m, warnInertPrefabSizes: (...a: Parameters<typeof m.warnInertPrefabSizes>) => {
    if (thrown.at === 'plan') throw new Error('threw after the plan (armed)');
    return m.warnInertPrefabSizes(...a);
  } };
});
vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefabRebuild')>();
  return { ...m, rebaseStaleInstances: (...a: Parameters<typeof m.rebaseStaleInstances>) => {
    if (thrown.at === 'rebase') throw new Error('threw after the rebuild (armed)');
    return m.rebaseStaleInstances(...a);
  } };
});
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, type Fixture } from './prefabFuzz/harness';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';

/** `v` in a stable form, its Maps and Sets written out (a record holds both). */
function canon(v: unknown): string {
  const sorted = (m: Map<unknown, unknown>) => [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  return JSON.stringify(v, (_k, x) => (x instanceof Map ? sorted(x) : x instanceof Set ? [...x].sort() : x));
}

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (name: string) => {
  const hits = authored().filter((e) => e.name === name);
  if (hits.length !== 1) throw new Error(`expected one "${name}", found ${hits.length}`);
  return hits[0]!;
};
const keyOf = (name: string) => templateKeyOf(findEntity(byName(name).id)) || undefined;
/** The Extra of the O placed under H1 (O1's own Extra is outside the Apply). */
const placedExtraKey = (h1: number) => {
  const under = (id: number) => { for (let p = authored().find((x) => x.id === id)?.parentId ?? 0; p; p = authored().find((x) => x.id === p)?.parentId ?? 0) if (p === h1) return true; return false; };
  return authored().filter((e) => e.name === 'Extra' && under(e.id)).map((e) => templateKeyOf(findEntity(e.id)));
};

/** H1's root holding a placed Q with a scene-added Z under its QR (unkeyed), and a placed O (its Extra keyed). */
async function setup(f: Fixture): Promise<number> {
  const h1 = byName('HR').id;
  await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: h1 });
  await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: h1 });
  await settle();
  const qr = authored().find((e) => e.name === 'QR' && e.parentId === h1)!.id;
  const { specs } = emptySpecs(qr);
  createEntityWithUndo('Create Z', qr, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Z' } } : s)), () => {});
  await settle();
  expect(keyOf('Z'), 'premise: Z is scene-added, unkeyed').toBeUndefined();
  expect(placedExtraKey(h1), "premise: the placed O's Extra is keyed by O's template").toEqual(['k-extra']);
  return h1;
}

/** Apply every override H1 has (the placed Q and O among them) to H. */
async function applyAll(h1: number, f: Fixture) {
  await preloadNestedPrefabsForSubtree(h1);
  const keys = collectInstanceOverrideKeys(h1, getCachedPrefabSync(f.prefabs.H.guid)!);
  return applyToPrefabWithUndo(h1, new Set([...keys.all, ...keys.nested]));
}

describe("an Apply that lands nothing takes its promotion's keys off (#1884 rider)", () => {
  for (const mode of ['conflict', 'failed'] as const) {
    it(`the write ${mode === 'conflict' ? 'conflicts' : 'fails'}: Z is unkeyed, as a save + reload leaves it, and Extra keeps k-extra`, async () => {
      const f = await startRun(be, async () => {}, `applyKeys-${mode}`);
      const h1 = await setup(f);
      const through = be.fetch;
      if (mode === 'conflict') {
        // The prefab changed on disk since the editor read it: the guarded write answers 409.
        const d = JSON.parse(be.read(f.prefabs.H.path)!);
        d.entities[0].traits.Transform.x = 99;
        be.write(f.prefabs.H.path, `${JSON.stringify(d, null, 2)}\n`);
      } else {
        vi.stubGlobal('fetch', async (url: string, init?: Parameters<typeof through>[1]) => {
          if (String(url).includes('/api/write-file') && String(init?.body ?? '').includes('H.prefab.json')) {
            return new Response(JSON.stringify({ error: 'disk full (armed)' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
          }
          return through(url, init);
        });
      }
      let r: Awaited<ReturnType<typeof applyAll>>;
      try {
        r = await applyAll(h1, f);
      } finally {
        vi.stubGlobal('fetch', through);
      }
      await settle();
      expect(r.applied, `premise: nothing was applied (${r.refused})`).toBe(false);
      expect(r.refused).toMatch(mode === 'conflict' ? /changed on disk/ : /could not be written/);
      expect(keyOf('Z')).toBeUndefined();
      expect(placedExtraKey(h1)).toEqual(['k-extra']);
      await saveScene({ allowDialog: false });
      await loadSceneReporting(f.scenePath);
      await settle();
      expect(keyOf('Z'), 'the reload agrees').toBeUndefined();
    });
  }

  it('an Apply that THROWS after its plan promoted Z: Z is unkeyed, as a save + reload leaves it, and Extra keeps k-extra', async () => {
    const f = await startRun(be, async () => {}, 'applyKeys-throw');
    const h1 = await setup(f);
    const before = be.read(f.prefabs.H.path);
    thrown.at = 'plan';
    try {
      await expect(applyAll(h1, f)).rejects.toThrow(/after the plan/);
    } finally {
      thrown.at = '';
    }
    await settle();
    expect(be.read(f.prefabs.H.path), 'premise: H was not written').toBe(before);
    expect(keyOf('Z')).toBeUndefined();
    expect(placedExtraKey(h1)).toEqual(['k-extra']);
    await saveScene({ allowDialog: false });
    await loadSceneReporting(f.scenePath);
    await settle();
    expect(keyOf('Z'), 'the reload agrees').toBeUndefined();
  });

  // A throw after the rebuild took the tree, with H written: the Apply rolls back (#2001 S8b, hub decision A,
  // `instanceRollback.ts`) — H1's records as they stood before it, the tree rebuilt from them over the H that stays
  // written (edge 3), named in the console error. What H now declares (the placed Q and O, Z) shows from the template
  // AND from H1's own records, which still add them: the honest result of a file left written under records put back.
  // Before, the throw left the records stale and the re-seed took the half-applied tree, keys and all.
  it('an Apply that throws AFTER its rebuild took the tree rolls back to its records over the written H (accept side)', async () => {
    const f = await startRun(be, async () => {}, 'applyKeys-throwLanded');
    const h1 = await setup(f);
    const hr = byName('HR').guid!;
    const before = canon(storedInstance(getCurrentWorld(), hr)?.record);
    const errors = vi.spyOn(console, 'error');
    thrown.at = 'rebase';
    try {
      await expect(applyAll(h1, f)).rejects.toThrow(/after the rebuild/);
    } finally {
      thrown.at = '';
    }
    await settle();
    expect(be.read(f.prefabs.H.path), 'premise: H landed').toContain('"Z"');
    expect(canon(storedInstance(getCurrentWorld(), hr)?.record), "H1's record as before the Apply").toBe(before);
    const said = errors.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[instanceRollback]'));
    expect(said.some((m) => /rolled back/.test(m) && m.includes(f.prefabs.H.path)), said.join(' | ')).toBe(true);
    errors.mockRestore();
  });
});
