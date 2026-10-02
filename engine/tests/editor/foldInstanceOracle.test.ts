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
  });
});
