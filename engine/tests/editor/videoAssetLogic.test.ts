/** VideoAssetView's decision logic — the parts that fail SILENTLY in the panel.
 *
 *  Each of these has a failure mode that looks like a working editor: previewing the
 *  source shows a broken <video> for a clip that converted fine; a remote clip with no
 *  URL plays in dev off its local path and 404s only in production; a
 *  delivery-only change that demanded a re-encode would multiply every reimport. */

import { describe, it, expect } from 'vitest';
import {
  videoPreviewUrl, describeVideoDelivery, videoSettingsWarnings, conversionSettingsDiffer,
} from '../../packages/modoki/src/editor/panels/assetViews/videoAssetLogic';
import {
  DEFAULT_VIDEO_SETTINGS, AUTO_DOWNLOAD_MAX_BYTES,
  type VideoImportSettings, type VideoCacheInfo,
} from '../../packages/modoki/src/runtime/loaders/videoSettings';

const s = (patch: Partial<VideoImportSettings> = {}): VideoImportSettings => ({ ...DEFAULT_VIDEO_SETTINGS, ...patch });
const cache = (patch: Partial<VideoCacheInfo> = {}): VideoCacheInfo => ({ hash: 'abc', ext: 'mp4', ...patch });

describe('videoPreviewUrl', () => {
  it('points at the converted variant once one exists', () => {
    expect(videoPreviewUrl('/games/x/assets/intro.mov', true)).toBe('/games/x/assets/intro.mov~video.mp4');
  });

  it('falls back to the source before the first convert — there is nothing else', () => {
    expect(videoPreviewUrl('/games/x/assets/intro.mp4', false)).toBe('/games/x/assets/intro.mp4');
  });
});

describe('describeVideoDelivery', () => {
  it('says nothing about policy for a bundled clip — policy does not apply', () => {
    const text = describeVideoDelivery(s({ delivery: 'bundled', policy: 'download' }), cache());
    expect(text).toMatch(/inside the build/);
    expect(text).not.toMatch(/download/);
  });

  it("resolves 'auto' against the measured size — small downloads", () => {
    const text = describeVideoDelivery(s({ delivery: 'remote', policy: 'auto' }), cache({ bytes: 1024 * 1024 }));
    expect(text).toMatch(/auto → downloaded/);
    expect(text).toMatch(/1\.00 MB/);
  });

  it("resolves 'auto' the other way for a clip over the threshold", () => {
    const text = describeVideoDelivery(s({ delivery: 'remote', policy: 'auto' }), cache({ bytes: AUTO_DOWNLOAD_MAX_BYTES + 1 }));
    expect(text).toMatch(/auto → streamed/);
  });

  it('omits the "auto →" prefix when the policy was pinned by hand', () => {
    const text = describeVideoDelivery(s({ delivery: 'remote', policy: 'stream' }), cache({ bytes: 10 }));
    expect(text).toMatch(/streamed/);
    expect(text).not.toMatch(/auto/);
  });

  it('survives an unconverted clip, where no size is known', () => {
    expect(() => describeVideoDelivery(s({ delivery: 'remote' }), undefined)).not.toThrow();
    expect(describeVideoDelivery(s({ delivery: 'remote' }), undefined)).toMatch(/streamed/);
  });
});

describe('videoSettingsWarnings', () => {
  it('is silent for a plain bundled clip', () => {
    expect(videoSettingsWarnings(s(), cache())).toEqual([]);
  });

  it('flags remote delivery with no URL — the case that only 404s in production', () => {
    const w = videoSettingsWarnings(s({ delivery: 'remote' }), cache());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/No Remote URL/);
  });

  it('flags a relative remote URL', () => {
    expect(videoSettingsWarnings(s({ delivery: 'remote', remoteUrl: '/assets/x.mp4' }), cache())[0])
      .toMatch(/absolute http/);
  });

  it('flags plain http (mixed content / iOS ATS)', () => {
    expect(videoSettingsWarnings(s({ delivery: 'remote', remoteUrl: 'http://cdn.test/x.mp4' }), cache())[0])
      .toMatch(/http:\/\//);
  });

  it('flags GitHub Releases — it serves ranges but no CORS, so a texture load fails', () => {
    const w = videoSettingsWarnings(s({ delivery: 'remote', remoteUrl: 'https://github.com/o/r/releases/download/v1/x.mp4' }), cache());
    expect(w[0]).toMatch(/CORS/);
  });

  it('accepts a CORS-serving host without comment', () => {
    expect(videoSettingsWarnings(s({ delivery: 'remote', remoteUrl: 'https://cdn.jsdelivr.net/gh/o/r/x.mp4' }), cache())).toEqual([]);
  });

  it("notes that 'strip' has not taken effect while the variant still carries audio", () => {
    expect(videoSettingsWarnings(s({ audio: 'strip' }), cache({ hasAudio: true }))[0]).toMatch(/re-import/i);
    expect(videoSettingsWarnings(s({ audio: 'strip' }), cache({ hasAudio: false }))).toEqual([]);
  });

  it('warns only about delivery, not about being unconverted', () => {
    expect(videoSettingsWarnings(s(), undefined)).toEqual([]);
  });
});

/* The defaults-vs-option-lists contract is guarded ACROSS ALL asset kinds in
 * engine/tests/assets/importSettingsOptions.test.ts — video's rows live there with
 * texture/audio/environment's, since the bug class is not video-specific. */

describe('conversionSettingsDiffer', () => {
  it('is false for identical settings', () => {
    expect(conversionSettingsDiffer(s(), s())).toBe(false);
  });

  it.each<Partial<VideoImportSettings>>([
    { quality: 30 }, { preset: 'slow' }, { maxWidth: 640 }, { maxHeight: 640 },
    { maxFps: 30 }, { keyframeIntervalSec: 4 }, { audio: 'strip' }, { audioBitrate: 256 },
  ])('is true when %o changes the encoded bytes', (patch) => {
    expect(conversionSettingsDiffer(s(), s(patch))).toBe(true);
  });

  it.each<Partial<VideoImportSettings>>([
    { delivery: 'remote' }, { policy: 'stream' }, { remoteUrl: 'https://cdn.test/x.mp4' },
  ])('is false when only the delivery fork changes (%o) — those are not in the cache key', (patch) => {
    expect(conversionSettingsDiffer(s(), s(patch))).toBe(false);
  });

  it('notices a resize-mode switch', () => {
    expect(conversionSettingsDiffer(s({ resizeMode: 'bounds' }), s({ resizeMode: 'percent' }))).toBe(true);
  });

  it('tracks only the ACTIVE half of the resize mode — matching what the cache key hashes', () => {
    const pct = { resizeMode: 'percent' } as const;
    expect(conversionSettingsDiffer(s({ ...pct, scalePercent: 50 }), s({ ...pct, scalePercent: 25 }))).toBe(true);
    expect(conversionSettingsDiffer(s({ ...pct, maxWidth: 640 }), s({ ...pct, maxWidth: 3840 }))).toBe(false);

    const bnd = { resizeMode: 'bounds' } as const;
    expect(conversionSettingsDiffer(s({ ...bnd, maxWidth: 640 }), s({ ...bnd, maxWidth: 3840 }))).toBe(true);
    expect(conversionSettingsDiffer(s({ ...bnd, scalePercent: 50 }), s({ ...bnd, scalePercent: 100 }))).toBe(false);
  });
});
