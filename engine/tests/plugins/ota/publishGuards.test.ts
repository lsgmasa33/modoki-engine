/** Unit tests for engine/scripts/ota/publishGuards.mjs's `otaBundleDistKindRefusal` — the
 *  CLI's dist-KIND guard (#582). `otaSigningKeyRefusal`'s own behaviour is already covered by
 *  `viteAssetScanner.test.ts`'s `describe('otaSigningKeyRefusal ...')` (it re-exports the same
 *  function from this module, see vite-asset-scanner.ts), so it isn't duplicated here. */
import { describe, it, expect } from 'vitest';
import { OTA_DEFAULT_BUNDLE_NAME, otaBundleDistKindRefusal } from '../../../scripts/ota/publishGuards.mjs';
import { DEFAULT_PROJECT_CONFIG } from '../../../project-config';

describe('otaBundleDistKindRefusal (ota-publish.mjs dist-kind identity guard)', () => {
  it('allows a plain shell dist published under the project\'s own bundle name', () => {
    expect(otaBundleDistKindRefusal({ bundleName: 'shell', projectBundleName: 'shell', distIsSubgameModule: false })).toBeNull();
  });

  it('allows a sub-game module dist published under a DIFFERENT (sub-game) bundle name', () => {
    expect(otaBundleDistKindRefusal({ bundleName: 'subgame-x', projectBundleName: 'shell', distIsSubgameModule: true })).toBeNull();
  });

  it('refuses a plain shell dist published under a DIFFERENT (sub-game) bundle name', () => {
    // The bug otaPublishBundleNameAllowed exists to prevent, reached via a different route:
    // this would ship the project's own shell content under someone else's identity.
    expect(otaBundleDistKindRefusal({ bundleName: 'subgame-x', projectBundleName: 'shell', distIsSubgameModule: false }))
      .toBe('subgame-name-with-shell-dist');
  });

  it('refuses a sub-game module dist published under the project\'s own (shell) bundle name', () => {
    // Would replace the shell bundle with a module the OTA client cannot boot standalone.
    expect(otaBundleDistKindRefusal({ bundleName: 'shell', projectBundleName: 'shell', distIsSubgameModule: true }))
      .toBe('shell-name-with-subgame-dist');
  });
});

describe('OTA_DEFAULT_BUNDLE_NAME', () => {
  // A `.mjs` script can't import project-config.ts, so OTA_DEFAULT_BUNDLE_NAME is a
  // deliberate second authored copy of DEFAULT_PROJECT_CONFIG.ota.bundleName. This test is
  // what allows that copy to exist safely — if the two ever drift, ota-publish.mjs's and
  // ota-embed-manifest.mjs's "absent bundleName" resolution would silently disagree with what
  // Project Settings actually persists as the default.
  it('matches DEFAULT_PROJECT_CONFIG.ota.bundleName', () => {
    expect(OTA_DEFAULT_BUNDLE_NAME).toBe(DEFAULT_PROJECT_CONFIG.ota.bundleName);
  });
});
