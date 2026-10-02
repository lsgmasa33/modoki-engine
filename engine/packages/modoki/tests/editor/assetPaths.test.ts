/** Unit tests for the Assets-panel pure path/tree helpers. These back the
 *  rename, duplicate, cut/paste, folder-rename, and folder-tree features —
 *  the compound-extension and collision edge cases especially. */

import { describe, it, expect } from 'vitest';
import {
  splitAssetPath, duplicatePathFor, pastePathIn, remapPrefix, buildFolderTree, planAutoImports,
  autoImportBaseline, diffAutoImportScan, markAutoImported, effectiveAssetsRoot, collectFolderPaths, createNewFolder,
  type AssetEntry,
} from '../../src/editor/utils/assetPaths';

const asset = (path: string): AssetEntry => ({ path, name: path.split('/').pop()!, type: 'x' });
const typed = (path: string, type: string): AssetEntry => ({ path, name: path.split('/').pop()!, type });

describe('splitAssetPath', () => {
  it('splits a simple path + extension', () => {
    expect(splitAssetPath('/a/b/tree.glb')).toEqual({ dir: '/a/b', base: 'tree', ext: '.glb' });
  });

  it('keeps a KNOWN compound extension intact', () => {
    expect(splitAssetPath('/a/weed.prefab.json')).toEqual({ dir: '/a', base: 'weed', ext: '.prefab.json' });
    expect(splitAssetPath('/a/m.mat.json')).toEqual({ dir: '/a', base: 'm', ext: '.mat.json' });
    expect(splitAssetPath('/a/moge.scene.json')).toEqual({ dir: '/a', base: 'moge', ext: '.scene.json' });
    // sidecars are not asset kinds, so they are not in the classifier's list — listed separately
    expect(splitAssetPath('/a/x.png.meta.json')).toEqual({ dir: '/a', base: 'x.png', ext: '.meta.json' });
  });

  // An ORDINARY dot is part of the name, not the start of the extension. This is the
  // reported bug: macOS screenshots are named `... 11.35.37 AM.png`, and the first-dot
  // rule made the rename box offer only `Screenshot 2026-08-20 at 11` — renaming to
  // "Test" produced `Test.35.37 AM.png`, with the timestamp welded on unremovably.
  it('splits only the LAST extension when the name merely contains dots', () => {
    expect(splitAssetPath('/a/Screenshot 2026-08-20 at 11.35.37 AM.png'))
      .toEqual({ dir: '/a', base: 'Screenshot 2026-08-20 at 11.35.37 AM', ext: '.png' });
    expect(splitAssetPath('/a/v1.2.glb')).toEqual({ dir: '/a', base: 'v1.2', ext: '.glb' });
    // a known compound extension still wins, with the extra dots left on the base
    expect(splitAssetPath('/a/Level.1.court.json')).toEqual({ dir: '/a', base: 'Level.1', ext: '.court.json' });
  });

  // Duplicate/paste naming shares the split, so the bug reached copy names too.
  it('names a copy of a dotted file without swallowing the dots', () => {
    expect(duplicatePathFor('/a/v1.2.glb', new Set(['/a/v1.2.glb']))).toBe('/a/v1.2 copy.glb');
  });

  it('handles no extension and no directory', () => {
    expect(splitAssetPath('/a/folder')).toEqual({ dir: '/a', base: 'folder', ext: '' });
    expect(splitAssetPath('file.png')).toEqual({ dir: '', base: 'file', ext: '.png' });
  });

  // F8 — a leading dot is part of the base (dotfile), not an empty-base extension.
  it('treats a leading dot (dotfile) as part of the base, not an extension', () => {
    expect(splitAssetPath('/a/.gitkeep')).toEqual({ dir: '/a', base: '.gitkeep', ext: '' });
    expect(splitAssetPath('.gitkeep')).toEqual({ dir: '', base: '.gitkeep', ext: '' });
    // dotfile WITH a real extension: leading dot stays on the base, then split on the next dot.
    expect(splitAssetPath('/a/.config.json')).toEqual({ dir: '/a', base: '.config', ext: '.json' });
  });

  it('handles multi-dot and trailing-dot names', () => {
    // Was `base:'foo', ext:'.bar.baz'` under the first-dot rule. That expectation was
    // wrong, not merely different: `.bar.baz` is not a known compound extension, so
    // `.bar` is part of the user's filename and must stay editable.
    expect(splitAssetPath('/a/foo.bar.baz')).toEqual({ dir: '/a', base: 'foo.bar', ext: '.baz' });
    expect(splitAssetPath('/a/foo.')).toEqual({ dir: '/a', base: 'foo', ext: '.' });
  });

  it('duplicate of a dotfile keeps its name (regression for the empty-base bug)', () => {
    expect(duplicatePathFor('/a/.gitkeep', new Set())).toBe('/a/.gitkeep copy');
  });
});

describe('duplicatePathFor', () => {
  it('appends " copy" when the target is free', () => {
    expect(duplicatePathFor('/a/tree.glb', new Set())).toBe('/a/tree copy.glb');
  });

  it('bumps to " copy 2", " copy 3" on collision', () => {
    const taken = new Set(['/a/tree copy.glb', '/a/tree copy 2.glb']);
    expect(duplicatePathFor('/a/tree.glb', taken)).toBe('/a/tree copy 3.glb');
  });

  it('preserves compound extensions', () => {
    expect(duplicatePathFor('/a/hero.prefab.json', new Set())).toBe('/a/hero copy.prefab.json');
  });
});

describe('pastePathIn', () => {
  it('keeps the original name when the target folder has no collision', () => {
    expect(pastePathIn('/b', '/a/tree.glb', new Set())).toBe('/b/tree.glb');
  });

  it('appends " copy" / " copy N" on collision (e.g. pasting into the same folder)', () => {
    const taken = new Set(['/a/tree.glb', '/a/tree copy.glb']);
    expect(pastePathIn('/a', '/a/tree.glb', taken)).toBe('/a/tree copy 2.glb');
  });

  it('normalizes the root folder ("/") to a bare prefix', () => {
    expect(pastePathIn('/', '/a/tree.glb', new Set())).toBe('/tree.glb');
  });

  it('preserves compound extensions', () => {
    expect(pastePathIn('/b', '/a/hero.prefab.json', new Set())).toBe('/b/hero.prefab.json');
  });
});

describe('remapPrefix', () => {
  it('remaps an exact match and any descendants, leaving unrelated entries', () => {
    const set = new Set(['/a/old', '/a/old/x.png', '/a/old/sub/y.png', '/a/other', '/a/older']);
    const out = remapPrefix(set, '/a/old', '/a/new');
    expect([...out].sort()).toEqual(
      ['/a/new', '/a/new/sub/y.png', '/a/new/x.png', '/a/older', '/a/other'].sort(),
    );
  });

  it('does NOT touch a sibling that merely shares a name prefix', () => {
    // "/a/old2" must not be rewritten when renaming "/a/old".
    const out = remapPrefix(new Set(['/a/old2/x']), '/a/old', '/a/new');
    expect([...out]).toEqual(['/a/old2/x']);
  });
});

describe('buildFolderTree', () => {
  it('groups assets into nested folders', () => {
    const tree = buildFolderTree([asset('/m/a.glb'), asset('/m/sub/b.glb'), asset('/c.png')]);
    expect(tree.path).toBe('/');
    expect(tree.files.map(f => f.path)).toEqual(['/c.png']);
    const m = tree.children.find(c => c.name === 'm')!;
    expect(m.files.map(f => f.path)).toEqual(['/m/a.glb']);
    expect(m.children.find(c => c.name === 'sub')!.files.map(f => f.path)).toEqual(['/m/sub/b.glb']);
  });

  it('seeds empty folders from extraFolders (which hold no assets)', () => {
    const tree = buildFolderTree([asset('/m/a.glb')], ['/m/empty', '/standalone']);
    const m = tree.children.find(c => c.name === 'm')!;
    expect(m.children.find(c => c.name === 'empty')).toBeTruthy();
    expect(tree.children.find(c => c.name === 'standalone')).toBeTruthy();
    // The seeded "/" itself is a no-op, never duplicated.
    expect(tree.children.filter(c => c.name === 'standalone')).toHaveLength(1);
  });

  it('sorts children and files alphabetically', () => {
    const tree = buildFolderTree([asset('/z.png'), asset('/a.png')], ['/zeta', '/alpha']);
    expect(tree.files.map(f => f.name)).toEqual(['a.png', 'z.png']);
    expect(tree.children.map(c => c.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('planAutoImports', () => {
  const setOf = (...paths: string[]) => new Set(paths);

  it('imports a newly-added model that has no sibling prefab', () => {
    const added = [typed('/assets/models/ship.glb', 'model')];
    const { models, textures } = planAutoImports(added, setOf('/assets/models/ship.glb'));
    expect(models.map(m => m.path)).toEqual(['/assets/models/ship.glb']);
    expect(textures).toEqual([]);
  });

  it('skips a model whose sibling <name>.prefab.json already exists (already imported)', () => {
    const added = [typed('/assets/models/ship.glb', 'model')];
    const all = setOf('/assets/models/ship.glb', '/assets/models/ship.prefab.json');
    expect(planAutoImports(added, all).models).toEqual([]);
  });

  it('strips only the LAST extension for the sibling check (multi-dot model names)', () => {
    const added = [typed('/assets/models/ship.lod0.glb', 'model')];
    // importModelWithMeta would write ship.lod0.prefab.json — so that's the marker.
    expect(planAutoImports(added, setOf('/assets/models/ship.lod0.glb', '/assets/models/ship.lod0.prefab.json')).models).toEqual([]);
    expect(planAutoImports(added, setOf('/assets/models/ship.lod0.glb')).models.map(m => m.path)).toEqual(['/assets/models/ship.lod0.glb']);
  });

  it('skips a .colmesh.glb (collision source, not a render model — no prefab/import)', () => {
    const added = [typed('/assets/models/terrain/terrain_col.colmesh.glb', 'model')];
    expect(planAutoImports(added, setOf('/assets/models/terrain/terrain_col.colmesh.glb')).models).toEqual([]);
  });

  it('imports newly-added textures (convert with default config)', () => {
    const added = [typed('/assets/tex/wood.png', 'texture'), typed('/assets/tex/metal.jpg', 'texture')];
    const { models, textures } = planAutoImports(added, setOf('/assets/tex/wood.png', '/assets/tex/metal.jpg'));
    expect(models).toEqual([]);
    expect(textures.map(t => t.path)).toEqual(['/assets/tex/wood.png', '/assets/tex/metal.jpg']);
  });

  it('ignores import OUTPUTS and other types (no loop): prefab, mesh, material, scene', () => {
    const added = [
      typed('/a/x.prefab.json', 'prefab'), typed('/a/x.mesh.json', 'mesh'),
      typed('/a/x.mat.json', 'material'), typed('/a/level.json', 'scene'),
    ];
    expect(planAutoImports(added, new Set(added.map(a => a.path)))).toEqual({ models: [], textures: [] });
  });

  it('handles an empty diff', () => {
    expect(planAutoImports([], setOf('/a/x.glb'))).toEqual({ models: [], textures: [] });
  });
});

// #2054 — a MOVED asset is not a new one. Mutations, each checked red here:
// - judge by path only (drop the GUID clause in `diffAutoImportScan`): both move cases, the vacated-path case (its
//   moved `b.png` reappears as new), and "once a scan has seen an asset…".
// - judge by GUID only (drop the path clause): "an asset the last scan did not know…".
// - keep the queued GUIDs in `next` (`keepGuid` → always true): "a model moved while its import is still QUEUED".
// - leave out every ADDED GUID, not just the queued ones (`queued` → `new Set(added)`): "an added model the plan does not
//   queue…".
// - `markAutoImported` returns the baseline unchanged: "…moved AFTER its import finished, in the same batch, is a move".
describe('diffAutoImportScan (#2054)', () => {
  const added = (prev: ReturnType<typeof autoImportBaseline>, assets: AssetEntry[]) => diffAutoImportScan(prev, assets).added;
  const g = (path: string, type: string, guid?: string): AssetEntry => ({ ...typed(path, type), ...(guid ? { guid } : {}) });

  it('a renamed folder`s textures are moves, not adds — nothing to convert', () => {
    const before = [g('/assets/old/wood.png', 'texture', 'g-wood'), g('/assets/old/metal.png', 'texture', 'g-metal')];
    const after = [g('/assets/new/wood.png', 'texture', 'g-wood'), g('/assets/new/metal.png', 'texture', 'g-metal')];
    expect(added(autoImportBaseline(before), after)).toEqual([]);
  });

  it('a .glb moved WITHOUT its prefab is not imported again (no second prefab minted)', () => {
    const before = [g('/assets/models/kit/cone.glb', 'model', 'g-cone'), g('/assets/models/kit/cone.prefab.json', 'prefab', 'g-pf')];
    const after = [g('/assets/models/cone.glb', 'model', 'g-cone'), g('/assets/models/kit/cone.prefab.json', 'prefab', 'g-pf')];
    const r = diffAutoImportScan(autoImportBaseline(before), after);
    expect({ models: r.models, textures: r.textures }).toEqual({ models: [], textures: [] });
  });

  it('an asset the last scan did not know is new, at a new path or one a moved asset vacated', () => {
    const before = [g('/assets/a.png', 'texture', 'g-a')];
    const after = [g('/assets/b.png', 'texture', 'g-a'), g('/assets/a.png', 'texture', 'g-fresh'), g('/assets/c.png', 'texture', 'g-c')];
    // `a.png` is a known PATH, so it is not new even with a fresh GUID (a replaced file is the scanner's business).
    expect(added(autoImportBaseline(before), after).map((a) => a.path)).toEqual(['/assets/c.png']);
  });

  it('a copy carries a FRESH GUID, so it is new', () => {
    const before = [g('/assets/wood.png', 'texture', 'g-wood')];
    const after = [...before, g('/assets/wood copy.png', 'texture', 'g-copy')];
    expect(added(autoImportBaseline(before), after).map((a) => a.path)).toEqual(['/assets/wood copy.png']);
  });

  // The batch, as Assets.tsx runs it: scan 1 queues a.glb and b.glb; a's import FINISHES (marked); then, before b's turn,
  // both are dragged into kit/. Mid-batch scans bail, so the post-batch scan diffs against scan 1's `next` + the marks.
  const batch = () => {
    const r1 = diffAutoImportScan(autoImportBaseline([]), [g('/assets/a.glb', 'model', 'g-a'), g('/assets/b.glb', 'model', 'g-b')]);
    expect(r1.models.map((m) => m.path)).toEqual(['/assets/a.glb', '/assets/b.glb']);
    const afterBatch = markAutoImported(r1.next, r1.models[0]);
    return diffAutoImportScan(afterBatch, [
      g('/assets/kit/a.glb', 'model', 'g-a'), g('/assets/a.prefab.json', 'prefab', 'g-apf'), g('/assets/kit/b.glb', 'model', 'g-b'),
    ]);
  };

  it('a model moved while its import is still QUEUED is new at its new path, so it is imported there', () => {
    // b's queued import of /assets/b.glb failed (the file had gone), so its GUID was never marked.
    expect(batch().models.map((m) => m.path)).toContain('/assets/kit/b.glb');
  });

  it('a model moved AFTER its import finished, in the same batch, is a move — no second prefab', () => {
    expect(batch().models.map((m) => m.path)).not.toContain('/assets/kit/a.glb');
  });

  it('an added model the plan does not queue (its prefab came with it) is known at once, so a move of it is a move', () => {
    const r1 = diffAutoImportScan(autoImportBaseline([]), [g('/assets/a.glb', 'model', 'g-a'), g('/assets/a.prefab.json', 'prefab', 'g-apf')]);
    expect(r1.models).toEqual([]);
    const r2 = diffAutoImportScan(r1.next, [g('/assets/kit/a.glb', 'model', 'g-a'), g('/assets/a.prefab.json', 'prefab', 'g-apf')]);
    expect(r2.models).toEqual([]);
  });

  it('once a scan has seen an asset where it sits, a later move of it is a move', () => {
    const r1 = diffAutoImportScan(autoImportBaseline([]), [g('/assets/b.glb', 'model', 'g-b')]);
    const r2 = diffAutoImportScan(r1.next, [g('/assets/b.glb', 'model', 'g-b')]);
    expect(r2.added).toEqual([]);
    expect(added(r2.next, [g('/assets/kit/b.glb', 'model', 'g-b')])).toEqual([]);
  });

  it('an entry with no GUID falls back to the path test', () => {
    const before = [g('/assets/x.png', 'texture')];
    const after = [g('/assets/x.png', 'texture'), g('/assets/y.png', 'texture')];
    expect(added(autoImportBaseline(before), after).map((a) => a.path)).toEqual(['/assets/y.png']);
  });
});

describe('effectiveAssetsRoot', () => {
  it('collapses the redundant single-folder wrapper chain (assets ▸ assets)', () => {
    // buildFolderTree produces a virtual `/` root → one child `/assets`, then the
    // real category folders under it. The section header replaces that wrapper.
    const tree = buildFolderTree([
      asset('/assets/models/tree.glb'),
      asset('/assets/textures/wood.png'),
    ]);
    const root = effectiveAssetsRoot(tree);
    expect(root.path).toBe('/assets');
    expect(root.children.map((c) => c.name).sort()).toEqual(['models', 'textures']);
  });

  it('stops descending at the first branching node (2+ children)', () => {
    const tree = buildFolderTree([
      asset('/a/x.png'),
      asset('/b/y.png'),
    ]);
    // `/` wraps two children (a, b) → already branches, so it is the effective root.
    const root = effectiveAssetsRoot(tree);
    expect(root.path).toBe('/');
    expect(root.children.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('stops descending when a node has files of its own', () => {
    const tree = buildFolderTree([
      asset('/assets/readme.txt'),      // file directly in the single child
      asset('/assets/models/tree.glb'),
    ]);
    const root = effectiveAssetsRoot(tree);
    expect(root.path).toBe('/assets');
    expect(root.files.map((f) => f.name)).toEqual(['readme.txt']);
  });

  it('returns the root unchanged when it already branches at the top', () => {
    const tree = buildFolderTree([]);
    expect(effectiveAssetsRoot(tree)).toBe(tree); // empty root: no single child to descend into
  });
});

describe('collectFolderPaths', () => {
  it('returns the node path plus every descendant folder path', () => {
    const tree = buildFolderTree([
      asset('/assets/models/props/tree.glb'),
      asset('/assets/textures/wood.png'),
    ]);
    const paths = collectFolderPaths(tree).sort();
    expect(paths).toEqual([
      '/', '/assets', '/assets/models', '/assets/models/props', '/assets/textures',
    ]);
  });

  it('returns just the node itself for a leaf folder (no child folders)', () => {
    const tree = buildFolderTree([asset('/assets/x.png')]);
    const assetsNode = tree.children[0]; // /assets holds the file directly, no child folders
    expect(assetsNode.path).toBe('/assets');
    expect(collectFolderPaths(assetsNode)).toEqual(['/assets']);
  });

  it('appends into a provided accumulator', () => {
    const tree = buildFolderTree([asset('/assets/x.png')]);
    const out: string[] = ['seed'];
    const result = collectFolderPaths(tree, out);
    expect(result).toBe(out);
    expect(out[0]).toBe('seed');
    expect(out).toContain('/assets');
  });
});

// #2040: New Folder's name. Observed live: an empty folder made OUTSIDE the panel is in no list the panel keeps, so the
// name check alone picked it and every click was refused "Folder exists".
describe('createNewFolder', () => {
  /** A backend holding `onDisk`: 409 for a taken path, ok (and now taken) otherwise; records every attempt. */
  const backend = (onDisk: string[], failWith?: { status: number; error: string }) => {
    const disk = new Set(onDisk);
    const tried: string[] = [];
    const create = async (p: string) => {
      tried.push(p);
      if (failWith) return { ok: false as const, ...failWith };
      if (disk.has(p)) return { ok: false as const, status: 409, error: 'Folder exists' };
      disk.add(p);
      return { ok: true as const };
    };
    return { create, tried };
  };

  it('the first name the panel does not know, with no collision', async () => {
    const b = backend([]);
    expect(await createNewFolder('/assets/p', (p) => p === '/assets/p/New Folder', b.create))
      .toEqual({ ok: true, path: '/assets/p/New Folder 2', collided: false });
    expect(b.tried).toEqual(['/assets/p/New Folder 2']);
  });

  // Mutation: return on the first non-ok answer (no retry on 409) — the refusal the live run showed.
  it('a name the backend refuses as taken (a folder made outside the panel) is skipped, and the caller told to rescan', async () => {
    const b = backend(['/assets/p/New Folder 3']);
    const known = new Set(['/assets/p/New Folder', '/assets/p/New Folder 2']);
    expect(await createNewFolder('/assets/p', (p) => known.has(p), b.create))
      .toEqual({ ok: true, path: '/assets/p/New Folder 4', collided: true });
    expect(b.tried).toEqual(['/assets/p/New Folder 3', '/assets/p/New Folder 4']);
  });

  // Mutation: retry on every failure — a 403 would be retried 50 times and reported as "no free name".
  it('any other refusal is reported as it is, not retried', async () => {
    const b = backend([], { status: 403, error: 'outside the asset roots' });
    expect(await createNewFolder('/x', () => false, b.create)).toEqual({ ok: false, error: 'outside the asset roots', collided: false });
    expect(b.tried).toHaveLength(1);
  });

  it('gives up after a bounded number of real attempts, and the root parent spells /New Folder', async () => {
    const b = backend([]);
    const always = async (p: string) => { b.tried.push(p); return { ok: false as const, status: 409, error: 'Folder exists' }; };
    const r = await createNewFolder('', () => false, always);
    expect(r.ok).toBe(false);
    expect(b.tried[0]).toBe('/New Folder');
    expect(b.tried).toHaveLength(50);
  });
});
