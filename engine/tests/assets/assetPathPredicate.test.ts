/** `isInternalAssetPath` must recognise EVERY managed asset kind (#123 close-out sweep).
 *
 *  It is the predicate every literal-path rejection site consults — `resolveRef` (rejects
 *  loudly), the scene validator (warns), `assertNoPathRefs` (console.error at save), and
 *  `diagnose` (reports `literal-path`). A kind missing from it is a kind where a literal path
 *  is silently PASSED THROUGH as if it were a usable URL: it resolves off disk in dev and
 *  breaks once the build hashes/relocates the file — docs/build.md, "Assets the build cannot
 *  see", the #53 class.
 *
 *  This is a drift guard, not a style check, and it is retrospective: the predicate had
 *  already drifted. It covered `.anim.json` but NOT `.animset.json` / `.spriteanim.json` /
 *  `.timeline.json` / `.rig2d.json`, and no audio or video extension at all — leaving
 *  `SkeletalAnimator.animSet`, `SpriteAnimator.clipSet`, `Director.timeline`,
 *  `SkinnedSprite2D.rig`, `AudioSource.clip` and `VideoPlayer.clip` able to hold a path that
 *  nothing rejected. The list cannot simply IMPORT the classifier: `core/assetRefRules.ts` is
 *  L0 and may import nothing (docs/architecture-layers.md), while the classifier is L3
 *  `loaders/`. So the copy is forced, and this test is what keeps it honest. */
import { describe, it, expect } from 'vitest';
import { isInternalAssetPath, isInternalFontPath } from '../../packages/modoki/src/runtime/core/assetRefRules';
import {
  JSON_ASSET_SUFFIX_TYPE, BINARY_EXT_TYPE,
} from '../../packages/modoki/src/runtime/loaders/assetTypeClassifier';

/** Fonts are deliberately NOT asset-path refs: `UIElement.fontFamily` is a CSS family name
 *  (or a font path), so rejecting one would break a legitimate authored value. Stated here
 *  so the exclusion is a decision the test defends, not a hole it happens to leave. */
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

describe('isInternalAssetPath covers every managed asset kind', () => {
  it('recognises a literal path for every JSON asset suffix the classifier knows', () => {
    const missing = JSON_ASSET_SUFFIX_TYPE
      .map(([suffix]) => suffix)
      .filter((suffix) => !isInternalAssetPath(`/games/x/assets/thing${suffix}`));
    expect(
      missing,
      'These asset kinds are tracked by GUID but a literal path to one is NOT rejected — it '
        + 'passes through as a usable URL, works in dev, and breaks in a production build. Add '
        + 'them to JSON_ASSET_SUFFIXES in core/assetRefRules.ts.',
    ).toEqual([]);
  });

  it('recognises a literal path for every shippable binary extension (fonts excepted)', () => {
    const missing = Object.keys(BINARY_EXT_TYPE)
      .filter((ext) => !FONT_EXTS.has(ext))
      .filter((ext) => !isInternalAssetPath(`/games/x/assets/thing${ext}`));
    expect(
      missing,
      'Same failure mode as above, via the binary path — add them to BINARY_ASSET_EXTS in '
        + 'core/assetRefRules.ts.',
    ).toEqual([]);
  });

  it('still does NOT claim a font path — fontFamily is a CSS name, not an asset GUID', () => {
    for (const ext of FONT_EXTS) {
      expect(isInternalAssetPath(`/games/x/assets/fonts/thing${ext}`), ext).toBe(false);
    }
  });

  /** QA-INSP-0004 — the exclusion above is right for `UIElement.fontFamily` and WRONG for
   *  `Text2D.font` / `Text3D.font`, which are manifest-tracked font-asset GUIDs. The answer
   *  depends on the FIELD, not the extension, so it is a second predicate rather than a
   *  widening of the first — and the field-aware rejection sites (resolveRef, the scene
   *  validator, diagnose) ask both. */
  describe('isInternalFontPath — the field-aware other half', () => {
    it('claims an internal font path for every font extension', () => {
      for (const ext of FONT_EXTS) {
        expect(isInternalFontPath(`/games/x/assets/fonts/thing${ext}`), ext).toBe(true);
      }
    });

    it('claims nothing else — not a GUID, a URL, a bare filename, or another asset kind', () => {
      expect(isInternalFontPath('7b5534ab-5bc6-4082-a813-a291f3a69e54')).toBe(false);
      expect(isInternalFontPath('https://fonts.example.com/Inter.woff2')).toBe(false);
      expect(isInternalFontPath('Inter.ttf')).toBe(false);          // no leading slash
      expect(isInternalFontPath('Helvetica Neue')).toBe(false);     // a CSS family name
      expect(isInternalFontPath('/games/x/assets/tex/hero.png')).toBe(false);
      expect(isInternalFontPath('')).toBe(false);
      expect(isInternalFontPath(undefined)).toBe(false);
    });
  });

  it('needs the leading slash — a bare filename or a URL is not an internal path', () => {
    expect(isInternalAssetPath('thing.mesh.json')).toBe(false);
    expect(isInternalAssetPath('https://cdn.example.com/thing.glb')).toBe(false);
    // A GUID and a primitive sprite keyword must both stay untouched.
    expect(isInternalAssetPath('7b5534ab-5bc6-4082-a813-a291f3a69e54')).toBe(false);
    expect(isInternalAssetPath('circle')).toBe(false);
  });

  it('the four kinds the drift actually exposed are now rejected', () => {
    // Named explicitly so a future narrowing of the list fails on the concrete regression,
    // not only on the abstract classifier comparison above.
    for (const p of [
      '/games/x/assets/anims/hero.animset.json',      // SkeletalAnimator.animSet
      '/games/x/assets/anims/catvader.spriteanim.json', // SpriteAnimator.clipSet
      '/games/x/assets/cutscene.timeline.json',       // Director.timeline
      '/games/x/assets/rigs/hero.rig2d.json',         // SkinnedSprite2D.rig
      '/games/x/assets/sfx/shoot.mp3',                // AudioSource.clip
      '/games/x/assets/video/intro.mp4',              // VideoPlayer.clip
    ]) {
      expect(isInternalAssetPath(p), p).toBe(true);
    }
  });
});
