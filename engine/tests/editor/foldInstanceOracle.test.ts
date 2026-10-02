/** The #2007 oracle (#2001 S2): `foldInstance(parse(entry))` is what `instantiatePrefabIntoWorld` spawns today.
 *
 *  For every corpus scene holding a prefab instance, the scene loads through today's path (the SceneManager callback's
 *  root patches included), and each top-level instance's live tree is read back by the keys the fold uses: a member by
 *  its member row key (`memberRowKeysIn`), a template-added node by its frame's key plus `/a+<key>`, a scene-owned node
 *  by the anchor it hangs at. The fold of the same entry must produce the same keys, the same parents, the same
 *  components and every field it states with the value the live entity holds.
 *
 *  A divergence is not forced to match: it is triaged against the rules (docs/prefabs.md § High-level rules). Where a
 *  rule CHANGES what the user sees, `foldOracle.ts` applies that change to today's tree first; everything else fails. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createWorld } from 'koota';
import { readFileSync, writeFileSync } from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getTraitByName, setRunMode, loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearKeptMemberOrphans, type SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import type { PrefabDoc, PrefabReader } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import { memberIdentities } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { memberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
import { parseSteps } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { checkInstance, seen } from './foldOracle';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const corpus = (repoFiles({ under: ['games', 'demos'], match: (rel: string) => /\/runtime\/assets\/.*\.(scene|prefab)\.json$/.test(rel), exclude: ['node_modules', 'dist', 'ios', 'android', 'build'], floor: 0 }) as Array<{ rel: string; abs: string }>);
const projectOf = (rel: string) => rel.split('/').slice(0, 2).join('/');
const readJson = (abs: string) => JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
const projects = [...new Set(corpus.map((f) => projectOf(f.rel)))].map((id) => {
  const files = corpus.filter((f) => projectOf(f.rel) === id);
  return {
    id,
    prefabFiles: files.filter((f) => f.rel.endsWith('.prefab.json')).map((f) => f.abs),
    scenes: files.filter((f) => f.rel.endsWith('.scene.json') && /"prefab":\s*"/.test(readFileSync(f.abs, 'utf8'))),
  };
}).filter((p) => p.scenes.length);

beforeAll(() => setRunMode('stopped'));
afterAll(() => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  getCurrentWorld()?.destroy();
});

const installProject = (prefabFiles: string[]) => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  prefabs.clear();
  for (const f of prefabFiles) {
    const doc = readJson(f) as { id?: string };
    if (!doc.id) continue;
    prefabs.set(doc.id, doc);
    setPrefabCache(doc.id, doc as never);
  }
};
const reader: PrefabReader = (g) => (prefabs.has(g) ? { doc: prefabs.get(g) as PrefabDoc } : { missing: true });

/** Today's load, through SceneManager's `onInstantiatePrefab` (root guid, editor folder, root extra traits). */
async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  clearKeptMemberOrphans();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, rootExtraTraits, overrides, structure, nested, rootGuid, rootEditorFolder, nestedStructure, ld) => {
      const read = (ld as { read?: (g: string) => unknown } | undefined)?.read;
      const cached = (read ?? ((g: string) => prefabs.get(g)))(source);
      if (!cached) return undefined;
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), cached as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
        { read, frame: (ld as { frame?: unknown } | undefined)?.frame } as never,
      );
      const root = id ? [...getCurrentWorld().entities].find((e) => e.id() === id) : undefined;
      if (!root) return id ?? undefined;
      if (rootGuid || rootEditorFolder) {
        root.set(eaMeta.trait, { ...(root.get(eaMeta.trait) as object), ...(rootGuid ? { guid: rootGuid } : {}), ...(rootEditorFolder ? { editorFolder: rootEditorFolder } : {}) });
      }
      for (const [name, data] of Object.entries(rootExtraTraits ?? {})) {
        const meta = getTraitByName(name);
        if (!meta) continue;
        const isTag = meta.category === 'tag' || data === true;
        if (root.has(meta.trait)) { if (!isTag) root.set(meta.trait, data as Record<string, unknown>); }
        else root.add(isTag ? (meta.trait as unknown as () => never)() : (meta.trait as unknown as (d: unknown) => never)(data));
      }
      return id;
    },
  });
}

const report: Record<string, string[]> = {};

describe.skipIf(!hasInternalGames())('#2007 oracle: the fold is what today spawns (corpus)', () => {
  for (const project of projects) {
    for (const scene of project.scenes) {
      const rel = scene.abs.slice(scene.abs.indexOf(project.id));
      it(rel, async () => {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
        installProject(project.prefabFiles);
        const file = readJson(scene.abs) as { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown };
        await load(file as unknown as SceneData);
        const entries = file.entities ?? [];
        const idToGuid = new Map(entries.map((e) => [e.id, e.guid] as const));
        const held = new Set(entries.map((e) => e.guid).filter((g): g is string => !!g));
        const ea = getTraitByName('EntityAttributes')!.trait;
        const lines: string[] = [];
        for (const entry of entries) {
          if (!entry.prefab || !entry.guid) continue;
          const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
          if (!root) { lines.push(`${entry.name}: no live root`); continue; }
          for (const d of checkInstance(entry, reader, root.id(), {
            sceneVersion: (typeof (file as { version?: unknown }).version === 'number' ? (file as { version: number }).version : 0),
            parentGuid: (r) => (typeof r === 'number' ? idToGuid.get(r) ?? '' : typeof r === 'string' ? r : ''),
            sceneHadCopies: !!file.embeddedPrefabs, held: (g) => held.has(g),
          })) lines.push(`${entry.name}: ${d}`);
        }
        report[rel] = lines;
        vi.unstubAllGlobals();
        expect(lines).toEqual([]);
      });
    }
  }

  it('checked the corpus (non-vacuity)', () => {
    if (process.env.ORACLE_OUT) writeFileSync(process.env.ORACLE_OUT, JSON.stringify({ seen, report }, null, 1));
    expect(seen.instances).toBeGreaterThan(20);
    expect(seen.defaults).toBeGreaterThan(0);
  });
});

/** The close-out review's cases (#2007) that neither the corpus nor the fuzz seeds reach, through today's real load:
 *  synthetic documents, the same comparison. Not layout-conditional — they need no game. */
describe('#2007 oracle: synthetic cases the corpus does not reach', () => {
  const G = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000c0de`;
  const ROOT = G(100), SCENE = G(200);
  const tf = { x: 0, y: 0, z: 0 };
  const row = (localId: number, name: string, parentId: number, extra: object = {}) => ({ localId, nodeGuid: G(localId + 10 * (name.length + 1)), traits: { EntityAttributes: { name, parentId }, Transform: tf }, ...extra });
  const install = (...docs: Array<{ id: string } & Record<string, unknown>>) => {
    for (const id of prefabs.keys()) setPrefabCache(id, null);
    prefabs.clear();
    for (const d of docs) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); }
  };
  const ea = () => getTraitByName('EntityAttributes')!.trait;
  const check = async (entries: SceneEntityEntry[], entry: SceneEntityEntry): Promise<string[]> => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    await load({ version: 15, entities: entries } as unknown as SceneData);
    vi.unstubAllGlobals();
    const root = [...getCurrentWorld().entities].find((e) => (e.get(ea()) as { guid?: string } | undefined)?.guid === ROOT)!;
    const held = new Set(entries.map((e) => e.guid).filter((g): g is string => !!g));
    return checkInstance(entry, reader, root.id(), { sceneVersion: 15, held: (g) => held.has(g) });
  };
  const top = (extra: object = {}): SceneEntityEntry => ({ id: 2, name: 'Ship', prefab: 'P', guid: ROOT, traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { name: 'Ship', guid: ROOT, parentId: 0 } }, ...extra }) as SceneEntityEntry;

  describe('#2022 (hub rulings 2026-10-02): the fold\'s residual move and cascade cases, against today\'s load', () => {
    const Q = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QA', 1), row(3, 'QB', 2)] };
    const P = (extra: object[] = [], moved?: object) => ({ id: 'P', version: 5, rootLocalId: 1, ...(moved ? { moved } : {}), entities: [row(1, 'Ship', 0), row(2, 'A', 1), row(3, 'B', 2), row(4, 'C', 1), ...extra] });
    const g = (lid: number, name: string) => row(lid, name, 0).nodeGuid;
    const same = (extra: object): [SceneEntityEntry[], SceneEntityEntry] => [[top(extra)], top(extra)];
    const fold = async (e: SceneEntityEntry, opts: { sceneVersion: number } = { sceneVersion: 15 }) => {
      const { parseInstanceRecord } = await import('../../packages/modoki/src/runtime/prefab/parseInstanceRecord');
      const { foldInstance } = await import('../../packages/modoki/src/runtime/prefab/foldInstance');
      const parsed = parseInstanceRecord(e, reader, opts);
      return { parsed, f: foldInstance(reader, parsed.record) };
    };

    it('1, a ruled visible FIX: a move into a row today deletes later is refused, and the member stays (today loses it)', async () => {
      install(P([row(5, 'E', 1)]));
      const e = top({ members: { [`/${g(2, 'A')}`]: { removed: true, guid: G(82) }, [`/${g(4, 'C')}`]: { guid: G(81) }, [`/${g(3, 'B')}`]: { parent: G(81) }, [`/${g(5, 'E')}`]: { parent: G(82) } } });
      expect(await check([e], e)).toEqual([`fold-only node /${g(5, 'E')}`]);
    });

    it('2: a plain row under a removed missing-prefab row goes with it, in either form (no dangling parent)', async () => {
      install(P([row(5, 'R', 1, { prefab: 'M-missing' }), row(6, 'X', 5)]));
      // Today books the row\'s removal twice, kept AND applied (#2013, ruled today-wrong): the oracle marks it applied.
      expect(await check(...same({ members: { [`/${g(5, 'R')}`]: { removed: true } } }))).toEqual([`kept-only unused /${g(5, 'R')} removed (applied)`]);
      expect(await check(...same({ removed: [5] }))).toEqual([]);
    });

    it('3: the instance root\'s own parent record moves nothing and is reported unused, gone', async () => {
      install(P());
      expect(await check(...same({ members: { '/': { parent: SCENE } } }))).toEqual([]);
      // The legacy form: today drops it (lost on save); the rules report it ("never neither").
      expect(await check(...same({ moved: { 1: SCENE } }))).toEqual(['fold-only unused / parent (gone)']);
    });

    it('4: under the instance\'s own removal, a template-keyed node\'s ignored parent is inert — kept, not unused', async () => {
      install(P([row(5, 'R', 1, { prefab: 'Q', added: [{ parentLocalId: 2, guid: '', key: 'k1', name: 'K1', traits: { EntityAttributes: { name: 'K1' }, Transform: tf }, children: [] }] })]), Q);
      const e = top({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { removed: true }, [`/${g(5, 'R')}/a+k1`]: { parent: SCENE } } });
      expect(await check([e], e)).toEqual([]);
      expect((await fold(e)).f.unused).toEqual([]);
    });

    it('4 (rule 3, G2): under the instance\'s own removal, a removal that would not take and an unknown field are inert too', async () => {
      install(P());
      const e = top({ members: { [`/${g(3, 'B')}`]: { removed: true, traitRemovals: { Light: true }, traits: { Transform: { bogus: 1 } } } } });
      expect(await check([e], e)).toEqual([]);
      expect((await fold(e)).f.unused).toEqual([]);
    });

    it('5, matching today: a member token written in a scene row names nothing — the member stays, the token is kept, unused, and warned', async () => {
      install(P());
      const e = top({ members: { [`/${g(3, 'B')}`]: { parent: '@member:4' } } });
      // Today keeps the row and ignores it; the rules report the record (unused, gone).
      expect(await check([e], e)).toEqual([`fold-only unused /${g(3, 'B')} parent (gone)`]);
      const { parsed, f } = await fold(e);
      expect(f.nodes.get(`/${g(3, 'B')}` as never)?.parent).toEqual({ key: `/${g(2, 'A')}` });
      expect(parsed.record.held.pendingLegacy).toEqual({ members: { [`/${g(3, 'B')}`]: { parent: '@member:4' } } });
      expect(parsed.warnings.some((w) => w.code === 'pendingLegacy' && w.key === `/${g(3, 'B')}`)).toBe(true);
    });

    it('5 (review): the held token is still the member\'s ONE move — it replaces a lower one, and a legacy move of the same row', async () => {
      install(P([], { '2.3': '@member:4' }));
      const e = top({ members: { [`/${g(3, 'B')}`]: { parent: '@member:99' } } });
      expect(await check([e], e)).toEqual([`fold-only unused /${g(3, 'B')} parent (gone)`]);
      install(P());
      const e2 = top({ moved: { 3: G(81) }, members: { [`/${g(4, 'C')}`]: { guid: G(81) }, [`/${g(3, 'B')}`]: { parent: '@member:99' } } });
      expect(await check([e2], e2)).toEqual([`fold-only unused /${g(3, 'B')} parent (gone)`]);
      expect((await fold(e2)).parsed.record.list.rows.get(`/${g(3, 'B')}` as never)?.parent).toBeUndefined();
    });

    it('5 (review): a held token under the instance\'s own removal is inert, as every record there', async () => {
      install(P());
      expect((await fold(top({ members: { [`/${g(3, 'B')}`]: { removed: true, parent: '@member:4' } } }))).f.unused).toEqual([]);
      expect((await fold(top({ members: { [`/${g(2, 'A')}`]: { removed: true }, [`/${g(3, 'B')}`]: { parent: '@member:4' } } }))).f.unused).toEqual([]);
    });

    it('5 (review; hub Q1): a reference copy whose member row carries a token CONVERTS before v20 — only the token is held', async () => {
      const Q2 = { id: 'Q2', version: 5, rootLocalId: 1, entities: [row(1, 'Q2', 0), row(2, 'Q2A', 1), row(3, 'Q2B', 2)] };
      const k1 = { parentLocalId: 2, guid: '', key: 'k1', prefab: 'Q2', name: 'K1', traits: { EntityAttributes: { name: 'K1' }, Transform: tf }, children: [] };
      install(P([row(5, 'R', 1, { prefab: 'Q', added: [k1] })]), Q, Q2);
      const copy = { ...k1, members: { [`/${g(3, 'Q2B')}`]: { parent: '@member:2', traits: { Transform: { x: 7 } } } } };
      const e = top({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [copy] } } });
      // Today applies the copy's x=7 and ignores the token: so does the fold. The token is kept as an unnameable remainder,
      // reported as a held copy whose node shows is — waiting, never removable (close-out review round 2).
      expect(await check([e], e)).toEqual([`fold-only unused /${g(5, 'R')}/${g(2, 'QA')} own (unresolved)`]);
      const { parsed, f } = await fold(e);
      expect(parsed.record.held.pendingLegacy).toEqual({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [{ ...copy, traits: {}, children: [], members: { [`/${g(3, 'Q2B')}`]: { parent: '@member:2' } } }], heldRemainder: true } } });
      expect(f.unused.length).toBe(1);
      // From v20 no writer states a copy: held whole.
      expect((await fold(e, { sceneVersion: 20 })).parsed.record.held.pendingLegacy).toEqual({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [copy], heldRemainder: true } } });
      // Written back, the converted overrides and the held token read back as they were.
      const { roundTripEntry } = await import('./instanceRecordRoundTrip');
      const rt = roundTripEntry(e, reader, { sceneVersion: 15 });
      expect(rt.second.record.held.pendingLegacy).toEqual(rt.first.record.held.pendingLegacy);
      expect(rt.second.record.list).toEqual(rt.first.record.list);
      // The held element states the copy's identity and the tokens, nothing else: its other channels converted.
      const withChannels = { ...copy, overrides: { 2: { Transform: { x: 5 } } } };
      const held = (await fold(top({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [withChannels] } } }))).parsed.record.held.pendingLegacy as { members: Record<string, { added: object[] }> };
      expect(Object.keys(held.members[`/${g(5, 'R')}/${g(2, 'QA')}`]!.added[0]!).sort()).toEqual(['children', 'guid', 'key', 'members', 'name', 'parentLocalId', 'prefab', 'traits']);
    });

    it('#2025 item 2: a node a slot adds to a MISSING nested frame waits unresolved, keyed at its placeholder (today shows none)', async () => {
      install(P([row(5, 'R', 1, { prefab: 'M-missing' })]));
      const mine = { parentLocalId: 1, guid: G(89), name: 'MineNS', traits: {}, children: [] };
      const { f } = await fold(top({ nestedStructure: { '5': { added: [mine] } } }));
      expect(f.unused).toEqual([{ key: `/${g(5, 'R')}`, part: { kind: 'legacy', path: ['nestedStructure', '5', 'added', '0'] }, cause: 'unresolved' }]);
      expect([...f.anchors.values()].flat()).toEqual([]);
    });

    it('#2025 item 4: a user node held inside a missing frame under the instance\'s OWN removal is kept, heldNode — never neither', async () => {
      install(P([row(5, 'R', 2, { prefab: 'M-missing' })]));
      const mine = { parentLocalId: 1, guid: G(86), name: 'Mine', traits: {}, children: [] };
      const e = top({ members: { [`/${g(2, 'A')}`]: { removed: true }, [`/${g(5, 'R')}/${G(87)}`]: { added: [mine] } } });
      expect((await fold(e)).f.unused).toEqual([{ key: `/${g(5, 'R')}/${G(87)}`, part: { kind: 'legacy', path: ['members', `/${g(5, 'R')}/${G(87)}`, 'added', '0'] }, cause: 'heldNode' }]);
    });

    it('#2025 item 2 under the instance\'s OWN removal: the slot\'s node is kept heldNode, keyed at its placeholder as uncut', async () => {
      install(P([row(5, 'R', 2, { prefab: 'M-missing' })]));
      const mine = { parentLocalId: 1, guid: G(89), name: 'MineNS', traits: {}, children: [] };
      const { f } = await fold(top({ members: { [`/${g(2, 'A')}`]: { removed: true } }, nestedStructure: { '5': { added: [mine] } } }));
      expect(f.unused).toEqual([{ key: `/${g(5, 'R')}`, part: { kind: 'legacy', path: ['nestedStructure', '5', 'added', '0'] }, cause: 'heldNode' }]);
    });

    it('#2025 item 5: a held node\'s content whose link the list states is reported once, by the link', async () => {
      install(P());
      const { parsed } = await fold(top({ members: { [`/${g(2, 'A')}`]: { own: [{ parentLocalId: 0, guid: G(88), name: 'N', traits: {}, children: [] }] } } }));
      expect(parsed.record.list.rows.get(`/${g(2, 'A')}` as never)?.own).toEqual([{ guid: G(88) }]);
      const rec = { ...parsed.record, held: { ...parsed.record.held, heldOwn: new Map([[`/${g(2, 'A')}`, [{ guid: G(88), name: 'N', traits: {}, children: [] }]]]) } };
      const { foldInstance } = await import('../../packages/modoki/src/runtime/prefab/foldInstance');
      expect(foldInstance(reader, rec as never).unused.filter((u) => u.part.kind === 'own')).toEqual([]);
    });

    it('#2024: a restore AT a placeholder row whose template removed it is applied — the placeholder shows — and not unused', async () => {
      const QZ = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QZ', 1, { prefab: 'Z-missing' })] };
      install(P([row(5, 'R', 1, { prefab: 'Q', members: { [`/${g(2, 'QZ')}`]: { removed: true } } })]), QZ);
      const e = top({ members: { [`/${g(5, 'R')}/${g(2, 'QZ')}`]: { removed: false } } });
      expect(await check([e], e)).toEqual([]);
      const { f } = await fold(e);
      expect(f.placeholders.has(`/${g(5, 'R')}/${g(2, 'QZ')}` as never)).toBe(true);
      expect(f.unused).toEqual([]);
      expect((await fold(top())).f.placeholders.has(`/${g(5, 'R')}/${g(2, 'QZ')}` as never)).toBe(false);
      // Only the removal: a field there targets the missing document's root, and waits on it.
      const withField = top({ members: { [`/${g(5, 'R')}/${g(2, 'QZ')}`]: { removed: false, traits: { Transform: { x: 3 } } } } });
      expect((await fold(withField)).f.unused.map((u) => `${u.part.kind} ${u.cause}`)).toEqual(['field unresolved']);
    });

    it('#2025: a user node in a v16 row\'s added AT a Missing Prefab placeholder is anchored there, as in every file form', async () => {
      install(P([row(5, 'R', 1, { prefab: 'M-missing' })]));
      const mine = { parentLocalId: 0, guid: G(84), name: 'Mine', traits: { EntityAttributes: { name: 'Mine', guid: G(84) }, Transform: tf }, children: [] };
      const e = top({ members: { [`/${g(5, 'R')}`]: { added: [mine] } } });
      expect(await check([e], e)).toEqual([]);
      const { f, parsed } = await fold(e);
      expect(f.anchors.get(`/${g(5, 'R')}` as never)).toEqual([{ guid: G(84) }]);
      // The list it was stays held, the user's node taken out: it still replaces the missing document's nodes there.
      expect(parsed.record.held.pendingLegacy).toEqual({ members: { [`/${g(5, 'R')}`]: { added: [] } } });
      // One node, one link: stated already by the legacy channel, the row's copy of it stays held.
      const twice = top({ added: [{ ...mine, parentLocalId: 1 }], members: { [`/${g(5, 'R')}`]: { added: [mine] } } });
      expect(await check([twice], twice)).toEqual([]);
      expect((await fold(twice)).f.anchors.get(`/${g(5, 'R')}` as never)).toBeUndefined();
    });

    it('2 (review): a failed move lifted through a cut placeholder reaches the nearest row that stays', async () => {
      install(P([row(5, 'R', 1, { prefab: 'M-missing' }), row(6, 'X', 5), row(7, 'M', 6)]));
      const e = top({ members: { [`/${g(5, 'R')}`]: { removed: true }, [`/${g(6, 'X')}`]: { guid: G(83) }, [`/${g(7, 'M')}`]: { parent: G(83) } } });
      expect((await fold(e)).f.nodes.get(`/${g(7, 'M')}` as never)?.parent).toEqual({ key: '/' });
    });

    it('4 (review): the instance\'s own removal of an ancestor covers a row an inner layer removed — its records inert', async () => {
      install(P([row(5, 'R', 1, { prefab: 'Q', members: { [`/${g(3, 'QB')}`]: { removed: true } } })]), Q);
      const e = top({ members: { [`/${g(5, 'R')}`]: { removed: true }, [`/${g(5, 'R')}/${g(3, 'QB')}`]: { traits: { Transform: { x: 1 } } } } });
      expect(await check([e], e)).toEqual([]);
      expect((await fold(e)).f.unused).toEqual([]);
      // The same with a missing-prefab row in the inner layer\'s place: the placeholder\'s records are inert too.
      const Q3 = { id: 'Q3', version: 5, rootLocalId: 1, entities: [row(1, 'Q3', 0), row(2, 'S', 1, { prefab: 'M-missing' })] };
      install(P([row(5, 'R', 1, { prefab: 'Q3', members: { [`/${g(2, 'S')}`]: { removed: true } } })]), Q3);
      const e3 = top({ members: { [`/${g(5, 'R')}`]: { removed: true }, [`/${g(5, 'R')}/${g(2, 'S')}`]: { traits: { Transform: { x: 1 } } } } });
      expect((await fold(e3)).f.unused).toEqual([]);
    });

    it('#2020: a whole removedTraits row on a plain template-added node is a stray form — held, not applied, at every version', async () => {
      const lightTf = { EntityAttributes: { name: 'K2' }, Transform: tf, Light: {} };
      install(P([row(5, 'R', 1, { prefab: 'Q', added: [{ parentLocalId: 2, guid: '', key: 'k2', name: 'K2', traits: lightTf, children: [] }] })]), Q);
      const e = top({ members: { [`/${g(5, 'R')}/a+k2`]: { removedTraits: ['Light'] } } });
      // Today keeps Light (and its next save drops the row); the fold keeps Light and reports the held row.
      expect(await check([e], e)).toEqual([`fold-only unused /${g(5, 'R')}/a+k2 -Light (gone)`]);
      const { parsed, f } = await fold(e);
      expect(parsed.warnings.some((w) => w.code === 'pendingLegacy' && w.key === `/${g(5, 'R')}/a+k2`)).toBe(true);
      expect(f.nodes.get(`/${g(5, 'R')}/a+k2` as never)?.traits.Light).toBeDefined();
      // No writer states it, the v20 one included: written back, it reads back held — load, save, load shows the same.
      expect((await fold(e, { sceneVersion: 20 })).f.nodes.get(`/${g(5, 'R')}/a+k2` as never)?.traits.Light).toBeDefined();
      const { roundTripEntry } = await import('./instanceRecordRoundTrip');
      const rt = roundTripEntry(e, reader, { sceneVersion: 15 });
      expect(rt.second.record.held.pendingLegacy).toEqual(rt.first.record.held.pendingLegacy);
    });

    it('#2020: on a template-added REFERENCE node\'s root row, today applies it — and so does the fold', async () => {
      const Q2 = { id: 'Q2', version: 5, rootLocalId: 1, entities: [row(1, 'Q2', 0, { traits: { EntityAttributes: { name: 'Q2', parentId: 0 }, Transform: tf, Light: {} } }), row(2, 'Q2A', 1)] };
      install(P([row(5, 'R', 1, { prefab: 'Q', added: [{ parentLocalId: 2, guid: '', key: 'k2', prefab: 'Q2', name: 'K2', traits: { EntityAttributes: { name: 'K2' }, Transform: tf }, children: [] }] })]), Q, Q2);
      const e = top({ members: { [`/${g(5, 'R')}/a+k2`]: { removedTraits: ['Light'] } } });
      expect(await check([e], e)).toEqual([]);
    });

    it('#2019: before v20, a row\'s whole lists at a NESTED ROOT sit beside the legacy part (today shows both); a plain anchor replaces', async () => {
      const QL = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0, { traits: { EntityAttributes: { name: 'Q', parentId: 0 }, Transform: tf, Light: {} } }), row(2, 'QA', 1)] };
      install(P([row(5, 'R', 1, { prefab: 'Q' })]), QL);
      const node = (n: number, name: string, at: number) => ({ parentLocalId: at, guid: G(n), name, traits: { EntityAttributes: { name, guid: G(n) }, Transform: tf }, children: [] });
      const nested = top({ added: [node(61, 'LA', 5)], removedTraits: { 5: ['Light'] }, members: { [`/${g(5, 'R')}`]: { added: [node(62, 'RB', 5)], removedTraits: [] } } });
      expect(await check([nested], nested)).toEqual([]);
      const { f } = await fold(nested);
      expect(f.nodes.get(`/${g(5, 'R')}` as never)?.traits.Light).toBeUndefined();
      expect((f.anchors.get(`/${g(5, 'R')}` as never) ?? []).map((r) => r.guid).sort()).toEqual([G(61), G(62)].sort());
      // From v20 the row wins (§ 10.3): a legacy channel beside it is a stray writer's.
      expect((await fold(nested, { sceneVersion: 20 })).f.anchors.get(`/${g(5, 'R')}` as never)?.map((r) => r.guid)).toEqual([G(62)]);
      const plain = top({ added: [node(63, 'LC', 2)], members: { [`/${g(2, 'A')}`]: { added: [node(64, 'RD', 2)] } } });
      expect(await check([plain], plain)).toEqual([]);
    });

    it('#2019 review: a nested frame\'s OWN slot at its root is replaced by the row, as today; and the row\'s restore keeps a beside removal', async () => {
      const Q2 = { id: 'Q2', version: 5, rootLocalId: 1, entities: [row(1, 'Q2', 0, { traits: { EntityAttributes: { name: 'Q2', parentId: 0 }, Transform: tf, Light: {} } }), row(2, 'Q2A', 1)] };
      const QS = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QA', 1), row(3, 'S', 1, { prefab: 'Q2' })] };
      install(P([row(5, 'R', 1, { prefab: 'Q' })]), QS, Q2);
      const node = (n: number, name: string, at: number) => ({ parentLocalId: at, guid: G(n), name, traits: { EntityAttributes: { name, guid: G(n) }, Transform: tf }, children: [] });
      const own = top({ nestedStructure: { '5.3': { added: [node(71, 'LA', 1)], removed: [], removedTraits: { 1: ['Light'] } } }, members: { [`/${g(5, 'R')}/${g(3, 'S')}`]: { added: [node(72, 'RB', 1)], removedTraits: [] } } });
      expect(await check([own], own)).toEqual([]);
      // The chain removed Light at R; the entry\'s legacy channel removes it again, and the row restores nothing it names.
      const QL = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0, { traits: { EntityAttributes: { name: 'Q', parentId: 0 }, Transform: tf, Light: {} } }), row(2, 'QA', 1)] };
      install(P([row(5, 'R', 1, { prefab: 'Q', removedTraits: { 1: ['Light'] } })]), QL);
      const restore = top({ removedTraits: { 5: ['Light'] }, members: { [`/${g(5, 'R')}`]: { removedTraits: [] } } });
      // Light stays removed, as today. The kept legacy removal restates the chain's: an APPLIED record, not unused (hub
      // ruling on #2023's 418(b), #2027 — F1 by analogy; its target exists, so Remove Unused must not take it).
      expect(await check([restore], restore)).toEqual([]);
      expect((await fold(restore)).f.unused).toEqual([]);
      // The same at an entry-level row (418(b) is not copy-specific): a whole list restating the chain's removal.
      const entryRow = top({ members: { [`/${g(5, 'R')}`]: { removedTraits: ['Light'] } } });
      expect(await check([entryRow], entryRow)).toEqual([]);
      const { parsed, f } = await fold(entryRow);
      expect(parsed.record.list.rows.get(`/${g(5, 'R')}` as never)?.traitRemovals).toEqual({ Light: true });
      expect(f.unused).toEqual([]);
      expect(f.nodes.get(`/${g(5, 'R')}` as never)?.traits.Light).toBeUndefined();
    });

    it('5 (review): an alias row\'s token replaces no other row\'s move', async () => {
      install(P([row(5, 'R', 1, { prefab: 'Q' })]), Q);
      const e = top({ members: { [`/${g(4, 'C')}`]: { guid: G(81) }, [`/${g(5, 'R')}`]: { parent: G(81) }, [`/${g(5, 'R')}/${g(1, 'Q')}`]: { parent: '@member:99' } } });
      expect((await fold(e)).f.nodes.get(`/${g(5, 'R')}` as never)?.parent).toEqual({ key: `/${g(4, 'C')}` });
    });

    it('5 (review): a scene REFERENCE node\'s converted templateMoved survives a save — its row tokens are moves', async () => {
      const { parseReferenceNode } = await import('../../packages/modoki/src/runtime/prefab/parseInstanceRecord');
      const { foldInstance } = await import('../../packages/modoki/src/runtime/prefab/foldInstance');
      const { serializeInstanceRecord } = await import('../../packages/modoki/src/runtime/prefab/serializeInstanceRecord');
      const Q3 = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QA', 1), row(3, 'QB', 2), row(4, 'QC', 1)] };
      install(Q3);
      const node = { parentLocalId: 0, guid: G(90), name: 'QR', prefab: 'Q', traits: {}, children: [], templateMoved: { '2.3': '@member:4' } } as never;
      const first = parseReferenceNode(node, reader, { sceneVersion: 15 });
      const at = (p: typeof first) => foldInstance(reader, p.record).nodes.get(`/${g(3, 'QB')}` as never)?.parent;
      expect(at(first)).toEqual({ key: `/${g(4, 'QC')}` });
      const written = serializeInstanceRecord(first.record, { identity: new Map(), sceneOwned: (gd) => first.ownContent.get(gd) });
      expect(at(parseReferenceNode({ ...written.entry, guid: G(90), name: 'QR', parentLocalId: 0, children: [] } as never, reader, { sceneVersion: 20 }))).toEqual({ key: `/${g(4, 'QC')}` });
    });

    it('6: a ^ token in a template move matches today, in each layer it can be written in', async () => {
      install(P([row(5, 'R', 1, { prefab: 'Q' })], { '5.3': '@member:^4' }), Q);
      expect(await check([top()], top())).toEqual([]);
      install(P([row(5, 'R', 1, { prefab: 'Q', members: { [`/${g(3, 'QB')}`]: { parent: '@member:^4' } } })]), Q);
      expect(await check([top()], top())).toEqual([]);
      const Q2 = { id: 'Q2', version: 5, rootLocalId: 1, entities: [row(1, 'Q2', 0), row(2, 'Q2A', 1), row(3, 'S', 1, { prefab: 'Q' })] };
      install(P([row(5, 'R', 1, { prefab: 'Q2', members: { [`/${g(3, 'S')}/${g(3, 'QB')}`]: { parent: '@member:^2' } } })]), Q2, Q);
      expect(await check([top()], top())).toEqual([]);
      install(P([row(5, 'R', 1, { prefab: 'Q2' })]), { ...Q2, entities: [row(1, 'Q2', 0), row(2, 'Q2A', 1), row(3, 'S', 1, { prefab: 'Q', members: { [`/${g(3, 'QB')}`]: { parent: '@member:^2' } } })] }, Q);
      expect(await check([top()], top())).toEqual([]);
    });

    it('7 (not reproduced): a lift never frees a later cycle — it keeps the member inside every surviving ancestor', async () => {
      install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'M', 1), row(3, 'A', 2), row(4, 'B', 3), row(5, 'D', 4), row(6, 'N', 1)] });
      const base = { [`/${g(3, 'A')}`]: { removed: true }, [`/${g(5, 'D')}`]: { guid: G(83) }, [`/${g(4, 'B')}`]: { guid: G(84), parent: G(83) } };
      expect(await check(...same({ members: { ...base, [`/${g(2, 'M')}`]: { parent: G(84) } } }))).toEqual([]);
      expect(await check(...same({ members: { ...base, [`/${g(6, 'N')}`]: { parent: G(84) } } }))).toEqual([]);
    });
  });

  describe('#2027: a scene reference COPY\'s structure is ONE whole statement, over the chain without the base node\'s structure', () => {
    // Q3 ← S in Q2 ← k1 (a template-added reference node P's row R adds at QA) ← the scene's copy of k1.
    const lit = (name: string, parentId: number) => ({ traits: { EntityAttributes: { name, parentId }, Transform: tf, Light: {} } });
    const Q3 = { id: 'Q3', version: 5, rootLocalId: 1, entities: [row(1, 'Q3', 0), row(2, 'Q3XX', 1, lit('Q3XX', 1))] };
    const Q2 = { id: 'Q2', version: 5, rootLocalId: 1, entities: [row(1, 'Q2', 0), row(2, 'Q2A', 1), row(3, 'Q2B', 2, lit('Q2B', 2)), row(4, 'S', 1, { prefab: 'Q3' })] };
    const Q = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QA', 1), row(3, 'QB', 2)] };
    const g = (lid: number, name: string) => row(lid, name, 0).nodeGuid;
    const k1 = { parentLocalId: 2, guid: '', key: 'k1', prefab: 'Q2', name: 'K1', traits: { EntityAttributes: { name: 'K1' }, Transform: tf }, children: [] };
    const k2 = { parentLocalId: 0, guid: '', key: 'k2', name: 'K2', traits: { EntityAttributes: { name: 'K2' }, Transform: tf }, children: [] };
    /** P adds k1 (its template statement: `base`); the scene entry replaces it at QA with its copy (`copy`). */
    const scene = (base: object, copy: object, docs: Array<{ id: string } & Record<string, unknown>> = [Q2, Q3]): SceneEntityEntry => {
      install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(5, 'R', 1, { prefab: 'Q', added: [{ ...k1, ...base }] })] }, Q, ...docs);
      return top({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [{ ...k1, guid: G(95), ...copy }] } } });
    };
    const fold = async (e: SceneEntityEntry) => {
      const { parseInstanceRecord } = await import('../../packages/modoki/src/runtime/prefab/parseInstanceRecord');
      const { foldInstance } = await import('../../packages/modoki/src/runtime/prefab/foldInstance');
      const parsed = parseInstanceRecord(e, reader, { sceneVersion: 15 });
      return { parsed, f: foldInstance(reader, parsed.record) };
    };
    const K1 = `/${g(5, 'R')}/a+k1`;

    it('A (seed 566): a KEYED node in a copy row\'s own pairs with the chain node it restates — one node, at its a+key row', async () => {
      // Beside it, a keyless node of the user's: linked once, at the row's member.
      const mine = { parentLocalId: 0, guid: G(98), name: 'Mine', traits: { EntityAttributes: { name: 'Mine', guid: G(98) }, Transform: tf }, children: [] };
      const e = scene({ members: { [`/${g(2, 'Q2A')}`]: { added: [k2] } } }, { members: { [`/${g(2, 'Q2A')}`]: { own: [{ ...k2, guid: G(96) }, mine] } } });
      expect(await check([e], e)).toEqual([]);
      const { parsed, f } = await fold(e);
      expect(f.anchors.get(`${K1}/${g(2, 'Q2A')}` as never)?.map((r) => r.guid)).toEqual([G(98)]);
      expect(parsed.record.list.rows.get(`${K1}/a+k2` as never)?.guid).toBe(G(96));
      // The same one frame down: a deeper row's keyed own pairs with the chain node at its member.
      const deep = `/${g(4, 'S')}/${g(2, 'Q3XX')}`;
      const down = scene({ members: { [deep]: { added: [k2] } } }, { members: { [deep]: { own: [{ ...k2, guid: G(96) }] } } });
      expect(await check([down], down)).toEqual([]);
      expect((await fold(down)).f.anchors.get(`${K1}${deep}` as never)).toBeUndefined();
      // A copy that does not restate it: today spawns nothing there (the copy's structure is whole), and the fold agrees.
      const none = scene({ members: { [`/${g(2, 'Q2A')}`]: { added: [k2] } } }, { members: {} });
      expect(await check([none], none)).toEqual([]);
      expect((await fold(none)).f.nodes.has(`${K1}/a+k2` as never)).toBe(false);
    });

    it('A′ (seed 418): a copy row\'s added restates a node of the base\'s top-level list — paired, not pinned AND removed', async () => {
      const e = scene({ added: [{ ...k2, parentLocalId: 2 }] }, { members: { [`/${g(2, 'Q2A')}`]: { added: [{ ...k2, guid: G(97) }] } } });
      expect(await check([e], e)).toEqual([]);
      const { parsed, f } = await fold(e);
      expect(f.nodes.has(`${K1}/a+k2` as never)).toBe(true);
      expect(parsed.record.list.rows.get(`${K1}/a+k2` as never)?.removed).toBeUndefined();
      // The one list is today's: a row's whole added replaces the copy's top-level nodes at its member.
      const node = (n: number, at: number) => ({ parentLocalId: at, guid: G(n), name: `N${n}`, traits: { EntityAttributes: { name: `N${n}`, guid: G(n) }, Transform: tf }, children: [] });
      const replaced = scene({}, { added: [node(110, 2)], members: { [`/${g(2, 'Q2A')}`]: { added: [node(111, 0)] } } });
      expect(await check([replaced], replaced)).toEqual([]);
      expect((await fold(replaced)).f.anchors.get(`${K1}/${g(2, 'Q2A')}` as never)?.map((r) => r.guid)).toEqual([G(111)]);
    });

    describe('close-out review (F1–F5)', () => {
      const deep = `/${g(4, 'S')}/${g(2, 'Q3XX')}`;
      const Q4 = { id: 'Q4', version: 5, rootLocalId: 1, entities: [row(1, 'Q4', 0), row(2, 'Q4Y', 1, lit('Q4Y', 1))] };
      const kx = { parentLocalId: 2, guid: '', key: 'kx', prefab: 'Q4', name: 'KX', traits: { EntityAttributes: { name: 'KX' }, Transform: tf }, children: [] };
      const withS = (added: object[], docs: Array<{ id: string } & Record<string, unknown>> = [Q3, Q4]) => [{ ...Q2, entities: [...Q2.entities.slice(0, 3), row(4, 'S', 1, { prefab: 'Q3', added })] }, ...docs];
      /** The owner's own row into the copy's frame, read BEFORE the row holding the copy (writers sort member keys). */
      const first = (e: SceneEntityEntry, rows: Record<string, object>): SceneEntityEntry => ({ ...e, members: { ...rows, ...e.members } }) as SceneEntityEntry;

      it('F1: a copy\'s own top-level node a node row reaches is still in the one list (the fold clones it)', async () => {
        const kz = { ...kx, key: 'kz' };
        const r9 = scene({ added: [kz] }, { added: [{ ...kz, guid: G(120) }], members: { [`/a+kz/${g(2, 'Q4Y')}`]: { traits: { Transform: { x: 3 } } } } }, [Q2, Q3, Q4]);
        expect(await check([r9], r9)).toEqual([]);
        expect((await fold(r9)).f.nodes.has(`${K1}/a+kz` as never)).toBe(true);
        const k2a = { ...k2, parentLocalId: 2 };
        const r8 = scene({ added: [k2a] }, { added: [{ ...k2a, guid: G(121) }], members: { '/a+k2': { traits: { Transform: { x: 3 } } } } });
        expect(await check([r8], r8)).toEqual([]);
      });

      it('F2: the owner\'s own rows into the copy\'s frame win over the copy, in either key order', async () => {
        const r2 = first(scene({ members: { [deep]: { removed: true } } }, { members: {} }), { [`${K1}${deep}`]: { removed: true } });
        expect(await check([r2], r2)).toEqual([]);
        expect((await fold(r2)).parsed.record.list.rows.get(`${K1}${deep}` as never)?.removed).toBe(true);
        const r1 = first(scene({ members: { [deep]: { traitRemovals: { Light: true } } } }, { members: {} }), { [`${K1}${deep}`]: { traitRemovals: { Light: true } } });
        expect(await check([r1], r1)).toEqual([]);
        // The copy's own frame too (its top-level lists' restores; this predates #2027).
        const q2b = `/${g(3, 'Q2B')}`;
        const r4 = first(scene({ members: { [q2b]: { traitRemovals: { Light: true } } } }, { members: {} }), { [`${K1}${q2b}`]: { traitRemovals: { Light: true } } });
        expect(await check([r4], r4)).toEqual([]);
      });

      it('F3: a node a DOCUMENT supplies, which the base removes and the copy says nothing about, shows, as today', async () => {
        for (const n of [{ ...k2, key: 'kp', parentLocalId: 2 }, kx]) {
          const e = scene({ members: { [`/${g(4, 'S')}/a+${n.key}`]: { removed: true } } }, { members: {} }, withS([n]));
          expect(await check([e], e)).toEqual([]);
          expect((await fold(e)).f.nodes.has(`${K1}/${g(4, 'S')}/a+${n.key}` as never)).toBe(true);
        }
      });

      it('F4: a document repeated on the hang path (not containing itself) is walked: the base\'s removal there does not apply', async () => {
        const Q4t = { ...Q4, entities: [...Q4.entities, row(3, 'T', 1, { prefab: 'Q3' })] };
        const at = `/${g(4, 'S')}/a+kx/${g(3, 'T')}/${g(2, 'Q3XX')}`;
        const e = scene({ members: { [at]: { traitRemovals: { Light: true } } } }, { members: {} }, withS([kx], [Q3, Q4t]));
        expect(await check([e], e)).toEqual([]);
        expect((await fold(e)).f.nodes.get(`${K1}${at}` as never)?.traits.Light).toBeDefined();
      });

      it('re-review N1: an earlier SLOT copy of the same node does not beat the row\'s copy, which replaces it (today: x=7)', async () => {
        const q2b = `/${g(3, 'Q2B')}`;
        const e0 = scene({}, { overrides: { 3: { Transform: { x: 7 } } } });
        const e = { ...e0, nestedStructure: { '5': { added: [{ ...k1, guid: G(130), overrides: { 3: { Transform: { x: 5 } } } }] } } } as SceneEntityEntry;
        expect(await check([e], e)).toEqual([]);
        expect(((await fold(e)).f.nodes.get(`${K1}${q2b}` as never)?.traits.Transform as { x?: number })?.x).toBe(7);
      });

      it('re-review N3: a guid-less keyed node the COPY states is not "restored" as if a document supplied it', async () => {
        const kq = { parentLocalId: 2, guid: '', key: 'kq', name: 'KQ', traits: { EntityAttributes: { name: 'KQ' }, Transform: tf }, children: [] };
        const { parsed } = await fold(scene({}, { added: [kq] }));
        expect(parsed.record.list.rows.get(`${K1}/a+kq` as never)?.removed).toBeUndefined();
      });

      it('F5: a frame the base reaches that cannot be read holds the copy whole (all or nothing); one it does not reach does not', async () => {
        const e = scene({ members: { [deep]: { traitRemovals: { Light: true } } } }, { members: {} }, [Q2]);
        expect((await fold(e)).parsed.record.held.pendingLegacy).toEqual({ members: { [`/${g(5, 'R')}/${g(2, 'QA')}`]: { added: [{ ...k1, guid: G(95), members: {} }], heldRemainder: true } } });
        const quiet = scene({}, { members: {} }, [Q2]);
        expect((await fold(quiet)).parsed.record.held.pendingLegacy).toBeUndefined();
        // A row the base states there with VALUES only is no reason: values apply under the copy anyway (re-review N2).
        const values = scene({ members: { [deep]: { traits: { Transform: { x: 42 } } } } }, { overrides: { 3: { Transform: { x: 7 } } } }, [Q2]);
        expect((await fold(values)).parsed.record.held.pendingLegacy).toBeUndefined();
      });
    });

    describe('seed 1231: the base node\'s STRUCTURE records do not survive under the copy (today: `baseLayersOf`, values only)', () => {
      const deep = `/${g(4, 'S')}/${g(2, 'Q3XX')}`;
      it('the copy restates the base\'s removal: no Light, and the restated removal is applied (418(b)), not unused', async () => {
        const e = scene({ members: { [deep]: { traitRemovals: { Light: true } } } }, { members: { [deep]: { traitRemovals: { Light: true } } } });
        expect(await check([e], e)).toEqual([]);
        const { f } = await fold(e);
        expect(f.nodes.get(`${K1}${deep}` as never)?.traits.Light).toBeUndefined();
        expect(f.unused).toEqual([]);
      });
      it('the copy omits the base\'s removal: Light shows, as today', async () => {
        for (const at of [deep, `/${g(3, 'Q2B')}`]) {
          const e = scene({ members: { [at]: { traitRemovals: { Light: true } } } }, { members: {} });
          expect(await check([e], e)).toEqual([]);
          expect((await fold(e)).f.nodes.get(`${K1}${at}` as never)?.traits.Light).toBeDefined();
        }
      });
      it('the base removes a member the copy says nothing about: it shows, as today', async () => {
        const e = scene({ members: { [deep]: { removed: true } } }, { members: {} });
        expect(await check([e], e)).toEqual([]);
        expect((await fold(e)).f.nodes.has(`${K1}${deep}` as never)).toBe(true);
      });
      it('the base adds a node at a deeper member the copy says nothing about: it is not there, as today', async () => {
        const e = scene({ members: { [deep]: { added: [k2] } } }, { members: {} });
        expect(await check([e], e)).toEqual([]);
        expect((await fold(e)).f.nodes.has(`${K1}/${g(4, 'S')}/a+k2` as never)).toBe(false);
      });
      it('through a reference node a DOCUMENT supplies to both (not the copy): the base\'s removal there does not apply either', async () => {
        const Q4 = { id: 'Q4', version: 5, rootLocalId: 1, entities: [row(1, 'Q4', 0), row(2, 'Q4Y', 1, lit('Q4Y', 1))] };
        const kx = { parentLocalId: 2, guid: '', key: 'kx', prefab: 'Q4', name: 'KX', traits: { EntityAttributes: { name: 'KX' }, Transform: tf }, children: [] };
        const Q2x = { ...Q2, entities: [...Q2.entities.slice(0, 3), row(4, 'S', 1, { prefab: 'Q3', added: [kx] })] };
        const at = `/${g(4, 'S')}/a+kx/${g(2, 'Q4Y')}`;
        const e = scene({ members: { [at]: { traitRemovals: { Light: true } } } }, { members: {} }, [Q2x, Q3, Q4]);
        expect(await check([e], e)).toEqual([]);
        expect((await fold(e)).f.nodes.get(`${K1}${at}` as never)?.traits.Light).toBeDefined();
      });
      it('a document that contains itself further down ends the walk (no stack overflow)', async () => {
        const Q3c = { ...Q3, entities: [...Q3.entities, row(3, 'Z', 1, { prefab: 'Q2' })] };
        const { parsed } = await fold(scene({ members: { [deep]: { removed: true } } }, { members: {} }, [Q2, Q3c]));
        expect(parsed.record.list.rows.get(`${K1}${deep}` as never)?.removed).toBe(false);
      });
      it('the base sets a field the copy says nothing about: a value layer, so it still holds (today: x=42)', async () => {
        const e = scene({ members: { [deep]: { traits: { Transform: { x: 42 } } } } }, { members: {} });
        expect(await check([e], e)).toEqual([]);
        expect(((await fold(e)).f.nodes.get(`${K1}${deep}` as never)?.traits.Transform as { x?: number })?.x).toBe(42);
      });
    });
  });

  it('a template-added reference node is nested in the document that WROTE it, not the frame it hangs in (fuzz seed 6)', async () => {
    const node = (prefab: string) => ({ parentLocalId: 1, guid: '', key: 'ks', prefab, name: 'K', traits: { EntityAttributes: { name: 'K' }, Transform: tf }, children: [] });
    const Q = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'Q', 0), row(2, 'QA', 1)] };
    const S = { id: 'S', version: 5, rootLocalId: 1, entities: [row(1, 'S', 0), row(2, 'QinS', 1, { prefab: 'Q' })] };
    // S nests Q, and the node hangs in R's frame of Q: no document contains itself.
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'R', 1, { prefab: 'Q', added: [node('S')] })] }, Q, S);
    expect(await check([top()], top())).toEqual([]);
    // A node of Q itself, written by P and hanging in R's frame of Q: P contains Q twice, still no cycle.
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'R', 1, { prefab: 'Q', added: [node('Q')] })] }, Q);
    expect(await check([top()], top())).toEqual([]);
  });

  it('#2018: a scene node anchored at a missing nested row hangs from its placeholder (today: under the instance root)', async () => {
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'R', 1, { prefab: 'M-missing' })] });
    const node = { parentLocalId: 2, guid: G(51), name: 'S', traits: { EntityAttributes: { name: 'S', guid: G(51) }, Transform: tf }, children: [] };
    const before = seen.ruledOwn;
    expect(await check([top({ added: [node] })], top({ added: [node] }))).toEqual([]);
    expect(seen.ruledOwn).toBe(before + 1);
  });

  it('#2018 (i), a ruled visible fix: a v17 own row at a missing nested row now shows under its placeholder (today hides it)', async () => {
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'R', 1, { prefab: 'M-missing' })] });
    const R = row(2, 'R', 1).nodeGuid;
    const s = { parentLocalId: 0, guid: G(54), name: 'S', traits: { EntityAttributes: { name: 'S', guid: G(54) }, Transform: tf }, children: [] };
    const e = top({ members: { [`/${R}`]: { own: [s] } } });
    const before = seen.ruledOwnFix;
    expect(await check([e], e)).toEqual([]);
    expect(seen.ruledOwnFix).toBe(before + 1);
  });

  it('a whole-list row on a gone member is held verbatim and unused at its key, as today keeps the row', async () => {
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'A', 1)] });
    const e = top({ members: { [`/${G(999)}`]: { removedTraits: ['Light'] } } });
    expect(await check([e], e)).toEqual([]);
  });

  it('item 4: a member moved to a scene node survives its template ancestor\'s removal, as today', async () => {
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'A', 1), row(3, 'X', 2)] });
    const entry = top({ removed: [2], moved: { 3: SCENE } });
    const holder = { id: 1, name: 'Holder', guid: SCENE, traits: { EntityAttributes: { name: 'Holder', guid: SCENE, parentId: 0 }, Transform: tf } } as SceneEntityEntry;
    expect(await check([holder, entry], entry)).toEqual([]);
  });

  it('item 5: a document-level move two frames deep lands where today puts it', async () => {
    const T = { id: 'T', version: 5, rootLocalId: 1, entities: [row(1, 'TRoot', 0), row(2, 'Tx', 1)] };
    const Q = { id: 'Q', version: 5, rootLocalId: 1, entities: [row(1, 'QRoot', 0), row(2, 'S', 1, { prefab: 'T' }), row(3, 'Qx', 1)] };
    const P0 = { id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'R', 1, { prefab: 'Q' })] };
    install(T, Q, P0);
    const byId = new Map([...memberIdentities('P', {}, reader)].map(([p, id]) => [id, p] as const));
    install(T, Q, { ...P0, moved: { [byId.get('/2/2/2')!]: memberToken(0, parseSteps(byId.get('/2/3')!)) } });
    expect(await check([top()], top())).toEqual([]);
  });

  it('item 3: a missing nested row under a removed member leaves no placeholder, as today spawns nothing', async () => {
    install({ id: 'P', version: 5, rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'A', 1), row(3, 'R', 2, { prefab: 'M-missing' })] });
    const before = seen.ruledD;
    expect(await check([top({ removed: [2] })], top({ removed: [2] }))).toEqual([]);
    expect(seen.ruledD).toBe(before);
  });
});
