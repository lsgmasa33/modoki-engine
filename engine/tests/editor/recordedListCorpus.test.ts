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
 *  (in `recordedOverrides`), and the scenes whose files restate a base value go red on the record comparison. */

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
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
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
        await load(read(absOf(rel)) as unknown as SceneData);
        const fromFile = records();
        const first = await saveScene();
        dump[rel] = first;
        await load(first as unknown as SceneData);
        const fromSave = records();
        const second = await saveScene();
        if (Object.keys(fromFile).length) scenesWithRecords++;
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
