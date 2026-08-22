/** shaderCatalog unit tests — option building + schema resolution. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listShaderOptions, optionValueForMaterial, materialFieldsForOption, resolveShaderSchema,
} from '../../src/editor/shaderCatalog';
import { registerCustomShader, unregisterCustomShader } from '../../src/runtime/loaders/customShaders';
import { registerAsset, unregisterAsset } from '../../src/runtime/loaders/assetManifest';
import type { ShaderParamSchema } from '../../src/runtime/loaders/shaderSchema';

const CODE_NAME = 'test/catalog-shader';
const FILE_GUID = '11111111-2222-4333-8444-555555555555';
const FILE_PATH = '/games/test/assets/shaders/cool.shader.json';
const schema: ShaderParamSchema = { power: { type: 'float', default: 1 } };

describe('optionValueForMaterial', () => {
  it('maps pbr / absent type to "pbr"', () => {
    expect(optionValueForMaterial({})).toBe('pbr');
    expect(optionValueForMaterial({ type: 'pbr' })).toBe('pbr');
  });
  it('maps unlit', () => {
    expect(optionValueForMaterial({ type: 'unlit' })).toBe('unlit');
  });
  it('maps custom to its shader ref', () => {
    expect(optionValueForMaterial({ type: 'custom', shader: 'a/b' })).toBe('a/b');
    expect(optionValueForMaterial({ type: 'custom' })).toBe('pbr');
  });
});

describe('materialFieldsForOption', () => {
  it('builtins set type only', () => {
    expect(materialFieldsForOption('pbr')).toEqual({ type: 'pbr' });
    expect(materialFieldsForOption('unlit')).toEqual({ type: 'unlit' });
  });
  it('custom sets type + shader ref', () => {
    expect(materialFieldsForOption('a/b')).toEqual({ type: 'custom', shader: 'a/b' });
    expect(materialFieldsForOption(FILE_GUID)).toEqual({ type: 'custom', shader: FILE_GUID });
  });
});

describe('listShaderOptions', () => {
  beforeEach(() => {
    registerCustomShader(CODE_NAME, () => ({} as never), schema);
    registerAsset(FILE_GUID, FILE_PATH, 'shader');
  });
  afterEach(() => {
    unregisterCustomShader(CODE_NAME);
    unregisterAsset(FILE_GUID);
  });

  it('always lists the two built-in shaders first', () => {
    const opts = listShaderOptions();
    expect(opts[0]).toEqual({ label: 'Standard', value: 'pbr', kind: 'builtin' });
    expect(opts[1]).toEqual({ label: 'Unlit', value: 'unlit', kind: 'builtin' });
  });

  it('includes registered code shaders', () => {
    const opt = listShaderOptions().find(o => o.value === CODE_NAME);
    expect(opt).toEqual({ label: CODE_NAME, value: CODE_NAME, kind: 'code' });
  });

  it('includes file shader assets by guid, labeled from the path', () => {
    const opt = listShaderOptions().find(o => o.value === FILE_GUID);
    expect(opt).toEqual({ label: 'cool', value: FILE_GUID, kind: 'file' });
  });
});

describe('resolveShaderSchema', () => {
  beforeEach(() => registerCustomShader(CODE_NAME, () => ({} as never), schema));
  afterEach(() => unregisterCustomShader(CODE_NAME));

  it('returns null for built-ins', async () => {
    expect(await resolveShaderSchema({ kind: 'builtin', value: 'pbr' })).toBeNull();
  });
  it('returns a code shader’s registered schema', async () => {
    expect(await resolveShaderSchema({ kind: 'code', value: CODE_NAME })).toEqual(schema);
  });
});

describe('listShaderOptions ordering', () => {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const Z = 'zzzzzzzz'.replace(/z/g, 'b') + '-0000-4000-8000-00000000000b';
  afterEach(() => { unregisterAsset(A); unregisterAsset(Z); });

  // The manifest map is INSERTION-ordered, so a shader authored during the session lands
  // last in this dropdown until the next reload (spritePickerGroups.sortGroupsByName).
  it('sorts FILE shaders by label while the built-ins keep the lead', () => {
    registerAsset(Z, '/assets/shaders/zebra.shader.json', 'shader');
    registerAsset(A, '/assets/shaders/alpha.shader.json', 'shader');
    const files = listShaderOptions().filter((o) => o.kind === 'file').map((o) => o.label);
    expect(files).toEqual([...files].sort((x, y) => x.localeCompare(y)));
    expect(files.indexOf('alpha')).toBeLessThan(files.indexOf('zebra'));
    const opts = listShaderOptions();
    expect(opts[0].kind).toBe('builtin');
    expect(opts[1].kind).toBe('builtin');
  });
});
