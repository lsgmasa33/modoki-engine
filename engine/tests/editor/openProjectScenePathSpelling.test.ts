/** #1898 — the open project's scenes have ONE spelling in the editor, `/assets/…`. Vite also serves them as
 *  `/@fs/<abs>/runtime/assets/…` (a game's `config.ts` `?url` import, an explicit `/@fs/` load), and that spelling used to
 *  be stored as-is: `get_editor_state.scenePath` read `/@fs/…` after `modoki_open_project` and a scaffolded project's
 *  fresh launch, so `modoki_wait_for {editor:{scenePath:'/assets/…'}}` never matched (OBSERVED live by work-qa, and here
 *  on work-ai3's editor before the fix). Two causes: the `/@fs/` prefix swallowed a POSIX path's leading slash, so the
 *  origin check could never match on a Mac, and Vite's `/@fs/` is a REALPATH while the root is as opened (`/tmp` vs
 *  `/private/tmp`).
 *
 *  #1899 rides the same load: a scene load tells the observer when it starts reading and when it adopted, so the
 *  outside-change hold can drop the change the load read (the bridge side: agentBridgeLoadAppliesHeld.test.ts).
 *
 *  Mutations, each measured red here and restored: the leading slash not restored (`abs = m[1]`) → the POSIX cases; the
 *  setter's `toOpenProjectScenePath` dropped → "every writer"; loadScene's entry rewrite dropped → "a /@fs/ load";
 *  `begins` called after the read → "before its read"; `loaded` called before the load's read → "a load that fails"; the
 *  origin check widened back to "inside the root" → "a folder INSIDE the root". */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getCurrentWorld, sceneManager } from '@modoki/engine/runtime';
import { setCurrentScenePath, getCurrentScenePath, loadScene } from '../../packages/modoki/src/editor/scene/serialize';
import { setFreshFileReadObserver } from '../../packages/modoki/src/editor/scene/freshFileRead';
import { setOpenProjectRoots, toOpenProjectScenePath } from '../../packages/modoki/src/editor/scene/openProjectScenePath';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const ROOT = '/tmp/probe';
const REAL_ROOT = '/private/tmp/probe';
const FS_SCENE = `/@fs${REAL_ROOT}/runtime/assets/scenes/main.scene.json`;

let game: TestWorld | undefined;
beforeEach(() => {
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  game = createTestWorld({});
  setPlayState('stopped');
});
afterEach(() => {
  setFreshFileReadObserver(null);
  setOpenProjectRoots([]);
  setCurrentScenePath(null);
  game?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('toOpenProjectScenePath', () => {
  it('a POSIX /@fs/ path inside the open project maps to /assets/', () => {
    expect(toOpenProjectScenePath('/@fs/Users/me/proj/runtime/assets/scenes/a.scene.json', ['/Users/me/proj'])).toBe('/assets/scenes/a.scene.json');
  });

  it('the realpath of a root reached through a link counts as the root', () => {
    expect(toOpenProjectScenePath(FS_SCENE, [ROOT])).toBe(FS_SCENE);
    expect(toOpenProjectScenePath(FS_SCENE, [ROOT, REAL_ROOT])).toBe('/assets/scenes/main.scene.json');
  });

  it('another project, a prefix-sharing sibling, and no known root all stay as they are', () => {
    const other = '/@fs/Users/me/other/runtime/assets/scenes/a.scene.json';
    const sibling = '/@fs/Users/me/proj-evil/runtime/assets/scenes/a.scene.json';
    expect(toOpenProjectScenePath(other, ['/Users/me/proj'])).toBe(other);
    expect(toOpenProjectScenePath(sibling, ['/Users/me/proj'])).toBe(sibling);
    expect(toOpenProjectScenePath('/@fs/Users/me/proj/runtime/assets/scenes/a.scene.json', [])).toBe('/@fs/Users/me/proj/runtime/assets/scenes/a.scene.json');
  });

  it('a folder INSIDE the root is not the root: a package\'s runtime/assets, a nested runtime/assets chain (review F6)', () => {
    const inPackage = '/@fs/Users/me/proj/node_modules/@modoki/engine/src/runtime/assets/scenes/x.scene.json';
    const nested = '/@fs/Users/me/proj/runtime/assets/scenes/runtime/assets/x.scene.json';
    expect(toOpenProjectScenePath(inPackage, ['/Users/me/proj'])).toBe(inPackage);
    expect(toOpenProjectScenePath(nested, ['/Users/me/proj'])).toBe(nested);
  });

  it('a Windows /@fs/ path keeps working (drive letter, backslash root)', () => {
    expect(toOpenProjectScenePath('/@fs/E:/P/sling/runtime/assets/scenes/L.json', ['E:\\P\\sling'])).toBe('/assets/scenes/L.json');
  });

  it('an /assets/ path and a non-scene path pass through', () => {
    expect(toOpenProjectScenePath('/assets/scenes/a.scene.json', [ROOT])).toBe('/assets/scenes/a.scene.json');
    expect(toOpenProjectScenePath('/__prefab-edit__/x', [ROOT])).toBe('/__prefab-edit__/x');
  });
});

describe('the editor stores one spelling', () => {
  it('every writer: setCurrentScenePath stores an open-project /@fs/ path as /assets/', () => {
    setOpenProjectRoots([ROOT, REAL_ROOT]);
    setCurrentScenePath(FS_SCENE);
    expect(getCurrentScenePath()).toBe('/assets/scenes/main.scene.json');
  });

  it('a /@fs/ load of an open-project scene loads, and is adopted, under /assets/', async () => {
    setOpenProjectRoots([ROOT, REAL_ROOT]);
    const load = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: getCurrentWorld(), keptBaseGuids: new Set<string>() }));
    expect(await loadScene(FS_SCENE)).toBe('loaded');
    expect(load.mock.calls[0][0]).toBe('/assets/scenes/main.scene.json');
    expect(getCurrentScenePath()).toBe('/assets/scenes/main.scene.json');
  });
});

describe('a scene load reports the file it read (#1899)', () => {
  it('begins before its read, and reports the adopt with the same mark', async () => {
    const order: string[] = [];
    setFreshFileReadObserver({
      begins: (p) => { order.push(`begins ${p}`); return [7]; },
      loaded: (p, covered) => { order.push(`loaded ${p} ${covered.join()}`); },
    });
    vi.spyOn(sceneManager, 'loadScene').mockImplementation(async (p: string) => {
      order.push(`read ${p}`);
      return { world: getCurrentWorld(), keptBaseGuids: new Set<string>() };
    });
    expect(await loadScene('/assets/scenes/a.scene.json')).toBe('loaded');
    expect(order).toEqual(['begins /assets/scenes/a.scene.json', 'read /assets/scenes/a.scene.json', 'loaded /assets/scenes/a.scene.json 7']);
  });

  it('a load that fails reports no adopt — its bytes applied nothing', async () => {
    const loaded = vi.fn();
    setFreshFileReadObserver({ begins: () => [7], loaded }); // a held change it would cover — so only the failure keeps `loaded` silent
    vi.spyOn(sceneManager, 'loadScene').mockRejectedValueOnce(new Error('404'));
    expect(await loadScene('/assets/scenes/missing.scene.json', undefined, { probing: true })).toBe('failed');
    expect(loaded).not.toHaveBeenCalled();
  });
});
