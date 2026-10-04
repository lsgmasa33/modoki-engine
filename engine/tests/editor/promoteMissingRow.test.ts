/** #2001 S8b: a copy of a nested frame whose document holds a Missing Prefab placeholder (a nested row whose prefab is
 *  gone) is an instance of its own ON RECORDS (`promotedRecord`): the placeholder is the frame's own, and so are the records
 *  waiting inside it. Before, the promotion refused any placeholder in the frame, and the copy went stale and re-seeded
 *  from its capture (the hunt's last duplicate re-seeds).
 *
 *  O holds N, a P frame, whose C row expands Q. Q goes missing: C is a placeholder in N, and every layer's record on C's
 *  member M waits inside it (P's x 4 and z 9, O's y 8 and z 7). The copy of N keeps them on its own list: once Q is back,
 *  the copy's M shows what N's shows.
 *
 *  O's z 7 is stated through a legacy carrier, which the parse HOLDS while Q is missing (`TemplateOverrideList.held`):
 *  the fold hands it with N's layer (`HandedLayer.held`), and the copy's record holds it verbatim.
 *
 *  Mutation (measured): `promotedRecord` refusing a placeholder again — red (the copy is not on records); the composed
 *  rows dropped inside the placeholder (`isOwn` as `members.has`) — red (y 0: O's row value lost); the handed held data
 *  not carried (`held: {}`) — red (z 9: O's legacy value lost). The placeholder comparison after the fold (place, source,
 *  reason, name, order) dropped — GREEN: it is defensive; both folds read the same documents and the composed rows carry
 *  a layer's rename or removal of the placeholder row, and no shape that makes them differ was found. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities, readTraitData } from '@modoki/engine/runtime';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, placeholderGuids, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { duplicateEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const o1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!;
/** The nested P frames hanging directly under O's root: N, and its copy. */
const frames = (f: Fixture) => getAllEntities().filter((x) => x.parentId === o1(f).id && piOf(x.id)?.rootInstanceId === x.id);
/** M's Transform under frame `top` (its C row's Q, once Q resolves). */
function mOf(top: number): { x?: number; y?: number; z?: number } | undefined {
  const parent = new Map(getAllEntities().map((x) => [x.id, x.parentId]));
  const under = (id: number) => { for (let a = parent.get(id), n = 0; a && n < 64; a = parent.get(a), n++) if (a === top) return true; return false; };
  const m = getAllEntities().find((x) => x.name === 'M' && under(x.id));
  return m ? readTraitData(m.id, getTraitByName('Transform')!) as { x?: number; y?: number; z?: number } : undefined;
}
async function reload(f: Fixture) { expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle(); }

describe('#2001 S8b: a copy of a nested frame holding a Missing Prefab placeholder', () => {
  it('stays on records, and keeps every layer\'s records waiting inside the placeholder', async () => {
    const f = await startRun(be, async () => {}, 'promote-missing-row');
    const [n0] = frames(f);
    const want = mOf(n0!.id);
    expect(want, 'premise: N\'s M shows the layers\' values').toMatchObject({ x: 4, y: 8, z: 7 });

    const q = be.read(f.prefabs.Q.path)!;
    let before = be.snapshot();
    be.remove(f.prefabs.Q.path);
    await flushWatcher(be, before); await settle(); await reload(f);
    expect(placeholderGuids().size, 'premise: C is a placeholder').toBeGreaterThan(0);

    const [n] = frames(f);
    const had = new Set(getAllEntities().map((x) => x.guid));
    expect(duplicateEntity(n!.id, () => {})).not.toBeNull();
    await settle();
    const copy = frames(f).find((x) => !had.has(x.guid))!;
    expect(storedRecord(getCurrentWorld(), copy.guid!), 'the copy is on records').toBeDefined();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);

    before = be.snapshot();
    be.write(f.prefabs.Q.path, q);
    await flushWatcher(be, before); await settle(); await reload(f);
    const back = frames(f).find((x) => x.guid === copy.guid)!;
    expect(mOf(back.id)).toMatchObject(want!);
  }, 60_000);
});
