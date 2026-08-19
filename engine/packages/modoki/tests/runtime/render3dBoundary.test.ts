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
