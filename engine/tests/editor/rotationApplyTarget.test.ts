/** #1880 close-out re-review 2: one rotation axis selected is the whole rotation (F5, `toLocalIdKeys`), and the two axes
 *  it brings along answer to the axis the caller NAMED — its per-key target is theirs. Before, they fell to the default
 *  level: an Apply of A's rx to the ENCLOSING prefab O wrote ry and rz into P's template, changing every P in the project.
 *  Driven through the prefab fuzzer's harness, on its fixture: O1's N is a nested instance of P, A one of its members.
 *  Mutation: map a sibling's `original` to its own spelling (the first version) — P is written. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf } from './prefabFuzz/harness';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

describe('one rotation axis applied with a per-key target takes the whole rotation THERE (#1880 close-out re-review 2)', () => {
  it('an Apply of A\'s rx to O writes rx, ry and rz into O\'s row, and nothing into P', async () => {
    const f = await startRun(be, async () => {}, 'rotation-apply-target');
    const nRoot = () => authored().find((e) => piOf(e.id)?.rootInstanceId === e.id && piOf(e.id)?.source === f.prefabs.P.guid
      && !e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const a = authored().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === nRoot().id)!;
    const tf = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(a.id, tf, 'rx', 0.5); // the door: it records the override (#2001 S8b, the listing reads the record)
    await settle();
    const rx = collectInstanceOverrideKeys(nRoot().id, getCachedPrefabSync(f.prefabs.P.guid)!).all
      .find((k) => k.endsWith('.Transform.rx'))!;
    expect(rx, 'premise: the listing offers A\'s rx').toBeTruthy();
    const pBefore = be.read(f.prefabs.P.path);
    const r = await applyToPrefabSelective(nRoot().id, new Set([rx]), { perKey: { [rx]: f.prefabs.O.guid } });
    await settle();
    expect(r.applied).toBe(true);
    expect(be.read(f.prefabs.P.path)).toBe(pBefore);
    const o = be.read(f.prefabs.O.path)!;
    for (const axis of ['"rx"', '"ry"', '"rz"']) expect(o).toContain(axis);
  }, 120_000);
});
