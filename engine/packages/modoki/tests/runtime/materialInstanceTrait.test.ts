/** MaterialInstance trait helpers — pure-function coverage of hasPropOverride /
 *  isMaterialInstanced. These are the predicates scene3DSync uses to give a
 *  MaterialInstance clone precedence over Tint and to suppress syncMaterial's per-frame
 *  base rebind. No world, no renderer — the entity is a minimal fake with has()/get(),
 *  matching how isMaterialInstanced reads (loosely typed to dodge a koota import cycle). */

import { describe, it, expect } from 'vitest';
import {
  MaterialInstance,
  hasPropOverride,
  isMaterialInstanced,
  type MaterialParamOverride,
} from '../../src/runtime/traits/MaterialInstance';

/** A minimal entity handle exposing only what isMaterialInstanced calls: has() + get(). When
 *  `mi` is undefined the entity has no MaterialInstance (has → false). */
function fakeEntity(mi: { overrides: MaterialParamOverride[] } | undefined) {
  return {
    has: (t: typeof MaterialInstance) => t === MaterialInstance && mi !== undefined,
    get: (t: typeof MaterialInstance) => (t === MaterialInstance ? mi : undefined),
  };
}

const uniform = (target: string): MaterialParamOverride => ({ target, kind: 'uniform', source: { type: 'constant', value: 1 } });
const prop = (target: string): MaterialParamOverride => ({ target, kind: 'prop', source: { type: 'constant', value: 1 } });

describe('hasPropOverride', () => {
  it('is false for an empty overrides array', () => {
    expect(hasPropOverride({ overrides: [] })).toBe(false);
  });

  it('is false for uniform-only overrides', () => {
    expect(hasPropOverride({ overrides: [uniform('glow'), uniform('t')] })).toBe(false);
  });

  it('is true when any override is a prop', () => {
    expect(hasPropOverride({ overrides: [prop('opacity')] })).toBe(true);
  });

  it('is true for a mixed uniform + prop set', () => {
    expect(hasPropOverride({ overrides: [uniform('glow'), prop('opacity')] })).toBe(true);
  });
});

describe('isMaterialInstanced', () => {
  it('is false when the entity has no MaterialInstance trait', () => {
    expect(isMaterialInstanced(fakeEntity(undefined))).toBe(false);
  });

  it('is false when overrides are empty', () => {
    expect(isMaterialInstanced(fakeEntity({ overrides: [] }))).toBe(false);
  });

  it('is false for uniform-only overrides (no clone needed)', () => {
    expect(isMaterialInstanced(fakeEntity({ overrides: [uniform('glow')] }))).toBe(false);
  });

  it('is true for a prop override (drives a per-entity clone)', () => {
    expect(isMaterialInstanced(fakeEntity({ overrides: [prop('opacity')] }))).toBe(true);
  });

  it('is true for a mixed uniform + prop set', () => {
    expect(isMaterialInstanced(fakeEntity({ overrides: [uniform('glow'), prop('opacity')] }))).toBe(true);
  });
});
