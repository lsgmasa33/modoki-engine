/** Model conversion flag-builder tests — pure functions, no external CLIs. */

import { describe, it, expect } from 'vitest';
import {
  buildGltfTransformSimplifyArgs, buildGltfTransformMeshoptArgs, buildGltfpackArgs,
} from '../../plugins/model-convert';

describe('buildGltfTransformSimplifyArgs', () => {
  it('emits ratio + error flags and passes paths through', () => {
    const args = buildGltfTransformSimplifyArgs('in.glb', 'out.glb', 0.4, 0.02, true);
    expect(args).toContain('simplify');
    expect(args).toContain('--ratio');
    expect(args[args.indexOf('--ratio') + 1]).toBe('0.4');
    expect(args).toContain('--error');
    expect(args[args.indexOf('--error') + 1]).toBe('0.02');
    expect(args).toContain('in.glb');
    expect(args).toContain('out.glb');
  });

  it('leads with the `simplify` subcommand (the invocation prefix is added by the caller now)', () => {
    // E-3.5: the CLI command (userData install / npx dev-fallback) is resolved at the call site via
    // gltfTransformInvocation(); the builder returns only the subcommand + its args.
    const args = buildGltfTransformSimplifyArgs('in.glb', 'out.glb', 1, 0.01, true);
    expect(args[0]).toBe('simplify');
    expect(args).not.toContain('--no-install');
    expect(args).not.toContain('@gltf-transform/cli');
  });

  it('passes --lock-border 1 when locking borders (conservative)', () => {
    const args = buildGltfTransformSimplifyArgs('in.glb', 'out.glb', 0.4, 0.02, true);
    expect(args).toContain('--lock-border');
    expect(args[args.indexOf('--lock-border') + 1]).toBe('1');
  });

  it('passes --lock-border 0 when borders are unlocked (aggressive)', () => {
    const args = buildGltfTransformSimplifyArgs('in.glb', 'out.glb', 0.4, 0.02, false);
    expect(args).toContain('--lock-border');
    expect(args[args.indexOf('--lock-border') + 1]).toBe('0');
  });
});

describe('buildGltfTransformMeshoptArgs', () => {
  it('leads with the `meshopt` subcommand + both paths (invocation prefix added by the caller)', () => {
    const args = buildGltfTransformMeshoptArgs('in.glb', 'out.glb');
    expect(args[0]).toBe('meshopt');
    expect(args).not.toContain('--no-install');
    expect(args).toContain('in.glb');
    expect(args).toContain('out.glb');
  });
});

describe('buildGltfpackArgs', () => {
  it('passes -slb (lock borders) in conservative mode', () => {
    const args = buildGltfpackArgs('in.glb', 'out.glb', 0.5, false, false);
    expect(args).toContain('-slb');
    expect(args).not.toContain('-sa');
    expect(args).toContain('-si');
    expect(args[args.indexOf('-si') + 1]).toBe('0.5');
  });

  it('swaps -slb for -sa when aggressive', () => {
    const args = buildGltfpackArgs('in.glb', 'out.glb', 0.05, false, true);
    expect(args).toContain('-sa');
    expect(args).not.toContain('-slb');
  });

  it('adds -cc when meshopt is on', () => {
    expect(buildGltfpackArgs('in.glb', 'out.glb', 1, true, false)).toContain('-cc');
    expect(buildGltfpackArgs('in.glb', 'out.glb', 1, false, false)).not.toContain('-cc');
  });

  it('passes input/output paths via -i / -o', () => {
    const args = buildGltfpackArgs('a/b.glb', 'c/d.glb', 0.4, true, false);
    expect(args[args.indexOf('-i') + 1]).toBe('a/b.glb');
    expect(args[args.indexOf('-o') + 1]).toBe('c/d.glb');
  });

  it('always passes -kn to keep the parent node hierarchy intact', () => {
    // Without -kn, gltfpack flattens the entire chain into one Mesh-node
    // matrix and the runtime bake puts geometry in WORLD space — which then
    // renders too small because the existing ECS entity Transform also
    // applies the parent-chain scale.
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.5, false, false)).toContain('-kn');
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.05, true, true)).toContain('-kn');
  });

  it('always passes -km to disable named-material merging', () => {
    // Without -km gltfpack collapses primitives that share a material into a
    // single Mesh node, erasing per-mesh names. The runtime keys template
    // lookups on the source mesh name, so on multi-mesh models (e.g. island)
    // every .mesh.json misses its template and the whole model renders
    // nothing.
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.5, false, false)).toContain('-km');
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.05, true, true)).toContain('-km');
  });

  it('always passes -vtf so UVs stay unquantized after the texture strip', () => {
    // Default gltfpack quantizes UVs and rescales them to each primitive's UV
    // bounding box, storing the dequant as a KHR_texture_transform on the
    // material's baseColor texture binding. We strip embedded textures before
    // gltfpack, which removes that binding, so the dequant gets silently
    // dropped — palm-leaf primitives (small UV window, alpha-tested) then
    // sample palm.png's transparent border and disappear. -vtf keeps UVs as
    // Float32 with no remap, so the runtime sees the source's UVs.
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.5, false, false)).toContain('-vtf');
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.05, true, true)).toContain('-vtf');
  });

  it('always passes -kv so TEXCOORD_0 / TANGENT survive the strip pass', () => {
    // We strip embedded textures up-pipeline so materials end up with no
    // texture refs. Without -kv gltfpack treats UVs as unused and drops
    // them; the runtime then warns about a missing "uv" attribute when a
    // sidecar material binds a baseColorMap.
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.5, false, false)).toContain('-kv');
    expect(buildGltfpackArgs('in.glb', 'out.glb', 0.05, true, true)).toContain('-kv');
  });
});
