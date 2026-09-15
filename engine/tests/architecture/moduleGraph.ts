/**
 * Cross-folder import graph over `packages/modoki/src/runtime/**` — the shared measurement
 * used by the architecture guard tests (noNewCycles; `barrelSurface` imports the live barrel instead). See `docs/architecture-
 * layers.md` for the layer contract this graph polices. Not a test itself.
 *
 * Node granularity: every TOP-LEVEL subfolder of `runtime/` is one node (`core`, `traits`,
 * `animation`, …); every file directly AT `runtime/` root (no subfolder) is its OWN node, keyed
 * by its filename without extension — today that is only `index`, since every other loose root
 * file (`config`, `appServices`, …) moved into `core/` in P3c of the module-boundaries work.
 * Collapsing root files into one pseudo-node is what over-counted the very first cycle scan for
 * that work (a `store -> appServices` edge and an `index -> store` edge look like a 2-cycle
 * between two real files only if you first smash them into one fake node) — so this is the one
 * invariant callers must not "simplify" away.
 *
 * Edges are tagged `valueOnly: false` when the STATEMENT is erased — `import type` / `export type` —
 * because TypeScript's `verbatimModuleSyntax` (on in tsconfig.app.json) drops it entirely, so it can
 * never run the target module and can never produce an ESM circular-init `undefined`.
 * ⚠️ An import whose every specifier is inline-`type` (`import { type A } from './x'`) is NOT erased:
 * `verbatimModuleSyntax` rewrites it to `import {} from './x'`, which still runs `./x`. This graph used to
 * count it as type-only (#1193); the two such runtime edges measured on 2026-09-15 moved to value and
 * changed no cycle. Dynamic
 * `import(...)` is deliberately NOT modeled as a graph edge: it is evaluated lazily, well after
 * module-init, so it cannot participate in the init-order failure mode this graph exists to catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { importsIn, parseSource } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RUNTIME_ROOT = path.join(REPO_ROOT, 'engine/packages/modoki/src/runtime');

export interface ImportEdge {
  /** Repo-relative path of the file containing the import/export statement. */
  fromFile: string;
  /** Graph node the source file belongs to — a top-level folder name, or a root filename. */
  fromNode: string;
  /** Repo-relative path the specifier resolved to, or `null` if it didn't resolve to a file
   *  under RUNTIME_ROOT (e.g. it escapes to `../../three/...` — still a real edge, tracked by
   *  a synthetic node so those escapes are visible too). */
  toFile: string | null;
  /** Graph node the resolved target belongs to. For an out-of-runtime escape this is the
   *  resolved path's nearest named segment, prefixed `../` so it never collides with an
   *  in-runtime node name. */
  toNode: string;
  /** The raw specifier text, e.g. '../../packages/modoki/src/runtime/core/journal'. */
  specifier: string;
  /** false = every binding in this statement is erased (`import type` / inline `type`); the
   *  statement compiles to nothing and cannot run the target module. */
  valueOnly: boolean;
}

/** Every `.ts`/`.tsx` under `RUNTIME_ROOT`, as absolute paths — via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 540 measured today. */
function walk(dir: string): string[] {
  return repoFiles({
    under: dir, match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 400,
  }).map(({ abs }) => abs);
}

/** Node id for a file: its top-level subfolder under RUNTIME_ROOT, or (for a file directly at
 *  RUNTIME_ROOT) its own filename without extension. Files outside RUNTIME_ROOT entirely get a
 *  `../`-prefixed id built from the nearest informative path segment, so an edge that escapes the
 *  runtime tree (e.g. into `src/three/`) is still representable without colliding with real nodes. */
export function nodeIdFor(absFile: string): string {
  const rel = path.relative(RUNTIME_ROOT, absFile);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep);
    if (parts.length === 1) return path.basename(parts[0], path.extname(parts[0]));
    return parts[0];
  }
  // Outside runtime/ — identify by the path segment right after the shared `src/` ancestor,
  // e.g. `.../src/three/traits/Light.ts` -> `../three`.
  const srcRel = path.relative(path.join(REPO_ROOT, 'engine/packages/modoki/src'), absFile);
  const seg = srcRel.split(path.sep)[0] || path.basename(absFile);
  return `../${seg}`;
}

/** One file's static import/export-from edges (specifier + valueOnly), without resolving them to files
 *  yet. Exported for `moduleGraphCommentEdges.test.ts`, which pins what it reads.
 *
 *  ⚠️ **Read from the declarations, not from text (#1193).** This was five regexes, one per spelling it
 *  knew — `import type`, `export type {…}`, `import <clause> from`, `import '…'`, `export {…|*} from` —
 *  plus a hand-written split of the brace list. `importsIn` reads every spelling the parser does
 *  (`import x = require()`, a statement the regexes could not see past, an `import` in a template
 *  string that is not one). Measured over the 540 runtime files on 2026-09-15 it found the same 2,016
 *  edges; the only change was two `import { type A }` edges moving to value (see the header). */
export function parseFromStatements(code: string, label: string): Array<{ specifier: string; valueOnly: boolean }> {
  return importsIn(parseSource(code, label))
    .filter((e) => e.kind !== 'dynamic')
    .map((e) => ({ specifier: e.spec, valueOnly: !e.typeOnly }));
}

/** Resolve a relative specifier from `fromFile` to an actual file on disk (trying `.ts`, `.tsx`,
 *  and `/index.ts(x)`), or `null` if nothing resolves (rare — a specifier into a package export
 *  map, e.g. `@modoki/engine/three`, is not relative and is filtered out before this is called). */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Build the full edge list over `packages/modoki/src/runtime/**`. Only RELATIVE specifiers are
 *  followed (bare specifiers like `koota`/`three`/`@modoki/engine` are external packages, out of
 *  scope for an internal layering guard). */
export function buildRuntimeGraph(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of walk(RUNTIME_ROOT)) {
    // Read through the shared scanner (#812), which `commentStripperIsShared` enforces. Since #1193 the
    // parse cannot mistake a comment for an import anyway, but a doc comment SHOWING a relative import
    // was once a phantom cross-folder edge in a graph that feeds frozen baselines (`noNewCycles`), where
    // the cheapest "fix" is enshrining a cycle that does not exist.
    const src = readScannedSource(file).code;
    const fromNode = nodeIdFor(file);
    const fromFile = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    for (const { specifier, valueOnly } of parseFromStatements(src, fromFile)) {
      if (!specifier.startsWith('.')) continue; // external package — not our layering concern
      const resolved = resolveSpecifier(file, specifier);
      const toFile = resolved ? path.relative(REPO_ROOT, resolved).replace(/\\/g, '/') : null;
      const toNode = resolved ? nodeIdFor(resolved) : `../unresolved:${specifier}`;
      edges.push({ fromFile, fromNode, toFile, toNode, specifier, valueOnly });
    }
  }
  return edges;
}

/** Cross-folder VALUE-edge two-cycles: `{a, b}` such that some file in `a` imports (with a
 *  runtime value binding) something in `b`, AND some file in `b` imports back into `a`, where
 *  `a !== b`. Type-only edges are excluded per the D2 decision recorded in
 *  `docs/architecture-layers.md` — they cannot produce the ESM circular-init failure
 *  this guard exists to catch, so counting them would make the ratchet noisy enough to get
 *  disabled. Returned as a sorted array of `"a|b"` keys (alphabetical within the pair) so the
 *  baseline file is stable across runs regardless of edge discovery order. */
export function crossFolderValueCycles(edges: ImportEdge[]): string[] {
  const dirEdges = new Set<string>();
  for (const e of edges) {
    if (!e.valueOnly) continue;
    if (e.fromNode === e.toNode) continue;
    dirEdges.add(`${e.fromNode}->${e.toNode}`);
  }
  const cycles = new Set<string>();
  for (const key of dirEdges) {
    const [a, b] = key.split('->');
    if (dirEdges.has(`${b}->${a}`)) {
      cycles.add([a, b].sort().join('|'));
    }
  }
  return [...cycles].sort();
}
