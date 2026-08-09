/** Assets-panel list shaping (#105 Phase 3) — extracted from `Assets.tsx`'s
 *  `useMemo` bodies, which had no unit cover because reaching them meant rendering
 *  a 2,111-line panel.
 *
 *  `visibleOrder` carries the most risk: it must MIRROR the render's walk order,
 *  and it is what shift-range, arrow navigation and Select All operate on. A drift
 *  between the two has no visual symptom — the list looks right and the keyboard
 *  moves through it in an order the user cannot see. */

import { describe, it, expect } from 'vitest';
import {
  spritesByTexture, filterAssets, flatAssetTotal, groupByType, visibleOrder, ASSETS_SECTION,
} from '../../src/editor/panels/assetListing';
import { buildFolderTree, type AssetEntry, type FolderNode } from '../../src/editor/utils/assetPaths';

const a = (path: string, type = 'texture', name?: string): AssetEntry =>
  ({ path, name: name ?? path.split('/').pop()!, type }) as AssetEntry;

const sprite = (path: string, texture: string): AssetEntry =>
  ({ path, name: path.split('/').pop()!, type: 'sprite', sprite: { texture } }) as AssetEntry;

describe('spritesByTexture', () => {
  it('groups sliced sprites under the texture GUID they came from', () => {
    const m = spritesByTexture([a('/t/sheet.png'), sprite('/t/s0', 'guid-1'), sprite('/t/s1', 'guid-1'), sprite('/t/s2', 'guid-2')]);
    expect([...m.keys()]).toEqual(['guid-1', 'guid-2']);
    expect(m.get('guid-1')!.map((s) => s.path)).toEqual(['/t/s0', '/t/s1']);
  });

  it('ignores sprites with no source texture, and non-sprites', () => {
    const m = spritesByTexture([a('/t/sheet.png'), { path: '/t/orphan', name: 'orphan', type: 'sprite' } as AssetEntry]);
    expect(m.size).toBe(0);
  });
});

describe('filterAssets', () => {
  const ASSETS = [a('/x/hero.png'), a('/x/villain.glb', 'model'), a('/x/theme.mp3', 'audio'), sprite('/x/s0', 'g')];

  it('always drops sprites — they render as texture children, never standalone', () => {
    expect(filterAssets(ASSETS, '', new Set()).some((x) => x.type === 'sprite')).toBe(false);
  });

  it('matches the query against name OR path, case-insensitively', () => {
    expect(filterAssets(ASSETS, 'HERO', new Set()).map((x) => x.path)).toEqual(['/x/hero.png']);
    // path-only match: no asset is NAMED "x", but all of them live under /x/
    expect(filterAssets(ASSETS, '/x/', new Set())).toHaveLength(3);
  });

  it('applies the type filter only when at least one chip is active', () => {
    expect(filterAssets(ASSETS, '', new Set())).toHaveLength(3);
    expect(filterAssets(ASSETS, '', new Set(['model'])).map((x) => x.path)).toEqual(['/x/villain.glb']);
  });

  it('ANDs the query with the type filter', () => {
    expect(filterAssets(ASSETS, 'hero', new Set(['model']))).toEqual([]);
  });
});

describe('flatAssetTotal', () => {
  it('excludes sprites so the footer denominator matches the numerator', () => {
    // The bug this shape prevents: counting sprites here compares a sprite-free
    // `filtered` against a sprite-inflated total, so "N of M" never reaches M once
    // any texture is sliced.
    const assets = [a('/t/sheet.png'), sprite('/t/s0', 'g'), sprite('/t/s1', 'g')];
    expect(flatAssetTotal(assets)).toBe(1);
    expect(filterAssets(assets, '', new Set())).toHaveLength(flatAssetTotal(assets));
  });
});

describe('groupByType', () => {
  it('groups by type and orders sections canonically, not by first appearance', () => {
    // Deliberately fed in a scrambled order — the output must not depend on it.
    const grouped = groupByType([a('/z/c.mp3', 'audio'), a('/z/a.png', 'texture'), a('/z/b.glb', 'model'), a('/z/d.png', 'texture')]);
    const keys = [...grouped.keys()];
    expect(new Set(keys)).toEqual(new Set(['audio', 'texture', 'model']));
    expect(grouped.get('texture')!.map((x) => x.path)).toEqual(['/z/a.png', '/z/d.png']);

    // Same set, different input order ⇒ identical section order.
    const other = groupByType([a('/z/b.glb', 'model'), a('/z/d.png', 'texture'), a('/z/c.mp3', 'audio'), a('/z/a.png', 'texture')]);
    expect([...other.keys()]).toEqual(keys);
  });

  it('preserves input order WITHIN a section', () => {
    const grouped = groupByType([a('/z/second.png'), a('/z/first.png')]);
    expect(grouped.get('texture')!.map((x) => x.name)).toEqual(['second.png', 'first.png']);
  });
});

describe('visibleOrder — category view', () => {
  const grouped = groupByType([a('/z/a.png'), a('/z/b.png'), a('/z/c.glb', 'model')]);
  const emptyRoot = buildFolderTree([], []);

  it('lists only the types whose section is expanded', () => {
    expect(visibleOrder({ viewMode: 'category', grouped, assetsRoot: emptyRoot, expanded: new Set(['texture']) }))
      .toEqual(['/z/a.png', '/z/b.png']);
  });

  it('is empty when every section is collapsed', () => {
    expect(visibleOrder({ viewMode: 'category', grouped, assetsRoot: emptyRoot, expanded: new Set() })).toEqual([]);
  });

  it('walks sections in the grouped Map order, not the expanded set order', () => {
    const all = new Set([...grouped.keys()]);
    const order = visibleOrder({ viewMode: 'category', grouped, assetsRoot: emptyRoot, expanded: all });
    const sections = [...grouped.keys()];
    const firstOfEach = sections.map((s) => grouped.get(s)![0].path);
    // Each section's first item appears in section order.
    expect(firstOfEach.map((p) => order.indexOf(p))).toEqual([...firstOfEach.map((p) => order.indexOf(p))].sort((x, y) => x - y));
  });
});

describe('visibleOrder — folder view', () => {
  const assets = [a('/root/models/rig.glb', 'model'), a('/root/tex/a.png'), a('/root/tex/b.png'), a('/root/top.png')];
  const tree = buildFolderTree(assets, []);
  const allFolders = (n: FolderNode, out: string[] = []): string[] => {
    out.push(n.path);
    for (const c of n.children) allFolders(c, out);
    return out;
  };

  it('shows nothing until the Assets section itself is expanded', () => {
    const expanded = new Set(allFolders(tree));
    expect(visibleOrder({ viewMode: 'folder', grouped: new Map(), assetsRoot: tree, expanded })).toEqual([]);
  });

  it('walks children before files, and only under expanded folders', () => {
    const expanded = new Set([ASSETS_SECTION, ...allFolders(tree)]);
    const order = visibleOrder({ viewMode: 'folder', grouped: new Map(), assetsRoot: tree, expanded });
    // Every asset is reachable...
    expect(new Set(order)).toEqual(new Set(assets.map((x) => x.path)));
    // ...and the root's own file sorts AFTER the files nested in its subfolders,
    // which is what "children before files" means for keyboard navigation.
    expect(order[order.length - 1]).toBe('/root/top.png');
  });

  it('hides the contents of a collapsed subfolder without hiding its siblings', () => {
    const expanded = new Set([ASSETS_SECTION, ...allFolders(tree)]);
    const texFolder = allFolders(tree).find((p) => p.endsWith('/tex'))!;
    expanded.delete(texFolder);
    const order = visibleOrder({ viewMode: 'folder', grouped: new Map(), assetsRoot: tree, expanded });
    expect(order).not.toContain('/root/tex/a.png');
    expect(order).toContain('/root/models/rig.glb');
    expect(order).toContain('/root/top.png');
  });

  it('ignores the grouped map entirely in folder view', () => {
    const expanded = new Set([ASSETS_SECTION, ...allFolders(tree)]);
    const withGroups = visibleOrder({ viewMode: 'folder', grouped: groupByType(assets), assetsRoot: tree, expanded });
    const without = visibleOrder({ viewMode: 'folder', grouped: new Map(), assetsRoot: tree, expanded });
    expect(withGroups).toEqual(without);
  });
});
