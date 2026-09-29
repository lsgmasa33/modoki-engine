/** #1812 — the frame record's `unexpanded` list changes nothing for a frame whose rows all expanded, over the real corpus.
 *
 *  The scene save asks the frame record, not the editor cache, whether a nested row was expanded. For a frame the load
 *  built with every prefab readable the two must agree, so every corpus scene holding a prefab instance is loaded with its
 *  project's prefabs, saved once with the records as the expansions wrote them, and saved again with the field stripped
 *  from every record (which sends the capture back to the cache test it had before #1812). The two saves are compared
 *  byte for byte, and neither may carry the field (it is runtime only).
 *
 *  Mutation (measured): read the record without the claim (`return unexpanded.has(...)` in `nestedRowPresent`) — every
 *  expanded nested row reads as removed, and the space-console scenes diverge. What the corpus CANNOT see: a nested row a
 *  scene removed, and a row whose child is missing — no corpus scene has either, so a loader listing every row (or none)
 *  stays green here; `missingPrefabPassThrough.test.ts` § #1812 covers those. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createWorld } from 'koota';
import { readFileSync } from 'node:fs';
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
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { frameRootDoc, noteFrameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

// The shared corpus producer (#799): every tracked project file under games/ and demos/, its own `runtime/assets` only.
// ⚠️ `floor: 0`: Vitest collects a skipped describe's body too, and the OSS snapshot ships no `games/` — a floor here would
// throw at collection there and fail the file. The non-vacuity pins are inside the gated describe.
const corpus = (repoFiles({ under: ['games', 'demos'], match: (rel: string) => /\/runtime\/assets\/.*\.(scene|prefab)\.json$/.test(rel), exclude: ['node_modules', 'dist', 'ios', 'android', 'build'], floor: 0 }) as Array<{ rel: string; abs: string }>);
const projectOf = (rel: string) => rel.split('/').slice(0, 2).join('/');
/** Every project with a scene holding a prefab reference: its prefabs, and those scenes. */
const projects = [...new Set(corpus.map((f) => projectOf(f.rel)))].map((id) => {
  const files = corpus.filter((f) => projectOf(f.rel) === id);
  const scenes = files.filter((f) => f.rel.endsWith('.scene.json') && /"prefab":\s*"/.test(readFileSync(f.abs, 'utf8'))).map((f) => f.abs);
  return { id, prefabFiles: files.filter((f) => f.rel.endsWith('.prefab.json')).map((f) => f.abs), scenes };
}).filter((p) => p.scenes.length);

beforeAll(() => setRunMode('stopped'));
afterAll(() => { for (const id of prefabs.keys()) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  clearKeptMemberOrphans();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(data, {
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

let scenesWithRecords = 0;

describe.skipIf(!hasInternalGames())('#1812: the frame record\'s unexpanded list is inert for a frame that expanded every row (corpus)', () => {
  it('the corpus is not empty', () => {
    expect(projects.flatMap((p) => p.scenes).length).toBeGreaterThan(5);
  });

  for (const project of projects) {
    for (const scenePath of project.scenes) {
      it(`${project.id}: ${scenePath.slice(scenePath.lastIndexOf('/') + 1)}`, async () => {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
        for (const id of prefabs.keys()) setPrefabCache(id, null);
        prefabs.clear();
        for (const f of project.prefabFiles) {
          const doc = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as { id?: string };
          if (!doc.id) continue;
          prefabs.set(doc.id, doc);
          setPrefabCache(doc.id, doc as never);
        }
        await load(JSON.parse(readFileSync(scenePath, 'utf8').replace(/^\uFEFF/, '')) as SceneData);
        const world = getCurrentWorld();
        let recorded = 0;
        for (const e of world.entities) if (frameRootDoc(world, e as never)?.unexpanded) recorded++;
        // The scene's own `id` is minted per save when no scene path is open, and `createdAt` is the save's clock; everything
        // else must match byte for byte.
        const saveBytes = async () => {
          const { id: _id, createdAt: _at, ...rest } = (await serializeScene()) as unknown as Record<string, unknown>;
          return JSON.stringify(rest);
        };
        const withRecord = await saveBytes();
        for (const e of world.entities) {
          const rec = frameRootDoc(world, e as never);
          if (!rec?.unexpanded) continue;
          const { unexpanded: _u, ...rest } = rec;
          noteFrameRootDoc(world, e as never, rest as never);
        }
        const cacheOnly = await saveBytes();
        if (recorded) scenesWithRecords++; // a scene naming prefabs only in trait fields holds no instance, and no record
        expect(withRecord).not.toContain('"unexpanded"');
        let at = 0;
        while (at < withRecord.length && withRecord[at] === cacheOnly[at]) at++;
        // The first difference, with context, rather than two whole scenes.
        expect(withRecord.slice(Math.max(0, at - 200), at + 200)).toBe(cacheOnly.slice(Math.max(0, at - 200), at + 200));
        expect(withRecord).toBe(cacheOnly);
        vi.unstubAllGlobals();
      });
    }
  }

  it('not inert: most of those scenes built frames with records (runs last)', () => {
    expect(scenesWithRecords).toBeGreaterThan(10);
  });
});
