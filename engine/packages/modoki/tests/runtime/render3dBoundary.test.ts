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
import { walkClosure, importStatements, type ImportEdge } from '../helpers/importClosure';

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
    const offenders: string[] = [];
    for (const rel of reachable) {
      for (const { line, text } of importStatements(fs.readFileSync(path.join(srcDir, rel), 'utf8'))) {
        // The owner module legitimately names every one of these in an `import type` (erased, no
        // runtime edge) and again in a gated `import()`. Only a value-carrying static import is
        // the defect. Statement-based rather than line-based: a multi-line `import {\n X,\n}
        // from '…'` slips straight past a per-line regex, and did — verified by mutation.
        if (/^import\s+type\b/.test(text)) continue;
        const m = /from\s*['"](three\/examples\/jsm\/[^'"]+)['"]/.exec(text)
          ?? /^import\s*['"](three\/examples\/jsm\/[^'"]+)['"]/.exec(text);
        if (m) offenders.push(`${rel}:${line} → ${m[1]}`);
      }
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
    const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;

    // ⚠️ This used to find each import's enclosing function by scanning BACKWARDS for a line
    // matching /^(export )?(async )?function /, then looking for the flag anywhere in that span.
    // It was defeated by the exact shape it exists to catch: rewriting an accessor as
    // `export const ktx2LoaderCtor = () => {…}` and DELETING its gate still passed 6/6, because
    // the backward scan ran past the arrow function into the PREVIOUS accessor and found *its*
    // gate. Measured, not theorised. So pair them structurally instead: gates and imports must
    // ALTERNATE in source order, each gate immediately preceding the import it protects.
    const GATE = /!__MODOKI_MODULE_RENDER3D__/g;
    // `(?<!typeof )` excludes the type-position `typeof import('…')` that names MeshoptDecoder's
    // type — erased, needs no gate, and counting it would inflate the floor below.
    const DYN = /(?<!typeof )import\(\s*['"]three\/examples\/jsm\/[^'"]+['"]\s*\)/g;
    const gates = [...src.matchAll(GATE)].map((m) => lineOf(m.index));
    const imports = [...src.matchAll(DYN)].map((m) => lineOf(m.index));

    // Non-vacuity: one accessor per loader, plus meshopt. A renamed module or a changed import
    // shape would otherwise pass with zero matches and vouch for nothing.
    expect(imports.length).toBeGreaterThanOrEqual(5);
    expect(gates.length).toBeGreaterThanOrEqual(imports.length);

    const ungated = imports
      .map((imp, i) => ({ imp, gate: gates[i] as number | undefined }))
      // Each import must be preceded by ITS OWN gate — the i-th gate, not any gate — and closely
      // enough that the two are plainly the same accessor. Deleting one gate shifts every later
      // pairing and fails here; moving a gate below its import fails here too.
      .filter(({ imp, gate }) => gate === undefined || gate >= imp || imp - gate > 8)
      .map(({ imp }) => `${LOADER_OWNER}:${imp}`);
    expect(
      ungated,
      `an import() of a three example loader is reachable when render3d is off — Rolldown will ` +
        `emit its chunk into a 2D-only bundle. Put the __MODOKI_MODULE_RENDER3D__ check on the ` +
        `line immediately before it:\n  ${ungated.join('\n  ')}`,
    ).toEqual([]);
  });
});
