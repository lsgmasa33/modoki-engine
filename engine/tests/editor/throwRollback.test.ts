/** #2001 S8b, hub decision A (task #11): an op that THROWS part-way rolls back — every instance's records as they stood
 *  before it, each tree rebuilt from them (`editor/instance/instanceRollback.ts`). Before, the throw marked the records
 *  stale and the door re-seeded them from the capture: the half-applied tree became the records' truth.
 *
 *  The hub's four edges, each driven:
 *  1. an earlier unsaved edit, in the same tree, stays (live, in the records, and the scene still dirty);
 *  2. the throwing gesture pushes no undo entry: the next undo lands on the edit before it;
 *  3. a prefab file written before the throw stays written, and the console error names it;
 *  4. a rollback that cannot rebuild a tree fails loud and marks the world unsavable (a save refuses), with no record
 *     stale (nothing to re-seed), until a load replaces the world.
 *  And an undo step that throws part-way (a delete's undo) rolls back to the records the step found.
 *
 *  Mutations (measured): see the commit message. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
// Armed per test: a throw in an Apply's rebase of the other instances (after the prefab file is written), a throw in the
// delete undo's rebuild from records, and a reprojection that cannot rebuild (for the rollback's own, edge 4).
const armed = vi.hoisted(() => ({ rebase: false, restoreSide: false, reprojectFails: false, valuesEqual: false }));
// One shot: the door's field write compares values only after it changed the record's placement in place.
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefab')>();
  return { ...m, valuesEqual: (...a: Parameters<typeof m.valuesEqual>) => {
    if (armed.valuesEqual) { armed.valuesEqual = false; throw new Error('the door threw part-way (armed)'); }
    return m.valuesEqual(...a);
  } };
});
vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/scene/prefabRebuild')>();
  return { ...m, rebaseStaleInstances: (...a: Parameters<typeof m.rebaseStaleInstances>) => {
    if (armed.rebase) throw new Error('threw after the write (armed)');
    return m.rebaseStaleInstances(...a);
  } };
});
vi.mock('../../packages/modoki/src/editor/instance/instanceHistory', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/instance/instanceHistory')>();
  // After the real rebuild from records: the step has changed the records when it throws.
  return { ...m, restoreSide: (...a: Parameters<typeof m.restoreSide>) => {
    const out = m.restoreSide(...a);
    if (armed.restoreSide) throw new Error('the undo threw part-way (armed)');
    return out;
  } };
});
vi.mock('../../packages/modoki/src/editor/instance/instanceReproject', async (orig) => {
  const m = await orig<typeof import('../../packages/modoki/src/editor/instance/instanceReproject')>();
  return { ...m, reprojectFromStore: (...a: Parameters<typeof m.reprojectFromStore>) => (armed.reprojectFails ? null : m.reprojectFromStore(...a)) };
});
import { getAllEntities, findEntity, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { peekUndo, pushAction, undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { hasUnsavedChanges, loadSceneReporting, saveScene } from '../../packages/modoki/src/editor/scene/serialize';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';
import { isUnsavableAfterRollback, NO_RECORD_TO_WRITE } from '../../packages/modoki/src/editor/instance/instanceRollback';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { dropInstanceRecord, storedInstance, storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { setFields } from '../../packages/modoki/src/editor/instance/instanceEdits';
import { writeTraitField } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

afterEach(() => { armed.rebase = armed.restoreSide = armed.reprojectFails = armed.valuesEqual = false; vi.restoreAllMocks(); });

const p1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!;
const member = (f: Fixture, n: string) => getAllEntities().find((x) => x.name === n && piOf(x.id)?.rootInstanceId === p1(f).id)!;
const transform = () => getTraitByName('Transform')!;
const xOf = (id: number) => (findEntity(id)?.get(transform().trait) as { x?: number } | undefined)?.x;

/** `v` in a stable form, its Maps and Sets written out (a record holds both). */
function canon(v: unknown): string {
  const sorted = (m: Map<unknown, unknown>) => [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  return JSON.stringify(v, (_k, x) => (x instanceof Map ? sorted(x) : x instanceof Set ? [...x].sort() : x));
}
/** Every record in the store, whether it is stale, in a stable form. */
const store = () => canon([...storedInstances(getCurrentWorld())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, s]) => [g, s.record]));

/** P1 with an earlier unsaved edit (B.x = 33), then an edit to apply (A.x = 44). Returns the keys of the A edit alone. */
async function editedP1(f: Fixture): Promise<Set<string>> {
  const prefab = () => getCachedPrefabSync(f.prefabs.P.guid)!;
  expect(writeTraitFieldWithUndo(member(f, 'B').id, transform(), 'x', 33)).toBeNull();
  await settle();
  await preloadNestedPrefabsForSubtree(p1(f).id);
  const had = new Set(collectInstanceOverrideKeys(p1(f).id, prefab()).all);
  expect(writeTraitFieldWithUndo(member(f, 'A').id, transform(), 'x', 44)).toBeNull();
  await settle();
  const keys = new Set([...collectInstanceOverrideKeys(p1(f).id, prefab()).all].filter((k) => !had.has(k)));
  expect(keys.size, 'premise: the A edit is an override of its own').toBeGreaterThan(0);
  return keys;
}

describe('#2001 S8b: an op that throws part-way rolls back to the records it found', () => {
  it('an Apply that throws after writing its prefab: the records and the scene as before, its file named, no undo entry (edges 1-3)', async () => {
    const f = await startRun(be, async () => {}, 'throw-rollback-apply');
    const keys = await editedP1(f);
    const before = store();
    const top = peekUndo()?.label;
    const file = be.read(f.prefabs.P.path);
    const errors = vi.spyOn(console, 'error');
    armed.rebase = true;
    await expect(applyToPrefabWithUndo(p1(f).id, keys)).rejects.toThrow(/armed/);
    armed.rebase = false;
    await settle();
    expect(be.read(f.prefabs.P.path), 'premise: the Apply wrote P before it threw').not.toBe(file);
    const said = errors.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[instanceRollback]'));
    expect(said.some((m) => /rolled back/.test(m) && m.includes(f.prefabs.P.path)), `the rollback says so and names the file (edge 3): ${said.join(' | ')}`).toBe(true);
    expect(store(), 'every record as it stood before the Apply').toBe(before);
    expect(xOf(member(f, 'A').id), 'the edit the Apply took is the instance\'s again').toBe(44);
    expect(xOf(member(f, 'B').id), 'the earlier unsaved edit stays (edge 1)').toBe(33);
    expect(hasUnsavedChanges(), 'the scene is still dirty (edge 1)').toBe(true);
    expect(peekUndo()?.label, 'no undo entry: the next undo is the edit before (edge 2)').toBe(top);
    expect(isUnsavableAfterRollback(), 'the rollback finished: the world is savable').toBe(false);
  }, 60_000);

  it('a rollback that cannot rebuild a tree fails loud and marks the world unsavable, re-seeding nothing (edge 4)', async () => {
    const f = await startRun(be, async () => {}, 'throw-rollback-unsavable');
    const keys = await editedP1(f);
    const errors = vi.spyOn(console, 'error');
    armed.rebase = true;
    armed.reprojectFails = true;
    await expect(applyToPrefabWithUndo(p1(f).id, keys)).rejects.toThrow(/armed/);
    armed.rebase = armed.reprojectFails = false;
    await settle();
    const said = errors.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[instanceRollback]'));
    expect(said.some((m) => /could not rebuild/.test(m) && /unsavable/.test(m)), `fails loud: ${said.join(' | ')}`).toBe(true);
    expect(isUnsavableAfterRollback(), 'the world is marked unsavable').toBe(true);
    expect(whyWorldNotAuthored(), 'every writer of the live world refuses').toMatch(/could not be rolled back/);
    // Answered as the mark, not as a run mode (#2001 S8b review L2): Stop and a retry do not clear it.
    expect(await saveScene({ allowDialog: false }), 'a save refuses').toMatchObject({ saved: false, reason: 'unsavable', error: expect.stringMatching(/could not be rolled back/) });
    await loadSceneReporting(f.scenePath);
    await settle();
    expect(isUnsavableAfterRollback(), 'a load replaces the world, and with it the mark').toBe(false);
  }, 60_000);

  // The door takes only its verb's trees (`takeStore(trees)`): the record it changed in place before it threw is one.
  it('a door verb that throws after changing its record in place puts that record back', async () => {
    const f = await startRun(be, async () => {}, 'throw-rollback-door');
    const root = p1(f);
    writeTraitField(root.id, getTraitByName('EntityAttributes')!, 'name', 'Renamed');
    const before = canon(storedInstance(getCurrentWorld(), root.guid!)?.record);
    expect(before, 'premise: the record does not state the live name yet').not.toContain('Renamed');
    armed.valuesEqual = true;
    expect(() => setFields(root.id, 'EntityAttributes')).toThrow(/armed/);
    expect(armed.valuesEqual, 'premise: the throw came from inside the verb').toBe(false);
    expect(canon(storedInstance(getCurrentWorld(), root.guid!)?.record), 'the record as the verb found it').toBe(before);
  }, 60_000);

  // #2001 S8b review G2: a step that untags a tree and then throws (Create Prefab's undo when a link cannot be put back,
  // Detach's commit): its root is live, so the rollback found nothing "gone", and the untagged tree is no instance it
  // rebuilds — it said every instance was as it stood, over a tree that is not one any more. Mutation: drop the
  // "no longer an instance" report in `putBack` (instanceRollback.ts) — red at 'marked unsavable'.
  it('an undo step that untags a tree and throws: the rollback reports the tree and marks the world unsavable', async () => {
    const f = await startRun(be, async () => {}, 'throw-rollback-untag');
    const root = p1(f);
    const errors = vi.spyOn(console, 'error');
    pushAction({ label: 'Untag', redo: () => {}, undo: () => {
      findEntity(root.id)!.remove(getTraitByName('PrefabInstance')!.trait);
      throw new Error('threw after the untag (armed)');
    } });
    expect((await undoStep('undo')).did).toBe(false);
    await settle();
    const said = errors.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('[instanceRollback]'));
    expect(said.some((m) => /could not rebuild/.test(m) && m.includes(root.guid!)), `names the tree: ${said.join(' | ')}`).toBe(true);
    expect(isUnsavableAfterRollback(), 'marked unsavable').toBe(true);
  }, 60_000);

  it('an undo step that throws part-way rolls back to the records the step found (a delete\'s undo)', async () => {
    const f = await startRun(be, async () => {}, 'throw-rollback-undo');
    await editedP1(f);
    const b = member(f, 'B').guid;
    deleteEntitiesWithUndo([member(f, 'B').id]);
    await settle();
    const after = store();
    expect(getAllEntities().find((x) => x.guid === b), 'premise: B deleted').toBeUndefined();
    const errors = vi.spyOn(console, 'error');
    armed.restoreSide = true;
    const r = await undoStep('undo');
    armed.restoreSide = false;
    await settle();
    expect(r.failed, 'premise: the undo threw part-way').toMatchObject({ refused: false });
    expect(errors.mock.calls.some((c) => /\[instanceRollback\] Undo "Delete Entity" threw part-way .*rolled back/.test(c.join(' '))), 'the rollback ran and finished').toBe(true);
    expect(store(), 'every record as the delete left them').toBe(after);
    expect(getAllEntities().find((x) => x.guid === b), 'B stays deleted: the scene as the step found it').toBeUndefined();
    expect(xOf(member(f, 'A').id), 'the earlier edit stays').toBe(44);
  }, 60_000);
});

// #2001 S8b review L2: the FIRST save over a tree with no record — the serialize finds it, marks the world, and throws —
// is answered as the mark too, not as a run mode. Mutation: answer the serialize's refusal as 'playing' again
// (serialize.ts's catch) — red here.
describe('a save that finds a tree with no record', () => {
  it('answers \'unsavable\' with the mark\'s words', async () => {
    const f = await startRun(be, async () => {}, 'save-recordless');
    dropInstanceRecord(getCurrentWorld(), p1(f).guid!);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveScene({ allowDialog: false });
    errors.mockRestore();
    expect(r).toMatchObject({ saved: false, reason: 'unsavable', error: NO_RECORD_TO_WRITE });
  }, 60_000);
});
