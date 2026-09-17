/** applyToPrefabSelective — verify that only the user-selected overrides
 *  land in the new prefab file; unselected fields keep their old base values. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentWorld, Transient, findEntity, getAllEntities } from '@modoki/engine/runtime';
import { collectTransientSubtreeIds } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getTraitByName } from '@modoki/engine/runtime';
import {
  instantiatePrefab,
  applyToPrefabSelective,
  PREFAB_FORMAT_VERSION,
  type PrefabFile,
} from '@modoki/engine/editor';

registerAllTraits();

function makePrefab(): PrefabFile {
  return {
    version: 1,
    name: 'selective-test',
    rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Root', traits: {
        Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        Renderable3D: { mesh: 'root.mesh.json', material: 'base.mat.json', isActive: true },
        EntityAttributes: { name: 'Root', parentId: 0, layer: '3d' },
      } },
      { localId: 2, name: 'Child', traits: {
        Transform: { x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        Renderable3D: { mesh: 'child.mesh.json', material: 'base.mat.json', isActive: true },
        EntityAttributes: { name: 'Child', parentId: 1, layer: '3d' },
      } },
    ],
  };
}

function findChildEcsId(rootId: number, localId: number): number {
  const piMeta = getTraitByName('PrefabInstance')!;
  let id = 0;
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId === rootId && piData.localId === localId) id = entity.id();
  });
  return id;
}

describe('applyToPrefabSelective', () => {
  beforeEach(() => {
    // Stub fetch — applyToPrefabSelective writes the new prefab via /api/write-file
    // and reads the old prefab via getPrefabSource (also uses fetch). We capture
    // the write so we can assert on the JSON body.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/write-file' && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      // getPrefabSource fetches the source path; return a fresh prefab JSON
      return {
        ok: true,
        json: async () => makePrefab(),
      } as unknown as Response;
    }));
  });

  it('writes only the selected fields to the new prefab; unselected stay at base', async () => {
    // Seed the prefab cache by instantiating it (getPrefabSource caches)
    const prefab = makePrefab();
    const source = 'pkg/selective-test.prefab.json';

    // Pre-populate cache by calling getPrefabSource — easiest via the public
    // applyToPrefabSelective path can't read cache before it's primed, so use
    // a manual fetch through getPrefabSource (which we expose).
    const editorMod = await import('@modoki/engine/editor');
    await editorMod.getPrefabSource(source);

    // Instantiate and wire up the source
    const rootId = instantiatePrefab(prefab);
    editorMod.setPrefabSource(rootId, source);

    // Edit child fields: Transform.x AND Renderable3D.material
    const childId = findChildEcsId(rootId, 2);
    const tfMeta = getTraitByName('Transform')!;
    const r3dMeta = getTraitByName('Renderable3D')!;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childId) (tf as Record<string, unknown>).x = 99;
    });
    getCurrentWorld().query(r3dMeta.trait).updateEach(([r], entity) => {
      if (entity.id() === childId) (r as Record<string, unknown>).material = 'override.mat.json';
    });

    // Capture the write so we can read what was sent
    let writtenJson: PrefabFile | null = null;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/write-file' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { content: string };
        writtenJson = JSON.parse(body.content) as PrefabFile;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => makePrefab() } as unknown as Response;
    });

    // Select only Transform.x (NOT Renderable3D.material)
    await applyToPrefabSelective(rootId, new Set(['2.Transform.x']));

    expect(writtenJson).not.toBeNull();
    const childEntry = writtenJson!.entities.find((e) => e.localId === 2)!;
    const childTransform = childEntry.traits['Transform'] as Record<string, number>;
    const childRenderable = childEntry.traits['Renderable3D'] as Record<string, string>;

    expect(childTransform.x).toBe(99);             // selected — applied
    expect(childTransform.y).toBe(0);              // not edited — base
    expect(childRenderable.material).toBe('base.mat.json'); // edited but NOT selected — base preserved

    // ...and the file is stamped with the CURRENT format version (#379 close-out). This is the
    // scenario verbatim: `makePrefab()` is a legacy `version: 1` document, and a value-only apply
    // rewrites the whole thing with today's serializer semantics. `applyOverridesToPrefab` is the
    // fourth writer of this field and used to stamp nothing at all, leaving a v2-written file
    // claiming v1 — the #379 dishonesty in the other direction. It survived that issue's sweep
    // because the sweep grepped for the token `version`, which a writer that never mentions it
    // cannot match.
    expect(writtenJson!.version).toBe(PREFAB_FORMAT_VERSION);
  });

  /** #1301 — Apply-to-Prefab must not fan out to a RUNTIME instance of the same prefab.
   *
   *  `collectInstanceRoots` used to filter on `source` + `rootInstanceId` alone, which is exactly
   *  what a UIEntries pooled row and a timeline scrub spawn also satisfy — and a STOPPED editor
   *  really does hold several of them, because the pool runs above TRANSFORM and keeps recycling
   *  while the sim is not running (measured in docs/prefabs.md § Authoring scope).
   *  Refreshing one is wrong twice:
   *  `rebuildInstance` did not carry `Transient` over the respawn, so the artifact became
   *  serializable and the next save wrote a preview spawn into the authored scene — and the pool
   *  owns those rows, so tearing them down under it is not the editor's to do. */
  it('does NOT rebuild a Transient (runtime-spawned) instance of the same source', async () => {
    const editorMod = await import('@modoki/engine/editor');
    // Its OWN source path: this suite shares one world across tests, so instances an earlier test
    // left behind would be counted by the refresh below and make the assertion say nothing.
    const source = 'pkg/transient-fanout.prefab.json';
    await editorMod.getPrefabSource(source);

    // The authored instance the user edits and applies from.
    const authoredRoot = instantiatePrefab(makePrefab());
    editorMod.setPrefabSource(authoredRoot, source);

    // A second instance of the SAME source, tagged the way every runtime spawner tags one.
    const runtimeRoot = instantiatePrefab(makePrefab());
    editorMod.setPrefabSource(runtimeRoot, source);
    findEntity(runtimeRoot)!.add(Transient);
    // The fixture is only a fixture if the tag actually reads back through the shared predicate —
    // a mistagged or unregistered entity would make every assertion below pass for no reason.
    expect(collectTransientSubtreeIds(getAllEntities()).has(runtimeRoot)).toBe(true);

    const childId = findChildEcsId(authoredRoot, 2);
    const tfMeta = getTraitByName('Transform')!;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childId) (tf as Record<string, unknown>).x = 42;
    });

    // `refreshInstances` reports what it REBUILT, and that count is the only external signal of
    // which roots the fan-out reached. Asserting on it (rather than on ids) is deliberate: koota
    // recycles ids LIFO, so a torn-down root's id comes straight back to its replacement and an
    // id-based check reads a rebuilt instance as an untouched one.
    const refreshLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = String(args[0] ?? '');
      if (line.startsWith('[Prefab] Refreshed')) refreshLines.push(line);
    });
    try {
      await applyToPrefabSelective(authoredRoot, new Set(['2.Transform.x']));
    } finally {
      logSpy.mockRestore();
    }

    // The authored instance WAS refreshed — the exclusion must not eat authoring — and it was the
    // only one: 2 here is the defect (the pooled/scrub instance dragged into an authoring rebuild).
    expect(refreshLines).toEqual([`[Prefab] Refreshed 1 instance(s) of "${source}"`]);

    // A rebuild destroys the root and spawns a replacement under a NEW id, so surviving under the
    // same id with the tag intact is what "was not rebuilt" looks like from outside.
    const survivor = findEntity(runtimeRoot);
    expect(survivor).toBeTruthy();
    expect(survivor!.has(Transient)).toBe(true);
    const piMeta = getTraitByName('PrefabInstance')!;
    expect((survivor!.get(piMeta.trait) as Record<string, unknown>).rootInstanceId).toBe(runtimeRoot);
  });

  it('does nothing when the selected set is empty', async () => {
    const prefab = makePrefab();
    const source = 'pkg/selective-empty.prefab.json';
    const editorMod = await import('@modoki/engine/editor');
    await editorMod.getPrefabSource(source);
    const rootId = instantiatePrefab(prefab);
    editorMod.setPrefabSource(rootId, source);

    let writeCount = 0;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/write-file' && init?.method === 'POST') {
        writeCount++;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => makePrefab() } as unknown as Response;
    });

    await applyToPrefabSelective(rootId, new Set());
    expect(writeCount).toBe(0);
  });
});

describe('prefab source GUID resolution', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => makePrefab() } as unknown as Response)));
  });

  it('getPrefabSource resolves a GUID source to its manifest path before fetching', async () => {
    const { getPrefabSource } = await import('@modoki/engine/editor');
    const { registerAsset, newGuid, clearManifest } = await import('@modoki/engine/runtime');
    clearManifest();
    const guid = newGuid();
    const path = '/pkg/island.prefab.json';
    registerAsset(guid, path, 'prefab');

    let fetchedUrl = '';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo) => {
      fetchedUrl = typeof input === 'string' ? input : input.toString();
      return { ok: true, json: async () => makePrefab() } as unknown as Response;
    });

    const prefab = await getPrefabSource(guid);
    expect(fetchedUrl).toBe(path); // resolved path, not the raw guid
    expect(prefab?.name).toBe('selective-test');
    clearManifest();
  });

  it('applyToPrefabSelective writes to the resolved path when the source is a GUID', async () => {
    const { getPrefabSource, setPrefabSource } = await import('@modoki/engine/editor');
    const { registerAsset, newGuid, clearManifest } = await import('@modoki/engine/runtime');
    clearManifest();
    const guid = newGuid();
    const path = '/pkg/guid-src.prefab.json';
    registerAsset(guid, path, 'prefab');

    await getPrefabSource(guid); // prime cache (keyed by guid)
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, guid);

    const childId = findChildEcsId(rootId, 2);
    const tfMeta = getTraitByName('Transform')!;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childId) (tf as Record<string, unknown>).x = 42;
    });

    let writtenPath = '';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/write-file' && init?.method === 'POST') {
        writtenPath = (JSON.parse(init.body as string) as { path: string }).path;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => makePrefab() } as unknown as Response;
    });

    await applyToPrefabSelective(rootId, new Set(['2.Transform.x']));
    expect(writtenPath).toBe(path); // not the guid
    clearManifest();
  });
});
