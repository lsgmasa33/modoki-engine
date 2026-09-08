/** Restoring the last-opened animation clip across editor sessions.
 *
 *  The persisted Animator binding is an entity GUID. A guid alone is NOT a binding: the
 *  Animator component can be removed (undo, Inspector) after the binding was saved, and
 *  restoring that guid leaves the Animation panel "bound" to an entity with no Animator —
 *  the warning bar hides, the "Bind to Entity…" button is unreachable, and scrubbing
 *  live-poses the entity for a clip that would never play at runtime. So restore must
 *  re-verify the trait and fall back to UNBOUND. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// This suite runs in the default (node) environment — no jsdom, so no localStorage.
// The module only needs get/set/remove.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});

const ANIM = Symbol('AnimatorTrait');
const animMeta = { name: 'Animator', trait: ANIM };

/** entityId → whether it currently carries an Animator. */
let hasAnimator: Record<number, boolean> = {};
/** guid → entity id in the "current world". */
let guidToId: Record<string, number> = {};
let scenePath: string | null = '/assets/scenes/empty.json';

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => ({
    query: () => ({
      updateEach: (fn: (d: Record<string, unknown>[], e: { id(): number }) => void) => {
        for (const [guid, id] of Object.entries(guidToId)) fn([{ guid }], { id: () => id });
      },
    }),
  }),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => (n === 'Animator' || n === 'EntityAttributes' ? animMeta : undefined),
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  findEntity: (id: number) => (id in hasAnimator ? { has: () => hasAnimator[id] } : null),
}));
vi.mock('../../src/editor/scene/serialize', () => ({ getCurrentScenePath: () => scenePath }));

/** Paths the manifest knows about. Restore refuses anything else — a clip deleted or renamed
 *  since it was remembered would otherwise re-open onto the dev server's SPA fallback (#473). */
let knownPaths = new Set<string>(['/assets/animations/demo.anim.json']);
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  getGuidForPath: (p: string) => (knownPaths.has(p) ? 'guid-for-' + p : undefined),
}));

const openAnimationEditor = vi.fn();
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: Object.assign(
    () => undefined,
    { getState: () => ({ openAnimationEditor, editingAnimationAsset: null, animatorRootEntityId: null }), subscribe: () => () => {} },
  ),
}));

const { restoreLastAnimationClip } = await import('../../src/editor/animation/lastAnimationClip');
const { setEditorProjectScope, projectScopedKey } = await import('../../src/editor/projectScopedKey');

const KEY_BASE = 'editor:lastAnimationClip';
const persist = (animatorGuid: string | null, path = '/assets/animations/demo.anim.json') =>
  localStorage.setItem(projectScopedKey(KEY_BASE), JSON.stringify({
    path, name: 'Demo', animatorGuid, scenePath: '/assets/scenes/empty.json',
  }));

beforeEach(() => {
  localStorage.clear();
  openAnimationEditor.mockReset();
  scenePath = '/assets/scenes/empty.json';
  guidToId = { 'sphere-guid': 3 };
  hasAnimator = { 3: true };
  knownPaths = new Set(['/assets/animations/demo.anim.json']);
  setEditorProjectScope('Skin Test');
});

describe('restoreLastAnimationClip', () => {
  it('restores the root when the entity still has an Animator', () => {
    persist('sphere-guid');
    expect(restoreLastAnimationClip()).toBe(true);
    expect(openAnimationEditor.mock.calls[0][1]).toBe(3);
  });

  it('restores UNBOUND when the entity lost its Animator (the trait was removed/undone)', () => {
    hasAnimator = { 3: false };
    persist('sphere-guid');
    expect(restoreLastAnimationClip()).toBe(true); // the CLIP still reopens…
    expect(openAnimationEditor.mock.calls[0][1]).toBeNull(); // …just not bound
  });

  it('restores UNBOUND when the guid resolves to nothing in this world', () => {
    guidToId = {};
    persist('sphere-guid');
    expect(restoreLastAnimationClip()).toBe(true);
    expect(openAnimationEditor.mock.calls[0][1]).toBeNull();
  });

  it('skips entirely for a different scene (guids are scene-scoped)', () => {
    scenePath = '/assets/scenes/other.json';
    persist('sphere-guid');
    expect(restoreLastAnimationClip()).toBe(false);
    expect(openAnimationEditor).not.toHaveBeenCalled();
  });

  it('returns false with nothing saved / bad JSON', () => {
    expect(restoreLastAnimationClip()).toBe(false);
    localStorage.setItem(projectScopedKey(KEY_BASE), '{not json');
    expect(restoreLastAnimationClip()).toBe(false);
  });

  // #473: the same-scene guard does NOT cover a project switch — scene paths are flat, so two
  // projects share `/assets/scenes/empty.json` and the guard passes. Only the scoped key stops it.
  it('does not restore another project\'s clip, even when both use the same scene path', () => {
    persist('sphere-guid');
    setEditorProjectScope('3D Test');
    expect(restoreLastAnimationClip()).toBe(false);
    expect(openAnimationEditor).not.toHaveBeenCalled();
    // …and it is still there for the project that owns it.
    setEditorProjectScope('Skin Test');
    expect(restoreLastAnimationClip()).toBe(true);
  });

  it('refuses a remembered clip the manifest no longer knows (deleted/renamed since)', () => {
    persist('sphere-guid', '/assets/animations/gone.anim.json');
    expect(restoreLastAnimationClip()).toBe(false);
    expect(openAnimationEditor).not.toHaveBeenCalled();
  });

  // Refuse, never delete: a failed manifest fetch resolves to null and makes every path look
  // absent for one launch, so dropping would make a transient failure permanent.
  it('keeps the entry when the manifest is empty, and restores once it comes back', () => {
    persist('sphere-guid');
    knownPaths = new Set();
    expect(restoreLastAnimationClip()).toBe(false);
    expect(localStorage.getItem(projectScopedKey(KEY_BASE))).not.toBeNull();

    knownPaths = new Set(['/assets/animations/demo.anim.json']);
    expect(restoreLastAnimationClip()).toBe(true);
  });
});
