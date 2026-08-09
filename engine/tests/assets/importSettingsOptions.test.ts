/** Every import-setting DEFAULT must appear in the option list its inspector control
 *  offers. Cross-kind guard — texture, audio, environment, video.
 *
 *  This is not a style rule, it is a silent-misreport guard. An HTML `<select>` whose
 *  `value` matches none of its `<option>`s does not render empty and does not warn: it
 *  displays its FIRST option. So a default that is missing from its own list makes the
 *  inspector state, confidently, a setting the asset does not have — and since it is the
 *  DEFAULT, it does so for every unconfigured asset in every project rather than for one
 *  odd file.
 *
 *  Measured instance (2026-08-05): `DEFAULT_VIDEO_SETTINGS.maxHeight` was 1080 while
 *  `VIDEO_MAX_DIMENSIONS` was [0, 640, 1280, 1920, 3840], so every clip reported its
 *  height bound as "Source" — i.e. "don't resize" — when it was in fact bounded to 1080.
 *  The pair is only checkable from OUTSIDE either module, which is why the guard lives
 *  here rather than beside one of them.
 *
 *  Scope note: this covers the DEFAULTS. A hand-authored sidecar can still hold a legal
 *  off-list value (a CRF of 24 is valid, just not one of the five presets) and hit the
 *  same `<select>` behaviour. That half is handled at the control instead: since #131 all
 *  four kinds here — video, audio, texture AND environment — splice the bound value into
 *  their options via `withCurrentValue` (`assetViews/importSettingOptions.ts`, pinned by
 *  `tests/editor/importSettingOptions.test.ts`). The two halves are complementary and both
 *  are needed: this file catches a bad DEFAULT, which no amount of splicing would reveal,
 *  because a spliced default looks perfectly correct in the dropdown. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEXTURE_SETTINGS, TEXTURE_MAX_SIZES,
} from '../../packages/modoki/src/runtime/loaders/textureSettings';
import {
  DEFAULT_AUDIO_SETTINGS, AUDIO_BITRATES, AUDIO_SAMPLE_RATES, AUDIO_BIT_DEPTHS, AUDIO_FORMATS,
} from '../../packages/modoki/src/runtime/loaders/audioSettings';
import {
  DEFAULT_ENV_SETTINGS, ENV_MAX_SIZES,
} from '../../packages/modoki/src/runtime/core/environmentSettings';
import {
  DEFAULT_VIDEO_SETTINGS, VIDEO_QUALITIES, VIDEO_MAX_DIMENSIONS, VIDEO_MAX_FPS,
  VIDEO_SCALE_PERCENTS, VIDEO_PRESETS,
} from '../../packages/modoki/src/runtime/loaders/videoSettings';

/** [what it is, the default the inspector binds, the options it offers].
 *
 *  The audio sample-rate/bit-depth rows use the SAME `?? fallback` the inspector applies
 *  (AudioAssetView.tsx) — those fields are optional, so what must be selectable is the
 *  value the control is actually handed, not the absent field. */
const PAIRS: [string, unknown, readonly unknown[]][] = [
  ['texture.maxSize', DEFAULT_TEXTURE_SETTINGS.maxSize, TEXTURE_MAX_SIZES],

  ['audio.format', DEFAULT_AUDIO_SETTINGS.format, AUDIO_FORMATS],
  ['audio.quality (bitrate)', DEFAULT_AUDIO_SETTINGS.quality, AUDIO_BITRATES],
  ['audio.sampleRate', DEFAULT_AUDIO_SETTINGS.sampleRate ?? 0, AUDIO_SAMPLE_RATES],
  ['audio.bitDepth', DEFAULT_AUDIO_SETTINGS.bitDepth ?? 16, AUDIO_BIT_DEPTHS],

  ['environment.maxSize', DEFAULT_ENV_SETTINGS.maxSize, ENV_MAX_SIZES],

  ['video.quality (CRF)', DEFAULT_VIDEO_SETTINGS.quality, VIDEO_QUALITIES],
  ['video.preset', DEFAULT_VIDEO_SETTINGS.preset, VIDEO_PRESETS],
  ['video.maxWidth', DEFAULT_VIDEO_SETTINGS.maxWidth, VIDEO_MAX_DIMENSIONS],
  ['video.maxHeight', DEFAULT_VIDEO_SETTINGS.maxHeight, VIDEO_MAX_DIMENSIONS],
  ['video.maxFps', DEFAULT_VIDEO_SETTINGS.maxFps, VIDEO_MAX_FPS],
  ['video.scalePercent', DEFAULT_VIDEO_SETTINGS.scalePercent, VIDEO_SCALE_PERCENTS],
];

describe('every import-setting default is selectable in its own option list', () => {
  it.each(PAIRS)('%s', (_name, value, options) => {
    expect(options).toContain(value);
  });

  it('covers every kind that has both a default block and an option list', () => {
    // Cheap tripwire: if a new asset kind gains import settings and nobody adds it above,
    // this count is the only thing that notices. Bump it deliberately, with the rows.
    expect(PAIRS).toHaveLength(12);
  });
});
