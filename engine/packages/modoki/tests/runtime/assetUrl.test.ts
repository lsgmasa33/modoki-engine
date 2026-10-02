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
import { loadManifestJson, resolveRef, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { decodeAssetUrlPath, registerSubgameAssetBase } from '../../src/runtime/core/assetUrlPath';
import { cssUrl } from '../../src/runtime/core/assetUrlPath';
import { bootScenePath } from '../../src/runtime/core/config';

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

/** #1979: `assetUrl` is the ONE path → URL crossing, and `serveProjectAsset` the one URL → path
 *  crossing (`decodeAssetUrlPath`). An asset path is spelled as the file is named on disk, so
 *  `50%.png` and a literal `my%20tex.png` are ordinary names that must round-trip. */
describe('assetUrl — percent-encodes what a URL path cannot carry (#1979)', () => {
  afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as { __PLAYABLE_ASSETS__?: unknown }).__PLAYABLE_ASSETS__; });

  it('encodes %, ? and # — and nothing else, so an ordinary name\'s URL is unchanged', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(assetUrl('/assets/100%.png')).toBe('/assets/100%25.png');
    expect(assetUrl('/assets/my%20tex.png')).toBe('/assets/my%2520tex.png');
    expect(assetUrl('/assets/a?b#c.png')).toBe('/assets/a%3Fb%23c.png');
    expect(assetUrl('/assets/my tex.png')).toBe('/assets/my tex.png');
    expect(assetUrl('/assets/日本.png')).toBe('/assets/日本.png');
  });

  it('round-trips every name through the browser\'s URL parser and the server\'s one decode', () => {
    vi.stubEnv('BASE_URL', '/');
    for (const p of ['/assets/50%.png', '/assets/my%20tex.png', '/assets/my tex.png', '/assets/a#b.png',
      '/assets/q?.png', '/assets/100%25.png', '/assets/日本 語.png', '/assets/plain.png']) {
      // What the browser actually puts on the wire, then what the server decodes it to.
      const wire = new URL(assetUrl(p), 'http://localhost').pathname;
      expect(decodeAssetUrlPath(wire), p).toBe(p);
    }
  });

  it('looks the playable-inline map up by the RAW path, before encoding', () => {
    (globalThis as { __PLAYABLE_ASSETS__?: Record<string, string> }).__PLAYABLE_ASSETS__ = { '/assets/50%.png': 'blob:x' };
    expect(assetUrl('/assets/50%.png')).toBe('blob:x');
  });

  it('still prefixes BASE_URL after encoding', () => {
    vi.stubEnv('BASE_URL', '/demo/');
    expect(assetUrl('/assets/50%.png')).toBe('/demo/assets/50%25.png');
  });
});

describe('cssUrl — a quoted, escaped CSS url() (#1979)', () => {
  it('quotes, so a space or a parenthesis in the name stays one url() value', () => {
    expect(cssUrl('/assets/my tex (1).png')).toBe('url("/assets/my tex (1).png")');
  });
  it('escapes an embedded quote and backslash', () => {
    expect(cssUrl('/assets/a"b\\c.png')).toBe('url("/assets/a\\"b\\\\c.png")');
  });
});

describe('bootScenePath — config.scenePath is a `?url` URL, read as a PATH (#1979)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('decodes once: a space, a non-ASCII name, a literal %, and a /@fs project path with a space', () => {
    expect(bootScenePath({ scenePath: '/assets/scenes/level%201.scene.json' })).toBe('/assets/scenes/level 1.scene.json');
    expect(bootScenePath({ scenePath: encodeURI('/assets/scenes/ステージ.scene.json') })).toBe('/assets/scenes/ステージ.scene.json');
    expect(bootScenePath({ scenePath: '/assets/scenes/50%25.scene.json' })).toBe('/assets/scenes/50%.scene.json');
    expect(bootScenePath({ scenePath: '/@fs/Users/x/My%20Games/runtime/assets/scenes/a.scene.json' }))
      .toBe('/@fs/Users/x/My Games/runtime/assets/scenes/a.scene.json');
    expect(bootScenePath({ scenePath: undefined })).toBeUndefined();
  });

  it('round-trips: Vite\'s `?url` (encodeURI) → bootScenePath → assetUrl → the wire → the server\'s one decode', () => {
    vi.stubEnv('BASE_URL', '/');
    for (const onDisk of ['/assets/scenes/level 1.scene.json', '/assets/scenes/50%.scene.json', '/assets/scenes/ステージ.scene.json']) {
      const viteUrl = encodeURI(onDisk); // what Vite 8's `?url` emits (encodeURIPath)
      const wire = new URL(assetUrl(bootScenePath({ scenePath: viteUrl })!), 'http://localhost').pathname;
      expect(decodeAssetUrlPath(wire), onDisk).toBe(onDisk);
    }
  });
});

/** #2051: an OTA sub-game's asset path is its staged bundle's URL base + a root-absolute path. The
 *  base is a URL, the rest a PATH, and only the rest is encoded — by `assetUrl`, past a base the
 *  manifest merge registered. The native handler decodes the request path once, like the dev server. */
describe('an OTA sub-game base: a URL prefix assetUrl encodes past (#2051)', () => {
  const BASE = 'capacitor://localhost/_capacitor_file_/var/mobile/Library/NoCloud/ota/sub-a';
  const onWireToDisk = (url: string) => decodeAssetUrlPath(new URL(url).pathname)!;
  afterEach(() => { vi.unstubAllEnvs(); clearManifest(); });

  it('encodes the path after a registered base, and nothing before it', () => {
    vi.stubEnv('BASE_URL', '/');
    registerSubgameAssetBase(BASE + '/');
    expect(assetUrl(BASE + '/assets/50%.png')).toBe(BASE + '/assets/50%25.png');
    expect(assetUrl(BASE + '/assets/a?b#c.png')).toBe(BASE + '/assets/a%3Fb%23c.png');
    expect(assetUrl(BASE + '/assets/my tex.png')).toBe(BASE + '/assets/my tex.png');
    for (const p of ['/assets/50%.png', '/assets/my%20tex.png', '/assets/a#b.png', '/assets/日本 語.png']) {
      expect(onWireToDisk(assetUrl(BASE + p)).endsWith('/sub-a' + p), p).toBe(true);
    }
  });

  it('KEEP SIDE: a full URL under no registered base passes through, a sibling bundle included', () => {
    vi.stubEnv('BASE_URL', '/');
    registerSubgameAssetBase(BASE);
    expect(assetUrl('https://example.com/a%20b.png')).toBe('https://example.com/a%20b.png');
    expect(assetUrl(BASE + '-2/assets/50%.png')).toBe(BASE + '-2/assets/50%.png');
  });

  it('the manifest merge registers its pathPrefix: a sub-game GUID resolves to a PATH that assetUrl encodes', () => {
    vi.stubEnv('BASE_URL', '/');
    const guid = '5a1e0c4e-6a43-4d7e-9a35-2f7d8c1e9a01';
    loadManifestJson({ version: 2, assets: [{ guid, path: '/assets/50%.png', type: 'texture' }] } as never, { pathPrefix: BASE });
    const path = resolveRef(guid);
    expect(path, 'the identity stays decoded, as the shell spells its own').toBe(BASE + '/assets/50%.png');
    expect(assetUrl(path!)).toBe(BASE + '/assets/50%25.png');
    clearManifest();
    expect(assetUrl(BASE + '/assets/50%.png'), 'clearManifest forgets the base with its entries').toBe(BASE + '/assets/50%.png');
  });

  it('bootScenePath decodes the `?url` value, THEN prefixes assetBaseUrl — spelled like the manifest spells it', () => {
    vi.stubEnv('BASE_URL', '/');
    registerSubgameAssetBase(BASE);
    for (const onDisk of ['/assets/level 1.scene.json', '/assets/50%.scene.json', '/assets/ステージ.scene.json']) {
      const scene = bootScenePath({ scenePath: encodeURI(onDisk), assetBaseUrl: BASE });
      expect(scene).toBe(BASE + onDisk);
      expect(onWireToDisk(assetUrl(scene!)).endsWith('/sub-a' + onDisk), onDisk).toBe(true);
    }
    expect(bootScenePath({ scenePath: '/assets/a.scene.json', assetBaseUrl: BASE + '/' })).toBe(BASE + '/assets/a.scene.json');
    expect(bootScenePath({ scenePath: 'https://cdn/x.scene.json', assetBaseUrl: BASE }), 'only a root-absolute path is the bundle\'s').toBe('https://cdn/x.scene.json');
  });
});
