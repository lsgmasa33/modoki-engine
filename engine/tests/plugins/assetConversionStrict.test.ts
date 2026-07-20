/** Strict asset-conversion gate — a build fails when any texture/model fell back
 *  to raw source, unless explicitly allowed. Guards against a misconfigured
 *  environment (missing toktx/gltf-transform/gltfpack) silently shipping
 *  unoptimized assets with a green build. */

import { describe, it, expect } from 'vitest';
import { assertNoConversionFallback, type ConversionFailure } from '../../plugins/asset-conversion-strict';

const fail = (virtualPath: string, kind: ConversionFailure['kind'], error = 'toktx not found'): ConversionFailure =>
  ({ virtualPath, kind, error });

describe('assertNoConversionFallback', () => {
  it('does not throw when there are no failures', () => {
    expect(() => assertNoConversionFallback([], { allowFallback: false })).not.toThrow();
  });

  it('throws by default when any asset fell back to raw source', () => {
    expect(() => assertNoConversionFallback([fail('/assets/t/x.png', 'texture')], { allowFallback: false }))
      .toThrow(/could not be processed and fell back to raw source/);
  });

  it('aggregates every failure (all paths + kinds) into one error', () => {
    const failures = [
      fail('/assets/t/a.png', 'texture'),
      fail('/assets/m/b.glb', 'model', 'gltfpack missing'),
      fail('/assets/m/c.glb', 'rigged model', 'gltf-transform missing'),
    ];
    try {
      assertNoConversionFallback(failures, { allowFallback: false });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('3 asset(s)');
      expect(msg).toContain('/assets/t/a.png');
      expect(msg).toContain('/assets/m/b.glb');
      expect(msg).toContain('/assets/m/c.glb');
      expect(msg).toContain('gltfpack missing');
      // Points the user at the escape hatch + the encoders to install.
      expect(msg).toContain('MODOKI_ALLOW_ASSET_FALLBACK=1');
      expect(msg).toContain('toktx');
    }
  });

  it('does NOT throw when the fallback is explicitly allowed (opt-out)', () => {
    expect(() => assertNoConversionFallback([fail('/assets/t/x.png', 'texture')], { allowFallback: true }))
      .not.toThrow();
  });
});
