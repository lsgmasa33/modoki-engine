/** #1693 U13: an Apply to the inner prefab of a value an ENCLOSING prefab's row also sets writes BOTH files — the inner
 *  template, and the outer row with its override reverted — and its undo puts BOTH back, redo both forward again ("Apply's
 *  undo restores the row as well", owner, 2026-09-28). Driven through `applyToPrefabWithUndo` and the undo history, over
 *  a fake route that honours if-match as the real one does. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

/** The fake route's disk and switches. */
const fs = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  /** Every write the route was asked for, refused or not. */
  posts: [] as Array<{ path: string; content: string; ifMatch?: string }>,
  /** The next write fails as a backend error would (#1668). */
  fail: false,
  /** Per write, in order: `true` fails it as `fail` does (#1732: a later file, then its rollback). */
  failSeq: [] as boolean[],
  /** The next write is refused by the #1468 format gate, which runs BEFORE the if-match check. */
  tooNew: false,
  /** When set, every write waits for it — a write held in flight (#1667). */
  gate: null as Promise<void> | null,
  /** Writes waiting on `gate`. */
  waiting: 0,
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    if (fs.gate) { fs.waiting++; await fs.gate; fs.waiting--; }
    fs.posts.push({ path, content, ifMatch: opts?.ifMatch });
    const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    if (fs.fail || fs.failSeq.shift()) { fs.fail = false; return answer(500, { error: 'the disk is full' }); }
    if (fs.tooNew) { fs.tooNew = false; return answer(409, { ok: false, conflict: true, reason: 'prefab-format-too-new', error: 'a newer build wrote this prefab' }); }
    if (opts?.ifMatch !== undefined) {
      const cur = fs.disk.get(path);
      const hash = cur === undefined ? null : createHash('sha256').update(cur).digest('hex');
      if (hash !== opts.ifMatch) return answer(409, { ok: false, conflict: true, reason: 'if-match' });
    }
    fs.disk.set(path, content);
    return answer(200, { ok: true });
  },
}));

/** A titled scene: the restore reloads it under its path and saves it. Loads and saves are counted. */
const sm = vi.hoisted(() => ({
  path: 'scenes/Level.json' as string | null,
  load: null as null | ((data: unknown) => Promise<void>),
  loads: 0,
  saves: 0,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    sceneManager: {
      getCurrent: () => (sm.path === null ? null : { path: sm.path }),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: async (path: string, opts?: { preloaded?: unknown }) => {
        sm.loads++;
        await sm.load!(opts!.preloaded);
        sm.path = path;
        return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
      },
    },
  };
});
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveScene: async () => { sm.saves++; return { saved: true, reason: 'ok' }; },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undo, redo, swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';

registerAllTraits();
setActionCallback(pushAction);
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
// The multi-file commit reads each file before it writes any (#1692): serve the fake disk.
vi.stubGlobal('fetch', async (url: string) => {
  const path = [...fs.disk.keys()].find((p) => String(url).includes(p));
  return path ? new Response(fs.disk.get(path)!, { status: 200 }) : new Response('', { status: 404 });
});

const P = 'aaaaaaaa-0000-4000-8000-000000001693';
const O = 'aaaaaaaa-0000-4000-8000-000000001694';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = G(93);
const ROOT2 = G(94);
const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, G(1), 'R', 0), row(2, G(2), 'A', 1)] });
/** O: OR → N (P), whose row sets A.x = 3. */
const oDoc = () => ({ id: O, version: 6, name: 'O', rootLocalId: 1, entities: [
  row(1, G(3), 'OR', 0),
  { localId: 2, nodeGuid: G(4), name: 'N', prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } }, overrides: { 2: { Transform: { x: 3 } } } },
] });
const install = (doc: { id: string }) => { prefabs.set(doc.id, doc); setPrefabCache(doc.id, doc as never); };

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, (getCachedPrefabSync(source) ?? prefabs.get(source)) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      if (rootGuid) for (const e of world.entities) if (e.id() === rootId) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      return rootId;
    },
  });
}
sm.load = (data) => load(data as SceneData);

const all = () => getAllEntities();
/** The entity named `name` inside the O instance whose root guid is `root`. */
const inO = (root: string, name: string) => {
  const byId = new Map(all().map((e) => [e.id, e]));
  const r = all().find((e) => e.guid === root)!.id;
  return all().find((e) => {
    if (e.name !== name) return false;
    for (let c: typeof e | undefined = e; c; c = byId.get(c.parentId)) if (c.id === r) return true;
    return false;
  })!.id;
};
const byName = (name: string) => inO(ROOT, name);
const outerRoot = () => all().find((e) => e.guid === ROOT)!.id;
const tfX = (id: number) => (getCurrentWorld().entities.find((e) => e.id() === id)!.get(getTraitByName('Transform')!.trait) as { x: number }).x;
const disk = (id: string) => JSON.parse(fs.disk.get(id)!) as PrefabFile;
/** What an undo parked for `id` (#1868: the undo restores in memory, and Save writes it), or undefined. */
const parked = (id: string) => peekDirtyAsset(id)?.data as PrefabFile | undefined;
const sameDoc = (a: unknown, b: unknown) => expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

beforeEach(() => {
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('scenes/Level.json');
  prefabs.clear();
  install(pDoc());
  install(oDoc());
  fs.disk.clear();
  fs.disk.set(P, jsonFileBody(pDoc()));
  fs.disk.set(O, jsonFileBody(oDoc()));
  fs.posts.length = 0;
  fs.failSeq.length = 0;
  sm.path = 'scenes/Level.json';
  useEditorStore.setState({ showToast: vi.fn() } as never);
  setCurrentScenePath('scenes/Level.json');
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  for (const guid of [ROOT, ROOT2]) {
    const id = instantiatePrefabIntoWorld(getCurrentWorld(), oDoc() as never, 0, undefined, O);
    for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid });
  }
});

describe('U13: a two-file Apply is undone and redone as one', () => {
  it('Apply to P of a value O\'s row sets writes both; undo restores both byte for byte; redo applies both again', async () => {
    // Mutation: drop `others` from `restoreSnapshot`'s restore in the undo (`applyPrefabUndo.ts`) — P goes back and O
    // keeps the Apply's side: its row's x = 3 stays reverted after the undo.
    expect(tfX(byName('A'))).toBe(3); // precondition: the row sets it
    writeTraitFieldWithUndo(byName('A'), getTraitByName('Transform')!, 'x', 5);
    const nested = byName('R');
    const key = collectInstanceOverrideKeys(nested, getCachedPrefabSync(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    const res = await quietly(() => applyToPrefabWithUndo(nested, new Set([key])));
    expect(res.applied).toBe(true);
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]); // innermost first
    expect((disk(P).entities[1]!.traits.Transform as { x: number }).x).toBe(5);
    expect(disk(O).entities[1]!.overrides?.[2]?.Transform).toBeUndefined(); // U13: the row's override went
    expect(tfX(byName('A'))).toBe(5);

    expect(tfX(inO(ROOT2, 'A'))).toBe(5); // U13: the other O instance shows it too

    const [pApplied, oApplied] = [fs.disk.get(P), fs.disk.get(O)];
    await quietly(() => undo());
    // #1868: both documents back IN MEMORY, parked for Save; the files keep the Apply until then.
    sameDoc(parked(P), pDoc());
    sameDoc(parked(O), oDoc());
    expect([fs.disk.get(P), fs.disk.get(O)]).toEqual([pApplied, oApplied]);
    // The live world follows the documents: the edited instance back to its override, the other one to O's row.
    expect([tfX(byName('A')), tfX(inO(ROOT2, 'A'))]).toEqual([5, 3]);

    await quietly(() => redo());
    // Both back to what the files hold, so nothing is left for Save.
    expect([parked(P), parked(O)]).toEqual([undefined, undefined]);
    expect(((getCachedPrefabSync(P) as PrefabFile).entities[1]!.traits.Transform as { x: number }).x).toBe(5);
    expect((getCachedPrefabSync(O) as PrefabFile).entities[1]!.overrides?.[2]?.Transform).toBeUndefined();
    expect([tfX(byName('A')), tfX(inO(ROOT2, 'A'))]).toEqual([5, 5]);
  });

  it('an Apply on the OUTER instance into the nested prefab (U14) undoes BOTH files, though its first file is not the outer\'s', async () => {
    // Mutation: take the undo's other files as \`writes.slice(1)\` — writes are [P, O] and \`result.source\` is O, so P
    // keeps the Apply's bytes after the undo.
    writeTraitFieldWithUndo(byName('A'), getTraitByName('Transform')!, 'x', 5);
    const key = collectInstanceOverrideKeys(outerRoot(), getCachedPrefabSync(O) as PrefabFile).nested.find((k) => k.endsWith('.Transform.x'))!;
    const res = await quietly(() => applyToPrefabWithUndo(outerRoot(), new Set([key]), { perKey: { [key]: P } }));
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]);
    await quietly(() => undo());
    sameDoc(parked(P), pDoc());
    sameDoc(parked(O), oDoc());
  });
});

describe('#1732: a multi-file Apply and its undo report each file\'s outcome, not one', () => {
  /** N's A.x = 5 over O's row, keyed for an Apply to P — U13 writes [P, O]. */
  function editFive(): { nested: number; key: string } {
    writeTraitFieldWithUndo(byName('A'), getTraitByName('Transform')!, 'x', 5);
    const nested = byName('R');
    const key = collectInstanceOverrideKeys(nested, getCachedPrefabSync(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    return { nested, key };
  }

  it('P written, O fails, P cannot be put back: the refusal names O and the stranded P, and does not say "nothing was applied"', async () => {
    // Mutation: word the refusal without `committed.stranded` (the pre-fix text) — it reads "so nothing was applied"
    // while P holds the Apply on disk.
    //   And: drop `failed` from the commit's write-failure return — the refusal names no file, only "the prefab".
    const { nested, key } = editFive();
    fs.failSeq.push(false, true, true); // P lands, O fails, P's rollback fails
    const res = await quietly(() => applyToPrefabWithUndo(nested, new Set([key])));
    expect(fs.posts.map((p) => p.path)).toEqual([P, O, P]); // precondition: the write order the case needs
    expect(res.applied).toBe(false);
    expect((disk(P).entities[1]!.traits.Transform as { x: number }).x).toBe(5); // P really is stranded
    expect(res.refused).toContain(`the prefab ${O} file could not be written (the disk is full)`);
    expect(res.refused).toContain(`${P} was written and could not be put back`);
    expect(res.refused).not.toMatch(/nothing was applied/);
  });

  it('O fails with P put back: "nothing was applied" still holds, and names O', async () => {
    const { nested, key } = editFive();
    fs.failSeq.push(false, true); // P lands, O fails, P's rollback lands
    const res = await quietly(() => applyToPrefabWithUndo(nested, new Set([key])));
    expect(fs.disk.get(P)).toBe(jsonFileBody(pDoc()));
    expect(res.refused).toBe(`the prefab ${O} file could not be written (the disk is full), so nothing was applied.`);
  });

  it('an undo refused because O changed outside names O, the document that changed — not P', async () => {
    // Mutation: name the first restore instead of the one whose document changed in `prefabRestoreRefusal` — the detail
    // blames P, which is untouched.
    const { nested, key } = editFive();
    const res = await quietly(() => applyToPrefabWithUndo(nested, new Set([key])));
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]);
    // An outside change of O, as the watcher brings it in (both caches re-read).
    const outside = { ...disk(O), name: 'O edited outside' };
    fs.disk.set(O, jsonFileBody(outside as never));
    setPrefabCache(O, outside as never);
    const errors: string[] = [];
    const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); }));
    try { await undo(); } finally { for (const s of spies) s.mockRestore(); }
    expect([parked(P), parked(O)]).toEqual([undefined, undefined]); // refused whole: nothing restored
    const detail = errors.find((e) => e.includes('changed since this step'));
    expect(detail).toContain(`${O} changed since this step`);
    expect(detail).not.toContain(`${P} changed since`);
  });
  // #1732's undo-side case (a second file that fails with the first stranded) went with #1868: an undo writes no file, so
  // it cannot fail part-way. The forward Apply's two cases above still hold that bar.
});

describe('#1729: an id-less ENCLOSING prefab written by U13 round-trips through undo and redo', () => {
  it('the Apply stamps O\'s id on both sides, the undo puts back that same id, and the redo is allowed', async () => {
    // Mutation: drop the id stamp in `planApply`'s `docFor` (`if (!doc.id) before.id = doc.id = newGuid()`) — the commit
    // mints O an id the undo's `before` does not carry, and the undo parks O id-less.
    const idless = () => { const d = oDoc() as Partial<ReturnType<typeof oDoc>>; delete d.id; return d; };
    prefabs.set(O, idless());
    setPrefabCache(O, idless() as never);
    fs.disk.set(O, jsonFileBody(idless()));
    writeTraitFieldWithUndo(byName('A'), getTraitByName('Transform')!, 'x', 5);
    const nested = byName('R');
    const key = collectInstanceOverrideKeys(nested, getCachedPrefabSync(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    const res = await quietly(() => applyToPrefabWithUndo(nested, new Set([key])));
    expect(res.writes?.map((w) => w.source)).toEqual([P, O]);
    const oWrite = res.writes!.find((w) => w.source === O)!;
    expect(oWrite.after.id).toBeTruthy();
    expect(oWrite.before.id).toBe(oWrite.after.id);
    expect(disk(O).id).toBe(oWrite.after.id);

    await quietly(() => undo());
    expect(parked(O)?.id).toBe(oWrite.after.id);
    expect(parked(O)?.entities[1]!.overrides?.[2]?.Transform).toEqual({ x: 3 });

    await quietly(() => redo());
    expect(((getCachedPrefabSync(P) as PrefabFile).entities[1]!.traits.Transform as { x: number }).x).toBe(5);
    expect((getCachedPrefabSync(O) as PrefabFile).entities[1]!.overrides?.[2]?.Transform).toBeUndefined();
    expect((getCachedPrefabSync(O) as PrefabFile).id).toBe(oWrite.after.id);
    expect(parked(O)).toBeUndefined();
  });
});
