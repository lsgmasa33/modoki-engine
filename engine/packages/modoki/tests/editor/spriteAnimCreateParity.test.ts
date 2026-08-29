/** #417 item 2 — `defaultSpriteAnimData()`'s docstring claims it is the ONE definition behind
 *  BOTH the Assets panel's "Create Sprite Animation" button (via `defaultAssetData('spriteanim')`)
 *  and the SpriteAnim Editor's own "+ New Sprite Animation". That claim was false: the editor's
 *  `newSpriteAnim` inlined its own byte-identical literal (and `defaultSpriteAnimData` wasn't even
 *  exported), so no behavioural test could tell "shared" from "duplicated". This file pins the two
 *  call sites to the shared factory. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerBuiltinCreatableAssets } from '../../src/editor/panels/builtinCreatableAssets';
import { getCreatableAssets } from '../../src/editor/panels/creatableAssets';
import { defaultSpriteAnimData } from '../../src/runtime/assets/assetSchemas';

describe('spriteanim create-flow parity (#417)', () => {
  it('the Assets panel "Create Sprite Animation" body matches { id, ...defaultSpriteAnimData() }', () => {
    registerBuiltinCreatableAssets();
    const def = getCreatableAssets().find((d) => d.id === 'spriteanim');
    expect(def).toBeTruthy();
    expect(def!.body).toBeTruthy();
    const body = def!.body!('test-guid', 'New Sprite Animation');
    expect(body).toEqual({ id: 'test-guid', ...defaultSpriteAnimData() });
  });

  // Source-level guard, not a behavioural one: `newSpriteAnim` lives inside a .tsx component
  // (SpriteAnimEditor's "+ New Sprite Animation" button) so it is not directly callable from a
  // test, and two copies that happen to agree today are behaviourally indistinguishable — this is
  // the #411/#417 class of bug. So assert the SOURCE no longer inlines the sprite-anim-document
  // literal that used to sit in `newSpriteAnim`.
  //
  // This is deliberately a negative assertion only ("does NOT contain the old literal"), with no
  // positive "it calls defaultSpriteAnimData()" counterpart — a comment could satisfy a text-based
  // positive check without the code actually doing it. A false FAILURE here (the literal shape
  // reappearing inside a comment, say) is the safe direction: loud, not silent.
  it('SpriteAnimEditor.newSpriteAnim no longer inlines its own sprite-anim-document literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/editor/panels/SpriteAnimEditor.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/clips:\s*\{\s*idle:\s*defaultSpriteClip\(\)\s*\}/);
  });
});
