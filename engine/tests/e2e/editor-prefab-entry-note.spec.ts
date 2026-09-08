/** E2E — the Inspector's entry-prefab pooled-row note actually reaches the screen (#671).
 *
 *  `entriesSystem` pins fourteen `UIElement` fields onto a pooled `UIEntries` row root every
 *  tick (`buildPooledRowPin`, runtime/ui/uiAuthoring.ts), so those authored fields are inert.
 *  The Inspector's `PooledRowNote` used to gate ONLY on the live sibling `UIEntry` trait —
 *  stamped at spawn, `runtimeOnly`, absent from every `.prefab.json` — so it could never fire in
 *  PREFAB-EDIT mode, which is the one place an author actually SETS these fields. #671 widened
 *  the gate to also fire there (mode `'entry-prefab'`), resolved through `/api/find-references`
 *  (`entryPrefabUse.ts`) asking the ON-DISK reference graph "does any `UIEntries` view spawn this
 *  prefab as an entry kind?".
 *
 *  Every OTHER layer of that fix already has a test: the pure filter is covered by
 *  `entryPrefabUse.test.ts`, the note copy by `uiAuthoring.test.ts`, and the route's `via` label
 *  was checked live against a running editor. None of them drive the Inspector's own
 *  five-condition `useEffect` — exactly this repo's dominant defect class, a mechanism that is
 *  correct but cannot FIRE. Only a real browser, with a real double-click into prefab-edit mode
 *  and a real Hierarchy selection, can prove that.
 *
 *  Reuses COURT's own production wiring (`LevelScroll` → `level-page.prefab.json`, in
 *  `games/court/runtime/assets/scenes/main.scene.json`) rather than authoring a fixture: the
 *  route reads the reference graph off DISK (see `entryPrefabUse.ts`'s docblock), so a synthetic
 *  fixture would need its own scene + `UIEntries` view + prefab file just to reconstruct what
 *  already exists here. `games/court` is a private, never-published game (root CLAUDE.md), so it
 *  is absent only from the public OSS snapshot's CI (`games/` is not part of that snapshot) —
 *  this whole spec is a clean skip there, guarded by an on-disk existence check rather than
 *  `pickHostProject()` (which only proves *some* project exists, not this specific pairing).
 *
 *  The negative case reuses `level-tile.prefab.json` (`LevelTile`) — NOT a prefab with zero
 *  references, but one referenced a DIFFERENT way: `LevelPage`'s own `Tile0`..`Tile24` rows spawn
 *  it as a nested `PrefabInstance` (`via: 'prefab'`), a real reference the tree-shaker would
 *  keep, just not an entry-kind USE. Without this the spec would pass on a note that always
 *  renders once ANY reference exists — the same "cannot tell clean from not-running" failure
 *  `entryKindHitsFrom`'s own `via`-label filter exists to prevent. */

import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { gotoEmptyEditor } from './helpers';
import { REPO_ROOT, hasInternalGames } from '../helpers/repoLayout';

const ENTRY_PREFAB_URL = '/games/court/assets/prefabs/level-page.prefab.json';
const ENTRY_PREFAB_ROOT_NAME = 'LevelPage'; // level-page.prefab.json's own root entity name
const NON_ENTRY_PREFAB_URL = '/games/court/assets/prefabs/level-tile.prefab.json';
const NON_ENTRY_PREFAB_ROOT_NAME = 'LevelTile'; // level-tile.prefab.json's own root entity name

// ⚠️ **An e2e spec must NEVER call `discoverProjects` — not even to skip politely.** The first cut
// of this file did, at module scope, and `projectPresencePredicate.test.ts` caught it. The reason
// that guard exists is worse than style: a Playwright spec that derives a project at module scope
// and throws kills COLLECTION for the whole run, not just its own test — on v0.5.2 that shipped
// `only 0 tests were DISCOVERED` on a release publish, after the tag was cut, because the snapshot
// has no `games/`.
//
// So the presence question goes through the sanctioned predicate (`hasInternalGames()`), and the
// FIXTURE question is a plain path probe off `REPO_ROOT` — `existsSync` returns false rather than
// throwing, so the worst case here is a skip. Both are needed and they ask different things:
// `hasInternalGames()` says this checkout ships `games/` at all, the probes say THIS pairing is
// still where the spec thinks it is (a renamed prefab should skip loudly, not fail deep inside a
// double-click).
const courtPrefab = (file: string) =>
  path.join(REPO_ROOT, 'games', 'court', 'runtime', 'assets', 'prefabs', file);
const HAS_FIXTURES = hasInternalGames()
  && fs.existsSync(courtPrefab('level-page.prefab.json'))
  && fs.existsSync(courtPrefab('level-tile.prefab.json'));

test.skip(!HAS_FIXTURES, 'editor-prefab-entry-note: this snapshot ships no games/court (its LevelScroll → level-page.prefab.json pairing) to reuse');

/** Category groups collapse by default, so seed the expanded set to get rows. Mirrors
 *  `gotoEditorWithAssets` in editor-assets.spec.ts / editor-find-references.spec.ts.
 *
 *  ⚠️ `editor:assets:expanded:v2` is PER-PROJECT since #473 — its real key carries the open
 *  project's name, which an `addInitScript` (pre-boot) cannot know, and a seed written to the
 *  bare key is deleted as a pre-#473 legacy value. Drive the store's setter after boot instead.
 *  Kept in step with the other two specs' copies. */
async function gotoEditorWithAssets(page: Page) {
  // viewMode is a PREFERENCE and stays global, so it can still be seeded pre-boot.
  await page.addInitScript(() => {
    localStorage.setItem('editor:assets:viewMode', 'category');
  });
  await gotoEmptyEditor(page);
  await page.evaluate(async () => {
    const types = [
      'scene', 'prefab', 'model', 'mesh', 'material', 'texture', 'sprite', 'atlas',
      'animation', 'animset', 'particle', 'shader', 'environment', 'font', 'script', 'layout',
      '@@assets-section', '/',
    ];
    // Runtime URL served by the Vite dev server, NOT a module specifier tsc can resolve — held
    // in a variable so it stays a dynamic import and typechecking doesn't try to follow it.
    const url = '/packages/modoki/src/editor/panels/assetFolderState.ts';
    const m = await import(/* @vite-ignore */ url) as {
      setExpanded: (u: (prev: Set<string>) => Set<string>) => void;
    };
    m.setExpanded(() => new Set(types));
  });
  await page.locator('.flexlayout__tab_button', { hasText: 'Assets' }).click();
  await page.locator('[data-asset-path]').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Double-click a prefab's Assets row — the real gesture `openAssetInEditor.ts` routes to
 *  `openPrefabForEditing` for — and wait for its root entity to appear in the Hierarchy. That
 *  wait is proof the synthetic prefab-edit scene actually finished loading, not just that the
 *  click landed; unlike `gotoEditorWithScene`'s fixture path there is no test-bridge call to
 *  await here, so the Hierarchy row is the only observable signal. */
async function openPrefabAndWaitForRoot(page: Page, assetUrl: string, rootName: string) {
  const row = page.locator(`[data-asset-path="${assetUrl}"]`);
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.dblclick();
  const root = page.getByText(rootName, { exact: true });
  await root.waitFor({ state: 'visible', timeout: 20_000 });
  return root;
}

test('double-clicking an entry prefab and selecting its root shows the entry-prefab note (#671)', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const root = await openPrefabAndWaitForRoot(page, ENTRY_PREFAB_URL, ENTRY_PREFAB_ROOT_NAME);
  await root.click(); // select it — the note's useEffect gates on singleSelectedId

  const note = page.locator('[data-ui-id="inspector.section.pooledRowNote"]');
  // Async: the note only appears once /api/find-references answers — toBeVisible's own
  // auto-retry is the wait here, not a fixed sleep.
  await expect(note).toBeVisible({ timeout: 15_000 });
  // The ENTRY-PREFAB wording specifically (pooledRowNoteSegments('entry-prefab')), not the
  // pooled-row-INSTANCE wording ('inert'/'mixed') — neither of those ever says "entry kind", and
  // asserting the whole intro/field-list here would pin uiAuthoring.test.ts's copy a second time.
  await expect(note).toContainText('as an entry kind');
});

test('a prefab referenced elsewhere but NOT as an entry kind shows no note (#671)', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const root = await openPrefabAndWaitForRoot(page, NON_ENTRY_PREFAB_URL, NON_ENTRY_PREFAB_ROOT_NAME);

  const note = page.locator('[data-ui-id="inspector.section.pooledRowNote"]');
  // Wait for the SAME lookup to actually answer before trusting the note's absence — otherwise
  // this passes just as well while the fetch is still in flight (`entryKindHits` starts `null`,
  // which also renders no note) or even if the endpoint were broken outright. Only a proven 200
  // in response to selecting THIS root, followed by a confirmed-absent note, tells "the filter
  // said no" apart from "nothing has answered yet".
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/find-references') && r.request().method() === 'GET'),
    root.click(),
  ]);
  expect(resp.ok()).toBe(true);
  await expect(note).toHaveCount(0);
});
