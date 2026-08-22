/** E2E — the editor's commit-on-every-keystroke fields, driven the way an UNFOCUSED
 *  window delivers them: real `input` events through React, and NO focus/blur.
 *
 *  Both bugs covered here were invisible to every other tier. `npm test` cannot see them
 *  (they live in a real browser's event delivery), and an ordinary Playwright spec cannot
 *  either — a click-and-type in a FOCUSED window fires `focus`/`blur`, which is exactly the
 *  crutch the broken code leaned on. So `typeUnfocused` below reproduces the one thing that
 *  actually differs in an unfocused window: Chromium dispatches `focus`/`blur` only while
 *  `document.hasFocus()`, so a field gets its `onChange` and nothing else. (Headless Chromium
 *  reports `hasFocus() === true` and a second page does not change that — measured — so the
 *  state has to be produced through the events, not through window management.)
 *
 *  - **#244** — SpriteEditor's slicer params took their undo snapshot in `onFocus` and pushed
 *    it in `onBlur`, so with no focus events NOTHING reached the modal's history: the edit
 *    applied and ⌘Z silently reverted whatever came before it instead.
 *  - **#242** — ParticleEditor's `NumInput` re-synced its buffer from the store whenever it
 *    was not `focusedRef`-flagged, so the field's OWN commit echoed back and rewrote the text
 *    mid-edit; the remaining keystrokes landed on the echo and a clamped field committed a
 *    value the user never typed. That fix shipped with no automated guard (verified live
 *    only) — this is it.
 *
 *  `qa/knowledge.md` §5 / `docs/editor-input.md` § "Never make a commit depend on a focus
 *  EVENT" is the class both belong to.
 */

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { gotoEmptyEditor } from './helpers';
import { pickHostProject } from './hostProject';

// Host the generated fixtures inside a real project's asset root so the dev server serves
// them. See hostProject.ts for the pick and why it can't throw.
const HOST = pickHostProject();
test.skip(!HOST, 'editor-unfocused-field-commits: this snapshot ships no project to host the fixtures');
const ABS_DIR = HOST ? path.join(HOST.dir, 'runtime/assets/__e2e_fields__') : '';
const URL_DIR = HOST ? `/${HOST.root}/${HOST.name}/assets/__e2e_fields__` : '';
const SHEET_URL = `${URL_DIR}/sheet.png`;
const PARTICLE_URL = `${URL_DIR}/e2e-fields.particle.json`;

/** A minimal opaque RGBA PNG — the Sprite Editor needs a decodable image, not a real sheet. */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) raw.set([200, 60, 60, 255], off + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// `startOpacity` is the shape #242 was measured on: a CLAMPED field (min 0, max 1), which is
// what supplies the echo — an in-progress `-3` clamps to 0, moves the store, and the store
// answers back. 0.4 so the pre-edit value is distinguishable from every value in play.
const PARTICLE_JSON = {
  version: 1, name: 'E2E Fields', duration: 1, looping: true, maxParticles: 10, worldSpace: false,
  emission: { rateOverTime: 5 },
  shape: { type: 'cone', angle: 10, radius: 0.1 },
  startLifetime: { min: 1, max: 1 }, startSpeed: { min: 1, max: 1 }, startSize: { min: 0.1, max: 0.1 },
  startColor: { r: 1, g: 1, b: 1 }, startOpacity: 0.4, gravity: 0,
  render: { blend: 'normal', mode: 'mesh', meshPrimitive: 'box', meshLit: false },
  id: '2b0f9d41-4a2e-4f3a-9c66-0b1d5f7a1e02',
};

test.beforeAll(() => {
  // The file-level test.skip above covers the tests, but whether Playwright still runs a
  // beforeAll/afterAll when every test in the file is skipped is a semantic this repo cannot
  // observe from a clone (which always HAS a project). Guard explicitly: with no host,
  // ABS_DIR is '' and mkdirSync('') throws — which would turn a clean skip into a failure on
  // exactly the project-less snapshot this change exists for.
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ABS_DIR, 'sheet.png'), png(64, 64));
  fs.writeFileSync(path.join(ABS_DIR, 'e2e-fields.particle.json'), JSON.stringify(PARTICLE_JSON, null, 2));
});
test.afterAll(() => {
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

/** Tag the `<input>` whose label reads exactly `label` with `data-e2e-f="<label>"`.
 *  Matches the label's FIRST TEXT NODE, so a trailing hint marker (ParticleEditor's ⓘ) and a
 *  longer label that merely starts the same way can't be mistaken for it. */
async function tagField(page: Page, label: string) {
  const found = await page.evaluate((l) => {
    const span = [...document.querySelectorAll('span')].find((s) =>
      s.firstChild?.nodeType === Node.TEXT_NODE && s.firstChild.nodeValue === l && s.parentElement?.querySelector('input'));
    const input = span?.parentElement?.querySelector('input');
    if (!input) return false;
    input.setAttribute('data-e2e-f', l);
    return true;
  }, label);
  expect(found, `field labelled "${label}" not found`).toBe(true);
}

const fieldText = (page: Page, label: string) =>
  page.evaluate((l) => (document.querySelector(`[data-e2e-f="${l}"]`) as HTMLInputElement | null)?.value ?? null, label);

/** Type into a tagged field the way an UNFOCUSED window delivers it — one `input` event per
 *  character, through React's own value setter, with no `focus`/`blur` ever dispatched.
 *
 *  Each character is APPENDED to whatever the field currently shows, re-read from the DOM every
 *  time. That is the load-bearing detail: if the field's own commit echoes back and rewrites the
 *  buffer mid-edit (#242), the next character lands on the rewritten text — exactly as it does
 *  for a human typing into an unfocused window, and not at all if the test pushed whole strings. */
async function typeUnfocused(page: Page, label: string, text: string, { clear = true } = {}) {
  const send = async (next: string | null) => {
    await page.evaluate(({ l, n }) => {
      const el = document.querySelector(`[data-e2e-f="${l}"]`) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, n === null ? el.value : n);   // React tracks the node's value; go through its setter
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { l: label, n: next });
    // Let React flush + the store round-trip land before reading the field for the next char.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  };
  if (clear) await send('');
  for (const ch of text) {
    const cur = await fieldText(page, label);
    await send((cur ?? '') + ch);
  }
}

const undoKey = 'ControlOrMeta+z';

/** Widen the undo-coalescing idle window so a run of keystrokes CANNOT split, whatever the
 *  machine is doing (#300). `typeUnfocused` spends several CDP round-trips plus two rAF per
 *  character; in the full suite a gap stretched past the real 500 ms window, the coalescer
 *  correctly closed the step mid-run, and `⌘Z` then reverted to the intermediate `12` instead
 *  of `0` — ~1 run in 6, never in isolation. That is the coalescer working as designed (a
 *  human pausing 600 ms mid-number gets two steps too), so the spec is what had to stop racing
 *  a wall clock. Measured: with a 600 ms gap forced between characters the failure reproduces
 *  100%, with 0 ms it never does.
 *
 *  Nothing is lost by widening it. The timer's own behaviour — "a fast run stays one entry" —
 *  is pinned deterministically under `vi.useFakeTimers()` in
 *  `engine/packages/modoki/tests/editor/coalescedEdit.test.ts`. What only a real browser can
 *  show is what these specs are for: the unfocused event delivery, and a real ⌘Z flushing the
 *  pending session before it pops. Both still fail here if a per-keystroke history returns or
 *  if `undo()` stops flushing.
 *
 *  Scoped to the page, so it needs no teardown: each test gets a fresh page, the bridge is
 *  reinstalled on load, and the override goes with the old one. */
const coalesce = {
  widen: (page: Page) => page.evaluate(() => (window as any).__modokiEditorTest.setCoalesceMs(600_000)),
  /** What the user pausing over the idle window means, without waiting for one. */
  flush: (page: Page) => page.evaluate(() => (window as any).__modokiEditorTest.flushCoalescedEdits()),
};

test.describe('Sprite Editor — slicer params are undoable with no focus events (#244)', () => {
  test('⌘Z reverts the param the user just typed, not the step before it', async ({ page }) => {
    await gotoEmptyEditor(page);
    await page.evaluate((u) => (window as any).__modokiEditorTest.store.getState().requestTextureEditor(u, 'sprite'), SHEET_URL);
    await page.waitForSelector('text=Sprite Editor —', { timeout: 15_000 });
    await coalesce.widen(page);
    await tagField(page, 'Off X');
    await tagField(page, 'Cols');
    expect(await fieldText(page, 'Cols')).toBe('4');
    expect(await fieldText(page, 'Off X')).toBe('0');

    // Step 1: an earlier edit, closed as its own undo step. An explicit flush, not a sleep —
    // it is the same signal the idle timer sends, delivered when the spec means it rather
    // than whenever a loaded machine gets round to it.
    await typeUnfocused(page, 'Off X', '5');
    await coalesce.flush(page);
    expect(await fieldText(page, 'Off X')).toBe('5');

    // Step 2: the edit under test, undone WITHOUT ever leaving the field.
    await typeUnfocused(page, 'Cols', '8');
    expect(await fieldText(page, 'Cols')).toBe('8');
    await page.keyboard.press(undoKey);

    // Before the fix this asserted the bug: Cols stayed 8 (its edit was never pushed) and
    // Off X fell back to 0 (the step that WAS pushed is the one that got undone).
    await expect.poll(() => fieldText(page, 'Cols')).toBe('4');
    expect(await fieldText(page, 'Off X')).toBe('5');

    // …and the two are separate steps, in the order they happened.
    await page.keyboard.press(undoKey);
    await expect.poll(() => fieldText(page, 'Off X')).toBe('0');
    expect(await fieldText(page, 'Cols')).toBe('4');
  });

  test('a run of keystrokes in one field is ONE undo step, not one per keystroke', async ({ page }) => {
    await gotoEmptyEditor(page);
    await page.evaluate((u) => (window as any).__modokiEditorTest.store.getState().requestTextureEditor(u, 'sprite'), SHEET_URL);
    await page.waitForSelector('text=Sprite Editor —', { timeout: 15_000 });
    await coalesce.widen(page);
    await tagField(page, 'Pad X');

    await typeUnfocused(page, 'Pad X', '123');
    expect(await fieldText(page, 'Pad X')).toBe('123');
    await page.keyboard.press(undoKey);
    // One step back to the pre-typing value — not to '12', which is what a per-keystroke
    // history would give (and what the Selected-sprite fields used to do).
    await expect.poll(() => fieldText(page, 'Pad X')).toBe('0');
  });
});

test.describe('Particle Editor — a clamped number field survives typing with no focus events (#242)', () => {
  test('typing -3.5 into a clamped field commits the clamp, not an echo of its own commit', async ({ page }) => {
    await gotoEmptyEditor(page);
    await page.evaluate((u) => (window as any).__modokiEditorTest.store.getState()
      .openParticleEditor({ path: u, type: 'particle', name: 'e2e-fields' }), PARTICLE_URL);
    await expect.poll(async () => {
      await tagField(page, 'Opacity').catch(() => {});
      return fieldText(page, 'Opacity');
    }, { timeout: 15_000, intervals: [200, 400, 800] }).toBe('0.4');

    await typeUnfocused(page, 'Opacity', '-3.5');

    // The buffer holds what was typed — pre-fix, the echo of the field's own clamped commit
    // rewrote it mid-entry and the remaining characters landed on a '0'.
    expect(await fieldText(page, 'Opacity')).toBe('-3.5');
    // And the STORE holds the clamp of what was typed. Read the def, never the field: the
    // display legitimately shows an out-of-range value until something reconciles it.
    const stored = await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().editingParticleDef?.startOpacity);
    expect(stored).toBe(0);
  });
});
