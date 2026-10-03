/** #2001 S6: a prefab v10 row about a PRE-v5 nested prefab (no `nodeGuid` on its rows: v0.7.2 and earlier) keys its
 *  members by the identity the instance model derives for them (`preV5NodeGuid`). Every reader has to resolve that key,
 *  or the row reads as an orphan: kept beside the live nodes it did apply to, and written a second time by the next save.
 *
 *  The fuzzer's fixture with P and Q rewritten as pre-v5 files, through the real backend, SceneManager, both caches and
 *  prefab edit: O's row N (a P) adds Extra under P's A.
 *
 *  Mutations (both measured red): the load's settle keying live members by minted identity only (`applyStoredMemberRows`:
 *  `memberRowKeysIn(rootEcsId, world, true)` → `false`) — the second save is refused, the row's node stated twice;
 *  `docRows` indexing only rows with a `nodeGuid` (`memberTranslation.ts`, drop the derived branch) — the same, and
 *  createPrefabMemberIdentity.test.ts's four #1758 cases. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { ownNodes, v9Channels } from './v10Rows';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

async function saveO(f: Fixture): Promise<string> {
  expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
  expect(authored().filter((e) => e.name === 'Extra').length, 'one Extra in O\'s edit world').toBe(1);
  const report = await savePrefabEditReport({});
  expect(report.saved, JSON.stringify(report)).toBe(true);
  await exitPrefabEditing();
  await settle();
  return be.read(f.prefabs.O.path)!;
}
const rowN = (bytes: string) => (JSON.parse(bytes) as { entities: Array<{ localId: number }> }).entities.find((e) => e.localId === 2)!;

describe('#2001 S6: a v10 row about a pre-v5 nested prefab', () => {
  it('a second prefab-edit save states the row\'s nodes once, and the scene shows them once', async () => {
    const f = await startRun(be, async () => {}, 'v10-prev5-chain');
    const before = be.snapshot();
    for (const p of [f.prefabs.P, f.prefabs.Q]) {
      const doc = JSON.parse(be.read(p.path)!) as { version: number; entities: Array<{ nodeGuid?: string }> };
      doc.version = 4;
      for (const e of doc.entities) delete e.nodeGuid;
      be.write(p.path, `${JSON.stringify(doc, null, 2)}\n`);
    }
    await flushWatcher(be, before);
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();

    const first = await saveO(f);
    expect(v9Channels(rowN(first)), 'premise: the row is in the v10 form').toEqual([]);
    expect(ownNodes(rowN(first)).map((n) => n.name)).toEqual(['Extra']);
    const second = await saveO(f);
    expect(ownNodes(rowN(second)).map((n) => n.name)).toEqual(['Extra']);
    expect(second).toBe(first);

    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const scene = be.read(f.scenePath)!;
    // The scene states nothing about a node the prefab adds: restated, it would be the scene's own copy from then on.
    expect([scene.includes('"Extra"'), scene.includes('a+k-extra')]).toEqual([false, false]);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    const or = authored().find((e) => e.name === 'OR' && e.guid?.startsWith('ffffffff-0000-4000-8001-'))!;
    const n = authored().find((e) => e.name === 'R' && e.parentId === or.id)!;
    const under = (id: number): boolean => { for (let e = authored().find((x) => x.id === id); e?.parentId; e = authored().find((x) => x.id === e!.parentId)) if (e.parentId === n.id) return true; return false; };
    expect(authored().filter((e) => e.name === 'Extra' && under(e.id)).length, 'one Extra in the scene\'s O instance').toBe(1);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(scene);
  }, 60_000);

  it('records on a v10 row that apply to nothing today are kept by every prefab-edit save, on the root row, a live member\'s row and a gone member\'s row', async () => {
    // Format rule: a record with no target (a member the nested prefab no longer has, a field or a component this build
    // does not know) is kept until Remove Unused, never dropped by a save.
    // Mutations (both measured, this case red alone): `captureRowChannels` not putting the kept rows back (the loop over
    // `keptMemberOrphans`) loses the root row's two values and the gone member's row; without `withKeptUnused` the live
    // member's unknown field is lost.
    const f = await startRun(be, async () => {}, 'v10-unused-kept');
    const converted = JSON.parse(await saveO(f)) as { entities: Array<{ localId: number; members?: Record<string, { traits?: Record<string, Record<string, unknown>> }> }> };
    const row = converted.entities.find((e) => e.localId === 2)!;
    expect(v9Channels(row), 'premise: the row is in the v10 form').toEqual([]);
    const GONE = '/eeeeeeee-0000-4000-8000-00000000dead';
    const LIVE = `/${(JSON.parse(be.read(f.prefabs.P.path)!) as { entities: Array<{ name?: string; nodeGuid?: string }> }).entities.find((e) => e.name === 'A')!.nodeGuid}`;
    const unused = {
      '/': { traits: { Transform: { noSuchField: 1 }, NoSuchTrait: { a: 2 } } },
      [GONE]: { traits: { Transform: { x: 4 } } },
      [LIVE]: { traits: { Transform: { noSuchField: 3 } } },
    };
    const members = { ...(row.members ?? {}) };
    for (const [k, r] of Object.entries(unused)) members[k] = { ...members[k], traits: { ...members[k]?.traits, ...Object.fromEntries(Object.entries(r.traits).map(([t, v]) => [t, { ...members[k]?.traits?.[t], ...v }])) } };
    row.members = Object.fromEntries(Object.keys(members).sort().map((k) => [k, members[k]!]));
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(converted, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();

    const kept = (bytes: string) => {
      const m = (rowN(bytes) as unknown as { members?: Record<string, { traits?: Record<string, Record<string, unknown>> }> }).members ?? {};
      return [m['/']?.traits?.Transform?.noSuchField, m['/']?.traits?.NoSuchTrait, m[GONE]?.traits?.Transform, m[LIVE]?.traits?.Transform?.noSuchField];
    };
    const first = await saveO(f);
    expect(kept(first)).toEqual([1, { a: 2 }, { x: 4 }, 3]);
    const second = await saveO(f);
    expect(kept(second)).toEqual([1, { a: 2 }, { x: 4 }, 3]);
    expect(second).toBe(first);
  }, 60_000);

  // ⚠️ KNOWN OPEN, #2116 (low, parked): the scene DOES state the node, as its own copy beside a removal of the
  // template's, so the node stops following the prefab. The old capture states a pre-v5 frame as one whole legacy slot
  // (unchanged by S6; a v19 scene wrote that slot as it was), and the v20 writer states the slot as rows. Stable: one
  // node, and the second save's bytes are the first's. Pinned as it is; a fix turns the first assertion red.
  it('a scene over a chain that is pre-v5 at every level: the node the prefab adds is pinned, once, and stays (#2116)', async () => {
    const f = await startRun(be, async () => {}, 'v10-prev5-all');
    const before = be.snapshot();
    for (const p of [f.prefabs.O, f.prefabs.P, f.prefabs.Q]) {
      const doc = JSON.parse(be.read(p.path)!) as { version: number; entities: Array<{ nodeGuid?: string }> };
      doc.version = 4;
      for (const e of doc.entities) delete e.nodeGuid;
      be.write(p.path, `${JSON.stringify(doc, null, 2)}\n`);
    }
    await flushWatcher(be, before);
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const scene = be.read(f.scenePath)!;
    expect([scene.includes('"Extra"'), scene.includes('a+k-extra')]).toEqual([true, true]);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(authored().filter((e) => e.name === 'Extra').length).toBe(1);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(scene);
  }, 60_000);
});
