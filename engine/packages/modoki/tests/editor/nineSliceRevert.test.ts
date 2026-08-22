/** The 9-slice editor's live preview must be UNDONE when its modal closes without saving.
 *
 *  Against the REAL manifest, no mocks: the whole defect was a divergence between what the running
 *  manifest held and what the file held, so a test that mocks the manifest would be asserting the
 *  mock and could not have caught it.
 *
 *  Measured before the fix (games/3d-test, "Hello Buton" — a UI element whose imageSrc IS the
 *  whole-image sprite guid): drag l 34 -> 59, Cancel, then touch any UIElement field and the button
 *  re-renders at background-size 472.881% (= 279/59) instead of 820.588% (= 279/34). The file said
 *  34, the Inspector said 34, the screen showed 59 — for the rest of the session. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearManifest, registerAsset, registerSprite, getAssetEntry, type SpriteAssetRef,
} from '../../src/runtime/loaders/assetManifest';
import {
  captureSpriteSnapshot, revertSpritePreview, wholeImageSpriteGuid,
} from '../../src/editor/panels/nineSliceRevert';

const TEX = '3947ad3d-8876-4bdc-ac9c-581c247872db';
const PATH = '/assets/textures/red-button.png';

const spriteWithBorder = (l: number): SpriteAssetRef => ({
  texture: TEX, name: 'red-button', rect: { x: 0, y: 0, w: 279, h: 141 }, pivot: { x: 0.5, y: 0.5 },
  sheetW: 279, sheetH: 141, border: { l, r: 36, t: 26, b: 43, scale: 0.5 },
} as SpriteAssetRef);

const liveBorder = () => (getAssetEntry(wholeImageSpriteGuid(TEX))?.sprite?.border as { l: number } | undefined)?.l;

beforeEach(() => {
  clearManifest();
  registerAsset(TEX, PATH, 'texture');
});

describe('revertSpritePreview', () => {
  it('restores the border the modal opened with — the reported bug', () => {
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(34));
    const snapshot = captureSpriteSnapshot(TEX);

    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(59));  // live preview
    expect(liveBorder()).toBe(59);

    expect(revertSpritePreview({ texGuid: TEX, path: PATH, snapshot, saved: false })).toBe('restored');
    expect(liveBorder()).toBe(34);
  });

  it('leaves a SAVED edit alone — the preview is the truth once it reaches disk', () => {
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(34));
    const snapshot = captureSpriteSnapshot(TEX);
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(70));

    expect(revertSpritePreview({ texGuid: TEX, path: PATH, snapshot, saved: true })).toBe('saved');
    expect(liveBorder()).toBe(70);
  });

  it('REMOVES the sprite when the manifest had none — it must not invent one', () => {
    // A sliced sheet never gets a whole-image sprite (docs/textures.md), so restoring "the border
    // from the meta" instead of the snapshot would leave a ref the scanner would never produce,
    // and `resolveRef` would then hand out a sprite nothing on disk backs.
    const snapshot = captureSpriteSnapshot(TEX);
    expect(snapshot).toBeNull();

    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(59));  // preview created it
    expect(liveBorder()).toBe(59);

    expect(revertSpritePreview({ texGuid: TEX, path: PATH, snapshot, saved: false })).toBe('removed');
    expect(getAssetEntry(wholeImageSpriteGuid(TEX))).toBeUndefined();
  });

  it('does nothing when the preview never ran (snapshot never captured)', () => {
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(34));
    expect(revertSpritePreview({ texGuid: TEX, path: PATH, snapshot: undefined, saved: false })).toBe('nothing-to-undo');
    expect(liveBorder()).toBe(34);   // untouched, not "restored" to something invented
  });

  it('does nothing for a texture with no usable guid', () => {
    expect(revertSpritePreview({ texGuid: undefined, path: PATH, snapshot: null, saved: false })).toBe('nothing-to-undo');
    expect(revertSpritePreview({ texGuid: 'not-a-guid', path: PATH, snapshot: null, saved: false })).toBe('nothing-to-undo');
  });

  it('a second open snapshots the SAVED value, so cancelling then reverts to that', () => {
    // Cancel after a save must go back to what was just saved, not to what the session started
    // with. Verified live: save 70, reopen, drag to 90, Cancel -> 70.
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(70));
    const snapshot = captureSpriteSnapshot(TEX);
    registerSprite(wholeImageSpriteGuid(TEX), TEX, PATH, spriteWithBorder(90));

    revertSpritePreview({ texGuid: TEX, path: PATH, snapshot, saved: false });
    expect(liveBorder()).toBe(70);
  });
});
