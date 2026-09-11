/** resolveCreateEntitySpec — the ONE vocabulary check both create-entity ops share (#1070). It
 *  returns the refusal as DATA (each op adapts it to its own transport), applies the per-kind
 *  defaults, and never mutates the caller's payload. The op-level tests prove each op ADAPTS it;
 *  these prove what it decides. */

import { describe, it, expect } from 'vitest';
import { resolveCreateEntitySpec } from '../../src/runtime/scene/createEntitySpec';
import { buildEntityCreateSpecs, CREATE_ENTITY_KINDS, LIGHT_KINDS } from '../../src/runtime/scene/entityCreateSpecs';
import { UI_PRESET_NAMES } from '../../src/runtime/ui/uiAuthoring';
import { PRIMITIVE_NAMES } from '../../src/runtime/loaders/primitives';
import { PRIMITIVE_SPRITE_NAMES } from '../../src/runtime/loaders/sceneValidation';

const refusal = (raw: object) => {
  const r = resolveCreateEntitySpec(raw);
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}, got ${JSON.stringify(r.spec)}`);
  return r;
};
const accepted = (raw: object) => {
  const r = resolveCreateEntitySpec(raw);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(raw)} to be accepted, got: ${r.error}`);
  return r.spec as unknown as Record<string, unknown>;
};

describe('unknown vocabulary is refused WITH the real options', () => {
  it.each([
    { raw: { kind: 'pyramid' }, noun: 'entity kind', options: CREATE_ENTITY_KINDS },
    { raw: { kind: 'primitive', mesh: 'pyramid' }, noun: 'primitive mesh', options: PRIMITIVE_NAMES },
    { raw: { kind: '2d', shape: 'star' }, noun: '2D shape', options: PRIMITIVE_SPRITE_NAMES },
    { raw: { kind: 'light', light: 'pont' }, noun: 'light kind', options: LIGHT_KINDS },
    { raw: { kind: 'ui', preset: 'buton' }, noun: 'UI preset', options: UI_PRESET_NAMES },
  ])('$noun', ({ raw, noun, options }) => {
    const r = refusal(raw);
    expect(r.error).toContain(`unknown ${noun}`);
    expect(r.error).toContain('nothing was created');
    expect(r.options).toEqual([...options]);
  });

  // #993's scar: the tables are plain objects, so an inherited key used to resolve to a FUNCTION.
  it.each([
    { kind: 'constructor' },
    { kind: 'light', light: 'constructor' },
    { kind: 'ui', preset: 'toString' },
  ])('a prototype key is not a member: %o', (raw) => {
    expect(resolveCreateEntitySpec(raw).ok).toBe(false);
  });

  it('a missing or non-string kind is refused, not thrown', () => {
    expect(refusal({}).options).toEqual([...CREATE_ENTITY_KINDS]);
    expect(refusal({ kind: 7 }).error).toContain('unknown entity kind 7');
  });

  it('a non-string vocabulary value is refused, not thrown', () => {
    expect(refusal({ kind: 'light', light: 5 }).error).toContain('unknown light kind 5');
  });

  it('the 2D refusal points at the sprite-GUID route', () => {
    expect(refusal({ kind: '2d', shape: 'star' }).error).toMatch(/Renderable2D\.sprite/);
  });
});

describe('the accept side — every real value passes', () => {
  it.each([
    ...PRIMITIVE_NAMES.map((mesh) => ({ kind: 'primitive', mesh })),
    ...PRIMITIVE_SPRITE_NAMES.map((shape) => ({ kind: '2d', shape })),
    ...LIGHT_KINDS.map((light) => ({ kind: 'light', light })),
    ...UI_PRESET_NAMES.map((preset) => ({ kind: 'ui', preset })),
    ...['empty', 'canvas2d', 'camera', 'environment', 'particle'].map((kind) => ({ kind })),
  ])('%o', (raw) => {
    expect(accepted(raw)).toEqual(raw);
  });
});

describe('defaults', () => {
  it.each([
    { kind: 'primitive', key: 'mesh', value: 'sphere' },
    { kind: '2d', key: 'shape', value: 'square' },
    { kind: 'light', key: 'light', value: 'point' },
    { kind: 'ui', key: 'preset', value: 'view' },
  ])('$kind with no $key defaults to $value', ({ kind, key, value }) => {
    expect(accepted({ kind })[key]).toBe(value);
  });

  it('does not mutate the caller\'s payload', () => {
    const raw = { kind: 'light' };
    accepted(raw);
    expect(raw).toEqual({ kind: 'light' });
  });
});

describe('buildEntityCreateSpecs backstop', () => {
  it('an unknown kind throws a message naming the kinds, instead of returning undefined', () => {
    expect(() => buildEntityCreateSpecs({ kind: 'pyramid' } as never, 0)).toThrow(/unknown entity kind "pyramid"[\s\S]*Valid: .*camera/);
  });
});
