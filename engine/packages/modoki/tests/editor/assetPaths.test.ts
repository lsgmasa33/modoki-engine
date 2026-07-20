/** Unit tests for the Assets-panel pure path/tree helpers. These back the
 *  rename, duplicate, cut/paste, folder-rename, and folder-tree features —
 *  the compound-extension and collision edge cases especially. */

import { describe, it, expect } from 'vitest';
import {
  splitAssetPath, duplicatePathFor, pastePathIn, remapPrefix, buildFolderTree, planAutoImports,
  effectiveAssetsRoot, collectFolderPaths,
  type AssetEntry,
} from '../../src/editor/utils/assetPaths';

const asset = (path: string): AssetEntry => ({ path, name: path.split('/').pop()!, type: 'x' });
const typed = (path: string, type: string): AssetEntry => ({ path, name: path.split('/').pop()!, type });

describe('splitAssetPath', () => {
  it('splits a simple path + extension', () => {
    expect(splitAssetPath('/a/b/tree.glb')).toEqual({ dir: '/a/b', base: 'tree', ext: '.glb' });
  });

  it('keeps compound extensions intact (splits on the FIRST dot)', () => {
    expect(splitAssetPath('/a/weed.prefab.json')).toEqual({ dir: '/a', base: 'weed', ext: '.prefab.json' });
    expect(splitAssetPath('/a/m.mat.json')).toEqual({ dir: '/a', base: 'm', ext: '.mat.json' });
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
    expect(splitAssetPath('/a/foo.bar.baz')).toEqual({ dir: '/a', base: 'foo', ext: '.bar.baz' });
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
