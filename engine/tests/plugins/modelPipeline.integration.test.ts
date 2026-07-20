/** Model conversion pipeline — end-to-end integration over the REAL encoders.
 *
 *  Generates a GLB in memory (Root → Box + Terrain, embedded texture+material),
 *  then runs `convertModel` through BOTH encoder paths — gltf-transform and
 *  gltfpack — and asserts the contract the runtime depends on:
 *    • every LOD GLB is valid + readable,
 *    • named nodes + parent-child hierarchy survive simplification,
 *    • embedded textures are stripped (materials come from sidecar .mat.json),
 *    • simplification actually reduces triangles for LOD1+.
 *
 *  This is the only test that exercises the shell-out to the real `gltfpack`
 *  binary + `@gltf-transform/cli`. It is gated: if a CLI is missing the suite
 *  skips (CI without the tools stays green) rather than failing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { convertModel, __resetModelCliChecks } from '../../plugins/model-convert';
import { DEFAULT_MODEL_SETTINGS, type ModelImportSettings, type ModelEncoder } from '../../packages/modoki/src/runtime/loaders/modelSettings';
import { makeTestGlb, type TestGlbResult } from './fixtures/makeTestGlb';

// --- CLI availability gate -------------------------------------------------
function cliPresent(): { gltfTransform: boolean; gltfpack: boolean } {
  let gltfTransform = false;
  let gltfpack = false;
  try { execFileSync('npx', ['--no-install', '@gltf-transform/cli', '--version'], { stdio: 'ignore' }); gltfTransform = true; } catch { /* missing */ }
  try { execFileSync('gltfpack', ['-v'], { stdio: 'ignore' }); gltfpack = true; } catch {
    // gltfpack -v exits non-zero on some builds but is still present; probe `which`.
    try { execFileSync('command', ['-v', 'gltfpack'], { stdio: 'ignore', shell: true } as never); gltfpack = true; } catch { /* missing */ }
  }
  return { gltfTransform, gltfpack };
}
const CLI = cliPresent();

// --- GLB read-back helpers (NodeIO with meshopt + all extensions) ----------
async function makeReaderIO() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

interface GlbInfo {
  /** All node names (may include '' — gltfpack hangs the mesh on an anonymous
   *  child of the named node). */
  nodeNames: string[];
  textureCount: number;
  triangles: number;
  /** Per mesh-bearing node: the chain of NON-EMPTY ancestor names, nearest
   *  first (includes the node's own name if it has one). This is exactly how
   *  the runtime resolves a mesh's name + parent — by walking up to the nearest
   *  named ancestor — so it is encoder-agnostic (gltf-transform puts the name on
   *  the mesh node; gltfpack puts it one level up). */
  meshNamedChains: string[][];
}

async function readGlb(io: Awaited<ReturnType<typeof makeReaderIO>>, glbPath: string): Promise<GlbInfo> {
  const doc = await io.read(glbPath);
  const root = doc.getRoot();
  const nodes = root.listNodes();

  // Parent map keyed by NODE IDENTITY — names are not unique (gltfpack emits
  // multiple '' nodes), so a name-keyed map would collide.
  type N = (typeof nodes)[number];
  const parent = new Map<N, N | null>();
  for (const n of nodes) if (!parent.has(n)) parent.set(n, null);
  for (const n of nodes) for (const c of n.listChildren()) parent.set(c, n);

  const namedChain = (start: N): string[] => {
    const chain: string[] = [];
    let cur: N | null | undefined = start;
    const seen = new Set<N>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const nm = cur.getName();
      if (nm) chain.push(nm);
      cur = parent.get(cur) ?? null;
    }
    return chain;
  };

  const meshNamedChains = nodes.filter((n) => !!n.getMesh()).map((n) => namedChain(n));

  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) triangles += idx.getCount() / 3;
      else { const pos = prim.getAttribute('POSITION'); if (pos) triangles += pos.getCount() / 3; }
    }
  }

  return {
    nodeNames: nodes.map((n) => n.getName()),
    textureCount: root.listTextures().length,
    triangles,
    meshNamedChains,
  };
}

/** The set of resolved mesh names — each mesh's NEAREST named ancestor. */
function resolvedMeshNames(info: GlbInfo): string[] {
  return info.meshNamedChains.map((chain) => chain[0]).filter((n): n is string => !!n).sort();
}

// Fixture meshes (sorted), shared by the assertions below.
const MESH_NAMES = ['BoxA', 'BoxB', 'BoxC', 'Terrain'];

// --- Shared fixture --------------------------------------------------------
let fixture: TestGlbResult;
let projectRoot: string; // sandbox so we never touch the real node_modules/.cache

beforeAll(async () => {
  fixture = await makeTestGlb({ gridSegments: 24 }); // 1152 grid + 12 box = 1164 tris
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-proj-'));
}, 60_000);

afterAll(() => {
  if (fixture?.dir) fs.rmSync(fixture.dir, { recursive: true, force: true });
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

function settingsFor(encoder: ModelEncoder): ModelImportSettings {
  return {
    ...DEFAULT_MODEL_SETTINGS,
    encoder,
    lodCount: 3,
    lodRatios: [1.0, 0.5, 0.2],
    lodDistances: [0, 50, 150],
    aggressiveSimplify: encoder === 'gltfpack', // hit the ratio on the dense grid
  };
}

async function runConvert(encoder: ModelEncoder) {
  __resetModelCliChecks();
  return convertModel({
    projectRoot,
    sourceUrlPath: `/games/test/assets/models/${encoder}/test-model.glb`,
    absSource: fixture.glbPath,
    settings: settingsFor(encoder),
    postprocessorId: 'none',
    recipeVersion: 0,
  });
}

const encoders: ModelEncoder[] = [];
if (CLI.gltfTransform) encoders.push('gltf-transform');
if (CLI.gltfpack) encoders.push('gltfpack');

describe('model conversion pipeline (real encoders)', () => {
  it('fixture GLB is well-formed: named hierarchy + embedded texture', async () => {
    const io = await makeReaderIO();
    const info = await readGlb(io, fixture.glbPath);
    expect(resolvedMeshNames(info)).toEqual(MESH_NAMES);
    expect(info.nodeNames).toContain('Root');
    // Each mesh's named-ancestor chain must reach Root.
    for (const chain of info.meshNamedChains) expect(chain).toContain('Root');
    expect(info.textureCount).toBe(1);
    expect(info.triangles).toBe(fixture.triangles);
  }, 30_000);

  if (encoders.length === 0) {
    it.skip('no model encoder CLI available (install gltfpack / @gltf-transform/cli)', () => {});
  }

  for (const encoder of encoders) {
    describe(`encoder: ${encoder}`, () => {
      let result: Awaited<ReturnType<typeof convertModel>>;
      let lods: GlbInfo[];

      beforeAll(async () => {
        result = await runConvert(encoder);
        const io = await makeReaderIO();
        lods = [];
        for (const p of result.lodPaths) lods.push(await readGlb(io, p));
      }, 120_000);

      it('produces one valid GLB per LOD', () => {
        expect(result.lodPaths).toHaveLength(3);
        for (const p of result.lodPaths) {
          expect(fs.existsSync(p)).toBe(true);
          const magic = fs.readFileSync(p).subarray(0, 4).toString('ascii');
          expect(magic).toBe('glTF');
        }
      });

      it('strips embedded textures from every LOD', () => {
        for (const lod of lods) expect(lod.textureCount).toBe(0);
      });

      it('preserves named meshes across every LOD (runtime-resolved names)', () => {
        // The runtime keys a mesh by its nearest named ancestor — true for both
        // gltf-transform (name on the mesh node) and gltfpack (name one level up).
        for (const lod of lods) expect(resolvedMeshNames(lod)).toEqual(MESH_NAMES);
      });

      it('preserves the named hierarchy up to Root across every LOD', () => {
        for (const lod of lods) {
          expect(lod.nodeNames).toContain('Root');
          // Every mesh resolves up through its named node to Root.
          for (const chain of lod.meshNamedChains) {
            expect(MESH_NAMES).toContain(chain[0]);
            expect(chain).toContain('Root');
          }
        }
      });

      it('reduces triangle count for LOD1 and LOD2', () => {
        expect(result.triCounts[0]).toBeGreaterThan(0);
        expect(result.triCounts[1]).toBeLessThan(result.triCounts[0]);
        expect(result.triCounts[2]).toBeLessThanOrEqual(result.triCounts[1]);
      });

      it('reports byte sizes parallel to the LOD paths', () => {
        expect(result.lodBytes).toHaveLength(3);
        for (const b of result.lodBytes) expect(b).toBeGreaterThan(0);
      });

      it('second convert is a cache hit (no re-encode)', async () => {
        const again = await runConvert(encoder);
        expect(again.cached).toBe(true);
        expect(again.hash).toBe(result.hash);
        expect(again.lodPaths).toEqual(result.lodPaths);
      }, 60_000);
    });
  }
});
