/** E2E — a texture modal re-pointed at ANOTHER texture while open (#1328).
 *
 *  The `open-sprite-editor` / `open-nine-slice-editor` agent ops select the requested texture while
 *  a modal is open. #1328 read the Inspector as rendering the asset view with no `key`, so the
 *  Sprite Editor and the 9-slice editor would SURVIVE the swap carrying the previous texture's undo
 *  history, entry snapshot and save-time state. They do not: `Inspector.tsx` renders
 *  `<AssetInspector key={selectedAsset.path}>`, so the swap remounts the whole view and both modals.
 *  That one `key` is the load-bearing line, and nothing else pins it. Each test is a symptom it
 *  prevents:
 *
 *  - Sprite Editor: undo on B would restore A's grid/slices.
 *  - 9-slice editor: B's preview would carry A's border, and Cancel would register A's snapshot
 *    under B's guid.
 *  - Either editor: a Save on A finishing after the swap would close B's modal (and the Sprite
 *    Editor's would unregister B's slices).
 *
 *  Driven through `requestTextureEditor`, the same store call the agent ops make: a human cannot
 *  swap, because the modal covers the Inspector.
 */

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { gotoEmptyEditor } from './helpers';
import { pickHostProject } from './hostProject';

const HOST = pickHostProject();
test.skip(!HOST, 'editor-texture-modal-swap: this snapshot ships no project to host the fixtures');
const ABS_DIR = HOST ? path.join(HOST.dir, 'runtime/assets/__e2e_texswap__') : '';
const URL_DIR = HOST ? `/${HOST.root}/${HOST.name}/assets/__e2e_texswap__` : '';
const url = (file: string) => `${URL_DIR}/${file}`;

const A_ID = '6c1e3a50-0000-4000-8000-00000000a001';
const B_ID = '6c1e3a50-0000-4000-8000-00000000b001';
const A_SLICE = '6c1e3a50-0000-4000-8000-00000000a002';
const B_SLICE = '6c1e3a50-0000-4000-8000-00000000b002';
const C_ID = '6c1e3a50-0000-4000-8000-00000000c001';
const D_ID = '6c1e3a50-0000-4000-8000-00000000d001';

/** A minimal opaque RGBA PNG — the editors need a decodable image, not real art. */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) raw.set([60, 120, 200, 255], off + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const slice = (guid: string, name: string) => ({ guid, name, rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } });
// A and B are sliced sheets whose authored grids differ (Cols 4 vs 2), so a grid carried across the
// swap is visible in the Cols field. C and D are unsliced UI textures, so the scanner gives each a
// whole-image sprite (which it emits only once it knows the source dims — `textureCache.srcWidth`);
// only C has a border.
const SRC_DIMS = { srcWidth: 32, srcHeight: 32 };
const FIXTURES: Record<string, unknown> = {
  'a.png.meta.json': { version: 2, id: A_ID, type: '2d', spriteMode: 'multiple', spriteSheet: { width: 32, height: 32 }, sprites: [slice(A_SLICE, 'a_0')], spriteGrid: { mode: 'count', cols: 4, rows: 4 } },
  'b.png.meta.json': { version: 2, id: B_ID, type: '2d', spriteMode: 'multiple', spriteSheet: { width: 32, height: 32 }, sprites: [slice(B_SLICE, 'b_0')], spriteGrid: { mode: 'count', cols: 2, rows: 2 } },
  'c.png.meta.json': { version: 2, id: C_ID, type: 'ui', textureCache: SRC_DIMS, border: { l: 5, r: 5, t: 5, b: 5 } },
  'd.png.meta.json': { version: 2, id: D_ID, type: 'ui', textureCache: SRC_DIMS },
};

test.beforeEach(() => {
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DIR, { recursive: true });
  for (const f of ['a.png', 'b.png', 'c.png', 'd.png']) fs.writeFileSync(path.join(ABS_DIR, f), png(32, 32));
  for (const [f, doc] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(ABS_DIR, f), JSON.stringify(doc, null, 2));
});
test.afterAll(() => {
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

const bridge = 'window.__modokiEditorTest';
const openModal = (page: Page, file: string, kind: 'sprite' | 'nineslice') =>
  page.evaluate(([u, k]) => (window as any).__modokiEditorTest.store.getState().requestTextureEditor(u, k), [url(file), kind] as const);
const spriteRef = (page: Page, guid: string) => page.evaluate((g) => (window as any).__modokiEditorTest.spriteRef(g), guid);
const wholeImage = (page: Page, tex: string) => page.evaluate((g) => (window as any).__modokiEditorTest.wholeImageSpriteRef(g), tex);
/** The slice list the open Sprite Editor publishes for the agent ops, once it has loaded `file`. */
const mountedSlices = (page: Page, file: string) => page.evaluate((u) => {
  const m = (window as any).__modokiEditorTest.store.getState().editorMounts?.sprite;
  return m && m.path === u ? m.slices as string[] : null;
}, url(file));

/** The value of the Sprite Editor's number field labelled `label` (read fresh: a remount replaces the node). */
const fieldText = (page: Page, label: string) => page.evaluate((l) => {
  const span = [...document.querySelectorAll('span')].find((s) =>
    s.firstChild?.nodeType === Node.TEXT_NODE && s.firstChild.nodeValue === l && s.parentElement?.querySelector('input'));
  return (span?.parentElement?.querySelector('input') as HTMLInputElement | null)?.value ?? null;
}, label);

/** Set a labelled field the way an unfocused window does (#244): an `input` event, no focus. */
const setField = (page: Page, label: string, value: string) => page.evaluate(({ l, v }) => {
  const span = [...document.querySelectorAll('span')].find((s) =>
    s.firstChild?.nodeType === Node.TEXT_NODE && s.firstChild.nodeValue === l && s.parentElement?.querySelector('input'));
  const el = span!.parentElement!.querySelector('input') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { l: label, v: value });

const undoKey = 'ControlOrMeta+z';
const redoKey = 'ControlOrMeta+Shift+z';

test.describe('texture modals re-pointed at another texture (#1328)', () => {
  // Mutation: drop `key={selectedAsset.path}` from <AssetInspector> in Inspector.tsx.
  test('Sprite Editor: undo after a swap never restores the previous texture', async ({ page }) => {
    await gotoEmptyEditor(page);
    await openModal(page, 'a.png', 'sprite');
    await expect.poll(() => mountedSlices(page, 'a.png'), { timeout: 15_000 }).toEqual([A_SLICE]);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('4');
    await page.evaluate(`${bridge}.setCoalesceMs(600000)`);

    // An undo step on A.
    await setField(page, 'Cols', '8');
    await page.evaluate(`${bridge}.flushCoalescedEdits()`);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('8');

    await openModal(page, 'b.png', 'sprite');
    await expect.poll(() => mountedSlices(page, 'b.png'), { timeout: 15_000 }).toEqual([B_SLICE]);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('2');

    // One undo step on B, then undo twice and redo once. B's history holds exactly one step, so the
    // second undo has nothing to pop and the redo re-applies B's edit (3). With A's history carried
    // over, the second undo applied A's snapshot (Cols 4) and the redo landed back on 2.
    await setField(page, 'Cols', '3');
    await page.evaluate(`${bridge}.flushCoalescedEdits()`);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('3');
    await page.keyboard.press(undoKey);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('2');
    await page.keyboard.press(undoKey);
    await page.keyboard.press(redoKey);
    await expect.poll(() => fieldText(page, 'Cols')).toBe('3');
    expect(await mountedSlices(page, 'b.png'), 'B still publishes only its own slices').toEqual([B_SLICE]);
  });

  // Mutation: drop `key={selectedAsset.path}` from <AssetInspector> in Inspector.tsx.
  test('9-slice editor: Cancel after a swap leaves the new texture\'s own whole-image sprite', async ({ page }) => {
    await gotoEmptyEditor(page);
    await expect.poll(() => wholeImage(page, D_ID), { timeout: 15_000 }).not.toBeNull();
    const dBefore = await wholeImage(page, D_ID);
    expect(dBefore.texture, 'premise: the scanner registered D\'s whole-image sprite').toBe(D_ID);
    expect(dBefore.border, 'premise: D has no border').toBeUndefined();

    await openModal(page, 'c.png', 'nineslice');
    await page.waitForSelector('text=9-slice Border — c', { timeout: 15_000 });
    await openModal(page, 'd.png', 'nineslice');
    await page.waitForSelector('text=9-slice Border — d', { timeout: 15_000 });
    // D's preview has run with D's own (empty) border. Before the fix it carried C's border of 5.
    // (The preview names the sprite after the file; the scanner after its stem. Only `name` differs.)
    const { name: _n, ...dGeometry } = dBefore;
    await expect.poll(async () => { const { name: _m, ...g } = await wholeImage(page, D_ID); return g; }).toEqual(dGeometry);

    await page.click('[data-ui-id="nineSlice.cancel"]');
    await expect(page.locator('text=9-slice Border —')).toHaveCount(0);
    // Before the fix, the revert registered C's snapshot under D's guid.
    expect(await wholeImage(page, D_ID)).toEqual(dBefore);
  });

  // Mutation: drop `key={selectedAsset.path}` from <AssetInspector> in Inspector.tsx.
  test('Sprite Editor: a Save that finishes after a swap leaves the new modal open and its slices registered', async ({ page }) => {
    await gotoEmptyEditor(page);
    await expect.poll(() => spriteRef(page, B_SLICE), { timeout: 15_000 }).not.toBeNull();

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let writes = 0;
    await page.route('**/api/write-meta**', async (route) => {
      writes++;
      await held;
      await route.continue();
    });

    await openModal(page, 'a.png', 'sprite');
    await expect.poll(() => mountedSlices(page, 'a.png'), { timeout: 15_000 }).toEqual([A_SLICE]);
    await page.click('[data-ui-id="spriteEditor.save"]');
    await expect.poll(() => writes).toBe(1);

    await openModal(page, 'b.png', 'sprite');
    await expect.poll(() => mountedSlices(page, 'b.png'), { timeout: 15_000 }).toEqual([B_SLICE]);

    const written = page.waitForResponse('**/api/write-meta**');
    release();
    expect((await written).ok(), 'A\'s write went through').toBe(true);
    // Everything `save()` does after its await is synchronous; two frames is past all of it.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    expect((await spriteRef(page, A_SLICE))?.texture, 'A\'s own slice stays registered').toBe(A_ID);
    // …and the save neither closed B's modal nor unregistered B's slice.
    await expect(page.locator('text=Sprite Editor — b')).toHaveCount(1);
    expect(await mountedSlices(page, 'b.png')).toEqual([B_SLICE]);
    expect((await spriteRef(page, B_SLICE))?.texture).toBe(B_ID);
  });

  // Mutation: drop `key={selectedAsset.path}` from <AssetInspector> in Inspector.tsx.
  test('9-slice editor: a Save that finishes after a swap leaves the new modal open', async ({ page }) => {
    await gotoEmptyEditor(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let writes = 0;
    await page.route('**/api/write-meta**', async (route) => { writes++; await held; await route.continue(); });

    await openModal(page, 'c.png', 'nineslice');
    await page.waitForSelector('text=9-slice Border — c', { timeout: 15_000 });
    // C's border reaches the edge fields in the same step that marks its meta read; a Save before
    // that is refused as a write built on no read.
    await expect.poll(() => page.evaluate(() =>
      [...document.querySelectorAll('input[type="number"]')].filter((i) => (i as HTMLInputElement).value === '5').length,
    ), { timeout: 15_000 }).toBe(4);
    await page.click('[data-ui-id="nineSlice.save"]');
    await expect.poll(() => writes).toBe(1);
    await openModal(page, 'd.png', 'nineslice');
    await page.waitForSelector('text=9-slice Border — d', { timeout: 15_000 });

    const written = page.waitForResponse('**/api/write-meta**');
    release();
    expect((await written).ok(), 'C\'s write went through').toBe(true);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await expect(page.locator('text=9-slice Border — d')).toHaveCount(1);
  });
});
