// @vitest-environment jsdom
/** Pure logic behind MaterialOverridesField (the Inspector editor for
 *  MaterialInstance.overrides). Four exported helpers carry real weight:
 *
 *   - partitionParams: splits a shader's param schema into scalar `uniforms` (drivable
 *     by a `uniform` override) and `textures` (extra-sampler params, swappable by a
 *     `texture` override) — this feeds the per-row suggestion chips + the `is2D` gate.
 *   - kindOptionsForRow: the `kind` dropdown options for ONE row. The load-bearing case
 *     is the desync guard — a `texture` row on a material later swapped to 3D must KEEP
 *     `texture` selectable, or the controlled <select> shows a wrong kind vs. the data.
 *   - defaultSource: builds the seed source object for a chosen source `type`.
 *   - num: a typed-number fallback coercer.
 *  All are exported in place — the panel imports cleanly in the jsdom test env. */

import { describe, it, expect } from 'vitest';
import {
  partitionParams,
  kindOptionsForRow,
  defaultSource,
  num,
} from '../../src/editor/panels/MaterialOverridesField';

describe('partitionParams', () => {
  it('splits texture params from scalar/uniform params', () => {
    const { uniforms, textures } = partitionParams({
      uMix: { type: 'float' },
      uTint: { type: 'vec3' },
      uReveal: { type: 'texture' },
      uMask: { type: 'texture' },
    });
    expect(uniforms).toEqual(['uMix', 'uTint']);
    expect(textures).toEqual(['uReveal', 'uMask']);
  });

  it('treats a param with no declared type as a uniform (non-texture)', () => {
    const { uniforms, textures } = partitionParams({ uFoo: {} });
    expect(uniforms).toEqual(['uFoo']);
    expect(textures).toEqual([]);
  });

  it('returns empty arrays for an empty schema', () => {
    expect(partitionParams({})).toEqual({ uniforms: [], textures: [] });
  });
});

describe('kindOptionsForRow', () => {
  it('offers texture only on a 2D custom material', () => {
    expect(kindOptionsForRow('uniform', true)).toEqual(['uniform', 'prop', 'texture']);
    expect(kindOptionsForRow('uniform', false)).toEqual(['uniform', 'prop']);
  });

  it('KEEPS texture selectable for a texture row even when the material is now 3D (is2D=false)', () => {
    // Desync guard: the entity's material was swapped to a 3D one after a texture override
    // was authored. The row is still kind:'texture'; the dropdown must include it so the
    // controlled <select value="texture"> reflects reality instead of a wrong option.
    expect(kindOptionsForRow('texture', false)).toContain('texture');
    expect(kindOptionsForRow('texture', false)).toEqual(['uniform', 'prop', 'texture']);
  });

  it('does not duplicate texture when the row is texture and the material is 2D', () => {
    const opts = kindOptionsForRow('texture', true);
    expect(opts).toEqual(['uniform', 'prop', 'texture']);
    expect(opts.filter((o) => o === 'texture')).toHaveLength(1);
  });
});

describe('defaultSource', () => {
  it('builds a bare time source', () => {
    expect(defaultSource('time')).toEqual({ type: 'time' });
  });
  it('builds a store source with an empty key', () => {
    expect(defaultSource('store')).toEqual({ type: 'store', key: '' });
  });
  it('builds a curve source with default points + time driver', () => {
    expect(defaultSource('curve')).toEqual({
      type: 'curve',
      points: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
      driver: { type: 'time', wrap: 1 },
    });
  });
  it('falls back to a zero constant for "constant" and any unknown type', () => {
    expect(defaultSource('constant')).toEqual({ type: 'constant', value: 0 });
    expect(defaultSource('anything-unknown')).toEqual({ type: 'constant', value: 0 });
  });
});

describe('num', () => {
  it('returns a number value unchanged', () => {
    expect(num(2.5, 1)).toBe(2.5);
  });
  it('falls back for undefined', () => {
    expect(num(undefined, 1)).toBe(1);
  });
  it('falls back for a numeric STRING (not typeof number)', () => {
    expect(num('3', 10)).toBe(10);
  });
  it('falls back for null', () => {
    expect(num(null, 0)).toBe(0);
  });
});
