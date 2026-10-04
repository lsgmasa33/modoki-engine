/** The AGENT `prefab` apply's `keys` is ALL-or-nothing for a key the template cannot express too (#1912). A moved member
 *  (`~moved.…`, #1437) is listed by `overrides` but never written, and an apply naming it beside a writable key used to
 *  write the rest and answer ok:true with it in `notWritten`. Driven the way production drives it: `runAgentOp` on the
 *  registered editor ops; the prefab write is captured. Each case names the mutation that turns it red. */

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
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';

import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { place, setFields } from '../../packages/modoki/src/editor/instance/instanceEdits';

registerAllTraits();
registerEditorAgentOps();

const P = 'dddddddd-0000-4000-8000-000000001912';
const G = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A, R → B. */
const pDoc = { id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, G(1)), row(2, 'A', 1, G(2)), row(3, 'B', 1, G(3))] };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  writes.length = 0;
  registerAsset(P, '/assets/prefabs/P.prefab.json', 'prefab');
  setPrefabCache(P, pDoc as never);
});
afterEach(() => { game?.dispose(); game = undefined; setPrefabCache(P, null); });

/** A P instance whose A is moved under B (an override Apply cannot write) and whose B has x = 5 (one it can). */
function instance(): { guid: string } {
  const root = instantiatePrefab(pDoc as never, 0);
  setPrefabSource(root, { id: P });
  const byName = (n: string) => getAllEntities().find((e) => e.name === n)!.id;
  const ea = getTraitByName('EntityAttributes')!;
  // The guid the test addresses, then the record under it (the store is keyed by the root's guid).
  writeTraitField(root, ea, 'guid', 'g-p-root');
  place(root);
  // A move is read against the new parent's DURABLE guid (`memberRowParents`), so B gets one.
  writeTraitField(byName('B'), ea, 'guid', G(13));
  writeTraitField(byName('A'), ea, 'parentId', byName('B'));
  writeTraitField(byName('B'), getTraitByName('Transform')!, 'x', 5);
  setFields(findEntity(byName('B'))!.id(), 'Transform', ['x']);
  return { guid: 'g-p-root' };
}

type Overrides = { keys: { all: string[] } };
async function keysOf(guid: string): Promise<{ moved: string; field: string }> {
  const all = (await runAgentOp('prefab', { action: 'overrides', entityGuid: guid }) as Overrides).keys.all;
  const moved = all.find((k) => k.startsWith('~moved.'));
  const field = all.find((k) => k.endsWith('.Transform.x'));
  if (!moved || !field) throw new Error(`fixture: expected a moved key and a Transform.x key, got ${JSON.stringify(all)}`);
  return { moved, field };
}

describe('prefab apply `keys` is ALL-or-nothing for a key the template cannot express (#1912)', () => {
  // Mutation: delete the `if (p.keys && !p.dryRun)` pre-flight — B's x is written and the call resolves ok:true.
  it('naming a moved member beside a writable key refuses the whole call, and NOTHING is written', async () => {
    const { guid } = instance();
    const { moved, field } = await keysOf(guid);
    const err = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [moved, field] }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP', options: [`keys:${JSON.stringify([field])}`] });
    expect((err as Error).message).toContain(`1 requested key(s) cannot be written into the prefab — ${moved} (`);
    expect((err as Error).message).toContain('NOTHING was applied');
    expect(writes).toEqual([]);
  });

  // Second close-out review: a per-key `targets` entry for the dropped key is refused as a stray once the key is gone, so
  // an offered `keys:[rest]` was refused again. Mutation: drop `&& !strayTargets.length` — the option comes back.
  it('with a `targets` entry for the unwritable key, it offers no `keys` option and says to drop it from `targets` too', async () => {
    const { guid } = instance();
    const { moved, field } = await keysOf(guid);
    const err = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [moved, field], targets: { [moved]: 'instance' } })
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
    expect((err as { options?: unknown }).options).toBeUndefined();
    expect((err as Error).message).toContain('Drop them from `keys` and from `targets` to apply the rest');
    expect(writes).toEqual([]);
  });

  // Third close-out review: the `targets` entry spells the same key by localId (A is row 2). Mutation: match `targets` by
  // exact string again (`k in p.targets`) — the option comes back, and following it is refused as a stray target.
  it('a `targets` entry spelling the unwritable key by localId withholds the option too', async () => {
    const { guid } = instance();
    const { moved, field } = await keysOf(guid);
    const err = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [moved, field], targets: { '~moved.2': 'instance' } })
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
    expect((err as { options?: unknown }).options).toBeUndefined();
    expect((err as Error).message).toContain('and from `targets`');
    expect(writes).toEqual([]);
  });

  // Mutation: restore the unconditional "Drop them from `keys` to apply the rest" — dropping them leaves an empty `keys`,
  // which is refused as AMBIGUOUS.
  it('naming ONLY the unwritable key says there is nothing left to apply, not "apply the rest"', async () => {
    const { guid } = instance();
    const { moved } = await keysOf(guid);
    const err = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [moved] }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
    expect((err as Error).message).toContain('there is nothing left to apply');
    expect((err as { options?: unknown }).options).toBeUndefined();
    expect(writes).toEqual([]);
  });

  // The accept side: the writable key alone still applies. Mutation: make the pre-flight refuse on any `keys` (drop
  // the `unwritable.length` test) — this refuses too.
  it('the writable key alone applies and is written', async () => {
    const { guid } = instance();
    const { field } = await keysOf(guid);
    const r = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [field] }) as { ok: boolean; appliedKeys: string[] };
    expect(r).toMatchObject({ ok: true, appliedKeys: [field] });
    expect(writes).toEqual(['/assets/prefabs/P.prefab.json']);
  });

  // A dry run is exempt: it writes nothing, and `notWritten` is its answer. Mutation: drop `!p.dryRun` from the
  // pre-flight — the preview is refused instead of answered.
  it('a dry run naming the moved member answers it under notWritten', async () => {
    const { guid } = instance();
    const { moved, field } = await keysOf(guid);
    const r = await runAgentOp('prefab', { action: 'apply', entityGuid: guid, keys: [moved, field], dryRun: true }) as { ok: boolean; notWritten?: Array<{ key: string }> };
    expect(r.ok).toBe(true);
    expect(r.notWritten?.map((x) => x.key)).toEqual([moved]);
    expect(writes).toEqual([]);
  });

  // Omitted keys is the documented partial form ("act on all"): the rest is written, the move reported. Mutation:
  // make the pre-flight fire whenever the plan skips a key (drop `p.keys &&`) — this refuses.
  it('an omitted-keys apply writes the rest and names the move under skippedKeys and notWritten', async () => {
    const { guid } = instance();
    const { moved, field } = await keysOf(guid);
    const r = await runAgentOp('prefab', { action: 'apply', entityGuid: guid }) as { ok: boolean; appliedKeys: string[]; skippedKeys?: string[]; notWritten?: Array<{ key: string }> };
    expect(r).toMatchObject({ ok: true, appliedKeys: [field], skippedKeys: [moved] });
    expect(r.notWritten?.map((x) => x.key)).toEqual([moved]);
    expect(writes).toEqual(['/assets/prefabs/P.prefab.json']);
  });
});
