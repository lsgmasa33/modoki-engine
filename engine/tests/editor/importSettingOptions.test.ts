/** `withCurrentValue` — the shared guard against an asset inspector's `<select>` silently
 *  misreporting a hand-authored setting (#130 for video, #131 for audio/texture).
 *
 *  The failure it exists for has no symptom: an HTML `<select>` whose `value` matches none of
 *  its `<option>`s displays the FIRST one, with no warning and no empty state. So the panel
 *  states a setting the asset does not have, confidently, and the only way a user finds out is
 *  by reading the `.meta.json`. Moved here from `videoAssetLogic.test.ts` when audio and
 *  texture were fixed — the bug class was never video's.
 *
 *  Severity is deliberately recorded as LATENT: a scan of every committed `.meta.json` under
 *  `games/`, `demos/` and `engine/` found exactly one off-list value in the whole repo (the
 *  `video.quality: 24` that exposed this). These tests pin the behaviour so the honest control
 *  survives a refactor, not because anything misreports today. */

import { describe, it, expect } from 'vitest';
import { withCurrentValue } from '../../packages/modoki/src/editor/panels/assetViews/importSettingOptions';
import { VIDEO_QUALITIES } from '../../packages/modoki/src/runtime/loaders/videoSettings';
import { AUDIO_BITRATES, AUDIO_SAMPLE_RATES, OPUS_SAMPLE_RATES, AUDIO_BIT_DEPTHS } from '../../packages/modoki/src/runtime/loaders/audioSettings';
import { TEXTURE_MAX_SIZES } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import { ENV_MAX_SIZES } from '../../packages/modoki/src/runtime/core/environmentSettings';

describe('withCurrentValue', () => {
  it('leaves a preset list untouched when the bound value is already in it', () => {
    expect(withCurrentValue(VIDEO_QUALITIES, 23)).toBe(VIDEO_QUALITIES);
  });

  it('splices a hand-authored value in, in order — a select given an unlisted value silently shows its FIRST option', () => {
    // The measured bug: a sidecar with `quality: 24` rendered as "18 — near-lossless".
    expect(withCurrentValue(VIDEO_QUALITIES, 24)).toEqual([18, 20, 23, 24, 26, 30]);
  });

  it('does not mutate the shared constant it was handed', () => {
    const before = [...VIDEO_QUALITIES];
    withCurrentValue(VIDEO_QUALITIES, 24);
    expect(VIDEO_QUALITIES).toEqual(before);
  });

  it('keeps a value that sorts BEFORE every preset visible rather than dropping it off', () => {
    // Ordering matters for more than tidiness: the first option is what a mismatched
    // select falls back to, so an out-of-range value has to land where it belongs.
    expect(withCurrentValue(AUDIO_BITRATES, 48)).toEqual([48, 96, 128, 160, 192, 256, 320]);
  });
});

/** Each row is a control the inspectors actually bind. The point is not that the helper works
 *  — the block above covers that — but that the SPECIFIC lists which #131 found unguarded
 *  behave when handed a legal off-list value. */
describe('the audio/texture controls fixed by #131', () => {
  const cases: { what: string; options: readonly number[]; authored: number; firstOption: number }[] = [
    { what: 'audio bitrate', options: AUDIO_BITRATES, authored: 224, firstOption: 96 },
    { what: 'audio sample rate', options: AUDIO_SAMPLE_RATES, authored: 96000, firstOption: 0 },
    { what: 'opus sample rate', options: OPUS_SAMPLE_RATES, authored: 16000, firstOption: 0 },
    { what: 'audio bit depth', options: AUDIO_BIT_DEPTHS, authored: 8, firstOption: 16 },
    { what: 'texture max size', options: TEXTURE_MAX_SIZES, authored: 1536, firstOption: 256 },
    { what: 'environment max size', options: ENV_MAX_SIZES, authored: 1536, firstOption: ENV_MAX_SIZES[0] },
  ];

  for (const { what, options, authored, firstOption } of cases) {
    it(`${what}: an authored ${authored} stays ${authored} instead of displaying as ${firstOption}`, () => {
      const widened = withCurrentValue(options, authored);
      expect(widened).toContain(authored);
      // Without the splice the select would render `firstOption` — assert the list is
      // genuinely widened rather than the preset list happening to contain the value.
      expect(options).not.toContain(authored);
      expect(widened.length).toBe(options.length + 1);
      // ...and sorted, so the value sits where a user reading the dropdown expects it.
      expect([...widened]).toEqual([...widened].sort((a, b) => a - b));
    });
  }

  it('the `0 = source` sentinel stays first in the sample-rate lists', () => {
    // `0` renders as "Source", not "0 Hz". Splicing must not push it out of the lead slot,
    // where a mismatched select would otherwise fall back to a real resample rate.
    expect(withCurrentValue(AUDIO_SAMPLE_RATES, 96000)[0]).toBe(0);
    expect(withCurrentValue(OPUS_SAMPLE_RATES, 16000)[0]).toBe(0);
  });
});
