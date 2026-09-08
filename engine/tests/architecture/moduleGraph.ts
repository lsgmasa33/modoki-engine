/**
 * Cross-folder import graph over `packages/modoki/src/runtime/**` — the shared measurement
 * used by the architecture guard tests (noNewCycles, barrelSurface). See `docs/architecture-
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
 * Edges are tagged `valueOnly: false` when EVERY binding the statement introduces is erased by
 * `import type` / `export type` / an inline `type` specifier — i.e. TypeScript's
 * `verbatimModuleSyntax` (on in tsconfig.app.json) drops the statement entirely, so it can never
 * run the target module for its side effects and can never produce an ESM circular-init
 * `undefined`. A statement with even one non-type binding is `valueOnly: true`. Dynamic
 * `import(...)` is deliberately NOT modeled as a graph edge: it is evaluated lazily, well after
 * module-init, so it cannot participate in the init-order failure mode this graph exists to catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
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

/** True iff every specifier in a `{ ... }` clause is `type`-prefixed (`type X` / `type X as Y`),
 *  meaning the whole clause is erasable. An empty clause (`{}`) is treated as value — it is rare
 *  in this codebase and erring conservative (counting it as a real edge) is the safe direction
 *  for a guard whose job is to not miss things. */
function braceIsAllType(braceContent: string): boolean {
  const specs = braceContent
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (specs.length === 0) return false;
  return specs.every((s) => /^type\b/.test(s));
}

/** Parse one file's static import/export-from statements into edges (specifier + valueOnly),
 *  without resolving them to files yet. Exported for the barrel-surface test, which also needs
 *  to read `runtime/index.ts`'s export list without duplicating this parsing. */
export function parseFromStatements(src: string): Array<{ specifier: string; valueOnly: boolean }> {
  const out: Array<{ specifier: string; valueOnly: boolean }> = [];

  // import type <clause> from '...'  — keyword right after `import` erases the WHOLE statement.
  // Tracked as ranges (not mutated out of `src`) so the general import regex below can skip
  // anything already counted here, without a `type { A } from 'x'` line being double-counted.
  const importTypeRe = /import\s+type\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  const typeRanges: Array<[number, number]> = [];
  for (const m of src.matchAll(importTypeRe)) {
    out.push({ specifier: m[1], valueOnly: false });
    typeRanges.push([m.index!, m.index! + m[0].length]);
  }
  const inTypeRange = (idx: number) => typeRanges.some(([a, b]) => idx >= a && idx < b);

  // export type { ... } from '...'
  const exportTypeRe = /export\s+type\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(exportTypeRe)) out.push({ specifier: m[1], valueOnly: false });
  const exportTypeRanges: Array<[number, number]> = [];
  for (const m of src.matchAll(exportTypeRe)) exportTypeRanges.push([m.index!, m.index! + m[0].length]);
  const inExportTypeRange = (idx: number) => exportTypeRanges.some(([a, b]) => idx >= a && idx < b);

  // General `import <clause> from '...'` (clause = `* as X` | `X` | `X, { ... }` | `{ ... }`).
  const importRe = /import\s+((?:\*\s+as\s+\w+)|(?:\w+(?:\s*,\s*\{[^}]*\})?)|(?:\{[^}]*\}))\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    if (inTypeRange(m.index!)) continue; // already counted above as type-only
    const clause = m[1];
    const specifier = m[2];
    const braceMatch = clause.match(/\{([^}]*)\}/);
    const hasBareDefaultOrNamespace = /^(?:\*\s+as\s+\w+|\w+)/.test(clause.trim()) && !clause.trim().startsWith('{');
    let valueOnly: boolean;
    if (hasBareDefaultOrNamespace) {
      valueOnly = true; // a default/namespace binding is never erasable
    } else if (braceMatch) {
      valueOnly = !braceIsAllType(braceMatch[1]);
    } else {
      valueOnly = true;
    }
    out.push({ specifier, valueOnly });
  }

  // Side-effect-only import: `import '...'` (no clause) — always runs the target module.
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(sideEffectRe)) out.push({ specifier: m[1], valueOnly: true });

  // `export { ... } from '...'` (not `export type { ... }`, handled above) — check inline `type`.
  const exportRe = /export\s+(\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(exportRe)) {
    if (inExportTypeRange(m.index!)) continue;
    const clause = m[1];
    const specifier = m[2];
    const braceMatch = clause.match(/\{([^}]*)\}/);
    const valueOnly = braceMatch ? !braceIsAllType(braceMatch[1]) : true; // `export *` / `export * as X` — value
    out.push({ specifier, valueOnly });
  }

  return out;
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
    // ⚠️ **Comments blanked before the statements are parsed (#812).** `parseFromStatements` is a
    // regex over text, so a doc comment SHOWING an import example is indistinguishable from a real
    // one — and a comment holding a RELATIVE specifier injects a phantom cross-folder edge. This
    // graph feeds `noNewCycles` and `barrelSurface`, both frozen baselines, so that lands not as a
    // red build you investigate but as a new cycle whose cheapest fix is adding it to
    // `cycles-baseline.json` — permanently enshrining a cycle that does not exist.
    // Two runtime files already hold an import in prose (`ui/storeHooks.ts`,
    // `storage/playerPrefs.ts`); both happen to use the bare `@modoki/engine/runtime`, which the
    // `.`-prefix filter below drops. The next one to be written relatively is the live bug.
    const src = readScannedSource(file).code;
    const fromNode = nodeIdFor(file);
    const fromFile = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    for (const { specifier, valueOnly } of parseFromStatements(src)) {
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
