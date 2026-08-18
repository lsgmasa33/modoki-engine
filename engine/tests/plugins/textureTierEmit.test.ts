/** #212 — per-tier texture LOD variants ship every size INSIDE the package, so the owner's call
 *  is to emit them only when the payload is delivered over the wire. This locks the predicate's
 *  decision table so a refactor can't silently flip which builds pay the +19% dist cost. */

import { describe, it, expect, afterEach } from 'vitest';
import { shouldEmitTextureTierVariants } from '../../plugins/textureTierEmit';

const ENV_KEYS = ['MODOKI_BUILD_TARGET', 'MODOKI_OTA_PUBLISH', 'MODOKI_PLAYABLE'] as const;

function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('shouldEmitTextureTierVariants', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("'auto': a web build emits", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'web' }, () => {
      expect(shouldEmitTextureTierVariants('auto')).toBe(true);
    });
  });

  it("'auto': a plain native build does NOT emit", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'native' }, () => {
      expect(shouldEmitTextureTierVariants('auto')).toBe(false);
    });
  });

  it("'auto': a native build that is an OTA publish DOES emit", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'native', MODOKI_OTA_PUBLISH: '1' }, () => {
      expect(shouldEmitTextureTierVariants('auto')).toBe(true);
    });
  });

  it("'auto': a playable build never emits, even flagged as web/OTA", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'web', MODOKI_OTA_PUBLISH: '1', MODOKI_PLAYABLE: '1' }, () => {
      expect(shouldEmitTextureTierVariants('auto')).toBe(false);
    });
  });

  it("'always': emits on a plain native build (the opt-in)", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'native' }, () => {
      expect(shouldEmitTextureTierVariants('always')).toBe(true);
    });
  });

  it("'always': still does NOT emit for a playable build", () => {
    withEnv({ MODOKI_PLAYABLE: '1' }, () => {
      expect(shouldEmitTextureTierVariants('always')).toBe(false);
    });
  });

  it("'never': does not emit even on web", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'web' }, () => {
      expect(shouldEmitTextureTierVariants('never')).toBe(false);
    });
  });

  it("'never': does not emit for an OTA publish either", () => {
    withEnv({ MODOKI_BUILD_TARGET: 'native', MODOKI_OTA_PUBLISH: '1' }, () => {
      expect(shouldEmitTextureTierVariants('never')).toBe(false);
    });
  });

  // Mutation check (brief #212): inverting either branch of the 'auto' OR should flip a case
  // above from true to false or vice versa — i.e. these two tests alone distinguish
  // `buildTarget === 'web' || otaPublish === '1'` from EITHER `&&`-ing them or dropping either
  // operand. Swapping `||` for `&&` fails "a web build emits" is untouched but "OTA publish
  // emits" (native, no web target) would go false — caught by the OTA-publish case above.
  // Dropping the OTA operand entirely (`buildTarget === 'web'` alone) is caught by the same case.
  it('mutation check: the auto branch really is an OR of two independent conditions', () => {
    withEnv({ MODOKI_BUILD_TARGET: 'native', MODOKI_OTA_PUBLISH: '1' }, () => {
      // OTA alone (no web target) must be sufficient.
      expect(shouldEmitTextureTierVariants('auto')).toBe(true);
    });
    withEnv({ MODOKI_BUILD_TARGET: 'web' }, () => {
      // web target alone (no OTA flag) must be sufficient.
      expect(shouldEmitTextureTierVariants('auto')).toBe(true);
    });
    withEnv({}, () => {
      // neither present must be insufficient.
      expect(shouldEmitTextureTierVariants('auto')).toBe(false);
    });
  });
});
