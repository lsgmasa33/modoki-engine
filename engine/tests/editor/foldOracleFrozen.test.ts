/** The #2007 oracle's TODAY side, frozen (design § 10.4b; #2001 S5, #2028).
 *
 *  Before S5 the oracle compared `foldInstance(parse(entry))` with what today's spawner builds. From S5 the load IS fold +
 *  realize, so that comparison checks only that realize builds what the fold says, never what the fold says against what
 *  today showed: it would go green by construction. So the pre-S5 load's tree of every instance, with the rules' visible
 *  changes applied to it (`translatedLive`: B, D and #2018's own links at a placeholder), and the stores today keeps for
 *  the save, is FROZEN here, and each later load must reproduce it. A difference is a visible change no rule made.
 *
 *  Inputs are fixed, so the comparison is too: the corpus scenes (internal games; frozen as hashes, since their content is
 *  private), and the scenes the prefab fuzzer's verify seeds saved, with the documents their load read (synthetic,
 *  committed as fixtures under `fixtures/foldOracleFrozen/`, written by `foldInstanceOracleFuzz.test.ts` with
 *  `MODOKI_FOLD_ORACLE_FREEZE=1`). The fuzz runs themselves are not replayed: S5 changes what a run does, so a run's
 *  saved scene is no fixed input.
 *
 *  Regenerate the frozen forms (ONLY on the pre-S5 load, or when the owner rules a new visible change): run this file with
 *  `MODOKI_FOLD_ORACLE_FREEZE=1`. `MODOKI_FOLD_ORACLE_DUMP=<dir>` writes every form in full (translated and not), for a
 *  before/after diff. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createWorld } from 'koota';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { parseInstanceRecord } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { checkInstance, frozenForm, liveTree, seen, translatedLive } from './foldOracle';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { fileForms, FILE_FORMS, type FileForm } from './prefabFuzz/fileForms';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'foldOracleFrozen');
const FROZEN = path.join(here, 'fixtures', 'foldOracleFrozen.json');
const FREEZE = process.env.MODOKI_FOLD_ORACLE_FREEZE === '1';
const DUMP = process.env.MODOKI_FOLD_ORACLE_DUMP;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const readJson = (abs: string) => JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;

type Frozen = Record<string, Record<string, string>>;
const frozen: Frozen = existsSync(FROZEN) ? JSON.parse(readFileSync(FROZEN, 'utf8')) as Frozen : {};
const written: Frozen = {};

beforeAll(() => setRunMode('stopped'));
afterAll(() => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  getCurrentWorld()?.destroy();
  if (FREEZE) writeFileSync(FROZEN, `${JSON.stringify(Object.fromEntries(Object.keys(written).sort().map((k) => [k, written[k]])), null, 1)}\n`);
});

const install = (docs: Iterable<unknown>) => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  prefabs.clear();
  for (const doc of docs) {
    const id = (doc as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    prefabs.set(id, doc);
    setPrefabCache(id, doc as never);
  }
};
const reader: PrefabReader = (g) => (prefabs.has(g) ? { doc: prefabs.get(g) as PrefabDoc } : { missing: true });

/** The load, through a callback shaped as SceneManager's `onInstantiatePrefab` (root guid, editor folder, root extra
 *  traits), with everything the loader hands the callback passed on to the spawner. */
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
        { ...(ld as object | undefined) } as never,
      );
      const root = id ? [...getCurrentWorld().entities].find((e) => e.id() === id) : undefined;
      if (!root) return id ?? undefined;
      if (rootGuid || rootEditorFolder) {
        root.set(eaMeta.trait, { ...(root.get(eaMeta.trait) as object), ...(rootGuid ? { guid: rootGuid } : {}), ...(rootEditorFolder ? { editorFolder: rootEditorFolder } : {}) });
      }
      for (const [name, d] of Object.entries(rootExtraTraits ?? {})) {
        const meta = getTraitByName(name);
        if (!meta) continue;
        const isTag = meta.category === 'tag' || d === true;
        if (root.has(meta.trait)) { if (!isTag) root.set(meta.trait, d as Record<string, unknown>); }
        else root.add(isTag ? (meta.trait as unknown as () => never)() : (meta.trait as unknown as (x: unknown) => never)(d));
      }
      return id;
    },
  });
}

/** Load `scene` and return each top-level instance's frozen form, by its root guid. */
async function formsOf(scene: Record<string, unknown>, dumpAs: string): Promise<Map<string, string>> {
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  await load(scene as unknown as SceneData);
  vi.unstubAllGlobals();
  const entries = (scene.entities ?? []) as SceneEntityEntry[];
  const idToGuid = new Map(entries.map((e) => [e.id, e.guid] as const));
  const held = new Set(entries.map((e) => e.guid).filter((g): g is string => !!g));
  const copies = new Set(Object.keys((scene.embeddedPrefabs ?? {}) as object));
  const version = typeof scene.version === 'number' ? scene.version : 0;
  const ea = getTraitByName('EntityAttributes')!.trait;
  const out = new Map<string, string>();
  const dump: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!entry.prefab || !entry.guid) continue;
    const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
    if (!root) { out.set(entry.guid, 'no live root'); continue; }
    const rec = parseInstanceRecord(entry, reader, {
      sceneVersion: version, sceneHadCopies: !!scene.embeddedPrefabs, held: (g) => held.has(g),
      parentGuid: (r) => (typeof r === 'number' ? idToGuid.get(r) ?? '' : typeof r === 'string' ? r : ''),
    }).record;
    if (DUMP) dump[entry.guid] = { untranslated: JSON.parse(frozenForm({ live: liveTree(root.id()), ruledKept: [] }, entry.guid)) };
    const form = frozenForm(translatedLive(rec, reader, root.id(), copies), entry.guid);
    if (DUMP) (dump[entry.guid] as Record<string, unknown>).translated = JSON.parse(form);
    out.set(entry.guid, form);
  }
  if (DUMP) { mkdirSync(DUMP, { recursive: true }); writeFileSync(path.join(DUMP, `${dumpAs}.json`), JSON.stringify(dump, null, 1)); }
  return out;
}

/** Compare (or, freezing, record) one case's forms. `hashed`: store a digest only (private content). */
function settle(caseKey: string, forms: Map<string, string>, hashed: boolean): void {
  const got: Record<string, string> = {};
  for (const [guid, form] of forms) got[hashed ? sha(guid) : guid] = hashed ? sha(form) : form;
  if (FREEZE) { written[caseKey] = got; return; }
  const want = frozen[caseKey];
  expect(want, `${caseKey}: not frozen (run with MODOKI_FOLD_ORACLE_FREEZE=1 on the pre-S5 load)`).toBeTruthy();
  expect(Object.keys(got).sort()).toEqual(Object.keys(want!).sort());
  for (const k of Object.keys(want!)) {
    if (hashed) expect(got[k], `${caseKey} ${k}: the load's tree differs from the frozen pre-S5 one (MODOKI_FOLD_ORACLE_DUMP for detail)`).toBe(want![k]);
    else expect(withoutPlaceholderNodes(got[k]!), `${caseKey} ${k}`).toEqual(withoutPlaceholderNodes(want![k]!));
  }
}

/** A form as the rules' visible changes leave it comparable (design § 10.4b), applied to both sides alike:
 *  - no node AT a placeholder: a placeholder entity's own fields are not compared (the frozen side's translation removed
 *    today's expansion there and had no placeholder entity to show). Its existence is: `placeholders` is compared whole;
 *  - no kept leaf at or under a placeholder: the placeholder keeps every record under it verbatim (rule 9), where today
 *    expanded a copy and kept the unused ones in its stores (ruling B);
 *  - `ruledKept`, the own links today kept unshown that the rules show (#2018 (i)), is the frozen side's note: each takes
 *    its kept `own` leaf with it, and the shown link is compared in `anchors`. */
function withoutPlaceholderNodes(form: string): unknown {
  const f = JSON.parse(form) as { nodes: [string, ...unknown[]][]; placeholders: string[]; kept: string[]; ruledKept: string[] };
  const at = new Set(f.placeholders);
  const under = (k: string) => [...at].some((p) => k === p || k.startsWith(p === '/' ? '/' : `${p}/`));
  const kept = [...f.kept];
  for (const k of f.ruledKept) { const i = kept.indexOf(`${k} own`); if (i >= 0) kept.splice(i, 1); }
  return {
    ...f, nodes: f.nodes.filter((n) => !at.has(n[0])), ruledKept: undefined,
    kept: kept.filter((l) => l.startsWith('(legacy)') || !under(l.slice(0, l.indexOf(' ')))),
  };
}

const fuzzCases = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort() : [];

describe('#2028: the load reproduces the frozen pre-S5 tree (the fuzzer\'s saved scenes)', () => {
  for (const file of fuzzCases) {
    it(file, async () => {
      const fx = readJson(path.join(FIXTURES, file)) as { scene: Record<string, unknown>; prefabs: unknown[] };
      install(fx.prefabs);
      settle(`fuzz/${file}`, await formsOf(fx.scene, `fuzz-${file.replace(/\.json$/, '')}`), false);
    });
  }
  it('has fixtures (non-vacuity)', () => expect(fuzzCases.length).toBeGreaterThan(5));
});

/** #2030's file forms, judged on the frozen pre-S5 saves (#2028). They state a user's node AT a Missing Prefab placeholder,
 *  which the editor wrote only while rule B's copy was expanded around it: from S5 a load shows the placeholder, and a node
 *  can no longer be hung at a nested one, so the fuzzer's own saves (`foldInstanceOracleFuzz.test.ts`) reach only the root
 *  forms. Each variant is loaded and its fold's placement judged by the rules (`placementDiverge`) against the live tree. */
describe('#2030: the file forms of the frozen pre-S5 saves are placed by the rules', () => {
  const forms = Object.fromEntries(FILE_FORMS.map((k) => [k, 0])) as Record<FileForm, number>;
  let slotJudged = 0;
  for (const file of fuzzCases) {
    it(file, async () => {
      const fx = readJson(path.join(FIXTURES, file)) as { scene: Record<string, unknown>; prefabs: unknown[] };
      install(fx.prefabs);
      const scene = fx.scene as { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown; version?: unknown };
      const held = new Set((scene.entities ?? []).map((e) => e.guid).filter((g): g is string => !!g));
      const opts = { sceneVersion: typeof scene.version === 'number' ? scene.version : 0, sceneHadCopies: !!scene.embeddedPrefabs, held: (g: string) => held.has(g) };
      const copies = new Set(Object.keys((scene.embeddedPrefabs ?? {}) as object));
      const ea = getTraitByName('EntityAttributes')!.trait;
      const lines: string[] = [];
      const slot0 = seen.heldSlotAdded;
      for (const v of fileForms(scene as never, reader, (entry) => [...foldInstance(reader, parseInstanceRecord(entry, reader, opts).record).placeholders.keys()])) {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
        await load(v.scene as unknown as SceneData);
        vi.unstubAllGlobals();
        const entry = v.scene.entities![v.entry]!;
        const root = [...getCurrentWorld().entities].find((e) => (e.get(ea) as { guid?: string } | undefined)?.guid === entry.guid);
        if (!root) { lines.push(`${v.form}: no live root`); continue; }
        for (const d of checkInstance(entry, reader, root.id(), opts, copies)) lines.push(`${v.form}: ${entry.name}: ${d}`);
        forms[v.form]++;
      }
      slotJudged += seen.heldSlotAdded - slot0;
      expect(lines).toEqual([]);
    });
  }
  // Every one of #2025's file forms was generated and judged, and a held slot node judged rather than left unjudged.
  it('judged every form (non-vacuity)', () => {
    for (const k of FILE_FORMS) expect(forms[k], k).toBeGreaterThan(0);
    expect(slotJudged).toBeGreaterThan(0);
  });
});

const corpus = (repoFiles({ under: ['games', 'demos'], match: (rel: string) => /\/runtime\/assets\/.*\.(scene|prefab)\.json$/.test(rel), exclude: ['node_modules', 'dist', 'ios', 'android', 'build'], floor: 0 }) as Array<{ rel: string; abs: string }>);
const projectOf = (rel: string) => rel.split('/').slice(0, 2).join('/');
const projects = [...new Set(corpus.map((f) => projectOf(f.rel)))].map((id) => {
  const files = corpus.filter((f) => projectOf(f.rel) === id);
  return {
    prefabFiles: files.filter((f) => f.rel.endsWith('.prefab.json')).map((f) => f.abs),
    scenes: files.filter((f) => f.rel.endsWith('.scene.json') && /"prefab":\s*"/.test(readFileSync(f.abs, 'utf8'))),
  };
}).filter((p) => p.scenes.length);

describe.skipIf(!hasInternalGames())('#2028: the load reproduces the frozen pre-S5 tree (corpus)', () => {
  let n = 0;
  for (const project of projects) {
    for (const scene of project.scenes) {
      it(`corpus scene ${sha(scene.rel).slice(0, 8)}`, async () => {
        install(project.prefabFiles.map(readJson));
        settle(`corpus/${sha(scene.rel)}`, await formsOf(readJson(scene.abs), `corpus-${sha(scene.rel).slice(0, 8)}`), true);
        n++;
      });
    }
  }
  it('checked the corpus (non-vacuity)', () => expect(n).toBeGreaterThan(10));
});
