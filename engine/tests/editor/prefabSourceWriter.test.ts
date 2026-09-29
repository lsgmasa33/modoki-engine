/** #1828 (owner ruling 2026-09-29, "Build it") — `setPrefabSource` writes `PrefabInstance.source` from the DOCUMENT its
 *  caller holds (I22): the document's guid, with no path fallback. The old writer resolved `getGuidForPath(path) ?? path`,
 *  so any manifest miss — a lag after a move (#1828's routes), a BOM the scanner could not read (#1799), another
 *  spelling (#1753 F4) — stored the raw path, which the loader and the scene validator reject.
 *
 *  Mutations, each checked (results in the close-out report):
 *  - write `getGuidForPath(doc.id) ?? doc.id` for a non-guid id again → the guid-less case goes red (a path is stored);
 *  - tag `instantiatePrefabInstance`'s instance from its path through the manifest → the manifest-miss case goes red;
 *  - add a second `.source =` writer in editor or app code → the guard goes red. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld, getTraitByName, clearManifest, registerAsset } from '@modoki/engine/runtime';
import { readScannedSource } from '@modoki/engine/testing';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab, instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const GUID = 'aaaaaaaa-0000-4000-8000-000000001828';
const OTHER_GUID = 'aaaaaaaa-0000-4000-8000-000000001829';
const PATH = '/games/x/assets/prefabs/Renamed.prefab.json';
const doc = (id?: string): PrefabFile => ({
  ...(id ? { id } : {}), version: 8, name: 'Renamed', rootLocalId: 1,
  entities: [
    { localId: 1, nodeGuid: 'dddddddd-0000-4000-8000-000000001828', traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' }, Transform: {} } },
    { localId: 2, nodeGuid: 'dddddddd-0000-4000-8000-000000001829', traits: { EntityAttributes: { name: 'C', parentId: 1, guid: '' }, Transform: {} } },
  ],
} as unknown as PrefabFile);

const sources = (root: number): string[] => {
  const meta = getTraitByName('PrefabInstance')!;
  const out: string[] = [];
  getCurrentWorld().query(meta.trait).updateEach(([pi]) => {
    const d = pi as { rootInstanceId?: number; source?: string };
    if (d.rootInstanceId === root) out.push(d.source ?? '');
  });
  return out;
};

beforeEach(() => {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  clearManifest();
});
afterEach(() => { clearManifest(); vi.restoreAllMocks(); });

describe('setPrefabSource writes the document\'s guid (#1828)', () => {
  it('writes the guid with no manifest entry at all — the lag a Rename undo leaves', () => {
    const root = instantiatePrefab(doc(GUID), 0);
    expect(setPrefabSource(root, doc(GUID))).toBe(true);
    expect(sources(root)).toEqual([GUID, GUID]);
  });

  it('writes the document\'s guid even where the manifest names ANOTHER prefab at that path (stale after a move)', () => {
    registerAsset(OTHER_GUID, PATH, 'prefab');
    const root = instantiatePrefab(doc(GUID), 0);
    setPrefabSource(root, doc(GUID));
    expect(sources(root)).toEqual([GUID, GUID]);
  });

  it('refuses a document with no guid loudly, and writes nothing — never a path', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerAsset(OTHER_GUID, PATH, 'prefab');
    const root = instantiatePrefab(doc(GUID), 0);
    setPrefabSource(root, doc(GUID));
    expect(setPrefabSource(root, { id: PATH, name: 'Renamed' })).toBe(false);
    expect(setPrefabSource(root, { name: 'Renamed' })).toBe(false);
    expect(sources(root)).toEqual([GUID, GUID]); // the earlier tag stands
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('its document has no guid'))).toHaveLength(2);
  });

  it('a placement tags by the document it read, whatever the manifest says about its path', async () => {
    // #1828 route 1 at unit level: the path the gesture captured resolves to nothing in the manifest.
    setPrefabCache(GUID, doc(GUID));
    const root = await instantiatePrefabInstance(doc(GUID), PATH, 0);
    expect(sources(root)).toEqual([GUID, GUID]);
  });
});

describe('guard: setPrefabSource is the only editor writer of PrefabInstance.source', () => {
  it('no other `.source =` assignment in editor or app code', () => {
    const hits: string[] = [];
    for (const { abs, rel } of repoFiles({ under: ['engine/packages/modoki/src/editor', 'engine/app'], match: /\.tsx?$/, floor: 200 })) {
      const { code } = readScannedSource(abs);
      code.split('\n').forEach((line, i) => { if (/\.source\s*=[^=]/.test(line)) hits.push(`${rel}:${i + 1}`); });
    }
    // The one: inside setPrefabSource. The Create Prefab tag writes `{ source: ref }` through `instanceSourceRef`, the
    // document-first owner (#1807), as a trait init rather than an assignment.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^engine\/packages\/modoki\/src\/editor\/scene\/prefabCache\.ts:/);
    const src = readScannedSource(repoFiles({ under: 'engine/packages/modoki/src/editor/scene', match: /\/prefabCache\.ts$/, floor: 1 })[0]!.abs).code;
    const fn = src.slice(src.indexOf('export function setPrefabSource('), src.indexOf('export function setPrefabSource(') + 1500);
    expect(fn).toContain('.source = ref');
    expect(fn).not.toMatch(/getGuidForPath/);
  });
});
