/** Restoring the last-opened .rig2d rig across editor sessions — and, above all, NOT restoring
 *  one that belongs to a different project.
 *
 *  #473, the root cause behind #460. One clone serves every project it opens from the SAME origin
 *  (the Vite port is derived from the clone directory, not the project), so localStorage is shared
 *  across projects. Asset URLs carry no project segment — a rig in `games/skin-test` is served at
 *  `/assets/rigs/zombie.rig2d.json` — so a path remembered under one project is a VALID-LOOKING
 *  url in the next one, where it addresses a different asset root, finds nothing, and takes the
 *  dev server's SPA fallback (`200 index.html`). The human was then told their rig file was
 *  corrupt JSON about a file that was present and fine.
 *
 *  These are the two guards, and they cover different failures: the scoped KEY stops another
 *  project's rig, and the MANIFEST check stops a rig of this project that has since been deleted,
 *  renamed or moved (routine under a live editor across a branch switch — a scoped key cannot see
 *  that at all). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Node environment — no jsdom, so no localStorage. The module only needs get/set/remove.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});

/** Paths the asset manifest knows about in the project currently open. */
let knownPaths = new Set<string>();
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  getGuidForPath: (p: string) => (knownPaths.has(p) ? 'guid-for-' + p : undefined),
}));

const openSkinEditor = vi.fn();
let editingSkinAsset: { path: string; name: string } | null = null;
/** The store subscriber registerLastSkinRigPersistence installs, so a test can drive it. */
let subscriber: ((s: unknown) => void) | null = null;
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: Object.assign(
    () => undefined,
    {
      getState: () => ({ openSkinEditor, editingSkinAsset }),
      subscribe: (fn: (s: unknown) => void) => { subscriber = fn; return () => { subscriber = null; }; },
    },
  ),
}));

const { registerLastSkinRigPersistence, restoreLastSkinRig } =
  await import('../../src/editor/panels/lastSkinRig');
const { setEditorProjectScope, projectScopedKey } =
  await import('../../src/editor/projectScopedKey');

const KEY_BASE = 'editor:lastSkinRig';
const ZOMBIE = '/assets/rigs/zombie.rig2d.json';

const persist = (path = ZOMBIE) =>
  localStorage.setItem(projectScopedKey(KEY_BASE), JSON.stringify({ path, name: 'zombie' }));

beforeEach(() => {
  localStorage.clear();
  openSkinEditor.mockReset();
  editingSkinAsset = null;
  knownPaths = new Set([ZOMBIE]);
  setEditorProjectScope('Skin Test');
});

describe('restoreLastSkinRig', () => {
  it('re-opens the rig remembered for THIS project', () => {
    persist();
    expect(restoreLastSkinRig()).toBe(true);
    expect(openSkinEditor).toHaveBeenCalledWith({ path: ZOMBIE, type: 'rig2d', name: 'zombie' });
  });

  it('returns false with nothing saved / bad JSON', () => {
    expect(restoreLastSkinRig()).toBe(false);
    localStorage.setItem(projectScopedKey(KEY_BASE), '{not json');
    expect(restoreLastSkinRig()).toBe(false);
    expect(openSkinEditor).not.toHaveBeenCalled();
  });

  // THE #460 REGRESSION. Before the scoped key this restored skin-test's rig into whatever
  // project launched next, and the SkinEditor's fetch reported the file as corrupt JSON.
  //
  // `knownPaths` deliberately still CONTAINS the rig: the manifest guard would refuse an absent
  // path all by itself, so emptying it here would let this pass with the scoping reverted and the
  // test would prove nothing about the key it is named for. Leaving the path resolvable makes the
  // scoped key the only thing that can explain the refusal.
  it('does not restore another project\'s rig after a project switch', () => {
    persist();                          // remembered while Skin Test was open
    setEditorProjectScope('3D Test');   // …now launch a different project
    expect(restoreLastSkinRig()).toBe(false);
    expect(openSkinEditor).not.toHaveBeenCalled();
  });

  it('leaves the owning project\'s rig intact across that switch', () => {
    persist();
    setEditorProjectScope('3D Test');
    knownPaths = new Set();
    restoreLastSkinRig();
    // Coming back must still reopen it — the guard must not have eaten another project's entry.
    setEditorProjectScope('Skin Test');
    knownPaths = new Set([ZOMBIE]);
    expect(restoreLastSkinRig()).toBe(true);
    expect(openSkinEditor).toHaveBeenCalledWith({ path: ZOMBIE, type: 'rig2d', name: 'zombie' });
  });

  // The case a scoped key CANNOT cover: same project, but the rig is gone (deleted, renamed, or
  // moved — a branch switch under a live editor does this routinely).
  it('refuses a rig this project no longer has, rather than opening onto the SPA fallback', () => {
    knownPaths = new Set();
    persist();
    expect(restoreLastSkinRig()).toBe(false);
    expect(openSkinEditor).not.toHaveBeenCalled();
  });

  // The refusal must NOT delete. `ensureManifestLoaded` swallows a failed fetch and returns null
  // (warns, boot continues, memo cleared so the next attempt retries), which leaves EVERY path
  // unresolvable for one launch — indistinguishable here from a genuinely deleted asset. Dropping
  // on that would turn a transient, self-healing failure into permanent loss of the memory.
  it('keeps the entry when the manifest is empty, and restores once it comes back', () => {
    persist();
    knownPaths = new Set();            // manifest fetch failed this launch
    expect(restoreLastSkinRig()).toBe(false);
    expect(localStorage.getItem(projectScopedKey(KEY_BASE))).not.toBeNull();

    knownPaths = new Set([ZOMBIE]);    // next launch, manifest loads
    expect(restoreLastSkinRig()).toBe(true);
    expect(openSkinEditor).toHaveBeenCalledWith({ path: ZOMBIE, type: 'rig2d', name: 'zombie' });
  });
});

describe('registerLastSkinRigPersistence', () => {
  it('writes under the scoped key, and drops the pre-#473 unscoped one', () => {
    localStorage.setItem(KEY_BASE, JSON.stringify({ path: '/assets/rigs/stale.rig2d.json', name: 'stale' }));
    registerLastSkinRigPersistence();
    // The legacy value belongs to whichever project wrote it last and can never be attributed.
    expect(localStorage.getItem(KEY_BASE)).toBeNull();

    editingSkinAsset = { path: ZOMBIE, name: 'zombie' };
    subscriber?.({ editingSkinAsset });
    expect(JSON.parse(localStorage.getItem(projectScopedKey(KEY_BASE))!).path).toBe(ZOMBIE);
    // …and nothing was written to the unscoped key, which is what leaked across projects.
    expect(localStorage.getItem(KEY_BASE)).toBeNull();
  });
});
