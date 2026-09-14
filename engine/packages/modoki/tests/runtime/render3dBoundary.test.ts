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
import { walkClosure, runtimeEdgesOf, type ImportEdge } from '../helpers/importClosure';
import { readScannedSource, stripComments } from '../helpers/sourceScanner';
import { findNodes, flatText, guardProves, guardsOf, lineOf, parseSource, stringValueOf, ts } from '../helpers/sourceAst';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const FLAG = '__MODOKI_MODULE_RENDER3D__';

/** Every dynamic `import(…)` in `rel` whose specifier `pick` accepts, each with whether IT runs only
 *  when the flag is on — inside a flag-true branch, or below an early exit on `!flag`, however far up.
 *
 *  ⚠️ **The import's OWN gate (#1179).** The two scans this replaces were a file-grained
 *  `src.includes(FLAG)` — any mention anywhere, a comment included, gated every import in the file —
 *  and an 8-line window pairing the i-th gate with the i-th import over the RAW text, where a
 *  commented-out gate counted and a gate for the accessor above could pair with an ungated import. The
 *  node says whether this import is reachable with the flag off; a type-position
 *  `typeof import('…')` is an import TYPE, not a call, so it is not in the population at all. */
function dynamicImports(rel: string, pick: (spec: string) => boolean): Array<{ site: string; spec: string; gated: boolean }> {
  return dynamicImportsIn(readScannedSource(path.join(srcDir, rel)).code, rel, pick);
}
function dynamicImportsIn(code: string, rel: string, pick: (spec: string) => boolean): Array<{ site: string; spec: string; gated: boolean }> {
  const sf = parseSource(code, rel);
  return findNodes(sf, (n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
    .map((c) => ({ c, spec: stringValueOf(c.arguments[0]) ?? '<non-literal>' }))
    .filter(({ spec }) => pick(spec))
    .map(({ c, spec }) => ({
      site: `${rel}:${lineOf(c)} ${flatText(c)}`,
      spec,
      gated: guardsOf(c).some((g) => guardProves(g, (e) => ts.isIdentifier(e) && e.text === FLAG)),
    }));
}

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

describe('the render3d gate reader asks each import for ITS OWN gate (#1179)', () => {
  const gated = (src: string) => dynamicImportsIn(stripComments(src), 'fixture.ts', () => true).map((i) => i.gated);

  it.each([
    ['an early return on !flag', 'export function a() {\n  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(e);\n  return import(\'x\');\n}'],
    ['an early-exit block with a warning in it', 'async function b() {\n  if (!__MODOKI_MODULE_RENDER3D__) {\n    warn();\n    return pbr();\n  }\n  return await import(\'x\');\n}'],
    ['a closure built below the early return', 'async function c() {\n  if (!__MODOKI_MODULE_RENDER3D__) { ready(); return; }\n  const f = async () => import(\'x\');\n}'],
    ['a flag-true branch wrapped by the formatter', 'if (\n  __MODOKI_MODULE_RENDER3D__ &&\n  wanted\n) {\n  void import(\'x\');\n}'],
    ['a failed `!flag || …` early exit', 'function d() {\n  if (!__MODOKI_MODULE_RENDER3D__ || off) return;\n  return import(\'x\');\n}'],
    ['a ternary arm', 'const p = __MODOKI_MODULE_RENDER3D__ ? import(\'x\') : null;'],
  ])('accepts %s', (_why, src) => {
    expect(gated(src)).toEqual([true]);
  });

  it.each([
    // The measured regression: an arrow accessor with its gate DELETED, below a gated one.
    ['an arrow accessor whose gate was deleted, below a gated accessor',
      'export function a() {\n  if (!__MODOKI_MODULE_RENDER3D__) return null;\n  return import(\'x\');\n}\nexport const b = () => {\n  return import(\'y\');\n};', [true, false]],
    ['an import AFTER a flag-true block rather than inside it', 'if (__MODOKI_MODULE_RENDER3D__) {\n  warm();\n}\nvoid import(\'x\');', [false]],
    ['a gate that is only a COMMENT', 'function a() {\n  // if (!__MODOKI_MODULE_RENDER3D__) return;\n  return import(\'x\');\n}', [false]],
    ['a flag test that does not prove it on', 'function a() {\n  if (__MODOKI_MODULE_RENDER3D__) return;\n  return import(\'x\');\n}', [false]],
    ['a flag-true branch of an `||`', 'if (__MODOKI_MODULE_RENDER3D__ || other) {\n  void import(\'x\');\n}', [false]],
  ])('refuses %s', (_why, src, expected) => {
    expect(gated(src)).toEqual(expected);
  });

  it('a type-position `typeof import(…)` is not a call, so it is not in the population', () => {
    expect(gated("type T = typeof import('x').Y;\nexport function a() { if (!__MODOKI_MODULE_RENDER3D__) return; return import('x'); }")).toEqual([true]);
  });
});

describe('render3d:false boundary — the 2D boot path never reaches three/webgpu (#214)', () => {
  it.each(GATED_EDGES)(
    'the $file → $spec edge is really gated on __MODOKI_MODULE_RENDER3D__',
    ({ file, spec }) => {
      expect(fs.existsSync(path.join(srcDir, file)), `${file} no longer exists — stale GATED_EDGES entry`).toBe(true);
      const imports = dynamicImports(file, (s) => s === spec);
      expect(imports.length, `${file} no longer imports ${spec} — drop the stale GATED_EDGES entry`).toBeGreaterThan(0);
      expect(
        imports.filter((i) => !i.gated).map((i) => i.site),
        `${file} imports ${spec} (which reaches three/webgpu) where ${FLAG} does not gate it — the gate ` +
          `that keeps 546 KB of Three out of a 2D-only build is gone. Restore it (the import inside a ` +
          `flag-true branch, or below an early return on the flag being off), or remove the entry from ` +
          `GATED_EDGES and let the closure assertion below report the real cost.`,
      ).toEqual([]);
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
const EXAMPLE_LOADER_RE = /^three\/examples\/jsm\//;

describe('render3d:false boundary — three\'s example loaders are imported on demand (#254)', () => {
  /** Files reachable from the 2D entries, following relative imports only (same closure the
   *  guard above walks). Reused by both assertions so they cannot disagree about the set. */
  const reachable = walkClosure({ srcDir, entries: ENTRIES, forbidden: [], skipEdges: GATED_EDGES }).visited;

  it('no module on the 2D path STATICALLY imports a three example loader', () => {
    expect(reachable.length).toBeGreaterThan(100); // non-vacuity: an empty closure proves nothing
    const offenders: string[] = [];
    for (const rel of reachable) {
      // The owner module legitimately names every one of these in an `import type` (erased, no
      // runtime edge — `runtimeEdgesOf` drops it) and again in a gated `import()`. Only a static or
      // re-exported edge is the defect. Read from the declarations (#1179): a multi-line
      // `import {\n X,\n} from '…'` slipped past a per-line regex once, and an `export … from '…'`
      // slipped past the statement joiner that replaced it.
      for (const { spec, kind, node } of runtimeEdgesOf(path.join(srcDir, rel))) {
        if (kind !== 'dynamic' && EXAMPLE_LOADER_RE.test(spec)) offenders.push(`${rel}:${lineOf(node)} → ${spec}`);
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
    expect(fs.existsSync(path.join(srcDir, LOADER_OWNER)), `${LOADER_OWNER} no longer exists — this guard is stale`).toBe(true);
    // ⚠️ This used to find each import's enclosing function by scanning BACKWARDS for a line
    // matching /^(export )?(async )?function /, then looking for the flag anywhere in that span.
    // It was defeated by the exact shape it exists to catch: rewriting an accessor as
    // `export const ktx2LoaderCtor = () => {…}` and DELETING its gate still passed 6/6, because
    // the backward scan ran past the arrow function into the PREVIOUS accessor and found *its*
    // gate. Measured, not theorised. Its replacement paired the i-th gate with the i-th import
    // within 8 lines — still text, and over the raw file (#1179). Now each import is asked whether
    // IT runs with the flag off.
    const imports = dynamicImports(LOADER_OWNER, (s) => EXAMPLE_LOADER_RE.test(s));
    // Non-vacuity: one accessor per loader, plus meshopt. A renamed module or a changed import
    // shape would otherwise pass with zero matches and vouch for nothing.
    expect(imports.length).toBeGreaterThanOrEqual(5);
    expect(
      imports.filter((i) => !i.gated).map((i) => i.site),
      `an import() of a three example loader is reachable when render3d is off — Rolldown will ` +
        `emit its chunk into a 2D-only bundle. Return early on !${FLAG} before it, as the other ` +
        `accessors do.`,
    ).toEqual([]);
  });
});
