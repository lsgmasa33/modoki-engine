/** Audio content-cache tests — hash stability, settings sensitivity, and the
 *  invariant that loadType does NOT affect the hash (it forks the runtime path,
 *  not the converted bytes) while conversion settings DO. */

import { describe, it, expect } from 'vitest';
import { audioHashKey, audioCachePathFor, getAudioCacheDir } from '../../plugins/audio-cache';
import { DEFAULT_AUDIO_SETTINGS } from '../../packages/modoki/src/runtime/loaders/audioSettings';

const bytes = Buffer.from('fake-audio-source-bytes');
const S = DEFAULT_AUDIO_SETTINGS;

describe('audioHashKey', () => {
  it('is stable for identical bytes + settings', () => {
    expect(audioHashKey(bytes, S)).toBe(audioHashKey(bytes, S));
  });

  it('16 hex chars', () => {
    expect(audioHashKey(bytes, S)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a CONVERSION setting changes', () => {
    expect(audioHashKey(bytes, { ...S, format: 'wav' })).not.toBe(audioHashKey(bytes, S));
    expect(audioHashKey(bytes, { ...S, quality: 320 })).not.toBe(audioHashKey(bytes, S));
    expect(audioHashKey(bytes, { ...S, forceMono: true })).not.toBe(audioHashKey(bytes, S));
    expect(audioHashKey(bytes, { ...S, normalize: true })).not.toBe(audioHashKey(bytes, S));
    expect(audioHashKey(bytes, { ...S, trimSilence: true })).not.toBe(audioHashKey(bytes, S));
  });

  it('does NOT change when only loadType changes (buffer vs stream)', () => {
    expect(audioHashKey(bytes, { ...S, loadType: 'stream' })).toBe(audioHashKey(bytes, S));
  });

  it('changes when sampleRate changes (re-encodes)', () => {
    expect(audioHashKey(bytes, { ...S, sampleRate: 22050 })).not.toBe(audioHashKey(bytes, S));
  });

  it('bitDepth affects the hash for wav only (dead input for other formats)', () => {
    const wav = { ...S, format: 'wav' as const };
    expect(audioHashKey(bytes, { ...wav, bitDepth: 24 })).not.toBe(audioHashKey(bytes, wav));
    // On a non-wav format the encoder ignores bitDepth → must NOT change the key.
    expect(audioHashKey(bytes, { ...S, bitDepth: 24 })).toBe(audioHashKey(bytes, S));
  });

  it('is backward-compatible: absent sampleRate/bitDepth (and sampleRate 0) hash as before', () => {
    const base = audioHashKey(bytes, S);
    expect(audioHashKey(bytes, { ...S, sampleRate: undefined, bitDepth: undefined })).toBe(base);
    expect(audioHashKey(bytes, { ...S, sampleRate: 0 })).toBe(base);
  });

  it('changes when the source bytes change', () => {
    expect(audioHashKey(Buffer.from('other'), S)).not.toBe(audioHashKey(bytes, S));
  });
});

describe('audioCachePathFor', () => {
  it('lays out <cacheDir>/<urlPath>/<hash>/audio.<ext>', () => {
    const dir = getAudioCacheDir('/proj');
    const p = audioCachePathFor(dir, '/games/x/assets/audio/m.mp3', 'abcd1234abcd1234', 'mp3');
    // Normalize separators — these are filesystem paths (path.join), so they're
    // backslash-delimited on Windows; assert the logical structure regardless of OS.
    expect(p.replace(/\\/g, '/')).toBe('/proj/.cache/modoki-audio/games/x/assets/audio/m.mp3/abcd1234abcd1234/audio.mp3');
  });
});
