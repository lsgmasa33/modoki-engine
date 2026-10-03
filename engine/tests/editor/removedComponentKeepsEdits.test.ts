/** #2001 S6, hub rule G2: removing a BASE component keeps the field records the instance made on it, beside the removal.
 *  They are inert while the removal stands, and the v20 save writes both, so a Revert of the removal after a reload
 *  brings the component back with the instance's edit, not with the prefab's value (the capture form dropped the edit at
 *  the save, and the Revert gave the prefab's value: the visible change).
 *
 *  The fixture's P has no removable component, so B gets a `Rotate3D` in the prefab file first.
 *
 *  Mutation (measured): in `instanceEdits.ts`, drop the row's records of the component when its removal is recorded —
 *  red: the saved row states the removal alone, and the Revert gives the prefab's speed. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { writeTraitFieldWithUndo, removeTraitFromEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = (f: Fixture): number => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!.id;
const memberB = (f: Fixture) => getAllEntities().find((x) => x.name === 'B' && piOf(x.id)?.rootInstanceId === p1(f))!;
const rotate = () => getTraitByName('Rotate3D')!;
const speed = (f: Fixture): number | undefined => {
  const e = findEntity(memberB(f).id)!;
  return e.has(rotate().trait) ? (e.get(rotate().trait) as { speed: number }).speed : undefined;
};
type Row = { name?: string; traits?: Record<string, unknown>; traitRemovals?: Record<string, unknown> };
const rowB = (f: Fixture): Row | undefined => {
  const guid = getAllEntities().find((x) => x.id === p1(f))!.guid;
  const members = (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; members?: Record<string, Row> }> }).entities.find((e) => e.guid === guid)!.members ?? {};
  return Object.values(members).find((r) => r.name === 'B');
};
async function reload(f: Fixture) { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }
async function save() { expect((await saveScene({ allowDialog: false })).saved).toBe(true); }

describe('#2001 S6 (G2): a removed base component keeps the instance\'s edits of it', () => {
  it('the saved row states the removal and the edit, and a Revert of the removal after a reload restores the edit', async () => {
    const f = await startRun(be, async () => {}, 'g2-revert');
    const doc = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: Array<{ name?: string; traits: Record<string, unknown> }> };
    doc.entities.find((e) => e.name === 'B')!.traits.Rotate3D = { axis: 'y', speed: 1 };
    const before = be.snapshot();
    be.write(f.prefabs.P.path, JSON.stringify(doc));
    await flushWatcher(be, before); await settle(); await reload(f);
    expect(speed(f), 'premise: the prefab supplies the component').toBe(1);

    writeTraitFieldWithUndo(memberB(f).id, rotate(), 'speed', 77);
    await settle();
    removeTraitFromEntitiesWithUndo([memberB(f).id], rotate());
    await settle();
    expect(speed(f)).toBeUndefined();
    await save();
    expect(rowB(f)).toMatchObject({ traits: { Rotate3D: { speed: 77 } }, traitRemovals: { Rotate3D: true } });

    await reload(f);
    expect(speed(f), 'the edit is inert while the removal stands').toBeUndefined();
    const keys = collectInstanceOverrideKeys(p1(f), getCachedPrefabSync(f.prefabs.P.guid)!);
    expect(keys.removedTraits).toHaveLength(1);
    expect(await revertOverridesWithUndo(p1(f), new Set(keys.removedTraits))).not.toBeNull();
    await settle();
    expect(speed(f)).toBe(77);

    await save();
    const row = rowB(f);
    expect(row?.traitRemovals).toBeUndefined();
    expect(row?.traits).toEqual({ Rotate3D: { speed: 77 } });
    await reload(f);
    expect(speed(f)).toBe(77);
  }, 60_000);
});
