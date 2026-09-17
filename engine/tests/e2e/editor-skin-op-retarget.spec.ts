/** Real-browser E2E: an async Skin editor op never lands on a rig opened while it was computing.
 *
 *  Re-tessellate reads the rig, awaits the sprite's alpha mask, then commits a whole copy of the
 *  document it read. It used to commit onto whatever rig was open by then — so opening rig B while
 *  bar's mask loaded replaced B's document with bar's, bones and all (observed before the fix: B's
 *  bones came back `base, mid, tip`). `skinOpBasis.ts` is the rule; this pins that SkinEditor.tsx
 *  applies it. The alpha-mask image request is held so the window is deterministic, not raced. */

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gotoEditorWithScene } from './helpers';
import { hasInternalGames } from '../helpers/repoLayout';

// games/skin-test is the Skin editor's documented fixture (see editor-skin-paint-sweep.spec.ts).
test.skip(!hasInternalGames(), 'editor-skin-op-retarget: games/ is absent from this snapshot');
test.use({ viewport: { width: 1600, height: 1000 } });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RIG_DIR = path.join(REPO_ROOT, 'games/skin-test/runtime/assets/rigs');
// The scratch rig goes in a gitignored `__e2e_*__` dir, so a killed run leaves nothing for git to see.
const SCRATCH_DIR = path.join(REPO_ROOT, 'games/skin-test/runtime/assets/__e2e_skin_retarget__');
const BAR = '/games/skin-test/assets/rigs/bar.rig2d.json';
const OTHER = '/games/skin-test/assets/__e2e_skin_retarget__/other.rig2d.json';

/** Write the scratch rig: bar's geometry with distinguishable bones, so whichever document it ends up
 *  holding is visible by name. The caller removes SCRATCH_DIR. */
function writeOtherRig(): void {
  const bar = JSON.parse(fs.readFileSync(path.join(RIG_DIR, 'bar.rig2d.json'), 'utf8'));
  const other = { ...bar, id: '7e57ab00-0002-4000-8000-00000000e2e1', bones: bar.bones.map((b: { name: string }) => ({ ...b, name: `B_${b.name}` })) };
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH_DIR, 'other.rig2d.json'), JSON.stringify(other, null, 2));
}

const open = (page: Page, rig: string) => page.evaluate((p) => {
  const s = (window as any).__editorStore;
  s.getState().openSkinEditor({ path: p, type: 'rig2d', name: p });
  s.getState().setSkinMode('parts');
}, rig);
const skinState = (page: Page) => page.evaluate(() => {
  const s = (window as any).__editorStore.getState();
  return { path: s.editingSkinAsset?.path as string | undefined, bones: (s.editingSkinDef?.bones ?? []).map((b: { name: string }) => b.name) as string[] };
});

/** Start Re-tessellate on bar with its alpha-mask image held; returns the release. */
async function retessellateHeld(page: Page): Promise<() => void> {
  await gotoEditorWithScene(page);
  await open(page, BAR);
  await expect.poll(async () => (await skinState(page)).bones, { timeout: 15_000 }).toEqual(['base', 'mid', 'tip']);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await page.route(/\/games\/skin-test\/assets\/textures\/bar\.png/, async (route) => { held++; await gate; await route.continue(); });
  await page.locator('[data-ui-id="skin.part.retessellate"]').click();
  await expect.poll(() => held, { message: 'premise: the op is waiting on the held alpha mask' }).toBeGreaterThan(0);
  return release;
}

const NOTICE = 'the rig changed while it was computing — nothing applied';
const settle = (page: Page) => page.evaluate(() => new Promise<void>((r) => setTimeout(r, 500)));

// Mutation: drop the `isSkinOpBasisCurrent` refusal in SkinEditor's `commit`.
test('Re-tessellate that finishes after another rig opened leaves that rig untouched', async ({ page }) => {
  writeOtherRig();
  try {
    const release = await retessellateHeld(page);
    await open(page, OTHER);
    await expect.poll(async () => (await skinState(page)).bones, { timeout: 15_000 }).toEqual(['B_base', 'B_mid', 'B_tip']);
    const before = await skinState(page);
    release();
    // Shown on the rig now open, so it names the one the op was for.
    await expect(page.getByText(`tessellate 4×8 on bar.rig2d: ${NOTICE}; run it again`)).toBeVisible();
    expect(await skinState(page)).toEqual(before);
  } finally {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
});

// The accept side: with nothing opened in between, the same held op still applies.
test('Re-tessellate with no retarget still applies once its mask arrives', async ({ page }) => {
  const release = await retessellateHeld(page);
  // Identity, not content: a fresh grid over bar can equal the fixture's own mesh, but a commit always
  // installs a new document object.
  await page.evaluate(() => { (window as any).__skinBefore = (window as any).__editorStore.getState().editingSkinDef; });
  release();
  await expect.poll(() => page.evaluate(() => (window as any).__editorStore.getState().editingSkinDef !== (window as any).__skinBefore), { timeout: 10_000 }).toBe(true);
  await settle(page);
  const after = await skinState(page);
  expect(after.path).toBe(BAR);
  expect(after.bones).toEqual(['base', 'mid', 'tip']);
  await expect(page.getByText(NOTICE, { exact: false })).toHaveCount(0);
});
