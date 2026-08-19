/** Source-level import-closure walking, for MODULE-BOUNDARY guards.
 *
 *  These guards answer one question cheaply: "can module X be reached from a boot path that is
 *  supposed to exclude it?" — the question a bloated bundle answers expensively and late. Two
 *  such guards share this walker (`mtsdf2DBoundary`, `render3dBoundary`); a third copy would
 *  drift from the other two, which is why it lives here rather than inline.
 *
 *  It walks SOURCE, not a bundle: it follows relative specifiers between `.ts`/`.tsx` files and
 *  reports the bare specifiers it meets on the way. That is deliberately an over-approximation
 *  of what Rolldown emits (it cannot see a branch fold), which is the safe direction for a
 *  guard — an edge that survives here but is DCE'd in the real build costs an allowlist entry
 *  with a stated reason, while the reverse would be a guard that misses the defect. */

import fs from 'node:fs';
import path from 'node:path';

/** Resolve a relative import specifier to an on-disk .ts/.tsx file (or null). */
export function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** All import specifiers in a file — static `from '…'` / `import '…'` AND dynamic
 *  `import('…')`. `import type` is EXCLUDED deliberately: an erased type import carries no
 *  runtime dependency, in either direction (following a type-only relative import would
 *  over-report; flagging a type-only `three/webgpu` import would too — several modules take
 *  only the `WebGPURenderer` type). */
export function importsOf(file: string): { relatives: string[]; bare: string[] } {
  const src = fs.readFileSync(file, 'utf8');
  const relatives: string[] = [];
  const bare: string[] = [];
  const re = /(?:^|\n)\s*(import\s+type\s+)?[^\n;]*?(?:from|import\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const isTypeOnly = Boolean(m[1]);
    const spec = m[2];
    if (spec.startsWith('.')) {
      if (!isTypeOnly) relatives.push(spec);
    } else if (!isTypeOnly) {
      bare.push(spec);
    }
  }
  return { relatives, bare };
}

/** One import edge, addressed the way an allowlist entry has to address it: the importing file
 *  (relative to `srcDir`) plus the exact specifier it writes. */
export interface ImportEdge {
  /** Importing file, relative to `srcDir` — e.g. `runtime/loaders/textureResolver.ts`. */
  file: string;
  /** The specifier as written — e.g. `../rendering/capsProbeRenderer`. */
  spec: string;
}

export interface ClosureResult {
  /** Every file reached, relative to `srcDir`. */
  visited: string[];
  /** `importer → forbidden specifier` for each hit, with the chain that reached the importer. */
  offenders: string[];
}

/** Walk the relative-import closure from `entries` and report every FORBIDDEN bare specifier
 *  reached. `skipEdges` are not followed — for edges a build-time flag makes unreachable; the
 *  CALLER owes a separate assertion that each skipped edge really is gated, or the allowlist
 *  becomes a way to silence the guard. */
export function walkClosure(opts: {
  srcDir: string;
  entries: string[];
  forbidden: readonly string[];
  skipEdges?: readonly ImportEdge[];
}): ClosureResult {
  const { srcDir, entries, forbidden } = opts;
  const skip = new Set((opts.skipEdges ?? []).map((e) => `${e.file}::${e.spec}`));
  const seen = new Set<string>();
  const offenders: string[] = [];
  /** How each file was first reached — turns a hit into a chain the reader can act on. */
  const cameFrom = new Map<string, string>();
  const queue = entries.map((e) => path.join(srcDir, e));

  const chainTo = (rel: string): string => {
    const chain = [rel];
    for (let hop = 0; hop < 32; hop++) {
      const prev = cameFrom.get(chain[chain.length - 1]);
      if (!prev) break;
      chain.push(prev);
    }
    return chain.reverse().join(' → ');
  };

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(srcDir, file);
    const { relatives, bare } = importsOf(file);
    for (const b of bare) {
      if (forbidden.includes(b)) offenders.push(`${b}\n     via ${chainTo(rel)}`);
    }
    for (const r of relatives) {
      if (skip.has(`${rel}::${r}`)) continue;
      const resolved = resolveRelative(file, r);
      if (!resolved) continue;
      const resolvedRel = path.relative(srcDir, resolved);
      if (!cameFrom.has(resolvedRel)) cameFrom.set(resolvedRel, rel);
      queue.push(resolved);
    }
  }
  return { visited: [...seen].map((f) => path.relative(srcDir, f)), offenders };
}
