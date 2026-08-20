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

/** Repo-relative paths this walker EMITS and MATCHES ON are always POSIX-separated.
 *
 *  Why this exists: `path.relative` returns `runtime\loaders\x.ts` on Windows, while every
 *  allowlist that consumes this walker is written with forward slashes (an `ImportEdge.file` is
 *  source text, not a filesystem path). Without normalizing, `skipEdges` matched NOTHING on
 *  Windows — so each guard followed the very edges its allowlist exempts, reported them as
 *  offenders, and failed. It was invisible on macOS and Linux, and it is why
 *  `render3dBoundary.test.ts` was red on `check (windows-latest)` while ubuntu passed.
 *  It broke both directions at once: the skip lookup missed, AND the caller's
 *  `offenders.some(o => o.includes(file))` could not match a backslash chain against a
 *  forward-slash entry.
 *
 *  Normalize at the ONE seam where a filesystem path becomes a comparable identity, so a caller
 *  can never reintroduce it by forgetting.
 *
 *  ⚠️ It splits on BOTH separators rather than on `path.sep`, and that is the difference between
 *  a fix and a fix nobody can check. A `path.sep` version is a no-op on macOS/Linux, so its test
 *  would pass on every machine that cannot reproduce the bug — vacuous exactly where the defect
 *  lives. Splitting on `[\\/]` makes the behaviour platform-independent and lets the unit test
 *  below feed it a Windows path from any OS. */
export const toPosix = (p: string): string => p.split(/[\\/]/).join('/');

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
  const add = (spec: string, isTypeOnly: boolean) => {
    if (isTypeOnly) return;
    if (spec.startsWith('.')) relatives.push(spec);
    else bare.push(spec);
  };
  const re = /(?:^|\n)\s*(import\s+type\s+)?[^\n;]*?(?:from|import\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) add(m[2], Boolean(m[1]));
  // Side-effect imports (`import 'x'` — no bindings, so no `from`) need their own pass: the regex
  // above is anchored on `from`/`import(` and cannot see them. It is a SEPARATE pass rather than
  // another alternation so it cannot perturb the matching above. This shape is exactly how a
  // polyfill or a registration module gets pulled in, and missing it made the walker answer
  // "nothing reaches three/webgpu" about a file that imports it outright — silently, which is the
  // failure mode these guards exist to prevent.
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]\s*;?/g;
  while ((m = sideEffect.exec(src)) !== null) add(m[1], false);
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
    const rel = toPosix(path.relative(srcDir, file));
    const { relatives, bare } = importsOf(file);
    for (const b of bare) {
      if (forbidden.includes(b)) offenders.push(`${b}\n     via ${chainTo(rel)}`);
    }
    for (const r of relatives) {
      if (skip.has(`${rel}::${r}`)) continue;
      const resolved = resolveRelative(file, r);
      if (!resolved) continue;
      const resolvedRel = toPosix(path.relative(srcDir, resolved));
      if (!cameFrom.has(resolvedRel)) cameFrom.set(resolvedRel, rel);
      queue.push(resolved);
    }
  }
  return { visited: [...seen].map((f) => toPosix(path.relative(srcDir, f))), offenders };
}
