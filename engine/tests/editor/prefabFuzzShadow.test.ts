/** #2009: the fuzzer's checks against the #2001 instance model, P1 and I25 (`prefabFuzz/shadow.ts`), held to both sides
 *  BEFORE the model exists. Nothing implements the store, the parser or the projection yet (S1 landed its types only), so
 *  each check runs here through FAKE seams: a fake door that records what the capture reads and one that misses a write, a
 *  fake reprojection that is the identity and one that is not. Each check must pass on the first and fail on the second;
 *  a check that cannot fail on a broken model guards nothing (docs/falsifiable-tests.md).
 *
 *  The fake capture reads an instance root's MARKED fields off the live world (today's override marks), into the `"/"`
 *  row — fresh objects on every call, as a real `parse(captureInstanceEntry(live))` builds them. */

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
import { installShadow, listDiff, liveStoredRoots, type ShadowSeams } from './prefabFuzz/shadow';
import type { Op } from './prefabFuzz/ops';
import { readTraitData, findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
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

/** The fake capture: the root's marked fields, read off the live world into the `"/"` row. */
function captureList(rootGuid: string): OverrideList | null {
  const ent = findEntityByGuid(rootGuid);
  if (!ent) return null;
  const traits: Record<string, Record<string, unknown>> = {};
  for (const m of [...(getOverrideMarkSet(ent as never) ?? [])].sort()) {
    const [trait, field] = m.split('.') as [string, string];
    const meta = getTraitByName(trait);
    const data = meta ? readTraitData(ent.id(), meta) as Record<string, unknown> | null : null;
    if (data) (traits[trait] ??= {})[field] = data[field];
  }
  return list({ '/': Object.keys(traits).length ? { guid: rootGuid, traits } : { guid: rootGuid } });
}

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

describe('#2009 I25 (the shadow): a record equals the capture, modulo identity pins, after an op whose door exists', () => {
  it('listDiff: pins are not overrides, a pins-only row is no record, and a value, a row or own order is a difference', () => {
    const a = list({ '/': { guid: 'g1', name: 'A', traits: { Transform: { x: 1 } } }, '/n1': { guid: 'g2' } });
    expect(listDiff(a, list({ '/': { guid: 'other', traits: { Transform: { x: 1 } } } }))).toBeNull();
    expect(listDiff(a, list({ '/': { traits: { Transform: { x: 2 } } } }))).toMatch(/Transform/);
    expect(listDiff(a, list({ '/': { traits: { Transform: { x: 1 } } }, '/n2': { removed: true } }))).toMatch(/n2/);
    const own = (...g: string[]) => list({ '/': { own: g.map((guid) => ({ guid })) } });
    expect(listDiff(own('a', 'b'), own('a', 'b'))).toBeNull();
    expect(listDiff(own('a', 'b'), own('b', 'a'))).not.toBeNull();
  });

  it('listDiff refuses to compare a record with itself (§ 10.5): the same list, or a row the store owns', () => {
    const a = list({ '/': { traits: { Transform: { x: 1 } } } });
    expect(() => listDiff(a, a)).toThrow(/compared the record with itself/);
    expect(() => listDiff(a, { rows: new Map([['/', a.rows.get('/')!]]) })).toThrow(/row \/ is the store's own object/);
  });

  it('a door that records what the capture reads passes; one that missed the write fails; an op with no door is not compared', async () => {
    // The good door: the store holds what the capture read when the op landed (a copy, never the capture's own object).
    const good: ShadowSeams = { records: () => liveRoots().map((g) => record(g, structuredClone(captureList(g)!))), captureList, doors: new Set(['copy', 'editField']) };
    const ok = await run(good, [copyAny, editRoot]);
    expect(ok.failure, ok.failure ? `${ok.failure.check}: ${ok.failure.detail}` : '').toBeUndefined();
    expect(ok.counted).toEqual(expect.arrayContaining(['I25 after copy', 'I25 after editField']));

    // The broken door: the store froze at the first op and missed the edit. Red, on the root, naming the field.
    let frozen: readonly InstanceRecord[] | null = null;
    const missed: ShadowSeams = { records: () => (frozen ??= good.records()), captureList, doors: new Set(['copy', 'editField']) };
    const bad = await run(missed, [copyAny, editRoot]);
    expect(bad.failure?.check).toBe('I25 the record is not the capture');
    expect(bad.failure?.op).toMatch(/^editField/);
    expect(bad.failure?.detail).toMatch(/Transform/);

    // The same gap after an op with no door yet is the step's known gap: not compared, and counted as such.
    frozen = null;
    const noDoor = await run({ ...missed, doors: new Set(['copy']) }, [copyAny, editRoot]);
    expect(noDoor.failure, noDoor.failure ? `${noDoor.failure.check}: ${noDoor.failure.detail}` : '').toBeUndefined();
    expect(noDoor.counted).toContain('I25 after editField: not compared (no door yet)');
  }, 60_000);

  it('a store that lacks a live stored instance fails, rather than comparing nothing and counting it as run', async () => {
    expect(liveStoredRoots().length).toBeGreaterThan(0);
    const empty = await run({ records: () => [], captureList, reproject: () => {}, doors: new Set(['copy']) }, [copyAny]);
    expect(empty.failure?.check).toBe('a live stored instance has no record');
    const oneShort = await run({ records: () => liveStoredRoots().slice(1).map((g) => record(g, structuredClone(captureList(g)!))), captureList, doors: new Set(['copy']) }, [copyAny]);
    expect(oneShort.failure?.check).toBe('a live stored instance has no record');
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

  it('a capture that returns the store\'s own list fails the step as a harness error, not a pass', async () => {
    const store = new Map<string, OverrideList>();
    const seams: ShadowSeams = {
      records: () => liveRoots().map((g) => record(g, store.get(g) ?? store.set(g, captureList(g)!).get(g)!)),
      captureList: (g) => store.get(g) ?? null,
      doors: new Set(['copy']),
    };
    const r = await run(seams, [copyAny]);
    expect(r.failure?.check).toBe('shadow check threw');
    expect(r.failure?.detail).toMatch(/compared the record with itself/);
  }, 60_000);
});

describe('#2009 P1: reprojecting every record leaves the world as it was', () => {
  it('an identity reprojection passes and is counted; one that moves a root fails, naming the field', async () => {
    const records = () => liveRoots().map((g) => record(g, list({})));
    const ok = await run({ records, reproject: () => {}, doors: new Set() }, [copyAny]);
    expect(ok.failure, ok.failure ? `${ok.failure.check}: ${ok.failure.detail}` : '').toBeUndefined();
    expect(ok.counted).toContain('P1');

    // Not a function of the record: the projection writes something the record does not say.
    const drift = (rec: InstanceRecord) => { const e = findEntityByGuid(rec.rootGuid); if (e) writeTraitField(e.id(), getTraitByName('Transform')!, 'y', 42); };
    const bad = await run({ records, reproject: drift, doors: new Set() }, [copyAny]);
    expect(bad.failure?.check).toBe('P1 reprojecting the records changed the world');
    expect(bad.failure?.detail).toMatch(/Transform\/y/);
  }, 60_000);

  it('with no seam installed neither check runs, and nothing is counted for them', async () => {
    const before = new Map(checksRun);
    const r = await runOps(be, [copyAny, editRoot], STRICT);
    expect(r.failure).toBeUndefined();
    // P1 by the FOLD needs no seam (S1's parser and S2's fold are real), so it runs; the seam checks do not.
    const grew = [...checksRun].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
    expect(grew.filter((k) => /^(I25|P1|shadow)/.test(k) && !k.startsWith('P1 by the fold'))).toEqual([]);
    expect(grew).toContain('P1 by the fold');
    expect(grew).toContain('P1 by the fold: a scene-added reference node');
  }, 60_000);
});
