/** #1891 (hunt seed 1233), stated without runtime ids: its fuzz list stopped reaching the case once #1880 F6 renumbered
 *  the rebuilt entry's ids (the list picks its targets in id order). The documents and the scene entry are the fuzz run's
 *  own, read from its dump (`tests/fixtures/prefab-1891-whole-list.json`).
 *
 *  HR nests Q as row QR, whose TEMPLATE `added` holds an O reference node (key 10000011) with a member row removing
 *  Rotate3D from N/A. The scene states QR's list WHOLE, with its own copy of OR, which carries the template key. A load
 *  hands that copy only its own statement, so A keeps the Rotate3D O's row N gives it. A rebuild of the copy by itself
 *  used to ask `frameForward`, which matched the copy to the template node BY KEY and forwarded the template's removal:
 *  A lost Rotate3D (T4, "a no-op rebuild is not the identity"). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import type { PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/prefab-1891-whole-list.json', import.meta.url), 'utf8')) as {
  docs: Array<{ id: string; name: string }>; scene: SceneData;
};
const O = fixture.docs.find((d) => d.name === 'O')!.id;
const HR = fixture.docs.find((d) => d.name === 'HR')!.id;
const A = 'f41bc8d1-5b3c-b630-6190-c68b0c0ddcfa';
const OR_COPY = 'b48e61de-d5bb-d0d7-56ec-c69479b99c4d';
const HR_ROOT = '1000000b-0000-4000-8000-25eda8900000';

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      for (const e of getCurrentWorld().entities) if (e.id() === id) { destroyEntity(e, getCurrentWorld()); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
      return id ?? undefined;
    },
  });
}

const idOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)?.id ?? 0;
const hasRotate = () => !!readTraitData(idOf(A), getTraitByName('Rotate3D')!);

describe('#1891 seed 1233: a scene copy of a template reference node, in a WHOLE list, rebuilds as a load gives it', () => {
  beforeEach(async () => {
    setRunMode('stopped');
    prefabs.clear();
    for (const d of fixture.docs) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); }
    await load(fixture.scene);
  });

  it('premise: the load gives A the Rotate3D O\'s row N adds (the template node\'s removal is not forwarded onto the copy)', () => {
    expect(idOf(OR_COPY)).toBeGreaterThan(0);
    expect(hasRotate()).toBe(true);
  });

  it('a no-op rebuild of the whole entry (HR) keeps it', () => {
    const doc = getCachedPrefabSync(HR) as PrefabFile;
    expect(refreshInstances(HR, [idOf(HR_ROOT)], doc, doc)).toBe(1);
    expect(hasRotate()).toBe(true);
  });

  // #1880 F6e's measuring case: the copy is a stored root INSIDE HR, rebuilt by itself until F6e mapped it to its outermost
  // entry. An expected failure until then; F6e flipped it to `it`.
  it('a no-op rebuild of the copy itself keeps it (F6e: the copy rebuilds through its outermost entry)', () => {
    const doc = getCachedPrefabSync(O) as PrefabFile;
    expect(refreshInstances(O, [idOf(OR_COPY)], doc, doc)).toBe(1);
    expect(hasRotate()).toBe(true);
  });
});
