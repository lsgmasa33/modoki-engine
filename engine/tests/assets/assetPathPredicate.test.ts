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
import { isInternalAssetPath } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { isVideoRef } from '../../packages/modoki/src/runtime/core/textureRefs';
import {
  JSON_ASSET_SUFFIX_TYPE, BINARY_EXT_TYPE,
} from '../../packages/modoki/src/runtime/loaders/assetTypeClassifier';

/** Font extensions, called out by name because they were the ONE exclusion from the
 *  predicate and stopped being one in #231: `UIElement.fontFamily` held a CSS family name
 *  (or a font path), so rejecting a font path would have broken a legitimate authored value.
 *  It holds a font-asset GUID now, so a literal font path is a violation like any other, and
 *  the field-aware second predicate (`isInternalFontPath`) has been retired. */
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

  it('recognises a literal path for every shippable binary extension, fonts included', () => {
    const missing = Object.keys(BINARY_EXT_TYPE)
      .filter((ext) => !isInternalAssetPath(`/games/x/assets/thing${ext}`));
    expect(
      missing,
      'Same failure mode as above, via the binary path — add them to BINARY_ASSET_EXTS in '
        + 'core/assetRefRules.ts.',
    ).toEqual([]);
  });

  it('claims a font path too, in every font extension (#231)', () => {
    for (const ext of FONT_EXTS) {
      expect(isInternalAssetPath(`/games/x/assets/fonts/thing${ext}`), ext).toBe(true);
    }
  });

  /** The values that must still pass through — a font REF is a GUID, and a system typeface
   *  is a bare CSS family name in the separate `systemFont` field. Neither is a path, so
   *  neither may be claimed by a predicate whose whole job is rejecting paths. */
  it('claims neither a font GUID nor a CSS family name', () => {
    expect(isInternalAssetPath('713d4a4c-ec3f-4bf0-9b60-e6ad493bb7ad')).toBe(false);
    expect(isInternalAssetPath('Helvetica Neue')).toBe(false);
    expect(isInternalAssetPath('Inter.ttf')).toBe(false);            // no leading slash
    expect(isInternalAssetPath('https://fonts.example.com/Inter.woff2')).toBe(false);
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

/** `isVideoRef` (core/textureRefs.ts) duplicates BINARY_EXT_TYPE's video entries for the same
 *  forced reason as `isInternalAssetPath` above (L0 `core/` may import nothing) — kept honest
 *  by this guard instead of by an import. Total in BOTH directions: every video extension the
 *  classifier knows must be claimed, and nothing else may be. */
describe('isVideoRef stays total over BINARY_EXT_TYPE\'s video entries', () => {
  const videoExts = Object.entries(BINARY_EXT_TYPE)
    .filter(([, type]) => type === 'video')
    .map(([ext]) => ext);

  it('claims a literal path for every classifier-known video extension', () => {
    const missing = videoExts.filter((ext) => !isVideoRef(`/games/x/assets/clip${ext}`));
    expect(
      missing,
      'These video containers are classified by BINARY_EXT_TYPE (assetTypeClassifier.ts) but '
        + 'isVideoRef does not recognise them — the 2D renderer silently stops adopting them as '
        + 'video and falls through to the still-image path instead. Add them to the regex in '
        + 'isVideoRef, core/textureRefs.ts.',
    ).toEqual([]);
  });

  it('claims no non-video extension from the classifier (regex not widened too far)', () => {
    const wronglyClaimed = Object.entries(BINARY_EXT_TYPE)
      .filter(([, type]) => type !== 'video')
      .map(([ext]) => ext)
      .filter((ext) => isVideoRef(`/games/x/assets/clip${ext}`));
    expect(
      wronglyClaimed,
      'isVideoRef claims a path extension that BINARY_EXT_TYPE classifies as something other '
        + 'than video — narrow the regex in isVideoRef, core/textureRefs.ts.',
    ).toEqual([]);
  });
});
