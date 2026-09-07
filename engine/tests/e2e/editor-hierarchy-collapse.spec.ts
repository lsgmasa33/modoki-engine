/** E2E — Hierarchy collapse persistence across a scene load (#839).
 *
 *  The defect: the panel recorded "this swap needs a collapse restore" as an unkeyed
 *  boolean and consumed it from `onStructureDirtyCoalesced`. Structure-dirty fires on
 *  `registerEntity`, and `loadSceneFile` registers the incoming scene's entities into the
 *  STAGING world BEFORE the swap — `SceneManager` marks nothing dirty after
 *  `setCurrentWorld` — so for an ordinary scene load no settled refresh ever arrived, the
 *  claim was never consumed, and the persistence effect early-returned for the rest of the
 *  scene. Every collapse the user performed was silently discarded, and the first entity
 *  they created finally ran the restore and overwrote what they had collapsed.
 *
 *  jsdom cannot reach this: it is the real load → staging-registration → swap → rAF
 *  ordering that decides whether the restore ever runs, and collapse is a DOM fact (the
 *  entities all still exist in the ECS either way). The decisions themselves are unit
 *  tested in `engine/tests/editor/hierarchyCollapse.test.ts`; this covers the wiring. */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, waitForFrames, SCENE } from './helpers';

const SCENE_COLLAPSE = '/tests/e2e/fixtures/e2e-hierarchy-collapse.scene.json';
const LS_KEY = 'editor:hierarchy:entityCollapsed:v1';

/** Fixture guids — the three parents and one child each (see the fixture JSON). */
const G = {
  group1: 'e2ec0000-0000-4000-8000-000000000002',
  group1A: 'e2ec0000-0000-4000-8000-000000000003',
  group1B: 'e2ec0000-0000-4000-8000-000000000004',
  group2: 'e2ec0000-0000-4000-8000-000000000005',
  group2A: 'e2ec0000-0000-4000-8000-000000000006',
  group3: 'e2ec0000-0000-4000-8000-000000000008',
  group3A: 'e2ec0000-0000-4000-8000-000000000009',
};

/** Is this entity's ROW rendered? Collapse hides rows; it does not despawn entities, so
 *  `getAllEntities()` answers the same either way and cannot be used here. */
const rowShown = (page: Page, guid: string) =>
  page.locator(`[data-ui-id="hierarchy.entity.${guid}"]`).count().then((n) => n > 0);

/** The guids saved as collapsed for `scenePath`, or null when the scene has no entry. */
const savedGuids = (page: Page, scenePath: string) =>
  page.evaluate(([key, path]) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const map = JSON.parse(raw);
      return Array.isArray(map?.[path]) ? map[path] as string[] : null;
    } catch { return null; }
  }, [LS_KEY, scenePath] as const);

const clearSaved = (page: Page) =>
  page.evaluate((key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } }, LS_KEY);

/** Double-click is the row's collapse gesture (EntityNode's onDoubleClick → onToggle). */
async function toggleRow(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().dblclick();
}

/** Expand `parent` if its child row is hidden; collapse it if shown. */
async function setExpanded(page: Page, name: string, childGuid: string, expanded: boolean) {
  if (await rowShown(page, childGuid) !== expanded) await toggleRow(page, name);
  await expect.poll(() => rowShown(page, childGuid), { timeout: 5_000 }).toBe(expanded);
}

test('a collapse toggle after an ordinary scene load reaches localStorage', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_COLLAPSE, 'Group1');
  // A never-seen scene collapses all parents (the tidy default), so children start hidden.
  await expect.poll(() => rowShown(page, G.group1A), { timeout: 10_000 }).toBe(false);
  await clearSaved(page);

  await setExpanded(page, 'Group1', G.group1A, true);

  // THE ASSERTION: the gate is open, so the toggle is written back. Pre-fix this stayed null
  // for the rest of the scene — the claim set on the swap was never consumed and the
  // persistence effect early-returned on every change.
  await expect.poll(() => savedGuids(page, SCENE_COLLAPSE), { timeout: 5_000 }).not.toBeNull();

  const saved = (await savedGuids(page, SCENE_COLLAPSE))!;
  expect(saved).not.toContain(G.group1);   // just expanded
  expect(saved).toContain(G.group2);       // untouched, still collapsed
  expect(saved).toContain(G.group3);
});

test('the collapse set is restored after a round-trip through another scene', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_COLLAPSE, 'Group1');
  await clearSaved(page);

  // A distinctive state: Group1 and Group3 open, Group2 shut.
  await setExpanded(page, 'Group1', G.group1A, true);
  await setExpanded(page, 'Group3', G.group3A, true);
  await setExpanded(page, 'Group2', G.group2A, false);
  await expect.poll(() => savedGuids(page, SCENE_COLLAPSE), { timeout: 5_000 }).toEqual([G.group2]);

  // Away to another scene and back — the swap the defect rode in on.
  await page.evaluate((s) => (window as any).__modokiEditorTest.loadScene(s), SCENE);
  await expect.poll(() => rowShown(page, G.group1), { timeout: 10_000 }).toBe(false);
  await page.evaluate((s) => (window as any).__modokiEditorTest.loadScene(s), SCENE_COLLAPSE);
  await expect.poll(() => rowShown(page, G.group1), { timeout: 10_000 }).toBe(true);

  // Restored exactly. Pre-fix no settled refresh followed this load, so the restore never
  // ran and the panel kept the PREVIOUS scene's stale entity ids as its collapsed set.
  await expect.poll(() => rowShown(page, G.group2A), { timeout: 10_000 }).toBe(false);
  expect(await rowShown(page, G.group1A)).toBe(true);
  expect(await rowShown(page, G.group3A)).toBe(true);
});

test('REGRESSION: Save As re-points the path with no swap — the arrangement must survive', async ({ page }) => {
  // The first fix for #839 keyed the collapse claim on the scene PATH. `saveScene()` changes the
  // path with no world swap and no structural change, so a Save As made the claim read "needs
  // restore", and the next structural change re-restored from a never-seen entry — collapse-all —
  // wiping the arrangement the user had just saved and persisting THAT. The claim is keyed on the
  // WORLD now: the ids did not move, only the file name did.
  await gotoEditorWithScene(page, SCENE_COLLAPSE, 'Group1');
  await clearSaved(page);
  await setExpanded(page, 'Group1', G.group1A, true);
  await setExpanded(page, 'Group2', G.group2A, true);

  const RENAMED = '/tests/e2e/fixtures/e2e-hierarchy-collapse-renamed.scene.json';
  await page.evaluate((p) => (window as any).__modokiEditorTest.renameCurrentScenePath(p), RENAMED);

  // A structural change is what pulls the settled refresh through. Delete a VISIBLE row, so its
  // disappearance proves the coalesced refresh actually ran — asserting "still expanded" without
  // that proof passes at t=0, before the defect has had a frame to land (it did, on the first
  // draft of this test, and the mutation check is what caught it).
  const id = await page.evaluate(() => {
    const ents = (window as any).__modokiEditorTest.getAllEntities();
    return ents.find((e: any) => e.name === 'Group1B')?.id ?? null;
  });
  expect(id).not.toBeNull();
  await page.evaluate((i) => (window as any).__modokiEditorTest.deleteEntity(i), id);
  await expect.poll(() => rowShown(page, G.group1B), { timeout: 5_000 }).toBe(false);
  await waitForFrames(page, 3);

  // THE ASSERTION: still open. The world never changed, so nothing needed restoring. Pre-fix the
  // path-keyed claim re-restored here from a never-seen entry and snapped the whole tree shut.
  expect(await rowShown(page, G.group1A)).toBe(true);
  expect(await rowShown(page, G.group2A)).toBe(true);

  // And the gate is still open, so the next toggle persists under the NEW path. (Nothing is
  // written by the rename itself — the effect is keyed on the collapsed set, and the set did not
  // change; that is unchanged from before this fix.)
  await setExpanded(page, 'Group1', G.group1A, false);
  await expect.poll(() => savedGuids(page, RENAMED), { timeout: 5_000 })
    .toEqual(expect.arrayContaining([G.group1, G.group3]));
});
