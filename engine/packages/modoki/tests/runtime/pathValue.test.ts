/** getPath / setPath — dotted-path access for nested animation-track fields
 *  (e.g. a MaterialInstance override's `overrides.0.source.value`). setPath must be
 *  IMMUTABLE: a fresh top-level reference, clones along the path, siblings preserved. */

import { describe, it, expect } from 'vitest';
import { getPath, setPath } from '../../src/runtime/animation/pathValue';

describe('getPath', () => {
  it('reads a nested object + array path', () => {
    const o = { overrides: [{ target: 'opacity', source: { type: 'constant', value: 0.5 } }] };
    expect(getPath(o, 'overrides.0.source.value')).toBe(0.5);
    expect(getPath(o, 'overrides.0.target')).toBe('opacity');
  });
  it('returns undefined for a missing segment', () => {
    expect(getPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getPath({ overrides: [] }, 'overrides.3.source.value')).toBeUndefined();
    expect(getPath(null, 'a.b')).toBeUndefined();
  });
});

describe('setPath (immutable)', () => {
  it('writes a nested value and clones along the path only', () => {
    const o = {
      overrides: [
        { target: 'opacity', source: { type: 'constant', value: 0.5 } },
        { target: 'glow', source: { type: 'time' } },
      ],
      other: { keep: 1 },
    };
    const next = setPath(o, 'overrides.0.source.value', 0.9);

    expect(next).not.toBe(o);                          // fresh top-level
    expect(next.overrides).not.toBe(o.overrides);      // array cloned
    expect(next.overrides[0]).not.toBe(o.overrides[0]);// touched element cloned
    expect(next.overrides[0].source).not.toBe(o.overrides[0].source);
    expect((next.overrides[0].source as { value: number }).value).toBe(0.9);

    // Untouched siblings preserved BY REFERENCE.
    expect(next.overrides[1]).toBe(o.overrides[1]);
    expect(next.other).toBe(o.other);
    // Original is untouched.
    expect((o.overrides[0].source as { value: number }).value).toBe(0.5);
  });

  it('writes a flat field (single segment)', () => {
    const o = { rx: 0, ry: 1 };
    const next = setPath(o, 'rx', 5);
    expect(next).not.toBe(o);
    expect(next.rx).toBe(5);
    expect(next.ry).toBe(1);
    expect(o.rx).toBe(0);
  });

  it('creates missing intermediate objects', () => {
    const next = setPath({} as Record<string, unknown>, 'a.b.c', 7);
    expect(getPath(next, 'a.b.c')).toBe(7);
  });

  it('drops the write on a stale/out-of-range array index (no sparse-array corruption)', () => {
    const o = { overrides: [{ source: { value: 1 } }, { source: { value: 2 } }] };
    // Index 5 no longer exists (array shrank) → return unchanged, no phantom entry / hole.
    const next = setPath(o, 'overrides.5.source.value', 9);
    expect(next.overrides).toHaveLength(2);
    expect(next.overrides).toEqual(o.overrides);
    // Negative / non-integer indices likewise no-op.
    expect(setPath(o, 'overrides.-1.x', 1).overrides).toHaveLength(2);
  });
});
