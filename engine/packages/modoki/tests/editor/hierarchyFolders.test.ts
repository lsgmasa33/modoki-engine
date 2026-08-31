/** Pure Hierarchy tree helpers: search pruning, type collection, and tag-based
 *  folder grouping. Guards the derive-folders-from-editorFolder-tag contract
 *  (nestable via "/", empty folders seeded via `extraPaths`) without rendering React. */

import { describe, it, expect } from 'vitest';
import type { EntityInfo } from '../../src/runtime/core/ecs/entityUtils';
import {
  filterEntityTree, collectEntityTypes, normalizeFolderPath,
  buildHierarchyFolders, countFolderRoots, folderSubtreePaths, folderSubtreeRootIds, revealTargetsFor,
  groupRootsBySourceScene, resolveDropFolderSync,
} from '../../src/editor/panels/hierarchyFolders';

/** Minimal EntityInfo factory. */
function ent(id: number, name: string, extra: Partial<EntityInfo> = {}): EntityInfo {
  return { id, name, traits: [], parentId: 0, sortOrder: 0, ...extra };
}

describe('normalizeFolderPath', () => {
  it('trims segments and drops empties', () => {
    expect(normalizeFolderPath('  Enemies / Ranged ')).toBe('Enemies/Ranged');
    expect(normalizeFolderPath('/Enemies//Ranged/')).toBe('Enemies/Ranged');
    expect(normalizeFolderPath('')).toBe('');
    expect(normalizeFolderPath('   ')).toBe('');
  });
});

describe('buildHierarchyFolders', () => {
  it('leaves untagged roots ungrouped, in input order', () => {
    const roots = [ent(1, 'A'), ent(2, 'B'), ent(3, 'C')];
    const { folders, ungrouped } = buildHierarchyFolders(roots);
    expect(folders).toEqual([]);
    expect(ungrouped.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('groups tagged roots under a folder, sorted alphabetically', () => {
    const roots = [
      ent(1, 'Sun', { editorFolder: 'Lights' }),
      ent(2, 'cube'),
      ent(3, 'Fill', { editorFolder: 'Lights' }),
      ent(4, 'Island', { editorFolder: 'Env' }),
    ];
    const { folders, ungrouped } = buildHierarchyFolders(roots);
    expect(folders.map((f) => f.name)).toEqual(['Env', 'Lights']); // alphabetical
    // Roots inside a folder follow `compareSiblings` — sortOrder, then guid, then name —
    // the SAME rule the scene file is written with (#500). These two tie at sortOrder 0
    // with no guid, so the name decides: 'Fill' (id 3) before 'Sun' (id 1). This asserted
    // [1, 3] while the tiebreak was the ecs id, which made the panel's order depend on
    // load history and disagree with the file.
    expect(folders[1].roots.map((r) => r.id)).toEqual([3, 1]);
    expect(ungrouped.map((r) => r.id)).toEqual([2]);
  });

  it('synthesizes ancestor folders for a nested path', () => {
    const roots = [ent(1, 'Archer', { editorFolder: 'Enemies/Ranged' })];
    const { folders } = buildHierarchyFolders(roots);
    expect(folders.map((f) => f.name)).toEqual(['Enemies']);
    expect(folders[0].roots).toEqual([]); // nothing tagged directly on "Enemies"
    expect(folders[0].children.map((c) => c.name)).toEqual(['Ranged']);
    expect(folders[0].children[0].roots.map((r) => r.id)).toEqual([1]);
  });

  it('normalizes tags so equivalent paths collapse to one folder', () => {
    const roots = [
      ent(1, 'a', { editorFolder: 'Lights' }),
      ent(2, 'b', { editorFolder: ' Lights ' }),
      ent(3, 'c', { editorFolder: '/Lights/' }),
    ];
    const { folders } = buildHierarchyFolders(roots);
    expect(folders).toHaveLength(1);
    expect(folders[0].roots.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('orders roots within a folder by sortOrder then id', () => {
    const roots = [
      ent(3, 'c', { editorFolder: 'F', sortOrder: 20 }),
      ent(1, 'a', { editorFolder: 'F', sortOrder: 10 }),
      ent(2, 'b', { editorFolder: 'F', sortOrder: 10 }),
    ];
    const { folders } = buildHierarchyFolders(roots);
    expect(folders[0].roots.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe('buildHierarchyFolders — empty folders (extraPaths)', () => {
  it('renders a rootless folder seeded from extraPaths', () => {
    const { folders } = buildHierarchyFolders([], ['New Folder']);
    expect(folders.map((f) => f.name)).toEqual(['New Folder']);
    expect(countFolderRoots(folders[0])).toBe(0);
  });

  it('seeds a nested empty subfolder, synthesizing its ancestor', () => {
    const { folders } = buildHierarchyFolders(
      [ent(1, 'E', { editorFolder: 'Enemies/Melee' })],
      ['Enemies/Ranged'],
    );
    const enemies = folders.find((f) => f.name === 'Enemies')!;
    expect(enemies.children.map((c) => c.name).sort()).toEqual(['Melee', 'Ranged']);
    expect(enemies.children.find((c) => c.name === 'Ranged')!.roots).toEqual([]);
  });

  it('does not duplicate a folder that is both tagged and seeded', () => {
    const { folders } = buildHierarchyFolders([ent(1, 'E', { editorFolder: 'Env' })], ['Env']);
    expect(folders).toHaveLength(1);
    expect(folders[0].roots.map((r) => r.id)).toEqual([1]);
  });

  it('ignores blank extra paths', () => {
    expect(buildHierarchyFolders([], ['', '  ']).folders).toEqual([]);
  });
});

describe('countFolderRoots', () => {
  it('sums a folder and all descendant folders', () => {
    const roots = [
      ent(1, 'a', { editorFolder: 'Enemies' }),
      ent(2, 'b', { editorFolder: 'Enemies/Ranged' }),
      ent(3, 'c', { editorFolder: 'Enemies/Ranged/Elite' }),
    ];
    const { folders } = buildHierarchyFolders(roots);
    expect(countFolderRoots(folders[0])).toBe(3);
  });
});

describe('folderSubtreePaths / folderSubtreeRootIds (Alt-click recursive)', () => {
  const roots = [
    ent(1, 'a', { editorFolder: 'Enemies' }),
    ent(2, 'b', { editorFolder: 'Enemies/Ranged' }),
    ent(3, 'c', { editorFolder: 'Enemies/Ranged/Elite' }),
    ent(9, 'z', { editorFolder: 'Other' }),
  ];
  const { folders } = buildHierarchyFolders(roots);
  const enemies = folders.find((f) => f.path === 'Enemies')!;

  it('collects the folder path plus every descendant subfolder path', () => {
    expect(folderSubtreePaths(enemies).sort()).toEqual(
      ['Enemies', 'Enemies/Ranged', 'Enemies/Ranged/Elite'],
    );
  });

  it('collects member root ids across the whole folder subtree, excluding siblings', () => {
    expect(folderSubtreeRootIds(enemies).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe('filterEntityTree', () => {
  const tree: EntityInfo[] = [
    { ...ent(1, 'Parent'), children: [ent(2, 'ChildMatch'), ent(3, 'Other')] },
    ent(4, 'Lonely'),
  ];

  it('keeps a match and its ancestors, pruning non-matching siblings', () => {
    const out = filterEntityTree(tree, (e) => e.name === 'ChildMatch');
    expect(out.map((n) => n.name)).toEqual(['Parent']);
    expect(out[0].children!.map((c) => c.name)).toEqual(['ChildMatch']); // sibling "Other" pruned
  });

  it('returns empty when nothing matches', () => {
    expect(filterEntityTree(tree, () => false)).toEqual([]);
  });

  it('keeps a matching parent (with only its matching subtree)', () => {
    const out = filterEntityTree(tree, (e) => e.name === 'Parent');
    expect(out.map((n) => n.name)).toEqual(['Parent']);
    expect(out[0].children).toEqual([]); // no descendant matched
  });
});

describe('collectEntityTypes', () => {
  it('counts trait occurrences across the whole tree, sorted by name', () => {
    const tree: EntityInfo[] = [
      { ...ent(1, 'A', { traits: ['Transform', 'Light'] }), children: [ent(2, 'B', { traits: ['Transform'] })] },
      ent(3, 'C', { traits: ['Camera', 'Transform'] }),
    ];
    expect(collectEntityTypes(tree)).toEqual([
      ['Camera', 1], ['Light', 1], ['Transform', 3],
    ]);
  });
});

describe('revealTargetsFor', () => {
  // A viewport click can select an entity buried under collapsed ancestors AND inside a
  // collapsed folder. Both have to open or the row never mounts, and an unmounted row
  // can't be scrolled to — the selection looks like it silently didn't happen.
  const flat = [
    ent(1, 'Island', { editorFolder: 'Levels/Tropical' }),
    ent(2, 'Boat', { parentId: 1 }),
    ent(3, 'Oar', { parentId: 2 }),
    ent(9, 'LooseRoot'),
  ];

  it('walks the full ancestor chain up to the root', () => {
    expect(revealTargetsFor(flat, 3).ancestorIds).toEqual([2, 1]);
  });

  it('returns the root ancestor\'s folder plus every ancestor folder', () => {
    // "Levels/Tropical" renders INSIDE "Levels", so both must be open.
    expect(revealTargetsFor(flat, 3).folderPaths).toEqual(['Levels', 'Levels/Tropical']);
  });

  it('reads editorFolder off the ROOT, not the selected descendant', () => {
    // Only roots carry the tag; a child's own (absent) tag must not shadow the root's.
    expect(revealTargetsFor(flat, 2).folderPaths).toEqual(['Levels', 'Levels/Tropical']);
    expect(revealTargetsFor(flat, 1).folderPaths).toEqual(['Levels', 'Levels/Tropical']);
  });

  it('an untagged root needs nothing revealed', () => {
    expect(revealTargetsFor(flat, 9)).toEqual({ ancestorIds: [], folderPaths: [] });
  });

  it('an unknown id yields empty targets (caller skips the state write)', () => {
    expect(revealTargetsFor(flat, 404)).toEqual({ ancestorIds: [], folderPaths: [] });
  });

  it('normalizes a sloppily-typed folder tag', () => {
    const messy = [ent(1, 'R', { editorFolder: ' /Levels// Tropical/ ' }), ent(2, 'C', { parentId: 1 })];
    expect(revealTargetsFor(messy, 2).folderPaths).toEqual(['Levels', 'Levels/Tropical']);
  });
});

describe('groupRootsBySourceScene (base-scene plan, Phase 9)', () => {
  it('a scene with no base loaded collapses to a single primary group', () => {
    const roots = [ent(1, 'A'), ent(2, 'B')];
    const groups = groupRootsBySourceScene(roots, ['']);
    expect(groups).toEqual([{ sourceScene: '', roots }]);
  });

  it('orders base-most first, primary LAST — matching the chain load order', () => {
    const roots = [
      ent(1, 'LevelThing', { sourceScene: '' }),
      ent(2, 'Camera', { sourceScene: 'g-base' }),
      ent(3, 'Time', { sourceScene: 'g-base' }),
    ];
    const groups = groupRootsBySourceScene(roots, ['g-base', '']);
    expect(groups.map((g) => g.sourceScene)).toEqual(['g-base', '']);
    expect(groups[0].roots.map((r) => r.id)).toEqual([2, 3]);
    expect(groups[1].roots.map((r) => r.id)).toEqual([1]);
  });

  it('omits a scene from sceneOrder that contributed no roots', () => {
    const roots = [ent(1, 'LevelThing', { sourceScene: '' })];
    const groups = groupRootsBySourceScene(roots, ['g-base', '']);
    expect(groups.map((g) => g.sourceScene)).toEqual(['']);
  });

  it('supports a nested chain (two base scenes)', () => {
    const roots = [
      ent(1, 'EngineThing', { sourceScene: 'g-engine' }),
      ent(2, 'GameThing', { sourceScene: 'g-game' }),
      ent(3, 'LevelThing', { sourceScene: '' }),
    ];
    const groups = groupRootsBySourceScene(roots, ['g-engine', 'g-game', '']);
    expect(groups.map((g) => g.sourceScene)).toEqual(['g-engine', 'g-game', '']);
  });

  it('a stale sourceScene not in sceneOrder is still surfaced, not dropped', () => {
    const roots = [
      ent(1, 'LevelThing', { sourceScene: '' }),
      ent(2, 'Orphan', { sourceScene: 'g-gone' }),
    ];
    const groups = groupRootsBySourceScene(roots, ['']);
    expect(groups.map((g) => g.sourceScene)).toEqual(['', 'g-gone']);
    expect(groups[1].roots.map((r) => r.id)).toEqual([2]);
  });

  it('an undefined sourceScene is treated the same as empty (primary)', () => {
    const roots = [ent(1, 'A'), ent(2, 'B', { sourceScene: '' })];
    const groups = groupRootsBySourceScene(roots, ['']);
    expect(groups).toHaveLength(1);
    expect(groups[0].roots.map((r) => r.id)).toEqual([1, 2]);
  });
});

// Regression coverage for the Hierarchy before/after drag-reorder folder-sync fix
// (2026-07-27): dropping a folder member next to an ungrouped sibling used to silently
// leave the stale editorFolder tag, because the reorder path only touched
// parentId/sortOrder. The decision itself is extracted here so it's unit-testable
// without a rendered Hierarchy + real drag events (Hierarchy.tsx's EntityNode drop
// handler is the only caller).
describe('resolveDropFolderSync', () => {
  it('dropping next to an ungrouped sibling clears the dragged entity\'s folder tag', () => {
    expect(resolveDropFolderSync(0, '', 'Enemies')).toBe('');
  });

  it('dropping next to a folder member adopts that folder', () => {
    expect(resolveDropFolderSync(0, 'Enemies', '')).toBe('Enemies');
  });

  it('dropping next to a member of the SAME folder is a no-op (returns null)', () => {
    expect(resolveDropFolderSync(0, 'Enemies', 'Enemies')).toBeNull();
  });

  it('dropping next to an ungrouped sibling when already ungrouped is a no-op', () => {
    expect(resolveDropFolderSync(0, '', '')).toBeNull();
  });

  it('a non-root reorder (nested sibling) never touches the folder tag — folders only tag roots', () => {
    expect(resolveDropFolderSync(7, 'Enemies', '')).toBeNull();
  });

  it('normalizes both sides before comparing, so equivalent paths are not treated as a change', () => {
    expect(resolveDropFolderSync(0, '/Enemies/', 'Enemies')).toBeNull();
  });
});
