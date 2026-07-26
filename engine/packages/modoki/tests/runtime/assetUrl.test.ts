/** assetUrl — prefixing a root-absolute asset path with Vite's BASE_URL for
 *  sub-path web hosting (e.g. a demo published at "/postfx-demo/").
 *
 *  Regression: a production build invoked without a trailing slash on its base
 *  path (BASE_PATH=/demo, not /demo/) yields import.meta.env.BASE_URL "/demo".
 *  Joining that directly against a root-absolute path used to glue the two
 *  segments with no separator ("/demo" + "assets.json" → "/demoassets.json"),
 *  a silent 404 that fails the asset-manifest fetch and drops every GUID
 *  lookup at once — the postfx-demo black-screen bug (all meshes "unknown
 *  guid"), traced live against https://modoki-engine.com/postfx-demo/. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { assetUrl } from '../../src/runtime/loaders/assetUrl';

describe('assetUrl — BASE_URL prefixing', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is a no-op when BASE_URL is "/" (dev + native)', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(assetUrl('/assets.manifest.json')).toBe('/assets.manifest.json');
  });

  it('prefixes with a trailing-slash base', () => {
    vi.stubEnv('BASE_URL', '/postfx-demo/');
    expect(assetUrl('/assets.manifest.json')).toBe('/postfx-demo/assets.manifest.json');
  });

  it('prefixes correctly even when the base has NO trailing slash', () => {
    vi.stubEnv('BASE_URL', '/postfx-demo');
    expect(assetUrl('/assets.manifest.json')).toBe('/postfx-demo/assets.manifest.json');
  });

  it('is idempotent — a path already under the base is not double-prefixed', () => {
    vi.stubEnv('BASE_URL', '/postfx-demo/');
    expect(assetUrl('/postfx-demo/assets/foo.glb')).toBe('/postfx-demo/assets/foo.glb');
  });

  it('leaves relative/http/data/blob paths untouched', () => {
    vi.stubEnv('BASE_URL', '/postfx-demo/');
    expect(assetUrl('assets/foo.glb')).toBe('assets/foo.glb');
    expect(assetUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(assetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });
});
