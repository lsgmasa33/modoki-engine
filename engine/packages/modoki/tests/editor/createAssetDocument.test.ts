/** `writeNewAssetDocument` (#1264) — the one create primitive every human create path goes through.
 *
 *  The defect it closes: eight create paths wrote with a plain replacing `/api/write-file` and a
 *  FRESH guid, so an existing asset was silently replaced and every ref to it dangled. The save
 *  dialog was never a guard, and three of the paths have no dialog at all.
 *
 *  The route's `ifNoneMatch:'*'` is modelled by the stub below exactly as `/api/write-file` answers
 *  it (409, nothing written, `existingPath` naming what is there) — and, like APFS/NTFS, the stub
 *  matches a path CASE-INSENSITIVELY and keeps the stored spelling (#1273).
 *  `tests/plugins/assetWritePreconditions.test.ts` pins the real route. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeNewAssetDocument, existingAssetPath, mayCreateOver, otherAssetKindAt } from '../../src/editor/scene/createAssetDocument';
import { registerAsset, unregisterAsset } from '../../src/runtime/loaders/assetManifest';
import { markAssetDirty, getDirtyAssetPaths, clearDirtyAssets } from '../../src/editor/scene/dirtyAssets';

const OLD = '11111111-1111-4111-8111-111111111111';
const FRESH = '22222222-2222-4222-8222-222222222222';
const PATH = '/assets/anims/Walk.anim.json';

let onDisk = new Map<string, string>();
let writes: Array<{ path: string; content: string; createOnly: boolean }> = [];
let failWrites = false;
/** Off → the route answers as it did before #1273, with no `existingPath` / `path`. */
let routeNamesExisting = true;
/** The spelling the route reports for a write it made — a folder the filesystem folded, say. */
let writtenAs = (p: string) => p;
/** The stored spelling of `p`, matched case-insensitively — what a case-insensitive filesystem does. */
const storedAs = (p: string) => [...onDisk.keys()].find((k) => k.toLowerCase() === p.toLowerCase());

beforeEach(() => {
  onDisk = new Map();
  writes = [];
  failWrites = false;
  routeNamesExisting = true;
  writtenAs = (p) => p;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/write-file')) {
      if (failWrites) return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
      const b = JSON.parse(init?.body ?? '{}') as { path: string; content: string; ifNoneMatch?: string };
      const existing = storedAs(b.path);
      if (b.ifNoneMatch === '*' && existing) {
        return { ok: false, status: 409, json: async () => (routeNamesExisting ? { existingPath: existing } : {}) } as unknown as Response;
      }
      writes.push({ path: b.path, content: b.content, createOnly: b.ifNoneMatch === '*' });
      const stored = existing ?? writtenAs(b.path);
      onDisk.set(stored, b.content);
      return { ok: true, status: 200, json: async () => ({ ok: true, ...(routeNamesExisting ? { path: stored } : {}) }) } as unknown as Response;
    }
    if (u.includes('/api/exists')) {
      const p = decodeURIComponent(u.split('path=')[1] ?? '');
      const existing = storedAs(p);
      const body = existing ? { exists: true, ...(routeNamesExisting ? { path: existing } : {}) } : { exists: false };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    const served = [...onDisk.entries()].find(([p]) => u.endsWith(p));
    if (served) return { ok: true, status: 200, text: async () => served[1], json: async () => JSON.parse(served[1]) } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); unregisterAsset(OLD); clearDirtyAssets(); });

const doc = (guid: string) => `{"id":"${guid}"}\n`;
const idOf = (text: string) => (JSON.parse(text) as { id: string }).id;

describe('a fresh destination', () => {
  it('writes create-only, with the guid it was given, and never asks', async () => {
    let asked = false;
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH, confirmReplace: async () => { asked = true; return true; } });
    expect(r).toEqual({ outcome: 'created', path: PATH, guid: FRESH });
    expect(writes).toEqual([{ path: PATH, content: doc(FRESH), createOnly: true }]);
    expect(asked).toBe(false);
  });

  it('mints a guid when none is given', async () => {
    const r = await writeNewAssetDocument(PATH, doc);
    expect(r.outcome).toBe('created');
    if (r.outcome !== 'created') return;
    expect(r.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(idOf(writes[0].content)).toBe(r.guid);
  });
});

describe('an EXISTING destination', () => {
  beforeEach(() => { onDisk.set(PATH, `{"id":"${OLD}","frames":[1,2,3]}\n`); });

  it('with no confirmReplace (an agent op) → exists, and nothing written', async () => {
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH });
    expect(r).toEqual({ outcome: 'exists', path: PATH });
    expect(writes).toEqual([]);
  });

  it('asks with the REAL destination, and a no writes nothing', async () => {
    const asked: string[] = [];
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH, confirmReplace: async (p) => { asked.push(p); return false; } });
    expect(r).toEqual({ outcome: 'declined', path: PATH });
    expect(asked).toEqual([PATH]);
    expect(writes).toEqual([]);
  });

  it('a yes replaces, KEEPING the manifest\'s guid for the path — and tells the builder so', async () => {
    registerAsset(OLD, PATH, 'animation');
    const built: Array<[string, boolean]> = [];
    const r = await writeNewAssetDocument(PATH, (g, kept) => { built.push([g, kept]); return doc(g); }, { guid: FRESH, confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'replaced', guid: OLD });
    expect(built).toEqual([[FRESH, false], [OLD, true]]);
    expect(writes).toEqual([{ path: PATH, content: doc(OLD), createOnly: false }]);
  });

  it('a file the manifest has not indexed still gives up its ON-DISK id', async () => {
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH, confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'replaced', guid: OLD });
  });

  it('an existing file carrying NO id replaces under the fresh guid, kept:false', async () => {
    onDisk.set(PATH, '{"frames":[]}\n');
    const built: boolean[] = [];
    const r = await writeNewAssetDocument(PATH, (g, kept) => { built.push(kept); return doc(g); }, { guid: FRESH, confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'replaced', guid: FRESH });
    expect(built).toEqual([false, false]);
  });

  it('keepPrevious reads the replaced bytes BEFORE overwriting them', async () => {
    const before = onDisk.get(PATH);
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH, confirmReplace: async () => true, keepPrevious: true });
    expect(r).toMatchObject({ outcome: 'replaced', previousContent: before });
    expect(onDisk.get(PATH)).toBe(doc(OLD));
  });

  it('without keepPrevious, previousContent is null (no extra read)', async () => {
    const r = await writeNewAssetDocument(PATH, doc, { guid: FRESH, confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'replaced', previousContent: null });
  });

  it('a Replace drops a PARKED panel edit for the path — or the next Cmd+S writes the old doc back', async () => {
    markAssetDirty(PATH, 'animation', { id: OLD, edited: true }, 'panel');
    await writeNewAssetDocument(PATH, doc, { confirmReplace: async () => true });
    expect(getDirtyAssetPaths()).not.toContain(PATH);
  });

  it('a builder that refuses the KEPT id (returns null) writes nothing', async () => {
    const r = await writeNewAssetDocument(PATH, (g, kept) => (kept ? null : doc(g)), { guid: FRESH, confirmReplace: async () => true });
    expect(r.outcome).toBe('failed');
    expect(writes).toEqual([]);
    expect(idOf(onDisk.get(PATH)!)).toBe(OLD);
  });
});

describe('failures', () => {
  it('a refused write is failed, not created, and parks survive', async () => {
    failWrites = true;
    markAssetDirty(PATH, 'animation', { id: OLD }, 'panel');
    const r = await writeNewAssetDocument(PATH, doc, { confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'failed', status: 403 });
    expect(getDirtyAssetPaths()).toContain(PATH);
  });

  it('a builder that refuses up front writes nothing', async () => {
    const r = await writeNewAssetDocument(PATH, () => null);
    expect(r.outcome).toBe('failed');
    expect(writes).toEqual([]);
  });
});

describe('existingAssetPath (the pre-check for a create that discards the world first)', () => {
  it('answers from /api/exists, not a raw fetch the SPA fallback would answer 200', async () => {
    onDisk.set('/assets/scenes/level.json', '{}');
    expect(await existingAssetPath('/assets/scenes/level.json')).toBe('/assets/scenes/level.json');
    expect(await existingAssetPath('/assets/scenes/none.json')).toBeNull();
  });
  it('names the ON-DISK spelling when the filesystem folded the case (#1273)', async () => {
    onDisk.set('/assets/scenes/Level.json', '{}');
    expect(await existingAssetPath('/assets/scenes/level.json')).toBe('/assets/scenes/Level.json');
  });
  it('a route that names nothing keeps the requested spelling', async () => {
    routeNamesExisting = false;
    onDisk.set('/assets/scenes/Level.json', '{}');
    expect(await existingAssetPath('/assets/scenes/level.json')).toBe('/assets/scenes/level.json');
  });
});

describe('mayCreateOver (Create Scene asks before its override discards the world)', () => {
  const SCENE = '/assets/scenes/level.json';
  it('a free path goes ahead without asking', async () => {
    let asked = false;
    expect(await mayCreateOver(SCENE, async () => { asked = true; return false; }, 'scene')).toEqual({ create: SCENE });
    expect(asked).toBe(false);
  });
  it('an existing scene asks, naming it, and the answer decides', async () => {
    onDisk.set(SCENE, '{}');
    const asked: string[] = [];
    expect(await mayCreateOver(SCENE, async (p) => { asked.push(p); return false; }, 'scene')).toBe('declined');
    expect(await mayCreateOver(SCENE, async () => true, 'scene')).toEqual({ create: SCENE });
    expect(asked).toEqual([SCENE]);
  });
  it('an existing asset of ANOTHER kind is refused without asking', async () => {
    const PREFAB = '/assets/prefabs/Enemy.prefab.json';
    onDisk.set(PREFAB, `{"id":"${OLD}"}`);
    registerAsset(OLD, PREFAB, 'prefab');
    let asked = false;
    expect(await mayCreateOver(PREFAB, async () => { asked = true; return true; }, 'scene')).toEqual({ existingType: 'prefab' });
    expect(asked).toBe(false);
  });
});

describe('a Replace across KINDS is refused, never kept (#1264 close-out)', () => {
  // The scene flows write plain `.json`, which can name `Enemy.prefab.json`. Keeping that prefab's guid
  // would re-register it as a scene, and every PrefabInstance.source would resolve to a scene document.
  const PREFAB = '/assets/prefabs/Enemy.prefab.json';
  beforeEach(() => { onDisk.set(PREFAB, `{"id":"${OLD}","entities":[]}\n`); registerAsset(OLD, PREFAB, 'prefab'); });

  it('a scene over a prefab → wrongKind, not asked, nothing written', async () => {
    let asked = false;
    const r = await writeNewAssetDocument(PREFAB, doc, { guid: FRESH, kind: 'scene', confirmReplace: async () => { asked = true; return true; } });
    expect(r).toEqual({ outcome: 'wrongKind', path: PREFAB, existingType: 'prefab' });
    expect(asked).toBe(false);
    expect(writes).toEqual([]);
  });

  it('the SAME kind still asks and keeps the id', async () => {
    const r = await writeNewAssetDocument(PREFAB, doc, { guid: FRESH, kind: 'prefab', confirmReplace: async () => true });
    expect(r).toMatchObject({ outcome: 'replaced', guid: OLD });
  });

  it('otherAssetKindAt: an unindexed path is no conflict; the same kind is none either', () => {
    expect(otherAssetKindAt('/assets/scenes/never-indexed.json', 'scene')).toBeUndefined();
    expect(otherAssetKindAt(PREFAB, 'prefab')).toBeUndefined();
    expect(otherAssetKindAt(PREFAB, 'scene')).toBe('prefab');
  });
});

describe('a CASE-VARIANT of an existing asset (#1273) — the filesystem folds it, the manifest does not', () => {
  // Save Scene As typed `enemy.prefab.json` while `Enemy.prefab.json` exists. The create-only write 409s
  // (the filesystem matched), but the manifest keys the prefab by its on-disk spelling: asking about the
  // TYPED one found no asset, no kind to refuse, and replaced a prefab with a scene.
  const ON_DISK = '/assets/prefabs/Enemy.prefab.json';
  const TYPED = '/assets/prefabs/enemy.prefab.json';
  beforeEach(() => { onDisk.set(ON_DISK, `{"id":"${OLD}","entities":[]}\n`); registerAsset(OLD, ON_DISK, 'prefab'); });

  it('a scene over it → wrongKind naming the real file, not asked, nothing written', async () => {
    let asked = false;
    const r = await writeNewAssetDocument(TYPED, doc, { guid: FRESH, kind: 'scene', confirmReplace: async () => { asked = true; return true; } });
    expect(r).toEqual({ outcome: 'wrongKind', path: ON_DISK, existingType: 'prefab' });
    expect(asked).toBe(false);
    expect(writes).toEqual([]);
  });

  it('the same kind asks about the REAL file, keeps its guid, and writes and reports its spelling', async () => {
    const asked: string[] = [];
    const r = await writeNewAssetDocument(TYPED, doc, { guid: FRESH, kind: 'prefab', confirmReplace: async (p) => { asked.push(p); return true; } });
    expect(r).toMatchObject({ outcome: 'replaced', path: ON_DISK, guid: OLD });
    expect(asked).toEqual([ON_DISK]);
    expect(writes).toEqual([{ path: ON_DISK, content: doc(OLD), createOnly: false }]);
  });

  it('the Replace drops a parked edit held under the REAL spelling', async () => {
    markAssetDirty(ON_DISK, 'animation', { id: OLD, edited: true }, 'panel');
    await writeNewAssetDocument(TYPED, doc, { confirmReplace: async () => true });
    expect(getDirtyAssetPaths()).not.toContain(ON_DISK);
  });

  it('mayCreateOver: another kind is refused, the same kind creates at the REAL file', async () => {
    expect(await mayCreateOver(TYPED, async () => true, 'scene')).toEqual({ existingType: 'prefab' });
    const asked: string[] = [];
    expect(await mayCreateOver(TYPED, async (p) => { asked.push(p); return true; }, 'prefab')).toEqual({ create: ON_DISK });
    expect(asked).toEqual([ON_DISK]);
  });

  it('a route that names nothing degrades to the requested spelling rather than failing', async () => {
    routeNamesExisting = false;
    const r = await writeNewAssetDocument(TYPED, doc, { guid: FRESH, confirmReplace: async () => false });
    expect(r).toEqual({ outcome: 'declined', path: TYPED });
  });
});

describe('a NEW file inside a folder typed in another case (#1273 close-out review)', () => {
  // The create succeeds — the filesystem puts it in the folder that exists — and the scanner keys it by
  // that folder's spelling. Registering the typed one would give the manifest a key no scan produces.
  const TYPED = '/assets/SCENES/new.json';
  const ON_DISK = '/assets/scenes/new.json';

  it('reports, and drops parked edits under, the path the route says it wrote', async () => {
    writtenAs = (p) => (p === TYPED ? ON_DISK : p);
    markAssetDirty(ON_DISK, 'animation', { stale: true }, 'panel');
    const r = await writeNewAssetDocument(TYPED, doc, { guid: FRESH });
    expect(r).toEqual({ outcome: 'created', path: ON_DISK, guid: FRESH });
    expect(getDirtyAssetPaths()).not.toContain(ON_DISK);
  });

  it('a route that names nothing keeps the requested spelling', async () => {
    routeNamesExisting = false;
    const r = await writeNewAssetDocument(TYPED, doc, { guid: FRESH });
    expect(r).toEqual({ outcome: 'created', path: TYPED, guid: FRESH });
  });
});
