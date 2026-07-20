/** Environment (HDR) content-cache tests — hash stability + settings sensitivity +
 *  the cache-path scheme. Mirrors textureCache/audioCache. */

import { describe, it, expect } from 'vitest';
import { envHashKey, envCachePathFor, getEnvCacheDir } from '../../plugins/env-cache';
import { DEFAULT_ENV_SETTINGS } from '../../packages/modoki/src/runtime/loaders/environmentSettings';

const bytes = Buffer.from('fake-hdr-source-bytes');
const S = DEFAULT_ENV_SETTINGS;

describe('envHashKey', () => {
  it('is stable for identical bytes + settings, 16 hex chars', () => {
    expect(envHashKey(bytes, S)).toBe(envHashKey(bytes, S));
    expect(envHashKey(bytes, S)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes when maxSize changes (re-encodes the variant)', () => {
    expect(envHashKey(bytes, { ...S, maxSize: 512 })).not.toBe(envHashKey(bytes, S));
  });
  it('changes when the source bytes change', () => {
    expect(envHashKey(Buffer.from('other'), S)).not.toBe(envHashKey(bytes, S));
  });
});

describe('envCachePathFor', () => {
  it('lays out <cacheDir>/<urlPath>/<hash>/env.hdr', () => {
    const dir = getEnvCacheDir('/proj');
    // Normalize separators — filesystem path (path.join), backslash-delimited on Windows.
    expect(envCachePathFor(dir, '/games/x/assets/env/studio.hdr', 'abcd1234abcd1234').replace(/\\/g, '/'))
      .toBe('/proj/.cache/modoki-env/games/x/assets/env/studio.hdr/abcd1234abcd1234/env.hdr');
  });
});
