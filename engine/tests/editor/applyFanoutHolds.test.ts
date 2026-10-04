/** #2001 S8b: an Apply's fan-out reprojects another tree from its records even when the documents it wrote drop the
 *  member a user's node hangs under in that tree. The record links the node under the member's row; the fold over the
 *  written document no longer places it, so the fan-out rebuilt that tree from the capture and left its records stale
 *  (hunt seed 9317; the same guard sent a Detach undo's rebase there, seed 9331). The node is live, so its content is
 *  read off the tree before the rebuild, and the reprojection HOLDS it on the record (`held.heldOwn`) as a load does — a
 *  reference node's own record going with it — so the record stays fresh and the save writes the node from it.
 *
 *  Mutations (measured), each run separately: the old guard (`reprojectsExactly` refusing any unplaced own link) — both
 *  red at 'fresh'; drop the hold after the rebuild (`reprojectFromStore`) — both red ('held'); drop only the reference
 *  node's record drop — the reference case red ('its own record went'); the node's content taken from the capture's
 *  parse instead of the live tree (it reads the tree against the written document, where A is gone, and states no
 *  content for the node) — both red ('held'). The hunt stays green on that last one: no check reads a held node.
 *
 *  The rebuild's written entry states the node too, so A's kept orphan row (what the capture reads) links it as a save +
 *  reload keeps it; without that, the kept row lost the link while the record held it (hunt seed 9449, an outside edit
 *  removing the member). Mutation: the entry written from the capture's parse alone (`withLinkedContent` dropped) — both
 *  red at 'A's kept row links it', and the 9449 replay red; restored green. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { createEntityWithUndo, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The root-level instances of P, in entity order: P1 (the fixture's) first. */
const ps = (f: Fixture) => getAllEntities().filter((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; });
const memberA = (root: number) => getAllEntities().find((x) => x.name === 'A' && piOf(x.id)?.rootInstanceId === root)!;
const byGuid = (g: string) => getAllEntities().find((x) => x.guid === g);
/** The own links of the member rows the scene keeps for `rootGuid` with no live member: what the capture reads them from. */
const recordLinks = (rootGuid: string) => [...(storedInstance(getCurrentWorld(), rootGuid)?.record.list.rows.values() ?? [])].flatMap((r) => (r.own ?? []).map((n) => n.guid));
const heldGuids = (rootGuid: string) => [...(storedInstance(getCurrentWorld(), rootGuid)?.record.held.heldOwn?.values() ?? [])].flat().map((n) => n.guid);

/** P2, a second P placed at the root, with its member A deleted (a removal); then `hang` puts the user's node under P1's
 *  A, and P2's removal is applied to P. Returns the node's guid and P1's guid. */
async function applyRemovalUnder(f: Fixture, hang: (a: number) => Promise<string>): Promise<{ g: string; p1: string }> {
  expect(await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: 0 })).toBeTruthy();
  await settle();
  const [p1, p2] = ps(f);
  expect(p2, 'premise: a second P').toBeDefined();
  const g = await hang(memberA(p1.id).id);
  await settle();
  deleteEntitiesWithUndo([memberA(p2.id).id]);
  await settle();
  const removal = [...new Set((await import('../../packages/modoki/src/editor/scene/prefabOverrideKeys')).collectInstanceOverrideKeys(ps(f)[1].id,
    (await import('../../packages/modoki/src/editor/scene/prefabCache')).getCachedPrefabSync(f.prefabs.P.guid)!).all)].filter((k) => k.startsWith('-removed.'));
  expect(removal, 'premise: P2 states A\'s removal').toHaveLength(1);
  expect((await applyToPrefabSelective(ps(f)[1].id, new Set(removal))).applied).toBe(true);
  await settle();
  return { g, p1: p1.guid! };
}

describe('#2001 S8b: an Apply whose fan-out drops the member a user\'s node hangs under keeps the records', () => {
  it('a plain node: P1\'s record holds it, fresh, and the save writes it', async () => {
    const f = await startRun(be, async () => {}, 'fanout-holds-plain');
    const { g, p1 } = await applyRemovalUnder(f, async (a) => {
      expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
      await settle();
      return getAllEntities().find((x) => x.name === 'Mine')!.guid!;
    });
    expect(byGuid(g), 'premise: A is gone from P, so the node is not shown').toBeUndefined();
    expect(heldGuids(p1), 'held').toContain(g);
    expect(recordLinks(p1), 'A\'s row in the record links it, as a reload keeps it').toContain(g);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!, 'the save writes it').toContain(g);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(heldGuids(p1), 'held after save and reload').toContain(g);
  }, 60_000);

  it('a reference node: held, and its own record goes, as a load does', async () => {
    const f = await startRun(be, async () => {}, 'fanout-holds-ref');
    const { g, p1 } = await applyRemovalUnder(f, async (a) => {
      expect(await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: a })).toBeTruthy();
      await settle();
      const q = getAllEntities().find((x) => x.parentId === a && piOf(x.id)?.source === f.prefabs.Q.guid)!;
      expect(storedInstance(getCurrentWorld(), q.guid!), 'premise: the node has a record of its own').toBeDefined();
      return q.guid!;
    });
    expect(storedInstance(getCurrentWorld(), g), 'its own record went').toBeUndefined();
    expect(heldGuids(p1), 'held').toContain(g);
    expect(recordLinks(p1), 'A\'s row in the record links it, as a reload keeps it').toContain(g);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!, 'the save writes it').toContain(g);
  }, 60_000);
});
