/** The AGENT `prefab` op renders the Apply PLAN's per-key effects (#1736): `overrides` answers each key's effect at its
 *  default from one dry run of that Apply, `apply {dryRun:true}` answers what an Apply would do without writing, and a
 *  conflict (#1727: two frames of one prefab writing one field of it) is refused whole with both keys named. Driven the
 *  way production drives it: `runAgentOp` on the registered editor ops. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const writes = vi.hoisted(() => [] as string[]);
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string) => { writes.push(path); return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response; },
}));

import {
  createTestWorld, type TestWorld, setPlayState, getTraitByName, writeTraitField, findEntity, getAllEntities,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { setPrefabCache, instantiatePrefab, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefab';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const P = 'dddddddd-0000-4000-8000-000000001736';
const O = 'dddddddd-0000-4000-8000-000000001737';
const G = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const ref = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, prefab: P, traits: { EntityAttributes: { name, parentId, guid: '' } },
});
/** P: R → A. O: OR → Slot → N (P), OR → Slot2 → N2 (P). */
const pDoc = { id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, G(1)), row(2, 'A', 1, G(2))] };
const oDoc = { id: O, version: 6, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, G(3)), row(2, 'Slot', 1, G(4)), row(3, 'Slot2', 1, G(5)), ref(4, 'N', 2, G(6)), ref(5, 'N2', 3, G(7)),
] };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  writes.length = 0;
  registerAsset(P, '/assets/prefabs/P.prefab.json', 'prefab');
  registerAsset(O, '/assets/prefabs/O.prefab.json', 'prefab');
  setPrefabCache(P, pDoc as never);
  setPrefabCache(O, oDoc as never);
});
afterEach(() => { game?.dispose(); game = undefined; setPrefabCache(P, null); setPrefabCache(O, null); });

/** An O instance whose A under Slot has x = `x1` and whose A under Slot2 has x = `x2`, both marked. */
function instance(x1: number, x2: number): string {
  const root = instantiatePrefab(oDoc as never, 0);
  setPrefabSource(root, O);
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const aUnder = (slot: string) => all.find((e) => {
    if (e.name !== 'A') return false;
    for (let c = byId.get(e.parentId); c; c = byId.get(c.parentId)) if (c.name === slot) return true;
    return false;
  })!.id;
  const tf = getTraitByName('Transform')!;
  for (const [slot, x] of [['Slot', x1], ['Slot2', x2]] as const) {
    writeTraitField(aUnder(slot), tf, 'x', x);
    markOverride(findEntity(aUnder(slot))!, 'Transform', 'x');
  }
  writeTraitField(root, getTraitByName('EntityAttributes')!, 'guid', 'g-o-root');
  return 'g-o-root';
}

describe('agent prefab op renders the Apply plan (#1736)', () => {
  it('`overrides` answers each key\'s effect at its default, and `apply {dryRun, target:"frame"}` the conflict — nothing written', async () => {
    // Mutation: drop `effects` from the `overrides` answer — the caller cannot see what applying each key does.
    const guid = instance(5, 9);
    const ov = await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as {
      keys: { nested: string[] }; effects: Record<string, { op: string; effect: string }>; conflicts?: unknown[];
      targets: Record<string, { options: Array<Record<string, unknown>> }>;
    };
    expect(ov.keys.nested).toHaveLength(2);
    for (const k of ov.keys.nested) {
      expect(ov.effects[k]).toMatchObject({ op: 'setField', effect: expect.stringMatching(/as an override in Prefab 'O'$/) }); // U14's default: an override on O's row
      expect(Object.keys(ov.targets[k]!.options[0]!).sort()).toEqual(['name', 'target']);
    }
    expect(ov.conflicts).toBeUndefined(); // two rows of O are two slots
    const dry = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, target: 'frame', dryRun: true }) as {
      dryRun: boolean; effects: Array<{ op: string; effect: string }>; conflicts?: Array<{ keys: unknown[] }>;
    };
    expect(dry.dryRun).toBe(true);
    expect(dry.effects.map((e) => e.op)).toEqual(['conflict', 'conflict']);
    expect(dry.conflicts?.[0]?.keys).toHaveLength(2);
    expect(writes).toEqual([]);
  });

  it('`apply` of that conflict is REFUSED whole, naming both keys — never a silent last-write-wins', async () => {
    // Mutation: drop the conflicts check in `applyToPrefabSelective` — the Apply writes P with A.x = 9.
    const guid = instance(5, 9);
    await expect(runAgentOp('prefab', { action: 'apply', entityGuid: guid, target: 'frame' }))
      .rejects.toMatchObject({ code: 'REFUSED_BY_OP', options: expect.arrayContaining([expect.stringContaining(':')]) });
    expect(writes).toEqual([]);
  });

  it('a clean `apply` answers each key\'s effect, worded as the dialog words it', async () => {
    // Mutation: drop `effects` from the `apply` answer.
    const guid = instance(5, 5);
    const res = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, target: 'frame' }) as {
      ok: boolean; effects: Array<{ op: string; effect: string; target: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.effects.map((e) => [e.op, e.target])).toEqual([['setField', P], ['setField', P]]);
    expect(res.effects[0]!.effect).toBe('A · Transform.x → 5 in Prefab \'P\'');
  });
});
