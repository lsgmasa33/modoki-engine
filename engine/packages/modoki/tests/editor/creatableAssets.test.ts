/** creatableAssets — the registry backing the Assets panel's "Create X" folder-context
 *  menu (Change A). Covers what the panel actually relies on: register/replace-by-id,
 *  order (ties broken alphabetically, unset order sorts last), and unregister. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCreatableAsset, unregisterCreatableAsset, getCreatableAssets,
} from '../../src/editor/panels/creatableAssets';

// The registry is a module-level singleton — clear every id this file touches before
// each test so tests don't leak into each other (or into other test files sharing the
// module in the same worker).
const TEST_IDS = ['test.a', 'test.b', 'test.c', 'test.replace'];
function clear() { for (const id of TEST_IDS) unregisterCreatableAsset(id); }

describe('creatableAssets registry', () => {
  beforeEach(clear);

  it('registers an entry and getCreatableAssets() returns it', () => {
    registerCreatableAsset({ id: 'test.a', label: 'Create A', ext: '.a.json', defaultName: 'New A', assetType: 'a' });
    const ids = getCreatableAssets().map((d) => d.id);
    expect(ids).toContain('test.a');
  });

  it('a second register() with the same id REPLACES, not duplicates', () => {
    registerCreatableAsset({ id: 'test.replace', label: 'First', ext: '.a.json', defaultName: 'New A', assetType: 'a' });
    registerCreatableAsset({ id: 'test.replace', label: 'Second', ext: '.a.json', defaultName: 'New A', assetType: 'a' });
    const matches = getCreatableAssets().filter((d) => d.id === 'test.replace');
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe('Second');
  });

  it('sorts by `order` ascending, ties broken by label', () => {
    registerCreatableAsset({ id: 'test.b', label: 'B Second', ext: '.b.json', defaultName: 'New B', assetType: 'b', order: 5 });
    registerCreatableAsset({ id: 'test.a', label: 'A First', ext: '.a.json', defaultName: 'New A', assetType: 'a', order: 1 });
    registerCreatableAsset({ id: 'test.c', label: 'C Tied With Second At order 5', ext: '.c.json', defaultName: 'New C', assetType: 'c', order: 5 });
    const ids = getCreatableAssets().filter((d) => TEST_IDS.includes(d.id)).map((d) => d.id);
    // order 1 first, then order-5 ties broken alphabetically by label ("B Second" < "C Tied...")
    expect(ids).toEqual(['test.a', 'test.b', 'test.c']);
  });

  it('an entry with no `order` sorts after every entry that has one', () => {
    registerCreatableAsset({ id: 'test.a', label: 'Ordered', ext: '.a.json', defaultName: 'New A', assetType: 'a', order: 0 });
    registerCreatableAsset({ id: 'test.b', label: 'Unordered', ext: '.b.json', defaultName: 'New B', assetType: 'b' });
    const ids = getCreatableAssets().filter((d) => TEST_IDS.includes(d.id)).map((d) => d.id);
    expect(ids).toEqual(['test.a', 'test.b']);
  });

  it('unregisterCreatableAsset removes the entry', () => {
    registerCreatableAsset({ id: 'test.a', label: 'Create A', ext: '.a.json', defaultName: 'New A', assetType: 'a' });
    unregisterCreatableAsset('test.a');
    expect(getCreatableAssets().some((d) => d.id === 'test.a')).toBe(false);
  });
});
