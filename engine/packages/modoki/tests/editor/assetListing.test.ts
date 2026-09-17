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
  spritesByTexture, filterAssets, flatAssetTotal, fileActionTargets, fileActionPaths, groupByType, visibleOrder, ASSETS_SECTION,
} from '../../src/editor/panels/assetListing';
import { buildFolderTree, type AssetEntry, type FolderNode } from '../../src/editor/utils/assetPaths';

const a = (path: string, type = 'texture', name?: string): AssetEntry =>
  ({ path, name: name ?? path.split('/').pop()!, type }) as AssetEntry;

const sprite = (path: string, texture: string): AssetEntry =>
  ({ path, name: path.split('/').pop()!, type: 'sprite', sprite: { texture } }) as AssetEntry;

const NONE: ReadonlySet<string> = new Set();

describe('spritesByTexture', () => {
  it('groups sliced sprites under the texture GUID they came from', () => {
    const m = spritesByTexture([a('/t/sheet.png'), sprite('/t/s0', 'guid-1'), sprite('/t/s1', 'guid-1'), sprite('/t/s2', 'guid-2')], NONE);
    expect([...m.keys()]).toEqual(['guid-1', 'guid-2']);
    expect(m.get('guid-1')!.map((s) => s.path)).toEqual(['/t/s0', '/t/s1']);
  });

  it('ignores sprites with no source texture, and non-sprites', () => {
    const m = spritesByTexture([a('/t/sheet.png'), { path: '/t/orphan', name: 'orphan', type: 'sprite' } as AssetEntry], NONE);
    expect(m.size).toBe(0);
  });

  it('nests nothing while the sprite chip makes sprites rows — a listed texture would show them twice (#1249)', () => {
    const assets = [tex('/t/sheet.png', 'g'), sprite('/t/sheet.png#s0', 'g')];
    expect(spritesByTexture(assets, new Set(['sprite', 'texture'])).size).toBe(0);
    expect(spritesByTexture(assets, new Set(['texture'])).get('g')).toHaveLength(1);
  });
});

/** A texture with a GUID, which is what its sprites point at. */
const tex = (path: string, guid: string): AssetEntry => ({ ...a(path), guid }) as AssetEntry;

describe('filterAssets — sprites (#1249)', () => {
  // Court's shape: every texture carries one auto whole-image sprite; plus a sliced sheet.
  const ASSETS = [
    tex('/t/hero.png', 'g-hero'), sprite('/t/hero.png#default', 'g-hero'),
    tex('/t/sheet.png', 'g-sheet'), { ...sprite('/t/sheet.png#s0', 'g-sheet'), name: 'fish_03' } as AssetEntry,
    a('/m/villain.glb', 'model'),
  ];
  const paths = (xs: AssetEntry[]) => xs.map((x) => x.path);

  it('the sprite chip lists every sprite as a row — it listed 0 while the menu counted them', () => {
    expect(paths(filterAssets(ASSETS, '', new Set(['sprite'])))).toEqual(['/t/hero.png#default', '/t/sheet.png#s0']);
  });

  it('the sprite chip still ANDs with the search and with the other chips', () => {
    expect(paths(filterAssets(ASSETS, 'fish', new Set(['sprite'])))).toEqual(['/t/sheet.png#s0']);
    expect(paths(filterAssets(ASSETS, '', new Set(['sprite', 'model'])))).toEqual(['/t/hero.png#default', '/t/sheet.png#s0', '/m/villain.glb']);
  });

  it("a search for a slice's name lists that slice when its texture does not match", () => {
    expect(paths(filterAssets(ASSETS, 'fish_03', NONE))).toEqual(['/t/sheet.png#s0']);
  });

  it('a search that also matches the texture lists only the texture — its row already holds the sprite', () => {
    expect(paths(filterAssets(ASSETS, 'hero', NONE))).toEqual(['/t/hero.png']);
  });

  it('a chip that is not sprite keeps sprites out, search or not', () => {
    expect(paths(filterAssets(ASSETS, 'fish_03', new Set(['texture'])))).toEqual([]);
  });
});

describe('filterAssets', () => {
  // hero.png owns the sprite, so a search that lists hero.png leaves the sprite nested under it.
  const ASSETS = [tex('/x/hero.png', 'g'), a('/x/villain.glb', 'model'), a('/x/theme.mp3', 'audio'), sprite('/x/s0', 'g')];

  it('drops sprites while nothing narrows to them — they render as texture children', () => {
    expect(filterAssets(ASSETS, '', NONE).some((x) => x.type === 'sprite')).toBe(false);
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
    expect(flatAssetTotal(assets, '', NONE)).toBe(1);
    expect(filterAssets(assets, '', NONE)).toHaveLength(flatAssetTotal(assets, '', NONE));
  });

  it('counts sprites while the sprite chip makes them rows, so the footer can still reach M (#1249)', () => {
    const assets = [tex('/t/sheet.png', 'g'), sprite('/t/sheet.png#s0', 'g'), sprite('/t/sheet.png#s1', 'g')];
    const chips = new Set(['sprite', 'texture']);
    expect(flatAssetTotal(assets, '', chips)).toBe(3);
    expect(filterAssets(assets, '', chips)).toHaveLength(flatAssetTotal(assets, '', chips));
    expect(filterAssets(assets, '', new Set(['sprite']))).toHaveLength(2); // "2 of 3"
  });

  it('counts sprites while a search can list them, so N never exceeds M (#1249 close-out)', () => {
    // 3 slices matching "slice", on a sheet whose own name does not match, in a 1-texture project.
    const assets = [tex('/t/sheet.png', 'g'), ...[0, 1, 2].map((i) => ({ ...sprite(`/t/sheet.png#${i}`, 'g'), name: `slice_${i}` }) as AssetEntry)];
    const n = filterAssets(assets, 'slice', NONE).length;
    expect(n).toBe(3);
    expect(n).toBeLessThanOrEqual(flatAssetTotal(assets, 'slice', NONE));
    expect(flatAssetTotal(assets, '', NONE)).toBe(1); // cleared search: sprites nest again and leave the count
  });
});

describe('fileActionTargets', () => {
  it('drops sprites — no file of their own — and keeps everything else in order (#1249 close-out)', () => {
    const picked = [a('/t/a.png'), sprite('/t/a.png#0', 'g'), a('/m/b.glb', 'model')];
    expect(fileActionTargets(picked).map((x) => x.path)).toEqual(['/t/a.png', '/m/b.glb']);
    expect(fileActionTargets([sprite('/t/a.png#0', 'g')])).toEqual([]);
  });
});

describe('fileActionPaths (#1257)', () => {
  const assets = [a('/t/a.png'), sprite('/t/a.png#0', 'g'), sprite('/t/a.png#default', 'g'), a('/m/b.glb', 'model')];

  it('one texture plus its selected sprite rows counts as ONE target — the context menu must not read it as many', () => {
    // The menu derives `many` from this length; 3 here hid Rename/Re-import/Copy Path/Find References.
    const selection = new Set(['/t/a.png', '/t/a.png#0', '/t/a.png#default']);
    expect(fileActionPaths(selection, assets)).toEqual(['/t/a.png']);
  });

  it('a folder drop keeps the real files in order and drops every sprite path', () => {
    expect(fileActionPaths(['/t/a.png#0', '/t/a.png', '/t/a.png#default', '/m/b.glb'], assets))
      .toEqual(['/t/a.png', '/m/b.glb']);
  });

  it('keeps a path with no listed entry — a folder or an engine built-in is not this filter\'s call', () => {
    expect(fileActionPaths(['/t', 'engine:/white.hdr', '/t/a.png#0'], assets)).toEqual(['/t', 'engine:/white.hdr']);
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
