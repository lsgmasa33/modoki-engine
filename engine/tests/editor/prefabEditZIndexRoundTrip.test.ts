/** Close-out (2026-09-05, #762 follow-up fallout): every editor path that OPENS a prefab
 *  for isolated editing (`openPrefabForEditing`) used to fetch the `.prefab.json` RAW —
 *  `fetch(asset.path)` + `parseAssetJson` — never through `getPrefabSource`, which is where the
 *  `UIAnchor.zIndex` → `UIElement.zIndex` migration used to live exclusively. A prefab authoring
 *  `UIAnchor.zIndex` therefore opened with the key silently dropped (the synthetic edit scene
 *  never runs `migrateV12toV13` — it starts life already at `SCENE_FORMAT_VERSION`, and
 *  `setPrefabCache` seeded the SAME cache `getPrefabSource` reads first with the un-migrated
 *  object, poisoning every later read in the session too), and saving wrote the loss to disk.
 *
 *  This drives the REAL `openPrefabForEditing` → `buildPrefabEditScene` → (spawn into the live
 *  world) → `serializePrefab` round trip, with only `sceneManager.loadScene` stubbed — and stubbed
 *  to actually SPAWN the built edit-scene's entities (mirroring `instantiatePrefab`'s own spawn
 *  loop), not mocked away, so the test can see what the user would actually edit, not just what
 *  was fetched. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// sceneManager.getCurrent() is read once (to compute the return-scene) and loadScene(key,
// {preloaded}) is what would normally hand the built edit-scene to the real loader. Stubbed to
// spawn `preloaded.entities` into the current world using the SAME registered-trait metadata
// `instantiatePrefab` uses, so this is a real spawn, not a no-op.
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => null,
    loadScene: async (
      _key: string,
      opts: { preloaded: { entities: { id?: number; traits: Record<string, unknown> }[] } },
    ) => {
      const { getAllTraits } = await import('@modoki/engine/runtime');
      const { getCurrentWorld, getTraitByName: byName, spawnEntity } = await import('@modoki/engine/runtime');
      const allTraits = getAllTraits();
      const localToEcs = new Map<number, number>();
      const spawned: { entry: { id?: number; traits: Record<string, unknown> }; ecsId: number }[] = [];
      for (const entry of opts.preloaded.entities) {
        const args: unknown[] = [];
        for (const meta of allTraits) {
          const saved = entry.traits[meta.name];
          if (saved === undefined) continue;
          // Spawn PARENTLESS, as the real loader does: the entry's `parentId` is a localId and
          // would otherwise name whichever entity happens to hold that ECS number.
          const data = meta.name === 'EntityAttributes'
            ? { ...(saved as Record<string, unknown>), parentId: 0 }
            : saved;
          args.push(data === true ? meta.trait() : meta.trait(data as Record<string, unknown>));
        }
        const e = spawnEntity(getCurrentWorld(), ...(args as Parameters<typeof spawnEntity>[1][]));
        if (entry.id) localToEcs.set(entry.id, e.id());
        spawned.push({ entry, ecsId: e.id() });
      }
      // Second pass: remap each localId parent to the ECS id it spawned as. Without this a
      // multi-row prefab loses its hierarchy here and `serializePrefab` writes only the root —
      // which silently narrowed what a save-side test could see.
      const eaMeta = byName('EntityAttributes');
      if (eaMeta) for (const { entry, ecsId } of spawned) {
        const ea = entry.traits.EntityAttributes as Record<string, unknown> | undefined;
        const parentLocal = typeof ea?.parentId === 'number' ? ea.parentId : 0;
        if (!parentLocal) continue;
        const handle = [...getCurrentWorld().entities].find((x) => x.id() === ecsId);
        if (handle) handle.set(eaMeta.trait, { ...(handle.get(eaMeta.trait) as object), parentId: localToEcs.get(parentLocal) ?? 0 });
      }
      return { keptBaseGuids: new Set<string>() };
    },
    getLoadedScenes: () => new Map(),
  },
}));

// savePrefabEdit's writePrefabFile POSTs through postWriteFile (#835) — capture what it would
// have written to disk instead of hitting a real dev server. jsonFileBody is left as the REAL
// implementation (importOriginal) — it's a pure byte producer, not something this test needs to
// fake, and faking it would silently stop this file from catching a #835 regression in it.
let written: { path: string; content: string } | null = null;
/** When set, the next `postWriteFile` answers 409 with this reason in its body, as the gate does. */
let refuseNextWrite: string | null = null;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/backend/editorBackend')>();
  return {
    ...actual,
    postWriteFile: async (path: string, content: string) => {
      // A 409 WITH A BODY when a test asks for one — that is the shape the format gate answers with,
      // and the reason lives in the body rather than the status (#1468).
      if (refuseNextWrite) {
        const reason = refuseNextWrite;
        refuseNextWrite = null;
        return { ok: false, status: 409, json: async () => ({ error: reason }), text: async () => reason } as Response;
      }
      written = { path, content };
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    },
  };
});

import { getAllEntities, getCurrentWorld } from '@modoki/engine/runtime';
import { getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing, savePrefabEdit, savePrefabEditReport, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCachedPrefabSync, warnInertPrefabSizes } from '../../packages/modoki/src/editor/scene/prefab';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';

registerAllTraits();

// jsdom-less node env — setCurrentScenePath persists to localStorage (mirrors the other
// prefab-edit test files' setup).
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

const RAW_PREFAB: PrefabFile = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  version: 2,
  name: 'Badge',
  rootLocalId: 1,
  entities: [
    {
      localId: 1, name: 'Badge',
      traits: {
        EntityAttributes: { name: 'Badge', parentId: 0, layer: 'ui', guid: '' },
        UIAnchor: { anchor: 'top-left', zIndex: 20 } as unknown as Record<string, unknown>,
        UIElement: { width: 100, height: 40, zIndex: 0 } as unknown as Record<string, unknown>,
      },
    },
  ],
};

/** The prefab the stubbed fetch serves — RAW_PREFAB unless a test swaps it. */
let served: PrefabFile = RAW_PREFAB;

beforeEach(() => {
  written = null;
  refuseNextWrite = null;
  served = RAW_PREFAB;
  setRunMode('stopped');
  setCurrentScenePath(null);
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(served),
    json: async () => JSON.parse(JSON.stringify(served)),
  }));
});

describe('openPrefabForEditing → savePrefabEdit round trip (#762 follow-up close-out)', () => {
  it('migrates UIAnchor.zIndex onto UIElement.zIndex BEFORE seeding the prefab cache', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const cached = getCachedPrefabSync(RAW_PREFAB.id!);
    expect(cached).not.toBeNull();
    const traits = cached!.entities[0].traits as Record<string, Record<string, unknown>>;
    expect(traits.UIElement.zIndex).toBe(20);
    expect(traits.UIAnchor.zIndex).toBeUndefined();
  });

  it('spawns the edit-world root with the migrated value (what the user actually sees)', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const eaMeta = getTraitByName('EntityAttributes')!;
    const uiElMeta = getTraitByName('UIElement')!;
    let rootId = 0;
    getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
      if ((ea as Record<string, unknown>).guid === PREFAB_EDIT_ROOT_GUID) rootId = entity.id();
    });
    expect(rootId).toBeGreaterThan(0);
    const rootEntity = getAllEntities().find((e) => e.id === rootId);
    expect(rootEntity).toBeDefined();
    const el = getCurrentWorld().entities.find((e) => e.id() === rootId)!.get(uiElMeta.trait) as Record<string, unknown>;
    expect(el.zIndex).toBe(20);
  });

  it('the value SURVIVES a save — written .prefab.json carries UIElement.zIndex, not UIAnchor.zIndex', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const ok = await savePrefabEdit();
    expect(ok).toBe(true);
    expect(written).not.toBeNull();

    const savedPrefab = JSON.parse(written!.content) as PrefabFile;
    const savedTraits = savedPrefab.entities[0].traits as unknown as Record<string, Record<string, unknown>>;
    expect(savedTraits.UIElement.zIndex).toBe(20);
    expect(savedTraits.UIAnchor?.zIndex).toBeUndefined();
  });
});

// #1468: a prefab-edit save must carry every row's MINTED node identity, and it is the one save path
// that cannot read it off the live world — `buildPrefabEditScene` flattens the document into PLAIN
// entities with no prefab link, so the baseline file is the only thing that still knows which row a
// given live entity is. Driven through the real open → spawn → serialize → write round trip for
// exactly that reason: the carry lives at the seam between `collectPreservedLocalIds` and
// `serializePrefab`, and a unit test of either half alone would not cross it.
describe('a prefab-edit save keeps the node identity the file already had (#1468)', () => {
  const NODE_ROOT = '11111111-2222-4333-8444-555555555555';
  const NODE_CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const withNodeGuids = (): PrefabFile => ({
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    version: 5, name: 'Badge', rootLocalId: 1,
    entities: [
      { localId: 1, nodeGuid: NODE_ROOT, name: 'Badge', traits: { EntityAttributes: { name: 'Badge', parentId: 0, guid: '' } } },
      { localId: 2, nodeGuid: NODE_CHILD, name: 'Dot', traits: { EntityAttributes: { name: 'Dot', parentId: 1, guid: '' } } },
    ],
  });

  it('writes the same guids back, on a no-op save', async () => {
    served = withNodeGuids();
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    expect(await savePrefabEdit()).toBe(true);
    const saved = JSON.parse(written!.content) as PrefabFile;
    expect(saved.entities.find((e) => e.name === 'Badge')!.nodeGuid).toBe(NODE_ROOT);
    expect(saved.entities.find((e) => e.name === 'Dot')!.nodeGuid).toBe(NODE_CHILD);
  });

  it('carries the backend\'s REFUSAL out to the caller, not just to the console', async () => {
    // #1468 close-out reviews F5 + R2. The owner's ruling is refuse-to-SAVE-never-to-LOAD, so a
    // build WILL open a prefab a newer build wrote, edit it, and press Cmd+S — that is the
    // designed-for case. `writePrefabFile` logged the status and threw the 409 body away, and the
    // server's own error goes to the DEV-SERVER terminal, not the editor console, so the save failed
    // silently. The first fix carried the reason into `warnings` and left it there: the human path
    // called the boolean wrapper and the agent path threw a hard-coded string, so the new field was
    // written by one line and read by zero — a producer with no consumer, in the same commit that
    // fixed its mirror image. This asserts the value reaches the caller.
    served = withNodeGuids();
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    refuseNextWrite = 'Badge.prefab.json was written by a newer build (prefab format 9; this build writes 5).';
    const report = await savePrefabEditReport();
    expect(report.saved).toBe(false);
    expect(report.warnings.join(' ')).toContain('prefab format 9');
  });

  it('refuses to let two rows share one identity, even when the file says they do', async () => {
    // The uniqueness branch in `nodeGuidsFor`. A close-out review called it dead code, having failed
    // to build a collision from live-world shapes — duplicating a member strips `PrefabInstance`,
    // duplicating an instance root is refused earlier by the cycle guard, another prefab's members
    // fail the source gate. It missed the carrier that is not the live world: `preserveNodeGuids` is
    // built from the BASELINE DOCUMENT (`prefabEdit`'s `nodeGuidByLocalId`, keyed by localId), so a
    // hand-edited or damaged file with one guid on two rows maps two live entities onto one
    // identity. The reviewer then drove this shape end-to-end and conceded the branch is reachable.
    //
    // ⚠️ Driven through the REAL open → spawn → serialize → write path, not by handing
    // `serializePrefab` a contrived preserve map. A map passed straight in would keep passing if
    // `savePrefabEditReport` were later changed to de-duplicate before calling — green under both
    // hypotheses, which is the shape these files exist to avoid.
    const SHARED = '11111111-2222-4333-8444-555555555555';
    served = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 5, name: 'Badge', rootLocalId: 1,
      entities: [
        { localId: 1, nodeGuid: SHARED, name: 'Badge', traits: { EntityAttributes: { name: 'Badge', parentId: 0, guid: '' } } },
        { localId: 2, nodeGuid: SHARED, name: 'Dot', traits: { EntityAttributes: { name: 'Dot', parentId: 1, guid: '' } } },
      ],
    };
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    expect(await savePrefabEdit()).toBe(true);
    const saved = JSON.parse(written!.content) as PrefabFile;
    const guids = saved.entities.map((e) => e.nodeGuid);
    expect(new Set(guids).size).toBe(saved.entities.length);   // no two rows share one
    expect(guids.filter((g) => g === SHARED)).toHaveLength(1);  // exactly one keeps it
  });

  it('mints for the rows of a pre-v5 file it opened, which had none to keep', async () => {
    // The accept side, and how a file migrates: the save is the ONLY place identity is assigned
    // (plan § 4 Phase 5). Opening it must not have minted anything.
    served = { ...withNodeGuids(), version: 4, entities: withNodeGuids().entities.map(({ nodeGuid: _drop, ...e }) => e) };
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    expect(await savePrefabEdit()).toBe(true);
    const saved = JSON.parse(written!.content) as PrefabFile;
    const guids = saved.entities.map((e) => e.nodeGuid);
    expect(guids.every((g) => typeof g === 'string' && /^[0-9a-f-]{36}$/.test(g!))).toBe(true);
    expect(new Set(guids).size).toBe(saved.entities.length);
  });
});

// #1258: the agent `edit-save` op answers with the report's warnings — the editor Console is not where an agent
// looks. Driven through the same real open → spawn → serialize → write round trip as the save above, because the
// finding is computed from what the edit world SERIALIZES, not from the file that was opened.
describe('savePrefabEditReport keeps the validation warnings its write reported (#1258)', () => {
  // A width in % under a top-left anchor: LIVE on disk. The test makes it inert in the edit world instead.
  const BAND: PrefabFile = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
    version: 2,
    name: 'Band',
    rootLocalId: 1,
    entities: [{
      localId: 1, name: 'Band',
      traits: {
        EntityAttributes: { name: 'Band', parentId: 0, layer: 'ui', guid: '' },
        UIAnchor: { anchor: 'top-left' } as unknown as Record<string, unknown>,
        UIElement: { width: 90, widthUnit: '%' } as unknown as Record<string, unknown>,
      },
    }],
  };

  it('reports the finding for the edited template — made inert in the edit world, not on disk — and still saves', async () => {
    // The premise, or the test cannot tell "validated what was serialized" from "validated the opened file".
    expect(warnInertPrefabSizes(BAND, BAND.id!)).toEqual([]);
    served = BAND;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await openPrefabForEditing({ path: '/games/x/assets/prefabs/Band.prefab.json', name: 'Band' });
      // The edit: a stretch anchor now owns the authored width's axis, so the width is stored, shown, never applied.
      const eaMeta = getTraitByName('EntityAttributes')!;
      const anchorMeta = getTraitByName('UIAnchor')!;
      let edited = false;
      getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
        if ((ea as Record<string, unknown>).guid !== PREFAB_EDIT_ROOT_GUID) return;
        entity.set(anchorMeta.trait, { anchor: 'stretch' });
        edited = true;
      });
      expect(edited).toBe(true);
      const report = await savePrefabEditReport();
      expect(report.saved).toBe(true);
      expect(written).not.toBeNull();
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings.join('\n')).toContain('entity[localId=1] "Band".UIElement.width is inert');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports no warnings for a clean template', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    expect(await savePrefabEditReport()).toEqual({ saved: true, warnings: [] });
  });

  it('savePrefabEdit is the same save, answered as a boolean', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    await expect(savePrefabEdit()).resolves.toBe(true);
    setRunMode('playing');
    try {
      await expect(savePrefabEdit()).resolves.toBe(false);
    } finally {
      setRunMode('stopped');
    }
  });
});
