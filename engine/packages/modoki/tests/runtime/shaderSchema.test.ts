/** shaderSchema unit tests — param coercion + default merging. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coerceParamValue, mergeParamDefaults, fetchShaderManifest, type ShaderParamSchema } from '../../src/runtime/loaders/shaderSchema';

describe('coerceParamValue', () => {
  it('keeps a valid float, falls back to default otherwise', () => {
    expect(coerceParamValue({ type: 'float', default: 1.5 }, 2.5)).toBe(2.5);
    expect(coerceParamValue({ type: 'float', default: 1.5 }, undefined)).toBe(1.5);
    expect(coerceParamValue({ type: 'float', default: 1.5 }, 'nope')).toBe(1.5);
  });

  it('keeps a valid color hex, falls back to default otherwise', () => {
    expect(coerceParamValue({ type: 'color', default: 0xffffff }, 0x00ff00)).toBe(0x00ff00);
    expect(coerceParamValue({ type: 'color', default: 0xffffff }, undefined)).toBe(0xffffff);
  });

  it('coerces bool', () => {
    expect(coerceParamValue({ type: 'bool', default: false }, true)).toBe(true);
    expect(coerceParamValue({ type: 'bool', default: true }, undefined)).toBe(true);
    expect(coerceParamValue({ type: 'bool', default: false }, 'x')).toBe(false);
  });

  it('passes through a texture ref string, falls back to default/empty', () => {
    expect(coerceParamValue({ type: 'texture', default: '' }, 'guid-abc')).toBe('guid-abc');
    expect(coerceParamValue({ type: 'texture', default: '/fallback.png' }, undefined)).toBe('/fallback.png');
    expect(coerceParamValue({ type: 'texture', default: 123 as unknown as string }, 456)).toBe('');
  });

  it('keeps a matching-length vector, else default, else zeros', () => {
    expect(coerceParamValue({ type: 'vec3', default: [1, 2, 3] }, [4, 5, 6])).toEqual([4, 5, 6]);
    expect(coerceParamValue({ type: 'vec3', default: [1, 2, 3] }, [4, 5])).toEqual([1, 2, 3]);
    expect(coerceParamValue({ type: 'vec2', default: undefined }, undefined)).toEqual([0, 0]);
  });
});

describe('mergeParamDefaults', () => {
  const schema: ShaderParamSchema = {
    rimColor: { type: 'color', default: 0x00ffff },
    power: { type: 'float', default: 2.5 },
    glow: { type: 'bool', default: false },
  };

  it('fills missing keys with defaults and keeps provided values', () => {
    const merged = mergeParamDefaults(schema, { power: 5 });
    expect(merged).toEqual({ rimColor: 0x00ffff, power: 5, glow: false });
  });

  it('drops keys the schema no longer declares', () => {
    const merged = mergeParamDefaults(schema, { power: 5, stale: 99 });
    expect(merged).not.toHaveProperty('stale');
  });

  it('handles undefined values object', () => {
    const merged = mergeParamDefaults(schema, undefined);
    expect(merged).toEqual({ rimColor: 0x00ffff, power: 2.5, glow: false });
  });
});

describe('fetchShaderManifest — param-type validation (F10)', () => {
  const okJson = (body: unknown) => ({ ok: true, json: async () => body });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); vi.restoreAllMocks(); });

  it('warns on an unknown/typo param type but still loads the manifest', async () => {
    global.fetch = vi.fn(async () => okJson({ params: { tint: { type: 'flot', default: 0xffffff } } })) as never;
    const m = await fetchShaderManifest('/shaders/x.shader.json');
    expect(m).not.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("param 'tint'") && String(c[0]).includes('flot'))).toBe(true);
  });

  it('does not warn when every param type is valid', async () => {
    global.fetch = vi.fn(async () => okJson({ params: {
      a: { type: 'float', default: 1 }, b: { type: 'color', default: 0xffffff }, c: { type: 'vec3', default: [0, 0, 0] },
    } })) as never;
    await fetchShaderManifest('/shaders/y.shader.json');
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults missing params to {} and returns null on a failed fetch', async () => {
    global.fetch = vi.fn(async () => okJson({})) as never;
    expect((await fetchShaderManifest('/shaders/z.shader.json'))?.params).toEqual({});
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as never;
    expect(await fetchShaderManifest('/shaders/bad.shader.json')).toBeNull();
  });
});
