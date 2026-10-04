/** #2001 S6 (the save writes the list): a prefab instance hung under another instance's member by a write that went
 *  ROUND the door (no record links it, and the records stay fresh) is still saved — as an entry of its own, parented by
 *  guid, which the load links back under the member. The save's own partition leaves a stored instance under a member
 *  to its owner's entry, so with no link in that entry it was written nowhere and the instance was gone on reload.
 *
 *  Mutation: drop the promotion loop in `serializeSceneScoped` (`serialize.ts`, the `storedUnderMember` worklist) — the
 *  saved scene holds no entry for the moved instance, and the reload has no H under A. Drop the late guid-parent retry for
 *  an instance entry in `loadSceneFile.ts` (the `guidParentMisses.push` after `spawnedEntries.push`) — the entry is saved,
 *  but the reload leaves H at the scene root: the member it names did not exist yet when the entry expanded. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { writeTraitField, markStructureDirty } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const rootOf = (f: Fixture, key: keyof Fixture['prefabs']) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs[key].guid && pi.rootInstanceId === x.id; })!;
function under(root: number): Set<number> {
  const all = getAllEntities();
  const s = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!s.has(e.id) && s.has(e.parentId)) { s.add(e.id); grew = true; } }
  return s;
}

describe('#2001 S6: an instance no record links is saved as an entry of its own', () => {
  it('moved under a member round the door: saved, and under the member again after a reload', async () => {
    const f = await startRun(be, async () => {}, 'unlinked-instance');
    const p1 = rootOf(f, 'P'), h = rootOf(f, 'H');
    const a = getAllEntities().find((x) => under(p1.id).has(x.id) && x.name === 'A')!;
    const hGuid = h.guid!, aGuid = a.guid!, p1Guid = p1.guid!;
    // Round the door: the raw trait write, which touches no record and marks none stale.
    writeTraitField(h.id, getTraitByName('EntityAttributes')!, 'parentId', a.id);
    markStructureDirty();
    await settle();
    expect(getAllEntities().find((x) => x.id === h.id)!.parentId, 'premise: the move landed').toBe(a.id);
    const rec = storedInstance(getCurrentWorld(), p1Guid)!;
    expect(JSON.stringify([...rec.record.list.rows.values()]), 'premise: and does not link the moved instance').not.toContain(hGuid);

    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const saved = (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; prefab?: string; traits?: { EntityAttributes?: { parentId?: string } } }> }).entities.find((e) => e.guid === hGuid);
    expect(saved?.prefab).toBe(f.prefabs.H.guid);
    expect(saved?.traits?.EntityAttributes?.parentId).toBe(aGuid);

    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle();
    const back = getAllEntities().find((x) => x.guid === hGuid)!;
    expect(back).toBeTruthy();
    expect(piOf(back.id)).toMatchObject({ source: f.prefabs.H.guid, rootInstanceId: back.id });
    expect(getAllEntities().find((x) => x.id === back.parentId)?.guid).toBe(aGuid);
    expect(getAllEntities().filter((x) => x.guid === hGuid)).toHaveLength(1);
  }, 60_000);
});
