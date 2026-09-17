/** ktx2LoaderAssetStrip (#1340) — three r185's KTX2Loader emits a hashed Basis transcoder pair via
 *  `new URL(…, import.meta.url)`; the plugin blanks those defaults, and refuses a shape it does not
 *  recognise rather than silently letting the emission back in. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { isKtx2LoaderId, stripKtx2LoaderAssetUrls } from '../../plugins/ktx2LoaderAssetStrip';

const require = createRequire(import.meta.url);

describe('ktx2LoaderAssetStrip', () => {
  it('blanks both transcoder URL defaults in the INSTALLED three KTX2Loader', () => {
    const src = fs.readFileSync(require.resolve('three/examples/jsm/loaders/KTX2Loader.js'), 'utf8');
    const out = stripKtx2LoaderAssetUrls(src);
    // The installed three is the one the build bundles; if it has no defaults the plugin has
    // nothing to do, and that is fine — but then the source must not mention import.meta.url.
    if (out === null) {
      expect(src).not.toContain('import.meta.url');
      return;
    }
    expect(out).not.toContain('import.meta.url');
    expect(out).toContain("const WASM_BIN_URL = '';");
    expect(out).toContain("const WASM_JS_URL = '';");
  });

  it('rewrites the r185 shape', () => {
    const src = [
      "const WASM_BIN_URL = new URL( '../libs/basis/basis_transcoder.wasm', import.meta.url ).toString();",
      "const WASM_JS_URL = new URL( '../libs/basis/basis_transcoder.js', import.meta.url ).toString();",
    ].join('\n');
    expect(stripKtx2LoaderAssetUrls(src)).toBe("const WASM_BIN_URL = '';\nconst WASM_JS_URL = '';");
  });

  it('refuses a source whose import.meta.url survives the rewrite', () => {
    const changed = "const WASM_JS_URL = new URL( '../libs/basis/transcoder.js', import.meta.url ).href;";
    expect(() => stripKtx2LoaderAssetUrls(changed)).toThrow(/still references `import.meta.url`/);
  });

  it('leaves a source with nothing to rewrite alone', () => {
    expect(stripKtx2LoaderAssetUrls('export class KTX2Loader {}')).toBeNull();
  });

  it('matches only three\'s KTX2Loader module id', () => {
    expect(isKtx2LoaderId('/r/node_modules/three/examples/jsm/loaders/KTX2Loader.js')).toBe(true);
    expect(isKtx2LoaderId('C:\\r\\node_modules\\three\\examples\\jsm\\loaders\\KTX2Loader.js?v=1')).toBe(true);
    expect(isKtx2LoaderId('/r/node_modules/three/examples/jsm/loaders/GLTFLoader.js')).toBe(false);
    expect(isKtx2LoaderId('/r/engine/packages/modoki/src/runtime/loaders/KTX2Loader.js')).toBe(false);
  });
});
