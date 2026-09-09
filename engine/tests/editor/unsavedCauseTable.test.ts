/** The cause table is the schema (#972 Phase 0).
 *
 *  `unsavedChangeCauses()` used to publish a VALUE and no schema, so ten sites re-stated the
 *  population of causes by hand and TypeScript checked none of them — a hand-written subset of a
 *  wider object is a legal structural subtype. `CAUSE_SPECS` inverts that: the cause TYPE is
 *  derived from the table, so adding a cause turns every downstream `satisfies` red.
 *
 *  ⚠️ **This file carries the RUNTIME half only, and that split is deliberate.** vitest transpiles
 *  through esbuild and erases types, so no test here can observe a `satisfies` failing — that is
 *  exactly why `resolveUnsavedOp.test.ts` asserts all five causes and still ran green on a sixth
 *  one. The type-level guarantees below are enforced by `npm run typecheck`, and the completeness
 *  test is the runtime backstop that goes red on a sixth cause even under vitest alone.
 *
 *  Nothing here is mocked. Every registry is driven through its own public mark/clear API — they
 *  are plain module-scoped Maps and need no editor. `runSaveAll.test.ts` mocks
 *  `unsavedChangeCauses` wholesale (with four of the five keys), which is why no assertion about
 *  this mechanism belongs there: it would assert the mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  hasUnsavedChanges, unsavedChangeCauses, markSceneSaved, causeSpecs,
  type UnsavedCauses, type PathKeyedCause, type SceneWrittenCause,
} from '../../packages/modoki/src/editor/scene/serialize';
import { getEditVersion } from '../../packages/modoki/src/editor/undo/undoManager';
import { markAssetDirty, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { markSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markBaseSceneEdit, clearPendingBaseScenes } from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import {
  parkMetaEdit, stampMetaReadPath, clearPendingMeta, clearMetaBaselines,
} from '../../packages/modoki/src/editor/scene/pendingMeta';

/** Every cause, with the cheapest REAL way to make that one alone dirty.
 *
 *  ⚠️ Hand-written on purpose, and checked for completeness against the live table below. A list
 *  derived from `causeSpecs()` would pass for a cause nobody wrote a driver for — it would assert
 *  that the table contains what the table contains, which is not a test. The completeness check is
 *  what makes the hand-writing safe: a sixth cause makes this list wrong, loudly. */
const DRIVERS: Record<keyof UnsavedCauses, () => void> = {
  // The PRIMARY live world is dirty when the edit version has moved past its saved baseline.
  // Re-baselining one BEHIND the current version is the public-API way to say that, with no
  // world and no undo stack — `notifyEdited()` is module-private.
  sceneDirty: () => markSceneSaved(getEditVersion() - 1),
  dirtyAssetPaths: () => markAssetDirty('/assets/x.mat.json', 'material', { a: 1 }),
  dirtyScenes: () => markSceneDirty('guid-of-a-loaded-base'),
  pendingBaseScenes: () => markBaseSceneEdit('/assets/scenes/child.scene.json', 'base-guid'),
  // Park the way a PANEL does — on a document this path's own read handed back. An unstamped
  // literal is refused by design (#890/#891), i.e. it is a document nobody read, and parking an
  // impossible input would prove nothing about the path this claims to cover.
  pendingImportSettings: () => {
    parkMetaEdit('/assets/tex.png', stampMetaReadPath({ maxSize: 1024 }, '/assets/tex.png'));
  },
};

function clearEverything(): void {
  clearDirtyAssets();
  clearAllSceneDirty();
  clearPendingBaseScenes();
  clearPendingMeta();
  clearMetaBaselines();
  markSceneSaved();   // re-baseline the live world LAST — the others do not touch the edit version
}

describe('the unsaved-cause table', () => {
  beforeEach(clearEverything);
  afterEach(clearEverything);

  it('reports nothing unsaved when every registry is clear', () => {
    expect(hasUnsavedChanges()).toBe(false);
    const causes = unsavedChangeCauses();
    expect(causes.sceneDirty).toBe(false);
    expect(causes.dirtyAssetPaths).toEqual([]);
    expect(causes.dirtyScenes).toEqual([]);
    expect(causes.pendingBaseScenes).toEqual([]);
    expect(causes.pendingImportSettings).toEqual([]);
  });

  // The load-bearing one. `hasUnsavedChanges()` is what EVERY refusal in the repo gates on, so a
  // cause it cannot see is not unsaved work anywhere — which is why it had to become derived
  // rather than merely guarded. One case per cause, each driving that cause ALONE.
  for (const cause of Object.keys(DRIVERS) as (keyof UnsavedCauses)[]) {
    it(`hasUnsavedChanges() is true when ${cause} is the ONLY dirty cause`, () => {
      expect(hasUnsavedChanges()).toBe(false);
      DRIVERS[cause]();
      expect(hasUnsavedChanges()).toBe(true);

      // …and the cause is reported as the one that is dirty, not merely as "something".
      const causes = unsavedChangeCauses();
      const value = causes[cause];
      expect(Array.isArray(value) ? value.length > 0 : value).toBeTruthy();

      // Every OTHER cause stays clean — proves the driver is specific, so a passing row above
      // cannot be some other cause leaking in from a previous test.
      for (const other of Object.keys(DRIVERS) as (keyof UnsavedCauses)[]) {
        if (other === cause) continue;
        const v = causes[other];
        expect(Array.isArray(v) ? v.length : v, `${other} should be clean`).toBeFalsy();
      }
    });
  }

  // The runtime backstop for a sixth cause. tsc catches an unmapped cause at every `satisfies`
  // site; this catches it here, under vitest, where types no longer exist.
  it('DRIVERS covers exactly the causes the table declares — a sixth cause fails here', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(Object.keys(causeSpecs()).sort());
    expect(Object.keys(unsavedChangeCauses()).sort()).toEqual(Object.keys(causeSpecs()).sort());
  });

  it('every cause declares a label, a keying and a writer', () => {
    for (const [key, spec] of Object.entries(causeSpecs())) {
      expect(['none', 'guid', 'path'], `${key}.keying`).toContain(spec.keying);
      const writer = spec.writtenBy;
      expect(
        writer === 'scene-write' || (typeof writer === 'object' && ['before-scene', 'after-scene'].includes(writer.flush)),
        `${key}.writtenBy`,
      ).toBe(true);
      // A cause with no phrasing would reach a refusal message as a bare field name, which is the
      // S3.11 failure wearing different clothes.
      expect(spec.label.bool ?? spec.label.noun, `${key}.label`).toBeTruthy();
    }
  });

  // ── Type-level guarantees. Enforced by `npm run typecheck`; vitest sees only the booleans. ──
  it('the derived cause types resolve to exactly the expected members', () => {
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Expect<T extends true> = T;

    const guards: [
      // ⚠️ The one that matters most: if `UnsavedCauses` ever widens to `Record<string, …>`, every
      // `satisfies Record<keyof UnsavedCauses, …>` in the repo silently stops checking anything
      // and the whole class is back with nothing red. `string extends keyof …` is how that shows.
      Expect<Equals<string extends keyof UnsavedCauses ? true : false, false>>,
      // The path-keyed slice drives the move repair — a cause missing from it is an edit that a
      // rename can strand (#972 P11).
      Expect<Equals<PathKeyedCause, 'dirtyAssetPaths' | 'pendingBaseScenes' | 'pendingImportSettings'>>,
      // The scene-written slice drives `sceneNeedsWriting()`, which decides whether a save is
      // worth interrupting a preview for (#972 P3/P12).
      Expect<Equals<SceneWrittenCause, 'sceneDirty' | 'dirtyScenes'>>,
    ] = [true, true, true];

    expect(guards).toEqual([true, true, true]);
  });
});
