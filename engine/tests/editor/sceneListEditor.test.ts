/** SceneListEditor's scene discovery (QA-DLG-0005).
 *
 *  The `options` the Project Settings schema carries are read ONCE, at editor setup
 *  (`/api/scenes` in `engine/app/editor/setup.ts`), and baked into a static field descriptor —
 *  so on their own they can only ever describe the scenes that existed when the app BOOTED.
 *  Measured on games/anim-bug: a scene authored live (New Scene → Save As) was already in the
 *  asset manifest and on disk, `modoki_list_assets {type:'scene'}` returned it, and this dialog
 *  still listed only the boot-time scene — silently, with no error, until a relaunch.
 *
 *  So the universe is taken from the LIVE manifest with `options` merged in. These tests pin the
 *  three things that decision has to keep true: the new scene appears, the boot-time LABELS still
 *  win (the host built them from the backend's own paths), and an empty manifest still yields the
 *  boot-time list rather than nothing. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const assets: { guid: string; path: string; type: string }[] = [];
vi.mock('../../packages/modoki/src/runtime/loaders/assetManifest', () => ({
  getAllAssets: () => assets,
}));

const { discoverScenes } = await import('../../packages/modoki/src/editor/panels/SceneListEditor');

beforeEach(() => { assets.length = 0; });

describe('discoverScenes', () => {
  it('includes a scene created AFTER boot — the whole defect', () => {
    assets.push(
      { guid: 'g-main', path: '/assets/scenes/main.scene.json', type: 'scene' },
      { guid: 'g-new', path: '/assets/scenes/qa-temp.scene.json', type: 'scene' },
    );
    const out = discoverScenes([{ value: 'g-main', label: 'main.scene.json' }]);
    expect(out.map((o) => o.value)).toEqual(['g-main', 'g-new']);
    expect(out[1].label).toBe('qa-temp.scene.json');
  });

  it('keeps the boot-time label for a scene both sources know', () => {
    // The host labels from the backend's own path listing; re-deriving one here for a scene
    // that already has a label would be a second source that can only drift.
    assets.push({ guid: 'g-main', path: '/somewhere/else/main.scene.json', type: 'scene' });
    expect(discoverScenes([{ value: 'g-main', label: 'Main Level' }])).toEqual([{ value: 'g-main', label: 'Main Level' }]);
  });

  it('ignores non-scene assets — the manifest holds every kind', () => {
    assets.push(
      { guid: 'g-tex', path: '/assets/textures/rock.png', type: 'texture' },
      { guid: 'g-pf', path: '/assets/prefabs/tree.prefab.json', type: 'prefab' },
    );
    expect(discoverScenes([])).toEqual([]);
  });

  it('falls back to the boot-time options when the manifest is empty', () => {
    // A bare host / a test / a backend that answered before the manifest loaded: the old
    // behaviour must still be the floor, never a regression to an empty list.
    expect(discoverScenes([{ value: 'g-main', label: 'main.scene.json' }]))
      .toEqual([{ value: 'g-main', label: 'main.scene.json' }]);
  });

  it('does not duplicate a guid listed twice in options', () => {
    expect(discoverScenes([
      { value: 'g-main', label: 'main.scene.json' },
      { value: 'g-main', label: 'main.scene.json' },
    ])).toHaveLength(1);
  });
});

describe('discoverScenes ordering', () => {
  // getAllAssets() returns the manifest map in INSERTION order, so a scene created during
  // the session is appended and would render LAST in the picker, then move on the next
  // reload. Same defect the sprite picker had (spritePickerGroups.sortGroupsByName).
  it('sorts manifest-discovered scenes by label, not by manifest order', () => {
    assets.push(
      { guid: 'g-z', path: '/assets/scenes/zebra.scene.json', type: 'scene' },
      { guid: 'g-a', path: '/assets/scenes/alpha.scene.json', type: 'scene' },
      { guid: 'g-m', path: '/assets/scenes/Mid.scene.json', type: 'scene' },
    );
    expect(discoverScenes([]).map((o) => o.value)).toEqual(['g-a', 'g-m', 'g-z']);
  });

  it('leaves the caller-supplied boot options ahead of discovered scenes, in their own order', () => {
    assets.push({ guid: 'g-a', path: '/assets/scenes/alpha.scene.json', type: 'scene' });
    const out = discoverScenes([
      { value: 'g-zzz', label: 'zzz boot' },
      { value: 'g-aaa', label: 'aaa boot' },
    ]);
    expect(out.map((o) => o.value)).toEqual(['g-zzz', 'g-aaa', 'g-a']);
  });
});
