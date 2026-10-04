/** #2009: the fuzzer's checks against the #2001 instance model (`prefabFuzz/shadow.ts`): the store's coverage and P1,
 *  held to both sides through FAKE seams: a store that covers every live stored root and one that lacks one, a fake
 *  projection that is the live instance and one that is not. Each check must pass on the first and fail on the second;
 *  a check that cannot fail on a broken model guards nothing (docs/falsifiable-tests.md). (I25's cases went with I25,
 *  #2001 S8b.) */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, writeTraitField } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, authored, piOf } from './prefabFuzz/harness';
import { markUnresolved } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { setTemplateKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { runOps, checksRun, consoleErrors, foldCheck } from './prefabFuzz/runner';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { installShadow, liveStoredRoots, type ShadowSeams } from './prefabFuzz/shadow';
import type { Op } from './prefabFuzz/ops';
import { readTraitData, findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import type { InstanceRecord, OverrideList, SceneTargetRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); });
for (const k of ['log', 'warn', 'info', 'debug'] as const) vi.spyOn(console, k).mockImplementation(() => {});
const STRICT = { expectedError: () => false };

afterEach(() => installShadow(null));

const list = (rows: Record<string, SceneTargetRecord>): OverrideList => ({ rows: new Map(Object.entries(rows)) });
const record = (rootGuid: string, l: OverrideList): InstanceRecord => ({ rootGuid, source: '', placement: { parent: '', sortOrder: 0, name: '' }, list: l, held: {} });

const liveRoots = liveStoredRoots;

/** An Inspector edit of Transform.x on the FIRST entity with a Transform (the O1 instance root, loaded first). */
const editRoot: Op = { kind: 'editField', u: [0, 0, 0.9, 0, 0, 0, 0, 0] };
const copyAny: Op = { kind: 'copy', u: [0, 0, 0, 0, 0, 0, 0, 0] };

/** A run with the seams installed, its failure and what the checks counted. */
async function run(seams: ShadowSeams, ops: Op[]) {
  const before = new Map(checksRun);
  installShadow(seams);
  const r = await runOps(be, ops, STRICT);
  installShadow(null);
  const counted = [...checksRun].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k).sort();
  return { failure: r.failure, counted, trace: r.trace };
}

describe('#2009: the store covers every live stored root', () => {
  it('a store that lacks a live stored instance fails, rather than comparing nothing and counting it as run', async () => {
    const empty = await run({ records: () => [], project: async () => undefined }, [copyAny]);
    expect(empty.failure?.check).toBe('a live stored instance has no record');
    expect(liveStoredRoots().length).toBeGreaterThan(0);
    const oneShort = await run({ records: () => liveStoredRoots().slice(1).map((g) => record(g, list({}))) }, [copyAny]);
    expect(oneShort.failure?.check).toBe('a live stored instance has no record');
    const all = await run({ records: () => liveStoredRoots().map((g) => record(g, list({}))) }, [copyAny]);
    expect(all.failure, all.failure ? `${all.failure.check}: ${all.failure.detail}` : '').toBeUndefined();
    expect(all.counted).toContain('shadow: the store covers every live stored root');
  }, 60_000);

  it('a template-added reference node\'s root owns no record (hub, 2026-10-02): the store need not cover it', async () => {
    expect((await runOps(be, [copyAny], STRICT)).failure).toBeUndefined();
    const root = authored().find((e) => { const pi = piOf(e.id); return !!pi && pi.rootInstanceId === e.id && !!e.guid; })!;
    expect(liveStoredRoots()).toContain(root.guid);
    setTemplateKey(findEntity(root.id) as never, 'k-ref');
    expect(liveStoredRoots()).not.toContain(root.guid);
  }, 60_000);

  it('a Missing Prefab placeholder is a stored root the store must cover, though it carries no PrefabInstance (rule 9)', async () => {
    expect((await runOps(be, [copyAny], STRICT)).failure).toBeUndefined();
    const plain = authored().find((e) => e.name === 'Plain')!;
    expect(liveStoredRoots()).not.toContain(plain.guid);
    markUnresolved(findEntity(plain.id) as never, 'cccccccc-0000-4000-8000-000000000000', 'entry', {});
    expect(liveStoredRoots()).toContain(plain.guid);
    // One a TEMPLATE supplies (it carries a template key) is the template's, not a stored root of the scene's.
    const leaf = authored().find((e) => e.name === 'Leaf')!;
    markUnresolved(findEntity(leaf.id) as never, 'cccccccc-0000-4000-8000-000000000000', 'node', {});
    setTemplateKey(findEntity(leaf.id) as never, 'k1');
    expect(liveStoredRoots()).not.toContain(leaf.guid);
  }, 60_000);

  // P1 by the FOLD (runner.ts `foldCheck`) needs no seam: S1's parser and S2's fold are real. Its red side is a live edit
  // the saved entry does not state — an unmarked write to a member, the shape of a capture that drops an edit.
  it('P1 by the fold: the live world is the fold of what the save states, and a live edit the save drops fails it', async () => {
    expect((await runOps(be, [copyAny], STRICT)).failure).toBeUndefined();
    expect(foldCheck(be, await serializeScene() as never)).toEqual([]);
    const member = authored().find((e) => { const pi = piOf(e.id); return !!pi && pi.rootInstanceId !== e.id; })!;
    writeTraitField(member.id, getTraitByName('Transform')!, 'x', 123.5);
    expect(foldCheck(be, await serializeScene() as never).map((f) => f.check)).toEqual(['P1 the live instance is not the fold of its record']);
    // Every instance is reported, not the first: a waiver tolerates one instance's failure and must not hide another's.
    const byId = new Map(authored().map((e) => [e.id, e]));
    const top = (id: number): number => { let e = byId.get(id)!; while (e.parentId && byId.has(e.parentId)) e = byId.get(e.parentId)!; return e.id; };
    const other = authored().find((e) => { const pi = piOf(e.id); return !!pi && pi.rootInstanceId !== e.id && top(e.id) !== top(member.id); })!;
    writeTraitField(other.id, getTraitByName('Transform')!, 'x', 77.5);
    expect(foldCheck(be, await serializeScene() as never).length).toBe(2);
  }, 60_000);

});

describe('#2009 P1: each record\'s projection is its live instance', () => {
  /** The live root's Transform, as a one-entity tree keyed by guid. */
  const tree = (rec: InstanceRecord): Record<string, unknown> => {
    const e = findEntityByGuid(rec.rootGuid);
    return { [rec.rootGuid]: { traits: { Transform: e ? readTraitData(e.id(), getTraitByName('Transform')!) : null } } };
  };
  it('a projection that is the live instance passes and is counted; one that moves a root fails, naming the field', async () => {
    const records = () => liveRoots().map((g) => record(g, list({})));
    const ok = await run({ records, project: async (rec) => ({ live: tree(rec), projected: tree(rec) }) }, [copyAny]);
    expect(ok.failure, ok.failure ? `${ok.failure.check}: ${ok.failure.detail}` : '').toBeUndefined();
    expect(ok.counted).toContain('P1');

    // Not a function of the record: the projection states something the live instance does not.
    const drift = async (rec: InstanceRecord) => {
      const live = tree(rec);
      const projected = structuredClone(live) as Record<string, { traits: { Transform: Record<string, unknown> } }>;
      projected[rec.rootGuid]!.traits.Transform.y = 42;
      return { live, projected };
    };
    const bad = await run({ records, project: drift }, [copyAny]);
    expect(bad.failure?.check).toBe('P1 the projection of a record is not its live instance');
    expect(bad.failure?.detail).toMatch(/Transform\/y/);
  }, 60_000);

  it('a record the seam does not compare is counted under its reason, and a nested one (with its owner) not at all', async () => {
    const records = () => liveRoots().map((g) => record(g, list({})));
    const skipped = await run({ records, project: async () => ({ skip: 'stale (test)' }) }, [copyAny]);
    expect(skipped.failure).toBeUndefined();
    expect(skipped.counted).toContain('P1 not compared: stale (test)');
    expect(skipped.counted).not.toContain('P1');
    const nested = await run({ records, project: async () => undefined }, [copyAny]);
    expect(nested.counted.filter((k) => k.startsWith('P1') && !k.startsWith('P1 by the fold'))).toEqual([]);
  }, 60_000);

  it('with no seam installed neither check runs, and nothing is counted for them', async () => {
    const before = new Map(checksRun);
    const r = await runOps(be, [copyAny, editRoot], STRICT);
    expect(r.failure).toBeUndefined();
    // P1 by the FOLD needs no seam (S1's parser and S2's fold are real), so it runs; the seam checks do not.
    const grew = [...checksRun].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
    expect(grew.filter((k) => /^(P1|shadow)/.test(k) && !k.startsWith('P1 by the fold'))).toEqual([]);
    expect(grew).toContain('P1 by the fold');
    expect(grew).toContain('P1 by the fold: a scene-added reference node');
  }, 60_000);
});
