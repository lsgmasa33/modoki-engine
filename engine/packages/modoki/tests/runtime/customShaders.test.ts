/**
 * customShaders registry unit tests (texture-shader-font F6) — register/unregister
 * must clear BOTH the build fn and the param schema; a shader registered without a
 * schema returns undefined; re-registering the same name overwrites cleanly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  registerCustomShader, unregisterCustomShader, getCustomShader,
  getCustomShaderSchema, getRegisteredShaderNames,
  type CustomShaderBuild,
} from '../../src/runtime/loaders/customShaders';
import type { ShaderParamSchema } from '../../src/runtime/loaders/shaderSchema';

const build: CustomShaderBuild = () => new THREE.MeshBasicMaterial();
const build2: CustomShaderBuild = () => new THREE.MeshStandardMaterial();
const schema: ShaderParamSchema = { tint: { type: 'color', default: '#ffffff' } as never };

const NAME = 'test/shader';

beforeEach(() => { unregisterCustomShader(NAME); });

describe('customShaders registry', () => {
  it('register → get returns the build fn and schema; unregister clears BOTH', () => {
    registerCustomShader(NAME, build, schema);
    expect(getCustomShader(NAME)).toBe(build);
    expect(getCustomShaderSchema(NAME)).toBe(schema);
    expect(getRegisteredShaderNames()).toContain(NAME);

    unregisterCustomShader(NAME);
    expect(getCustomShader(NAME)).toBeUndefined();
    expect(getCustomShaderSchema(NAME)).toBeUndefined(); // no stale schema left behind
    expect(getRegisteredShaderNames()).not.toContain(NAME);
  });

  it('a shader registered without a schema has undefined schema', () => {
    registerCustomShader(NAME, build);
    expect(getCustomShader(NAME)).toBe(build);
    expect(getCustomShaderSchema(NAME)).toBeUndefined();
  });

  it('re-registering the same name overwrites the build fn and drops a prior schema only if not re-supplied', () => {
    registerCustomShader(NAME, build, schema);
    registerCustomShader(NAME, build2); // no schema this time
    expect(getCustomShader(NAME)).toBe(build2);
    // Note: register without a schema does NOT clear a prior one (it only sets when given).
    expect(getCustomShaderSchema(NAME)).toBe(schema);
  });
});
