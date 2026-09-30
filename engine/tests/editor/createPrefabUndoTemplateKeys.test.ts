/** #1884 — Create Prefab's undo takes off the template keys the create put on, and only those (`tagCreatedPrefab`).
 *
 *  The key is put on by the create's CAPTURE, not its tag: `serializePrefab` writes a scene-added node under a nested
 *  instance as that row's added node and keys it (`addedNodeIdentity`). Undone, the node was plain again with a key the
 *  save drops, so the live world and the reloaded one disagreed (fuzz seed 1021, `prefabFuzz/knownOpen.ts` REGRESSIONS).
 *  These pin the halves the seed does not:
 *
 *  - create → undo → redo → undo on a scene-added child Z under a nested P instance: Z's key comes off at each undo and
 *    the redo puts the file's key back. Mutation: drop `undoKeys()` from `undoKept` — red.
 *  - the ACCEPT side, in the same tree: O's Extra carries `k-extra` from O's own template before the create, and keeps it
 *    through all four steps. Mutation: widen `unkeyedNodes` to every node of the tree (keyed ones too) — red here, and in
 *    every case below that asserts Extra except the Replace's: its undo's rebuild respawns O's Extra with its key, so it
 *    cannot see that mutation, and pins only Z.
 *  - a Replace over another prefab runs the same undo. Mutation: drop `undoKeys()` from `undoKept` — red, as the first.
 *  - a redo that REFUSES takes its seat back off. Mutation: drop `stripKeysNow(unkeyed)` in the refused branch — red,
 *    and only this.
 *  - a Create that writes nothing after its serialize keyed the tree takes the keys off at once, and Extra keeps k-extra:
 *    the write conflicts or fails (`!committed.ok`), or the serialize refuses a cycle part-way (`!draft`: the plan had
 *    already captured the P row when it reached the H instance a Replace of H would contain). Mutation: drop
 *    `unkeyed.drop()` at either exit — that exit's cases red.
 *
 *  - the rider review's three races, each inside the create's write (a fetch stub): an adoption that holds the commit's
 *    rebuild off and then fails WITHOUT switching the world (landed, nothing tagged: `if (!tagged) unkeyed.drop()` —
 *    mutation: drop it, red); a rebuild of the nested P in place (Z respawned with its key put back by guid) before a
 *    409 and before a landing that is then undone (mutation: address the snapshot by handle only, `n.same() ? n.id` for
 *    every node — both red); and a second Create Prefab of the same tree landing meanwhile, before this one's 500 — Z
 *    keeps the key that create's document declares: its tag re-derived Z's guid, so this one's snapshot no longer names Z
 *    (mutation: the handle-only snapshot above — red here too).
 *
 *  - an EXCEPTION after the serialize keyed the tree (a throw right after it, before the write) takes the keys off like a
 *    refusal, and Extra keeps k-extra (`dropOnThrow`, the #1884 close-out's un-killed candidate (a)); the ACCEPT side, a
 *    throw after the tag linked the tree (in the commit's rebase), leaves Z the key the written file declares, live and
 *    reloaded (`keep()`) — with Z guid-less, the one node the snapshot still names after the tag (by identity; a guid is
 *    renamed by the tag's derivation); and so does a throw INSIDE the tag once it linked (its guid stamp, its settle),
 *    which is why `keep()` runs from `tagTree`'s tag loop (`onLinked`), not after the tag. Mutations: drop `held?.drop()`
 *    in `dropOnThrow` — the first red; drop the `onLinked` call — all three accept cases red; call it after `tagTree`
 *    returns — the stamp case red; after `tagCreatedPrefab` returns — the stamp and settle cases red.
 *  - the strip of a Create that lands nothing writes no identity: a Z with NO durable guid keeps none (candidate (b):
 *    the strip addressed nodes by `entityRef`, which mints one). Mutation: strip through `stripCreatedKeys(ids())()` in
 *    `drop()` again — red.
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
// A throw at two seams of the door, armed per test: right after the serialize (its inert-size warning), and after the tag
// (the commit's rebase of the other instances).
const thrown = vi.hoisted(() => ({ at: '' as '' | 'serialize' | 'rebase' | 'settle' | 'stamp' }));
// …and inside the tag once it linked the tree: its guid stamp (inside `tagTree`, after its tag loop) and its kept-state
// settle (after `tagTree`).
vi.mock('../../packages/modoki/src/runtime/core/ecs/memberHome', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/runtime/core/ecs/memberHome')>();
  return { ...m, stampDerivedMemberGuids: (...a: Parameters<typeof m.stampDerivedMemberGuids>) => {
    const out = m.stampDerivedMemberGuids(...a);
    if (thrown.at === 'stamp') throw new Error('threw inside the tag (armed)');
    return out;
  } };
});
vi.mock('../../packages/modoki/src/editor/scene/prefabTokens', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefabTokens')>();
  return {
    ...m,
    // A live binding, not the spread's frozen copy: the serialize reads it inside `withKeptStateBake`.
    get bakingKeptState() { return m.bakingKeptState; },
    settleSwallowedKeptState: (...a: Parameters<typeof m.settleSwallowedKeptState>) => {
      if (thrown.at === 'settle') throw new Error('threw inside the tag (armed)');
      return m.settleSwallowedKeptState(...a);
    },
  };
});
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefab')>();
  return { ...m, warnInertPrefabSizes: (...a: Parameters<typeof m.warnInertPrefabSizes>) => {
    if (thrown.at === 'serialize') throw new Error('threw after the serialize (armed)');
    return m.warnInertPrefabSizes(...a);
  } };
});
vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefabRebuild')>();
  return { ...m, rebaseStaleInstances: (...a: Parameters<typeof m.rebaseStaleInstances>) => {
    if (thrown.at === 'rebase') throw new Error('threw after the tag (armed)');
    return m.rebaseStaleInstances(...a);
  } };
});
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, type Fixture } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { tagCreatedPrefab } from '../../packages/modoki/src/editor/scene/prefabLink';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntity, readTraitData, writeTraitField } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { withAdoption } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { piOf } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** Whether `id` sits under `ancestor`. */
const isUnder = (id: number, ancestor: number) => {
  for (let p = authored().find((x) => x.id === id)?.parentId ?? 0; p; p = authored().find((x) => x.id === p)?.parentId ?? 0) if (p === ancestor) return true;
  return false;
};
let scope = 0;
/** The one entity of that name under the Plain holder (a Replace rebuilds the scene's other instance with its own Z). */
const byName = (name: string) => {
  const hits = authored().filter((e) => e.name === name && (!scope || isUnder(e.id, scope)));
  if (hits.length !== 1) throw new Error(`expected one "${name}", found ${hits.length}`);
  return hits[0]!;
};
const keyOf = (name: string) => templateKeyOf(findEntity(byName(name).id)) || undefined;

const extraKeys = () => authored().filter((e) => e.name === 'Extra' && isUnder(e.id, scope)).map((e) => templateKeyOf(findEntity(e.id)));

/** The Plain entity holding a P instance with a scene-added child Z under its A, and an O instance (whose Extra O's
 *  template keys `k-extra`). Z has no key; Extra has one. */
async function holder(f: Fixture): Promise<number> {
  scope = 0;
  const plain = byName('Plain').id;
  await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: plain });
  await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: plain });
  await settle();
  // P1's A is the fixture scene's; the one under Plain is the placed instance's.
  const a = authored().find((e) => e.name === 'A' && isUnder(e.id, plain))!;
  scope = plain;
  const { specs } = emptySpecs(a.id);
  createEntityWithUndo('Create Z', a.id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Z' } } : s)), () => {});
  await settle();
  expect(keyOf('Z'), 'premise: Z is scene-added, unkeyed').toBeUndefined();
  expect(extraKeys(), "premise: the placed O's Extra is keyed by O's template").toEqual(['k-extra']);
  return plain;
}

describe("Create Prefab's undo takes off the keys the create put on (#1884)", () => {
  it('create → undo → redo → undo: Z loses the key at each undo, the redo puts the file\'s back, and Extra keeps k-extra', async () => {
    const f = await startRun(be, async () => {}, 'createKeys-create');
    const plain = await holder(f);
    const r = await createPrefabFromEntity(plain, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    const created = keyOf('Z');
    expect(created, 'premise: the create keyed Z (an added node of its nested P row)').toBeTruthy();
    expect(JSON.stringify(r.prefab), 'premise: the file holds that key').toContain(created!);
    expect(extraKeys()).toEqual(['k-extra']);

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);

    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(keyOf('Z')).toBe(created);
    expect(extraKeys()).toEqual(['k-extra']);

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
  });

  it("a Replace over another prefab: its undo takes Z's key off too", async () => {
    const f = await startRun(be, async () => {}, 'createKeys-replace');
    const plain = await holder(f);
    const r = await createPrefabFromEntity(plain, f.prefabs.H.path, 'Save prefab "H"', async () => true);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`replace: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(keyOf('Z'), 'premise: the Replace keyed Z').toBeTruthy();
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
  });

  it('a redo whose tag refuses takes the keys it seated back off', async () => {
    const f = await startRun(be, async () => {}, 'createKeys-refused');
    const plain = await holder(f);
    const r = await createPrefabFromEntity(plain, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    const created = keyOf('Z')!;
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(keyOf('Z'), 'premise: the undo took it off').toBeUndefined();
    // The redo's own call, over rows the tree no longer plans to (one row short): it seats Z's key, then refuses.
    const mismatched = { ...r.prefab, entities: r.prefab.entities.slice(0, -1) };
    const t = tagCreatedPrefab(plain, `${f.root}/prefabs/NewPlain.prefab.json`, mismatched, { keys: new Map([[byName('Z').guid!, created]]) });
    expect(t.refused, 'premise: the tag refused').toBeTruthy();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
  });

  // The write refused by the route (a file created at the path meanwhile: 409) or failed outright (500).
  for (const mode of ['conflict', 'failed'] as const) {
    it(`a Create whose write ${mode === 'conflict' ? 'conflicts' : 'fails'} takes the capture's keys off, and Extra keeps k-extra`, async () => {
      const f = await startRun(be, async () => {}, `createKeys-write-${mode}`);
      const plain = await holder(f);
      const target = `${f.root}/prefabs/Blocked.prefab.json`;
      const through = be.fetch;
      vi.stubGlobal('fetch', async (url: string, init?: Parameters<typeof through>[1]) => {
        if (String(url).includes('/api/write-file') && String(init?.body ?? '').includes('Blocked.prefab.json')) {
          if (mode === 'failed') return new Response(JSON.stringify({ error: 'disk full (armed)' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
          be.write(target, '{}\n'); // created meanwhile: the create-only write answers 409
        }
        return through(url, init);
      });
      try {
        const r = await createPrefabFromEntity(plain, target, 'Save prefab "Plain"', async () => false);
        if (mode === 'conflict') expect(r && r !== 'declined' && 'conflict' in r, 'premise: refused by the write\'s conflict').toBe(true);
        else expect(r && r !== 'declined' && 'refused' in r ? r.refused : r, 'premise: the create wrote nothing').toMatch(/not written/);
      } finally {
        vi.stubGlobal('fetch', through);
      }
      await settle();
      expect(keyOf('Z')).toBeUndefined();
      expect(extraKeys()).toEqual(['k-extra']);
    });
  }

  it('a Replace refused as a cycle part-way through its serialize takes the capture\'s keys off', async () => {
    const f = await startRun(be, async () => {}, 'createKeys-cycle');
    const plain = await holder(f);
    // After P and O in the tree, so the plan captures P's row (keying Z) before it meets H and refuses.
    await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: plain });
    await settle();
    const r = await createPrefabFromEntity(plain, f.prefabs.H.path, 'Save prefab "H"', async () => true);
    expect(r && r !== 'declined' && 'refused' in r ? r.refused : r, 'premise: refused as a cycle').toMatch(/cannot contain itself/);
    await settle();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
  });

  /** Run `during` inside this create's own write request (to `target`), then answer it as `answer` says. */
  const duringWrite = (target: string, during: () => Promise<void>, answer: 'through' | 'conflict' | 'failed') => {
    const through = be.fetch;
    let armed = true;
    vi.stubGlobal('fetch', async (url: string, init?: Parameters<typeof through>[1]) => {
      if (armed && String(url).includes('/api/write-file') && String(init?.body ?? '').includes(target.split('/').pop()!)) {
        armed = false;
        await during();
        if (answer === 'failed') return new Response(JSON.stringify({ error: 'disk full (armed)' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        if (answer === 'conflict') be.write(target, '{}\n');
      }
      return through(url, init);
    });
    return () => vi.stubGlobal('fetch', through);
  };

  it('an adoption holds the rebuild off and fails without switching the world: landed, untagged, and Z is unkeyed', async () => {
    const f = await startRun(be, async () => {}, 'createKeys-adoption');
    const plain = await holder(f);
    const target = `${f.root}/prefabs/Landed.prefab.json`;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let adoption: Promise<unknown> = Promise.resolve();
    const restore = duringWrite(target, async () => {
      adoption = withAdoption('scene-load', async () => { await held; throw new Error('the previous scene is still loaded (armed)'); }).catch(() => {});
    }, 'through');
    let r: Awaited<ReturnType<typeof createPrefabFromEntity>>;
    try { r = await createPrefabFromEntity(plain, target, 'Save prefab "Plain"', async () => false); } finally { restore(); }
    release();
    await adoption;
    await settle();
    expect(r && r !== 'declined' && !('refused' in r) && r.unlinked, 'premise: landed and not linked').toBeTruthy();
    expect(piOf(plain), 'premise: nothing tagged').toBeUndefined();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
    // The step is still pushed (the Hierarchy does), and its redo links the tree to the file: Z gets the key the FILE
    // declares, not one its plan mints — the drop above took the only copy (#1884's third review). Mutation: leave `keys`
    // empty on the untagged path — Z is minted a fresh key, and the reload has none.
    if (!r || r === 'declined' || 'refused' in r) throw new Error('unreachable');
    const declared = (JSON.stringify(r.prefab).match(/"key":"([^"]+)"/g) ?? []).map((m) => m.slice(7, -1)).filter((k) => k !== 'k-extra');
    expect(declared.length, 'premise: the file declares one key besides O\'s').toBe(1);
    pushAction(r.action);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(keyOf('Z')).toBeUndefined();
    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(piOf(plain)?.source, 'the redo linked the tree').toBe(r.prefab.id);
    expect(keyOf('Z')).toBe(declared[0]);
    await saveScene({ allowDialog: false });
    await loadSceneReporting(f.scenePath);
    await settle();
    expect(keyOf('Z'), 'the reload agrees').toBe(declared[0]);
  });

  for (const answer of ['conflict', 'through'] as const) {
    it(`the nested P is rebuilt in place during the write, then it ${answer === 'conflict' ? 'conflicts' : 'lands and is undone'}: Z's key comes off`, async () => {
      const f = await startRun(be, async () => {}, `createKeys-rebuilt-${answer}`);
      const plain = await holder(f);
      const target = `${f.root}/prefabs/Rebuilt.prefab.json`;
      const zBefore = byName('Z').id;
      const restore = duringWrite(target, async () => {
        const nestedP = authored().find((e) => e.name === 'R' && e.parentId === plain)!.id;
        const doc = getCachedPrefabSync(f.prefabs.P.guid)!;
        refreshInstances(f.prefabs.P.guid, [nestedP], doc, doc);
      }, answer);
      let r: Awaited<ReturnType<typeof createPrefabFromEntity>>;
      try { r = await createPrefabFromEntity(plain, target, 'Save prefab "Plain"', async () => false); } finally { restore(); }
      await settle();
      expect(byName('Z').id, 'premise: Z was respawned').not.toBe(zBefore);
      if (answer === 'through') {
        if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
        pushAction(r.action);
        await settle();
        expect(keyOf('Z'), 'premise: the create keyed the respawned Z').toBeTruthy();
        expect((await undoStep('undo')).did).toBe(true);
        await settle();
      } else {
        expect(r && r !== 'declined' && 'conflict' in r, 'premise: refused by the conflict').toBe(true);
      }
      expect(keyOf('Z')).toBeUndefined();
      expect(extraKeys()).toEqual(['k-extra']);
    });
  }

  it("a second Create Prefab of the tree lands during this one's write, which then fails: Z keeps the key that create declares", async () => {
    const f = await startRun(be, async () => {}, 'createKeys-concurrent');
    const plain = await holder(f);
    const target = `${f.root}/prefabs/First.prefab.json`;
    let second: Awaited<ReturnType<typeof createPrefabFromEntity>> | undefined;
    const restore = duringWrite(target, async () => {
      second = await createPrefabFromEntity(plain, `${f.root}/prefabs/Second.prefab.json`, 'Save prefab "Plain"', async () => false);
    }, 'failed');
    let r: Awaited<ReturnType<typeof createPrefabFromEntity>>;
    try { r = await createPrefabFromEntity(plain, target, 'Save prefab "Plain"', async () => false); } finally { restore(); }
    await settle();
    expect(r && r !== 'declined' && 'refused' in r ? r.refused : r, 'premise: the first wrote nothing').toMatch(/not written/);
    const s = second as Awaited<ReturnType<typeof createPrefabFromEntity>> | undefined;
    if (!s || s === 'declined' || 'refused' in s) throw new Error(`second: ${s && s !== 'declined' ? s.refused : s}`);
    expect(piOf(plain)?.source, 'premise: the second create linked the tree').toBe(s.prefab.id);
    const key = keyOf('Z');
    expect(key, 'Z keeps its key').toBeTruthy();
    expect(JSON.stringify(s.prefab), "the second create's document declares it").toContain(key!);
  });

  it("a Create that THROWS after its serialize takes the capture's keys off, as a save + reload leaves Z, and Extra keeps k-extra", async () => {
    const f = await startRun(be, async () => {}, 'createKeys-throw');
    const plain = await holder(f);
    thrown.at = 'serialize';
    try {
      await expect(createPrefabFromEntity(plain, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false))
        .rejects.toThrow(/after the serialize/);
    } finally {
      thrown.at = '';
    }
    await settle();
    expect(be.read(`${f.root}/prefabs/NewPlain.prefab.json`), 'premise: nothing was written').toBeFalsy();
    expect(keyOf('Z')).toBeUndefined();
    expect(extraKeys()).toEqual(['k-extra']);
    await saveScene({ allowDialog: false });
    await loadSceneReporting(f.scenePath);
    await settle();
    expect(keyOf('Z'), 'the reload agrees').toBeUndefined();
  });

  // Z with no durable guid: the snapshot then names it by its identity, which the tag keeps (a node with a guid is renamed
  // by the tag's derivation, so a drop after it would not find that node anyway).
  for (const at of ['rebase', 'settle', 'stamp'] as const) it(`a Create that throws AFTER its tag linked the tree (${at === 'rebase' ? 'in the commit\'s rebase' : `inside the tag, its ${at}`}) keeps the keys: they are the written file's (accept side)`, async () => {
    const f = await startRun(be, async () => {}, `createKeys-throwLanded-${at}`);
    const plain = await holder(f);
    writeTraitField(byName('Z').id, getTraitByName('EntityAttributes')!, 'guid', '');
    const path = `${f.root}/prefabs/NewPlain.prefab.json`;
    thrown.at = at;
    try {
      await expect(createPrefabFromEntity(plain, path, 'Save prefab "Plain"', async () => false)).rejects.toThrow(at === 'rebase' ? /after the tag/ : /inside the tag/);
    } finally {
      thrown.at = '';
    }
    await settle();
    const key = keyOf('Z');
    expect(key, 'Z keeps the key its landing wrote').toBeTruthy();
    expect(be.read(path), 'premise: the file landed, and declares that key').toContain(key!);
    expect(extraKeys()).toEqual(['k-extra']);
    await saveScene({ allowDialog: false });
    await loadSceneReporting(f.scenePath);
    await settle();
    expect(keyOf('Z'), 'the reload agrees').toBe(key);
  });

  it('the strip of a Create that lands nothing writes no identity: a Z with no durable guid still has none', async () => {
    const f = await startRun(be, async () => {}, 'createKeys-guidless');
    const plain = await holder(f);
    const ea = getTraitByName('EntityAttributes')!;
    const guidOf = (id: number) => (readTraitData(id, ea) as { guid?: string } | null)?.guid;
    writeTraitField(byName('Z').id, ea, 'guid', '');
    expect(guidOf(byName('Z').id), 'premise: Z has no guid').toBe('');
    const through = be.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: Parameters<typeof through>[1]) => {
      if (String(url).includes('/api/write-file') && String(init?.body ?? '').includes('NewPlain.prefab.json')) {
        return new Response(JSON.stringify({ error: 'disk full (armed)' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return through(url, init);
    });
    let r: Awaited<ReturnType<typeof createPrefabFromEntity>>;
    try {
      r = await createPrefabFromEntity(plain, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false);
    } finally {
      vi.stubGlobal('fetch', through);
    }
    await settle();
    expect(r && r !== 'declined' && 'refused' in r ? r.refused : r, 'premise: the write failed').toMatch(/was not written/);
    expect(keyOf('Z'), 'premise: the strip ran').toBeUndefined();
    expect(guidOf(byName('Z').id)).toBe('');
  });
});
