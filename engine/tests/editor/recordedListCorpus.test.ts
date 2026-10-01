/** I23 over the real corpus (#1914): a load→save carries an instance's recorded override list verbatim.
 *
 *  An instance's override records are what its file states, and nothing re-derives them (docs/prefabs.md § I2, I23). So
 *  for every corpus scene holding a prefab instance, the records the load seeds from the file must be the records the
 *  load of its OWN save seeds (nothing was dropped, nothing added), and that save must be stable (save→reload→save is
 *  byte-identical). The same for every prefab document with a reference row, through the prefab editor's world: its
 *  rows are that layer's records.
 *
 *  It is also the #1914 build's corpus gate. With `MODOKI_RECORD_CORPUS_DUMP=<file>` it writes every first save, so two
 *  trees' dumps can be compared (`0 corpus diffs` per step).
 *
 *  Mutation (measured in #1914 R0, again in R3c): write a recorded field only where its value differs from the base
 *  (in `recordedOverrides`), and the scenes whose files restate a base value go red on the record comparison.
 *  Mutations of the FILE comparison (#1933): keep no unused record (`withKeptLegacy`/`withKeptLocalRecords` return their
 *  channels) — Base and the space-console scenes go red on `statementsLost`, which the marks cannot see; and the floor
 *  counts file statements, not F7's implied root order, which every instance now records. The "nothing GAINED" half
 *  (`statementsGained`, #1933 N1, landed with #1938 C-B step 1): without `absenceIsRemoval` in the capture's removal diff,
 *  the scenes whose prefabs carry a game trait this suite does not register (sling's Fish, space-console's) go red. */

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
  getCurrentWorld, setCurrentWorld, getTraitByName, setRunMode, loadSceneFile, instantiatePrefabIntoWorld, destroyEntity,
  getAllEntities, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { buildPrefabEditScene, serializePrefabEditWorld, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getOverrideMarkSet, ROTATION_MARKS } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import type { PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';

registerAllTraits();

// `floor: 0`, as frameRecordCorpus.test.ts: the OSS snapshot ships no `games/`, and the non-vacuity pins are inside the gate.
const corpus = (repoFiles({ under: ['games', 'demos'], match: (rel: string) => /\/runtime\/assets\/.*\.(scene|prefab)\.json$/.test(rel), exclude: ['node_modules', 'dist', 'ios', 'android', 'build'], floor: 0 }) as Array<{ rel: string; abs: string }>);
const projectOf = (rel: string) => rel.split('/').slice(0, 2).join('/');
const read = (abs: string) => JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
const projects = [...new Set(corpus.map((f) => projectOf(f.rel)))].map((id) => {
  const files = corpus.filter((f) => projectOf(f.rel) === id);
  const prefabFiles = files.filter((f) => f.rel.endsWith('.prefab.json'));
  return {
    id,
    prefabFiles: prefabFiles.map((f) => f.abs),
    scenes: files.filter((f) => f.rel.endsWith('.scene.json') && /"prefab":\s*"/.test(readFileSync(f.abs, 'utf8'))).map((f) => f.rel),
    // A document holding a reference row: its rows are a layer's records.
    nesting: prefabFiles.filter((f) => ((read(f.abs).entities ?? []) as Array<{ prefab?: string }>).some((e) => !!e.prefab)).map((f) => f.rel),
  };
}).filter((p) => p.scenes.length || p.nesting.length);
const absOf = (rel: string) => corpus.find((f) => f.rel === rel)!.abs;

const dump: Record<string, unknown> = {};

beforeAll(() => setRunMode('stopped'));
afterAll(() => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  getCurrentWorld()?.destroy();
  const out = process.env.MODOKI_RECORD_CORPUS_DUMP;
  if (out) writeFileSync(out, JSON.stringify(Object.fromEntries(Object.entries(dump).sort(([x], [y]) => x.localeCompare(y))), null, 1));
});

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
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const installProject = (prefabFiles: string[]) => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  prefabs.clear();
  for (const f of prefabFiles) {
    const doc = read(f) as { id?: string };
    if (!doc.id) continue;
    prefabs.set(doc.id, doc);
    setPrefabCache(doc.id, doc as never);
  }
};

/** Every live entity's override records, by guid (entities with none left out). */
const records = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const e of getAllEntities()) {
    const ent = findEntity(e.id);
    const set = ent ? getOverrideMarkSet(ent) : undefined;
    if (set && set.size) out[e.guid ?? `#${e.id}`] = [...set].sort();
  }
  return out;
};

/** The scene's own `id` is minted per save when no scene path is open, and `createdAt` is the save's clock. */
const saveScene = async () => {
  const { id: _id, createdAt: _at, ...rest } = (await serializeScene()) as unknown as Record<string, unknown>;
  return rest;
};

/** The statements a stored instance's record channels make, as signatures with their addressing left out — a field
 *  `T.f=<value>`, a component added with no fields `+T`, a removal `-T` (a restore `~T`), a member removal, a move, an added
 *  node — so a file's legacy localId channels and the rows its save writes for them compare (#1933). The marks comparison
 *  below cannot see a record dropped at LOAD (both of its sides are loads) or an unused one (unused records are never
 *  marked); this compares the save with the FILE. The entry's own `traits` (name, parent, placement) are not records. */
function statementSignatures(e: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const add = (s: string) => out.set(s, (out.get(s) ?? 0) + 1);
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const bag = (b: unknown) => {
    if (!isObj(b)) return;
    for (const [t, f] of Object.entries(b)) {
      add(`@${t}`); // the component is stated in this bag, with fields or without: what keeps a `+T` (statementsLost)
      if (!isObj(f) || !Object.keys(f).length) add(`+${t}`);
      else for (const [k, v] of Object.entries(f)) add(`${t}.${k}=${JSON.stringify(v)}`);
    }
  };
  const nodes = (v: unknown) => { for (const n of list(v)) add(`added:${(n as { name?: string; key?: string })?.name ?? (n as { key?: string })?.key ?? '?'}`); };
  const structure = (s: unknown) => {
    if (!isObj(s)) return;
    nodes(s.added);
    for (const _ of list(s.removed)) add('removed');
    for (const names of Object.values(isObj(s.removedTraits) ? s.removedTraits : {})) for (const n of list(names)) add(`-${String(n)}`);
    for (const _ of Object.keys(isObj(s.moved) ? s.moved : {})) add('moved');
  };
  for (const b of Object.values(isObj(e.overrides) ? e.overrides : {})) bag(b);
  for (const frame of Object.values(isObj(e.nestedOverrides) ? e.nestedOverrides : {})) for (const b of Object.values(isObj(frame) ? frame : {})) bag(b);
  structure({ added: e.added, removed: e.removed, removedTraits: e.removedTraits, moved: e.moved });
  for (const s of Object.values(isObj(e.nestedStructure) ? e.nestedStructure : {})) structure(s);
  for (const r of Object.values(isObj(e.members) ? e.members : {})) {
    if (!isObj(r)) continue;
    bag(r.traits);
    for (const n of list(r.removedTraits)) add(`-${String(n)}`);
    for (const [t, on] of Object.entries(isObj(r.traitRemovals) ? r.traitRemovals : {})) add(on ? `-${t}` : `~${t}`);
    if (r.removed) add('removed');
    if (r.parent !== undefined) add('moved');
    nodes(r.added);
    nodes(r.own);
  }
  return out;
}

/** F7 (#1914 R6): every instance records its root's sortOrder, so a save may state one its file did not. */
const isF7Order = (s: string) => s.startsWith('EntityAttributes.sortOrder=');
/** A bag's mention of a component — bookkeeping for `+T`, not a statement of its own. */
const isMention = (s: string) => s.startsWith('@');

/** Each stored instance of `from` (a scene's entries, or a document's reference rows) with its counterpart in `to`, paired
 *  by the first identifier `from` gives it (guid, then nodeGuid, then localId), each looked up in its own index: a pre-v5
 *  row has no nodeGuid until the save mints one, so one combined key would pair it with nothing. */
function pairInstances(from: Record<string, unknown>, to: Record<string, unknown>): Array<{ label: string; e: Record<string, unknown>; other?: Record<string, unknown> }> {
  const keys = ['guid', 'nodeGuid', 'localId'] as const;
  const toEntities = (to.entities ?? []) as Array<Record<string, unknown>>;
  const index = new Map(keys.map((k) => [k, new Map(toEntities.filter((e) => e[k] != null).map((e) => [String(e[k]), e]))]));
  return ((from.entities ?? []) as Array<Record<string, unknown>>).filter((e) => e.prefab).map((e) => {
    const k = keys.find((key) => e[key] != null && index.get(key)!.has(String(e[key]))) ?? keys.find((key) => e[key] != null);
    return { label: k ? `${k}:${String(e[k])}` : '(no id)', e, other: k ? index.get(k)!.get(String(e[k])) : undefined };
  });
}

/** Every statement of each stored instance in `file` that `saved` no longer makes — a record the load or the save
 *  dropped. A `+T` (a component added with no fields) is kept when the save mentions `T` in as many bags as the file did
 *  (`@T`), since the save writes the component's fields once it carries them: a mention rescues one `+T`, so a second
 *  member's dropped add still counts as lost. */
function statementsLost(file: Record<string, unknown>, saved: Record<string, unknown>): string[] {
  const lost: string[] = [];
  for (const { label, e, other } of pairInstances(file, saved)) {
    const had = statementSignatures(e);
    const have = other ? statementSignatures(other) : new Map<string, number>();
    const mentions = (m: Map<string, number>, s: string) => m.get(`@${s.slice(1)}`) ?? 0;
    const kept = (s: string, n: number) => (have.get(s) ?? 0) >= n || (s.startsWith('+') && mentions(have, s) >= mentions(had, s));
    for (const [s, n] of had) if (!isMention(s) && !kept(s, n)) lost.push(`${label} ${s}`);
  }
  return lost;
}

/** Every statement `saved` makes of a stored instance that its `file` did not (#1933 N1: a save wrote a removal of every
 *  component whose trait is not registered, which no file stated). Allowed: F7's root order, which every instance now
 *  records; a field of a component the file added with no fields (`+T`), which the save fills in; and the rest of the
 *  rotation where the file states one axis (`ROTATION_MARKS`, #1880: rotation is one value, so one mark). */
function statementsGained(file: Record<string, unknown>, saved: Record<string, unknown>): string[] {
  const gained: string[] = [];
  for (const { label, e, other } of pairInstances(saved, file)) {
    const has = statementSignatures(e);
    const had = other ? statementSignatures(other) : new Map<string, number>();
    const filled = (s: string) => /^[^.+@~-][^.]*\./.test(s) && (had.get(`+${s.slice(0, s.indexOf('.'))}`) ?? 0) > 0;
    const rotation = (s: string) => ROTATION_MARKS.some((k) => s.startsWith(`${k}=`))
      && [...had.keys()].some((h) => ROTATION_MARKS.some((k) => h.startsWith(`${k}=`)));
    for (const [s, n] of has) if (!isMention(s) && !isF7Order(s) && (had.get(s) ?? 0) < n && !filled(s) && !rotation(s)) gained.push(`${label} ${s}`);
  }
  return gained;
}

/** Statements a file makes other than F7's implied root order: what makes a corpus file a real test of the keep. */
const fileStatements = (file: Record<string, unknown>) => ((file.entities ?? []) as Array<Record<string, unknown>>)
  .filter((e) => e.prefab).reduce((n, e) => n + [...statementSignatures(e)].filter(([s]) => !isF7Order(s) && !isMention(s)).reduce((m, [, c]) => m + c, 0), 0);

describe('statementsLost, the check the corpus rests on (#1933)', () => {
  const P = 'p-guid';
  it('pairs a pre-v5 row (localId only) with its saved self, which the save gave a nodeGuid', () => {
    const file = { entities: [{ localId: 3, prefab: P, overrides: { 7: { Transform: { x: 1 } } } }] };
    const kept = { entities: [{ localId: 3, nodeGuid: 'n-3', prefab: P, members: { a: { traits: { Transform: { x: 1 } } } } }] };
    expect(statementsLost(file, kept)).toEqual([]);
    expect(statementsLost(file, { entities: [{ localId: 3, nodeGuid: 'n-3', prefab: P }] })).toEqual(['localId:3 Transform.x=1']);
  });
  it('a component added with no fields is kept by the save stating its fields, and lost when the save says nothing of it', () => {
    const file = { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: {} } } } }] };
    expect(statementsLost(file, { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: { speed: 1 } } } } }] })).toEqual([]);
    expect(statementsLost(file, { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3DX: { speed: 1 } } } } }] })).toEqual(['guid:g +Rotate3D']);
  });
  it('one bag stating T rescues one fieldless add: a second member\'s dropped add is lost', () => {
    const two = { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: {} } }, b: { traits: { Rotate3D: { speed: 2 } } } } }] };
    expect(statementsLost(two, { entities: [{ guid: 'g', prefab: P, members: { b: { traits: { Rotate3D: { speed: 2 } } } } }] })).toEqual(['guid:g +Rotate3D']);
    const pair = { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: {} } }, c: { traits: { Rotate3D: {} } } } }] };
    expect(statementsLost(pair, { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: { speed: 1 } } } } }] })).toEqual(['guid:g +Rotate3D']);
    expect(statementsLost(pair, { entities: [{ guid: 'g', prefab: P, members: { a: { traits: { Rotate3D: { speed: 1 } } }, c: { traits: { Rotate3D: {} } } } }] })).toEqual([]);
  });
});

describe('statementsGained, the corpus check that a save states nothing its file did not (#1933 N1)', () => {
  const P = 'p-guid';
  const inst = (bag: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ entities: [{ guid: 'g', prefab: P, members: { a: { traits: bag, ...extra } } }] });
  it('a removal no file stated is gained', () => {
    expect(statementsGained(inst({ Fish: { speed: 1 } }), inst({ Fish: { speed: 1 } }, { removedTraits: ['Fish'] }))).toEqual(['guid:g -Fish']);
  });
  it('allowed: a fieldless add filled in, and the rest of a rotation the file states one axis of', () => {
    expect(statementsGained(inst({ Rotate3D: {} }), inst({ Rotate3D: { speed: 1 } }))).toEqual([]);
    expect(statementsGained(inst({ Transform: { ry: 0.3 } }), inst({ Transform: { rx: 0, ry: 0.3, rz: 0 } }))).toEqual([]);
    expect(statementsGained(inst({ Transform: { x: 1 } }), inst({ Transform: { x: 1, rx: 0 } }))).toEqual(['guid:g Transform.rx=0']);
  });
});

let scenesWithRecords = 0;
let docsChecked = 0;

describe.skipIf(!hasInternalGames())('I23: a load→save carries the recorded list verbatim (corpus, #1914)', () => {
  it('the corpus is not empty', () => {
    expect(projects.flatMap((p) => p.scenes).length).toBeGreaterThan(5);
    expect(projects.flatMap((p) => p.nesting).length).toBeGreaterThan(5);
  });

  for (const project of projects) {
    for (const rel of project.scenes) {
      it(`${rel}`, async () => {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
        installProject(project.prefabFiles);
        const file = read(absOf(rel));
        await load(file as unknown as SceneData);
        const fromFile = records();
        const first = await saveScene();
        dump[rel] = first;
        await load(first as unknown as SceneData);
        const fromSave = records();
        const second = await saveScene();
        if (fileStatements(file) > 0) scenesWithRecords++;
        expect(statementsLost(file, first)).toEqual([]);
        expect(statementsGained(file, first)).toEqual([]);
        expect(fromSave).toEqual(fromFile);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        vi.unstubAllGlobals();
      });
    }
    for (const rel of project.nesting) {
      it(`${rel} (prefab editor)`, async () => {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
        installProject(project.prefabFiles);
        const doc = read(absOf(rel)) as unknown as PrefabFile;
        const serialize = async (d: PrefabFile) => {
          prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never);
          await load(buildPrefabEditScene(d) as SceneData);
          expect(getAllEntities().some((e) => e.guid === PREFAB_EDIT_ROOT_GUID)).toBe(true);
          // What the prefab editor's Save writes (it keeps the rows' identity from the document the world was built from).
          const out = serializePrefabEditWorld(d.id!);
          if ('error' in out) throw new Error(out.error);
          return { saved: out.prefab, recs: records() };
        };
        const a = await serialize(doc);
        dump[rel] = a.saved;
        expect(statementsLost(doc as unknown as Record<string, unknown>, a.saved as unknown as Record<string, unknown>)).toEqual([]);
        expect(statementsGained(doc as unknown as Record<string, unknown>, a.saved as unknown as Record<string, unknown>)).toEqual([]);
        const b = await serialize(JSON.parse(JSON.stringify(a.saved)) as PrefabFile);
        docsChecked++;
        expect(b.recs).toEqual(a.recs);
        if (process.env.MODOKI_RECORD_CORPUS_DEBUG) writeFileSync(`${process.env.MODOKI_RECORD_CORPUS_DEBUG}/${rel.replace(/\//g, '_')}.json`, JSON.stringify({ a: a.saved, b: b.saved }, null, 1));
        expect(JSON.stringify(b.saved)).toBe(JSON.stringify(a.saved));
        vi.unstubAllGlobals();
      });
    }
  }

  it('not inert: the scenes carried records, and the prefab documents ran (runs last)', () => {
    expect(scenesWithRecords).toBeGreaterThanOrEqual(10);
    expect(docsChecked).toBeGreaterThan(5);
  });
});
