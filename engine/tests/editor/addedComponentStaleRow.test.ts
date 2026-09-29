/** #1663 close-out review — an added component's ONE row, `+trait.<member>.<Component>`, is expanded by Apply into the
 *  component's field keys. A row listed while the member had the component, and applied after it lost it (an undo, with
 *  the dialog left open or an agent's `keys`), has no fields to expand into. Sent to an ENCLOSING prefab, the unexpanded
 *  row reached that level's `+trait.` write, which states a TAG: O's row gained `{Rotate3D: {}}`, and every O re-gained
 *  at defaults the component the user had just removed. It is skipped with the reason now, at every level.
 *
 *  Driven through the prefab fuzzer's harness, on its fixture: O1's N is a nested instance of P, B one of its members.
 *  Mutation: pass the unexpanded row on (the pre-fix `continue`) — O is written and B has Rotate3D again. */

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
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { addTraitToEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync, applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefab';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

describe("an added component's row applied after the component is gone (#1663 close-out review)", () => {
  it('sent to the enclosing prefab, it is SKIPPED with the reason: nothing written, and the component stays removed', async () => {
    const f = await startRun(be, async () => {}, 'stale-component-row');
    const rot = getTraitByName('Rotate3D')!;
    // O1's N: the P frame that is not the scene's own P1 (entry 2).
    const nRoot = () => authored().find((e) => piOf(e.id)?.rootInstanceId === e.id && piOf(e.id)?.source === f.prefabs.P.guid
      && !e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const b = authored().find((e) => e.name === 'B' && piOf(e.id)?.rootInstanceId === nRoot().id)!;
    expect(addTraitToEntitiesWithUndo([b.id], rot, { axis: 'x', speed: 3 })).toBeNull();
    await settle();
    const row = collectInstanceOverrideKeys(nRoot().id, getCachedPrefabSync(f.prefabs.P.guid)!).all
      .find((k) => k.startsWith('+trait.') && k.endsWith('.Rotate3D'))!;
    expect(row).toBeTruthy();
    expect((await undoStep('undo')).did).toBe(true); // the component comes off; the row was listed before
    await settle();
    const oBefore = be.read(f.prefabs.O.path);

    const r = await applyToPrefabSelective(nRoot().id, new Set([row]), { perKey: { [row]: f.prefabs.O.guid } });
    await settle();
    expect(r.applied).toBe(false);
    expect(r.skipped).toEqual([{ key: row, reason: 'the member no longer has Rotate3D' }]);
    expect(be.read(f.prefabs.O.path)).toBe(oBefore);
    expect(findEntityByGuid(b.guid!)?.has(rot.trait)).toBe(false);
  }, 120_000);
});
