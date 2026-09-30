/** #1877 S4: a nested member's VALUE an OUTER prefab states in its legacy `nestedOverrides` beats what an INNER template
 *  states for the same field through a v6 member row. Unity: an override on an instance always wins over the asset it
 *  instances. Before the fix every layer's legacy values were merged into one map UNDER every layer's rows, so the inner
 *  row won, and the two writers that still put a nested value there lost it on the next load:
 *  - a prefab-edit save (`captureRowChannels` moves only structure onto rows);
 *  - an Apply that writes an override into an ENCLOSING prefab (`prefabApplyTargets.ts` `writeStated`).
 *
 *  The fuzzer's fixture (`prefabFuzz/harness.ts`): O's row N states `members['/gC/gM'].traits.Transform.y = 8` for the M
 *  it nests (O → R(N, a P) → QR(C, a Q) → M). H nests O once O is placed in H's prefab edit. Mutation for both cases:
 *  `foldStructureLayers` skips `layer.values` (`prefabOverrides.ts`) — M reloads at the inner row's 8. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, readTraitData } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, type Fixture } from './prefabFuzz/harness';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const ty = (id: number) => (readTraitData(id, getTraitByName('Transform')!) as { y: number }).y;
const under = (name: string, parentId: number) => authored().filter((e) => e.name === name && e.parentId === parentId);
/** M inside an O instance rooted at `or`: OR → R (row N) → QR (row C) → M. */
const mUnder = (or: number) => { const n = under('R', or)[0]!; const qr = under('QR', n.id)[0]!; return under('M', qr.id)[0]!; };
/** The scene's H instance (`HR`, placed by the fixture). */
const h1 = () => authored().find((e) => e.name === 'HR' && e.guid?.startsWith('ffffffff-0000-4000-8003-'))!;

/** In H's prefab edit, place an O under H's root; `y` set on its nested M before the save, when given. */
async function nestOInH(f: Fixture, y?: number): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
  const hr = authored().find((e) => e.name === 'HR' && !e.parentId)!;
  expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: hr.id })).toBeTruthy();
  await settle();
  const or = authored().find((e) => e.name === 'OR')!;
  expect(ty(mUnder(or.id).id)).toBe(8); // the inner row's value, before any edit
  if (y !== undefined) expect(writeTraitFieldWithUndo(mUnder(or.id).id, getTraitByName('Transform')!, 'y', y)).toBeFalsy();
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}

describe('#1877 S4: an outer prefab\'s legacy nested value beats an inner template\'s member row', () => {
  it('a prefab-edit save of the nested M.y: H reopened and the scene\'s H1 both show it', async () => {
    const f = await startRun(be, async () => {}, 'legacy-value-edit-save');
    await nestOInH(f, 3);
    // The writer still states it in legacy `nestedOverrides` (the shape this fix makes win): pinned, so a writer change
    // that moves it onto rows is seen here rather than silently making the case vacuous.
    const row = (JSON.parse(be.read(f.prefabs.H.path)!) as { entities: Array<{ prefab?: string; nestedOverrides?: unknown }> }).entities.find((e) => e.prefab);
    expect(row?.nestedOverrides).toBeDefined();
    expect(ty(mUnder(under('OR', h1().id)[0]!.id).id)).toBe(3);
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    expect(ty(mUnder(authored().find((e) => e.name === 'OR')!.id).id)).toBe(3);
    await exitPrefabEditing();
    await settle();
  });

  it('an Apply from the scene into the ENCLOSING prefab H (`writeStated`): H reopened shows it', async () => {
    const f = await startRun(be, async () => {}, 'legacy-value-apply-outer');
    await nestOInH(f);
    const m = mUnder(under('OR', h1().id)[0]!.id);
    expect(writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'y', 5)).toBeFalsy();
    await settle();
    const root = h1().id;
    await preloadNestedPrefabsForSubtree(root);
    const prefab = getCachedPrefabSync(piOf(root)!.source)!;
    const keys = collectInstanceOverrideKeys(root, prefab);
    const sel = new Set([...keys.nested].filter((k) => k.endsWith('.Transform.y')));
    expect(sel.size).toBe(1);
    // Into H itself: an override on H's row for the O it nests, three frames above M.
    const targets = { perKey: Object.fromEntries([...sel].map((k) => [k, f.prefabs.H.guid])) };
    const preview = await previewApply(root, new Set(sel), targets);
    const r = await applyToPrefabWithUndo(root, sel, targets, { expect: preview.fingerprint });
    expect(r.refused ?? null).toBeNull();
    expect(r.applied).toBe(true);
    await settle();
    expect(ty(mUnder(under('OR', h1().id)[0]!.id).id)).toBe(5);
    // Written where the fix matters, legacy `nestedOverrides` on H's row for O: pinned, as above.
    const row = (JSON.parse(be.read(f.prefabs.H.path)!) as { entities: Array<{ prefab?: string; nestedOverrides?: Record<string, unknown> }> }).entities.find((e) => e.prefab);
    expect(Object.keys(row?.nestedOverrides ?? {})).toEqual(['2.4']);
    // H read on its own (prefab edit), so no scene layer above it can supply the value: H's statement must win.
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    expect(ty(mUnder(authored().find((e) => e.name === 'OR')!.id).id)).toBe(5);
    await exitPrefabEditing();
    await settle();
  });
});
