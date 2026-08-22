/**
 * A texture RE-IMPORT must invalidate every cached resolution of that texture.
 *
 * `_spriteEpochByTexture` was bumped only by `registerSprite` (a re-slice), so retyping a texture
 * and reimporting it left the epoch untouched. Measured on `games/anim-bug`
 * (bug `udpbnC6DHswvCj115B7M`, QA-ASSET-0007): the sidecar, the manifest and
 * `resolveBrowserImageUrl` were all correct at that moment, and the live `UIElement.imageSrc` DOM
 * still read `…/lightning_real.png` with no `~webp` — nothing had re-asked for the URL. Toggling
 * the trait to '' and back fixed it instantly, which is what identified the re-render, not the
 * resolution, as the broken half.
 *
 * The predicate is deliberately narrow: the manifest is re-broadcast wholesale by the watcher, so
 * "bump on any re-register" would invalidate every cached resolution in the editor whenever an
 * unrelated asset changed.
 */
import { describe, it, expect } from 'vitest';
import { textureResolutionChanged } from '../../src/runtime/loaders/assetManifest';

const prior = { path: '/assets/textures/a.png', textureType: '3d', texture: { format: 'ktx2-uastc' }, hash: 'h1' };

describe('textureResolutionChanged', () => {
  it('fires on the RETYPE that QA-ASSET-0007 performs (3d → ui)', () => {
    // The authored usage type decides whether a WebP sibling is even looked for, so this is
    // exactly the change that alters the resolved DOM URL while the ref GUID stays the same.
    expect(textureResolutionChanged(prior, { path: prior.path, textureType: 'ui' })).toBe(true);
  });

  it('fires on a re-encode of the same settings (content hash moved)', () => {
    expect(textureResolutionChanged(prior, { path: prior.path, hash: 'h2' })).toBe(true);
  });

  it('fires on a format change and on a move/rename', () => {
    expect(textureResolutionChanged(prior, { path: prior.path, format: 'webp' })).toBe(true);
    expect(textureResolutionChanged(prior, { path: '/assets/textures/moved.png' })).toBe(true);
  });

  it('does NOT fire on a re-register that changes none of them', () => {
    // The watcher re-broadcasts the whole manifest; bumping here would churn every cached
    // resolution in the editor on any unrelated asset change.
    expect(textureResolutionChanged(prior, {
      path: prior.path, textureType: '3d', format: 'ktx2-uastc', hash: 'h1',
    })).toBe(false);
  });

  it('does NOT fire when a partial re-register simply OMITS the fields', () => {
    // A loader self-registering on fetch passes no settings blocks, and `registerAsset` carries
    // the prior ones forward. An omitted field is "unchanged", not "cleared" — reading it as a
    // change would make every such call bump the epoch.
    expect(textureResolutionChanged(prior, { path: prior.path })).toBe(false);
  });
});
