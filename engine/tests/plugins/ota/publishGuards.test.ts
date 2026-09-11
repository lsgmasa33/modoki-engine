/** Unit tests for engine/scripts/ota/publishGuards.mjs's `otaBundleDistKindRefusal` — the
 *  CLI's dist-KIND guard (#582). `otaSigningKeyRefusal`'s own behaviour is already covered by
 *  `viteAssetScanner.test.ts`'s `describe('otaSigningKeyRefusal ...')` (it re-exports the same
 *  function from this module, see vite-asset-scanner.ts), so it isn't duplicated here. */
import { describe, it, expect } from 'vitest';
import { OTA_DEFAULT_BUNDLE_NAME, OTA_DEFAULT_ENGINE_API, otaBundleDistKindRefusal, otaSubgameEngineApi } from '../../../scripts/ota/publishGuards.mjs';
import { DEFAULT_PROJECT_CONFIG } from '../../../project-config';

describe('otaSubgameEngineApi (ota-publish.mjs sub-game engine-API guard, #837)', () => {
  it('publishes the value the build stamped when it equals the shell\'s and no flag is given', () => {
    expect(otaSubgameEngineApi({ stamped: 2, requested: undefined, shellEngineApi: 2 })).toEqual({ engineApi: 2 });
  });

  it('accepts a flag that agrees with the stamped value', () => {
    expect(otaSubgameEngineApi({ stamped: 2, requested: 2, shellEngineApi: 2 })).toEqual({ engineApi: 2 });
  });

  it('refuses a flag that disagrees with what the build stamped — the manifest would contradict its own module', () => {
    expect(otaSubgameEngineApi({ stamped: 1, requested: 2, shellEngineApi: 1 })).toEqual({ refusal: 'flag-mismatch' });
  });

  it('refuses a stamped value that differs from the shell\'s ota.engineApi — every device would refuse the bundle', () => {
    expect(otaSubgameEngineApi({ stamped: 2, requested: undefined, shellEngineApi: 1 })).toEqual({ refusal: 'shell-mismatch' });
    expect(otaSubgameEngineApi({ stamped: 2, requested: 2, shellEngineApi: 1 })).toEqual({ refusal: 'shell-mismatch' });
  });

  it('refuses a missing or malformed stamped value, before comparing anything', () => {
    for (const stamped of [undefined, null, 0, -1, 1.5, '1']) {
      expect(otaSubgameEngineApi({ stamped, requested: undefined, shellEngineApi: 1 }), JSON.stringify(stamped))
        .toEqual({ refusal: 'stamped-invalid' });
    }
  });
});

describe('OTA_DEFAULT_ENGINE_API', () => {
  // The engine-API twin of OTA_DEFAULT_BUNDLE_NAME below: ota-publish.mjs resolves an ABSENT shell
  // ota.engineApi to this, so a drift would compare a sub-game against the wrong shell value.
  it('matches DEFAULT_PROJECT_CONFIG.ota.engineApi', () => {
    expect(OTA_DEFAULT_ENGINE_API).toBe(DEFAULT_PROJECT_CONFIG.ota.engineApi);
  });
});

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
