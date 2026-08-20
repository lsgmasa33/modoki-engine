/** MODULE-BOUNDARY GUARD (#214) — a `build.modules.render3d: false` bundle must not reach
 *  `three/webgpu`.
 *
 *  `games/space-invader` shipped a 546 KB `three.webgpu` chunk it could never execute: the
 *  toggle DID reach the app shell (`Scene3D` was null at build time), but ONE ungated dynamic
 *  import still rooted the whole Three node pipeline — `textureResolver`'s KTX2 caps probe
 *  (`ensureKtx2Caps` → `capsProbeRenderer` → `scene3DSync` → `three/webgpu`). Nothing in a
 *  2D-only build ever calls it, so the cost was pure graph: 3025 kB → 2443 kB of JS once gated
 *  (gzip 931 → 767 kB), which matters because that project drives the ≤5 MB playable-ad budget.
 *
 *  The defect is invisible to every other test — the code is correct, only the module GRAPH is
 *  wrong — and visible in a build only if someone reads the chunk table. So it is pinned here,
 *  at the source level, where it costs milliseconds instead of a build. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkClosure, importsOf, type ImportEdge } from '../helpers/importClosure';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** What a render3d-OFF build roots: the runtime barrel every game imports, plus the 2D renderer
 *  entry `App.tsx` lazy-loads when `__MODOKI_MODULE_RENDER2D__` is on. `Scene3D` is deliberately
 *  NOT here — that entry is the one the flag makes null. */
const ENTRIES = ['runtime/index.ts', 'runtime/rendering/Game.tsx'];

/** `three/tsl` rides along with `three/webgpu` (both are the node pipeline) and is the cheaper
 *  early warning: reaching it means a Three-node module got onto the 2D path. */
const FORBIDDEN = ['three/webgpu', 'three/tsl'] as const;

/** The dynamic imports a `__MODOKI_MODULE_RENDER3D__` gate folds away in a render3d-OFF build.
 *  Rolldown DCEs each because the flag is a build-time constant and the gate returns BEFORE the
 *  import — so the shape matters, not just the presence of the flag somewhere in the file.
 *  Every entry is re-verified below; an allowlist nobody checks is just a mute button. */
const GATED_EDGES: ImportEdge[] = [
  // #214 — the KTX2 caps probe. Nothing transcodes a KTX2 through three's loader in a 2D build
  // (PixiJS does its own), and `selectVariant`'s '2d' branch never reads the detected caps.
  { file: 'runtime/loaders/textureResolver.ts', spec: '../rendering/capsProbeRenderer' },
  // File shaders are WGSL/GLSL NodeMaterials — a 3D-renderer feature with no meaning when
  // render3d is off; `materialPresets` falls back to the standard material instead.
  { file: 'runtime/loaders/materialPresets.ts', spec: './fileShaderBuilder' },
];

describe('render3d:false boundary — the 2D boot path never reaches three/webgpu (#214)', () => {
  it.each(GATED_EDGES)(
    'the $file → $spec edge is really gated on __MODOKI_MODULE_RENDER3D__',
    ({ file, spec }) => {
      const abs = path.join(srcDir, file);
      expect(fs.existsSync(abs), `${file} no longer exists — stale GATED_EDGES entry`).toBe(true);
      const src = fs.readFileSync(abs, 'utf8');
      expect(
        src.includes(`import('${spec}')`) || src.includes(`import("${spec}")`),
        `${file} no longer imports ${spec} — drop the stale GATED_EDGES entry`,
      ).toBe(true);
      expect(
        src.includes('__MODOKI_MODULE_RENDER3D__'),
        `${file} imports ${spec} (which reaches three/webgpu) but no longer mentions ` +
          `__MODOKI_MODULE_RENDER3D__ — the gate that keeps 546 KB of Three out of a 2D-only ` +
          `build is gone. Restore it, or remove the entry from GATED_EDGES and let the closure ` +
          `assertion below report the real cost.`,
      ).toBe(true);
    },
  );

  it('no OTHER path from the 2D entries reaches the Three node pipeline', () => {
    const { offenders, visited } = walkClosure({ srcDir, entries: ENTRIES, forbidden: FORBIDDEN, skipEdges: GATED_EDGES });
    // Non-vacuity: a walker that resolved nothing would report zero offenders and look green.
    expect(visited.length).toBeGreaterThan(100);
    expect(
      offenders,
      `A render3d:false build would ship the whole Three node pipeline. Either move the shared ` +
        `value behind a three-free module (as mtsdfStyle.ts did for 2D text), or gate the import ` +
        `on __MODOKI_MODULE_RENDER3D__ and declare it in GATED_EDGES:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the gates are load-bearing — following them WOULD reach three/webgpu', () => {
    // Pins that GATED_EDGES lists real gates rather than dead entries: with the skips removed,
    // the closure must find the pipeline again. If this ever fails because the 3D renderer
    // genuinely stopped importing three/webgpu, delete the corresponding entry — do not skip.
    const { offenders } = walkClosure({ srcDir, entries: ENTRIES, forbidden: FORBIDDEN });
    for (const { file } of GATED_EDGES) {
      expect(
        offenders.some((o) => o.includes(file)),
        `${file}'s gated import no longer leads to ${FORBIDDEN.join('/')} — the GATED_EDGES ` +
          `entry is dead weight, and the gate it documents may be unnecessary now.`,
      ).toBe(true);
    }
  });
});

/** #254 — the SECOND mechanism with the same symptom, found while fixing #214.
 *
 *  three's example loaders (`three/examples/jsm/**`) are 3D-only consumers, but a *static*
 *  import of one is reachable from the `runtime/index.ts` barrel that every build keeps alive.
 *  So `games/space-invader` shipped GLTFLoader, both HDR decoders, KTX2Loader and the meshopt
 *  decoder it can never call. `three/webgpu` was never reached — this is a different edge, and
 *  #214's gate does not touch it, which is why FORBIDDEN above cannot see it.
 *
 *  Measured on that project (raw JS / gzip, whole `dist/assets`): GLTF+meshopt+HDR+UltraHDR
 *  −125.8 kB / −34.8 kB, KTX2Loader a further −60.2 kB / −24.4 kB. The two together release
 *  2.9 kB more than the sum of their parts — three core that only they retained.
 *
 *  The rule this pins: exactly ONE module may name those specifiers, it must do so with a
 *  gated `import()`, and nothing else on the 2D path may reach them statically. */
const LOADER_OWNER = 'runtime/loaders/threeLoaderModules.ts';
const EXAMPLE_LOADER_RE = /three\/examples\/jsm\//;

describe('render3d:false boundary — three\'s example loaders are imported on demand (#254)', () => {
  /** Files reachable from the 2D entries, following relative imports only (same closure the
   *  guard above walks). Reused by both assertions so they cannot disagree about the set. */
  const reachable = walkClosure({ srcDir, entries: ENTRIES, forbidden: [], skipEdges: GATED_EDGES }).visited;

  it('no module on the 2D path STATICALLY imports a three example loader', () => {
    expect(reachable.length).toBeGreaterThan(100); // non-vacuity: an empty closure proves nothing
    // Matched per LINE, not per specifier: the owner module legitimately names every one of
    // these in an `import type` (erased, no runtime edge) and again in a gated `import()`. Only
    // a value-carrying `from '…'` — or a bare side-effect import — is the defect.
    const STATIC_IMPORT = /^\s*import\s+(?!type[\s{])[^;]*?from\s*['"](three\/examples\/jsm\/[^'"]+)['"]/;
    const SIDE_EFFECT = /^\s*import\s*['"](three\/examples\/jsm\/[^'"]+)['"]/;
    const offenders: string[] = [];
    for (const rel of reachable) {
      const lines = fs.readFileSync(path.join(srcDir, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = STATIC_IMPORT.exec(line) ?? SIDE_EFFECT.exec(line);
        if (m) offenders.push(`${rel}:${i + 1} → ${m[1]}`);
      });
    }
    expect(
      offenders,
      `A render3d:false build would ship three's example loaders it can never call (#254). ` +
        `Route the import through ${LOADER_OWNER}, which gates it on __MODOKI_MODULE_RENDER3D__ ` +
        `so Rolldown can DCE both the import and its chunk:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it(`every ${LOADER_OWNER} import() sits behind the render3d gate`, () => {
    const abs = path.join(srcDir, LOADER_OWNER);
    expect(fs.existsSync(abs), `${LOADER_OWNER} no longer exists — this guard is stale`).toBe(true);
    const src = fs.readFileSync(abs, 'utf8');
    const dynamic = [...src.matchAll(/import\(\s*['"](three\/examples\/jsm\/[^'"]+)['"]\s*\)/g)];
    // Non-vacuity: a renamed module or a changed import shape would otherwise pass with zero
    // matches and vouch for nothing. Every accessor this file exports owns one.
    expect(dynamic.length).toBeGreaterThanOrEqual(4);
    // The gate must come BEFORE the import in the same function, or Rolldown keeps the chunk.
    // Checking per-line is what distinguishes "the flag is mentioned in this file somewhere"
    // from "this particular import is unreachable when the flag is false".
    const lines = src.split('\n');
    const ungated = dynamic
      .map((m) => lines.findIndex((l) => l.includes(m[0])))
      .filter((i) => {
        const fnStart = lines.slice(0, i).map((l, j) => ({ l, j })).reverse()
          .find(({ l }) => /^(export )?(async )?function /.test(l))?.j ?? 0;
        return !lines.slice(fnStart, i + 1).some((l) => l.includes('__MODOKI_MODULE_RENDER3D__'));
      })
      .map((i) => `${LOADER_OWNER}:${i + 1}`);
    expect(
      ungated,
      `an import() of a three example loader is reachable when render3d is off — Rolldown will ` +
        `emit its chunk into a 2D-only bundle. Put the __MODOKI_MODULE_RENDER3D__ check FIRST in ` +
        `the accessor:\n  ${ungated.join('\n  ')}`,
    ).toEqual([]);
  });
});
