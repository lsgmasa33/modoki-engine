/** #2125: a prefab v10 reference row states its nested instance's root on a `"/"` row (the root's name always, as a
 *  default override, design § 10.4). Prefab edit loads the edited document as a scene stamped in the CAPTURE form
 *  (v19), and the settle stripped the `"/"` row only for a v20 file, so it judged `"/"` as a member row naming no node:
 *  one false "names no node the template still declares" warning per nested row on every open (58 on Court's
 *  daily-month), and the row kept as an orphan that the save then wrote back OVER the edit world's own root value.
 *
 *  Through the real backend, SceneManager, both caches and prefab edit, on the fuzzer's fixture: O's row N expands P. */
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
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher } from './prefabFuzz/harness';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

type Row = { localId: number; members?: Record<string, { traits?: Record<string, Record<string, unknown>> }> };
const rowN = (bytes: string) => (JSON.parse(bytes) as { entities: Row[] }).entities.find((e) => e.localId === 2)!;
const ORPHAN_WARNING = /names? no node the template still declares/;

async function open(path: string): Promise<string[]> {
  const warn = vi.spyOn(console, 'warn');
  try {
    expect(await openPrefabForEditing({ path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
    await settle();
    return warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => ORPHAN_WARNING.test(l));
  } finally {
    warn.mockRestore();
  }
}
async function saveAndExit(): Promise<void> {
  const report = await savePrefabEditReport({});
  expect(report.saved, JSON.stringify(report)).toBe(true);
  await exitPrefabEditing();
  await settle();
}

describe('#2125: a v10 row\'s "/" row in prefab edit', () => {
  it('opens with no false orphan warning, and a save keeps the edit world\'s root value over the row\'s old one', async () => {
    const f = await startRun(be, async () => {}, 'v10-root-row');
    // Convert O to v10 with one prefab-edit save, then give N's "/" row a value of its own.
    await open(f.prefabs.O.path);
    await saveAndExit();
    const doc = JSON.parse(be.read(f.prefabs.O.path)!) as { version: number; entities: Row[] };
    const n = doc.entities.find((e) => e.localId === 2)!;
    expect(n.members, 'premise: the row is in the v10 form').toBeTruthy();
    const rootRow = n.members!['/'] ?? {};
    n.members!['/'] = { ...rootRow, traits: { ...rootRow.traits, Transform: { ...rootRow.traits?.Transform, x: 5 } } };
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(doc, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();

    expect(await open(f.prefabs.O.path)).toEqual([]);
    const or = authored().find((e) => e.name === 'OR')!;
    const root = authored().find((e) => e.name === 'R' && e.parentId === or.id)!;
    expect(root, 'the nested root is live').toBeTruthy();
    expect(writeTraitFieldWithUndo(root.id, getTraitByName('Transform')!, 'x', 7)).toBeNull();
    await saveAndExit();
    expect(rowN(be.read(f.prefabs.O.path)!).members?.['/']?.traits?.Transform?.x).toBe(7);
  }, 60_000);
});
