/** #1692 — the prefab-edit save is ONE `commitPrefabWrite`, conditional on the document the edit was opened from (or
 *  last saved as). A file changed on disk under the open edit is not overwritten unasked: the human is shown the
 *  conflict and chooses Overwrite or Cancel; an agent gets a refusal and an explicit `overwrite`. And the editor's OWN
 *  writes during the session never trip it (the hub's conditions on the design).
 *
 *  The route is a fake holding exactly the bytes it received, with `/api/write-file`'s `ifMatch` rule, and serving
 *  them to a GET. Mutations, each checked:
 *  - the save does not move its baseline (`editBaselineFor`) — the save-twice case goes red;
 *  - drop the re-read of a refused `expected` in `commitPrefabWrite` (the file holds the same document in other bytes)
 *    — the migration case goes red;
 *  - make the save conditional on the editor cache instead of the session's baseline — the in-editor write case goes
 *    red;
 *  - overwrite without asking (`overwrite` always on) — the conflict and Cancel cases go red;
 *  - seat the baseline at the fetch again, before the open can be cancelled — both open-another-prefab cases go red;
 *  - number the save's rows from the editor cache instead of the baseline — the numbering case goes red. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const loaded = vi.hoisted(() => ({ key: null as string | null }));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    // The world last loaded, so the save routes as it does in the editor: into prefab edit (`isPrefabEditWorld`).
    getCurrent: () => (loaded.key ? { path: loaded.key } : null),
    loadScene: async (
      _key: string,
      opts: { preloaded: { entities: { id?: number; traits: Record<string, unknown> }[] } },
    ) => {
      loaded.key = _key;
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
      // The loaded world, which the adoption owner offers (#1698).
      return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
    },
    getLoadedScenes: () => new Map(),
  },
}));

const PREFAB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000001692';
const PATH = '/games/x/assets/prefabs/Badge.prefab.json';
const route = vi.hoisted(() => ({ disk: new Map<string, string>(), writes: 0 }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string; createOnly?: boolean }) => {
    const cur = route.disk.get(path);
    if (opts?.ifMatch !== undefined && (cur === undefined || sha(cur) !== opts.ifMatch)) return answer(409, { reason: 'if-match' });
    route.writes++;
    route.disk.set(path, content);
    return answer(200, { ok: true, path });
  },
}));
/** What the human answers the Overwrite question with, and how often it was asked. */
const modal = vi.hoisted(() => ({ answer: false, asked: 0 }));
vi.mock('../../packages/modoki/src/editor/utils/saveDialog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmInEditor: async () => { modal.asked++; return modal.answer; },
  alertInEditor: async () => {},
}));

import { registerAsset, setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing, savePrefabEditReport } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { runSaveAll } from '../../packages/modoki/src/editor/scene/saveCommand';
import { setCurrentScenePath, hasUnsavedChanges } from '../../packages/modoki/src/editor/scene/serialize';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { pushAction } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, get length() { return store.size; },
  } as Storage;
}

const badge = (name = 'Badge'): PrefabFile => ({
  id: PREFAB_ID, version: 7, name: 'Badge', rootLocalId: 1,
  entities: [
    { localId: 1, nodeGuid: '11111111-2222-4333-8444-000000001692', name, traits: { EntityAttributes: { name, parentId: 0, guid: '' } } },
  ],
} as unknown as PrefabFile);
const onDisk = () => JSON.parse(route.disk.get(PATH)!) as PrefabFile;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
/** An edit in the prefab world — any undoable change makes it unsaved. */
const edit = () => pushAction({ label: 'an edit', undo: () => {}, redo: () => {} });

beforeEach(async () => {
  setRunMode('stopped');
  setCurrentScenePath(null);
  route.disk.clear();
  route.writes = 0;
  modal.answer = false;
  modal.asked = 0;
  registerAsset(PREFAB_ID, PATH, 'prefab');
  route.disk.set(PATH, jsonFileBody(badge()));
  vi.stubGlobal('fetch', async (url: string) => {
    const text = route.disk.get(String(url).replace(/^.*(?=\/games\/)/, ''));
    return text === undefined ? new Response('', { status: 404 }) : new Response(text, { status: 200 });
  });
  await quietly(() => openPrefabForEditing({ path: PATH, name: 'Badge' }));
});

describe("the editor's own writes never trip the prefab-edit save (#1692)", () => {
  it('save, edit, save again in one session: both land', async () => {
    edit();
    expect((await quietly(() => savePrefabEditReport())).saved).toBe(true);
    edit();
    expect(await quietly(() => savePrefabEditReport())).toMatchObject({ saved: true });
    expect(route.writes).toBe(2);
    expect(modal.asked).toBe(0);
  });

  it('a file the open migrated in memory (a pre-migration UIAnchor.zIndex) saves without a conflict', async () => {
    // On disk the LEGACY spelling; open migrates it onto UIElement, so the document the edit holds is not these bytes.
    const legacy = badge() as unknown as { entities: Array<{ traits: Record<string, unknown> }> };
    legacy.entities[0]!.traits.UIAnchor = { anchor: 'top-left', zIndex: 20 };
    legacy.entities[0]!.traits.UIElement = { width: 10, height: 10, zIndex: 0 };
    route.disk.set(PATH, jsonFileBody(legacy));
    await quietly(() => openPrefabForEditing({ path: PATH, name: 'Badge' }));
    edit();
    expect(await quietly(() => savePrefabEditReport())).toMatchObject({ saved: true });
    expect((onDisk().entities[0]!.traits as Record<string, { zIndex?: number }>).UIElement!.zIndex).toBe(20);
  });
});

describe('a file changed on disk under the open edit (#1692)', () => {
  const changeOnDisk = () => route.disk.set(PATH, jsonFileBody(badge('Renamed elsewhere')));

  it('is not overwritten unasked: the save refuses, and the edit stays open and unsaved', async () => {
    changeOnDisk();
    edit();
    const res = await quietly(() => savePrefabEditReport());
    expect(res).toMatchObject({ saved: false, conflict: true });
    expect(res.warnings.join(' ')).toMatch(/changed on disk/);
    expect(onDisk().entities[0]!.name).toBe('Renamed elsewhere');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('Cmd+S asks; Cancel writes nothing and leaves the edit unsaved', async () => {
    changeOnDisk();
    edit();
    modal.answer = false;
    const out = await quietly(() => runSaveAll());
    expect(modal.asked).toBe(1);
    expect(out.prefabSaved).toBe(false);
    expect(onDisk().entities[0]!.name).toBe('Renamed elsewhere');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('Cmd+S asks; Overwrite replaces the file with the edit', async () => {
    changeOnDisk();
    edit();
    modal.answer = true;
    const out = await quietly(() => runSaveAll());
    expect(modal.asked).toBe(1);
    expect(out.prefabSaved).toBe(true);
    expect(onDisk().entities[0]!.name).toBe('Badge');
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("an agent's explicit overwrite replaces it; without it the agent is refused", async () => {
    changeOnDisk();
    edit();
    expect((await quietly(() => savePrefabEditReport())).conflict).toBe(true);
    expect(await quietly(() => savePrefabEditReport({ overwrite: true }))).toMatchObject({ saved: true });
    expect(onDisk().entities[0]!.name).toBe('Badge');
  });

  it('a write from elsewhere IN the editor (an Apply from a carried instance) is not mistaken for the open edit: the save is told', async () => {
    // The Apply's one write step, over the file as it was read. The editor cache follows it (I9) — the edit's save is
    // conditional on the session's OWN baseline, not on that entry.
    const applied = badge('Applied from an instance');
    expect((await quietly(() => commitPrefabWrite(PREFAB_ID, applied, { expected: badge() }))).ok).toBe(true);
    expect(getCachedPrefabSync(PREFAB_ID)?.entities[0]!.name).toBe('Applied from an instance');
    edit();
    const res = await quietly(() => savePrefabEditReport());
    expect(res.conflict).toBe(true);
    expect(onDisk().entities[0]!.name).toBe('Applied from an instance');
  });
});

/** Close-out re-review of #1692: opening ANOTHER prefab that does not finish (its unsaved-work question cancelled, or
 *  answered with Save) must leave the session still open saveable. The baseline was seated at the fetch, before that
 *  question, so the open session lost its own and refused every save — the gate's Save included. */
describe('an open of another prefab that does not finish leaves this session saveable (#1692)', () => {
  const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000001693';
  const OTHER = '/games/x/assets/prefabs/Other.prefab.json';
  beforeEach(() => {
    registerAsset(OTHER_ID, OTHER, 'prefab');
    route.disk.set(OTHER, jsonFileBody({ ...badge('Other'), id: OTHER_ID }));
  });

  it('cancelled: the open edit still saves', async () => {
    edit();
    await quietly(() => openPrefabForEditing({ path: OTHER, name: 'Other' }, { confirmDiscard: async () => false }));
    expect(await quietly(() => savePrefabEditReport())).toMatchObject({ saved: true });
    expect(onDisk().entities[0]!.name).toBe('Badge');
  });

  it("the question's Save saves the open edit", async () => {
    edit();
    let saved: boolean | undefined;
    await quietly(() => openPrefabForEditing({ path: OTHER, name: 'Other' }, {
      confirmDiscard: async () => { saved = (await savePrefabEditReport()).saved; return false; },
    }));
    expect(saved).toBe(true);
  });
});

describe("the save numbers its rows from what the edit opened, not from the cache (#1692)", () => {
  it('after another write renumbered the file, an Overwrite keeps the rows the edit world was expanded from', async () => {
    // Written elsewhere with the root on another row: the editor cache follows it (I9); the edit world does not.
    const renumbered = { ...badge('Renumbered'), rootLocalId: 5, entities: [{ ...badge().entities[0]!, localId: 5, name: 'Renumbered' }] };
    expect((await quietly(() => commitPrefabWrite(PREFAB_ID, renumbered as unknown as PrefabFile, { expected: badge() }))).ok).toBe(true);
    edit();
    expect(await quietly(() => savePrefabEditReport({ overwrite: true }))).toMatchObject({ saved: true });
    expect(onDisk().rootLocalId).toBe(1);
    expect(onDisk().entities[0]!.localId).toBe(1);
  });
});
