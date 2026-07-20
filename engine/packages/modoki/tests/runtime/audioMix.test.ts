/** Audio Phase-3 units: import-settings resolution + format mappings,
 *  setBusVolume record-mode logging, and the converted-variant URL resolution
 *  (source vs `~audio.<ext>?v=<hash>`). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS, resolveAudioSettings,
  audioFormatExtension, audioFormatMime, audioVariantSuffix, audioFormatIsLossy,
} from '../../src/runtime/loaders/audioSettings';
import {
  setAudioRecordMode, clearAudioLog, getAudioLog, setBusVolume,
} from '../../src/runtime/audio/audioService';
import { resolveAudioUrl } from '../../src/runtime/loaders/audioBufferCache';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

describe('resolveAudioSettings', () => {
  it('returns defaults for a missing/empty audio block', () => {
    expect(resolveAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(resolveAudioSettings({})).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('merges a partial block over the defaults', () => {
    const r = resolveAudioSettings({ audio: { loadType: 'stream', quality: 320 } });
    expect(r.loadType).toBe('stream');
    expect(r.quality).toBe(320);
    expect(r.format).toBe('mp3'); // untouched default
  });
});

describe('audio format mappings', () => {
  it('extension per format', () => {
    expect(audioFormatExtension('mp3')).toBe('mp3');
    expect(audioFormatExtension('aac')).toBe('m4a');
    expect(audioFormatExtension('opus')).toBe('opus');
    expect(audioFormatExtension('wav')).toBe('wav');
    expect(audioFormatExtension('flac')).toBe('flac');
  });

  it('mime per format', () => {
    expect(audioFormatMime('mp3')).toBe('audio/mpeg');
    expect(audioFormatMime('aac')).toBe('audio/mp4');
  });

  it('variant suffix', () => {
    expect(audioVariantSuffix('mp3')).toBe('~audio.mp3');
    expect(audioVariantSuffix('aac')).toBe('~audio.m4a');
  });

  it('lossless formats report not-lossy', () => {
    expect(audioFormatIsLossy('mp3')).toBe(true);
    expect(audioFormatIsLossy('wav')).toBe(false);
    expect(audioFormatIsLossy('flac')).toBe(false);
  });
});

describe('setBusVolume (record mode)', () => {
  beforeEach(() => {
    setAudioRecordMode(true);
    setBusVolume('master', 1); // isolate: reset the shared bus state
    clearAudioLog();
  });

  it('logs the bus + target volume headlessly (no AudioContext)', () => {
    setBusVolume('music', 0.5);
    expect(getAudioLog()).toContainEqual({ op: 'setBusVolume', bus: 'music', volume: 0.5 });
  });
});

describe('resolveAudioUrl — converted variant vs source', () => {
  afterEach(() => clearManifest());

  it('returns the source URL for an unconverted clip', () => {
    const guid = newGuid();
    registerAsset(guid, '/games/x/assets/audio/plain.mp3', 'audio', undefined, {
      audio: { loadType: 'buffer' },
    });
    expect(resolveAudioUrl(guid)).toBe('/games/x/assets/audio/plain.mp3');
  });

  it('returns the ~audio.<ext> variant when converted (cache-bust is prod-only)', () => {
    const guid = newGuid();
    registerAsset(guid, '/games/x/assets/audio/music.mp3', 'audio', undefined, {
      audio: { loadType: 'stream', format: 'mp3', ext: 'mp3' },
    }, 'deadbeefdeadbeef');
    // vitest runs with import.meta.env.PROD=false ⇒ withCacheBust omits ?v=.
    expect(resolveAudioUrl(guid)).toBe('/games/x/assets/audio/music.mp3~audio.mp3');
  });
});
