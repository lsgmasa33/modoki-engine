/** IMPORT-ORDER INDEPENDENCE GUARD — `docs/architecture-layers.md` (P2 of the module-boundaries layering work).
 *
 *  `barrelLiveness.test.ts` proves the runtime graph initializes cleanly under ONE
 *  module-evaluation order: the one you get when `runtime/index.ts` is the first thing loaded.
 *  That is not the only order that happens in practice. The editor imports
 *  `@modoki/engine/editor`, a test imports `runtime/core/pipeline` directly, a game's
 *  `setup.ts` pulls a trait, the Vite dev server splits chunks differently from the prod build —
 *  each makes some OTHER module the first one evaluated.
 *
 *  An ESM cycle is order-sensitive. In a cycle A → B → A, whichever module is entered FIRST
 *  finishes last, so exactly one of the two orders hands out an `undefined` binding. A cycle
 *  that only breaks under the "B first" order is invisible to every other test in the suite —
 *  including the liveness test, which always enters at the barrel. That is precisely the bug
 *  class the P3–P7 file moves can introduce (moving a file changes nothing about the code, but
 *  it can change which import statement in the barrel reaches a given module first).
 *
 *  METHOD — one iteration per entry module:
 *    1. `vi.resetModules()`   → empty module registry (verified: this really does re-evaluate
 *                               the whole runtime graph, not serve a cached copy — the
 *                               `instanceGuard` counter increments on every iteration).
 *    2. import the ENTRY module first (so it, and everything it transitively pulls, is
 *       evaluated before the barrel's own import list is walked).
 *    3. import the barrel.
 *    4. re-run the liveness assertion (every named export defined).
 *
 *  ENTRY SET — derived at run time, not hardcoded. The entries are every relative specifier
 *  `runtime/index.ts` itself imports/re-exports (≈130 modules across all 20 top-level folders
 *  plus the loose root files), resolved to real files. Deriving it from the barrel source is
 *  deliberate: P3/P6 move these files wholesale, and a hardcoded list would either rot or have
 *  to be edited in the same commit as the move it is supposed to police. A folder that gains an
 *  entry point mid-refactor is picked up automatically.
 *
 *  Cost: ~6 ms per iteration after the first (Vite's transform cache survives `resetModules`),
 *  so the full sweep is well under a second.
 *
 *  KNOWN GAP (deliberate, documented rather than silently skipped): the entry set covers modules
 *  the barrel REACHES. A module that no barrel path touches — e.g. `rendering/Scene3D.tsx`, which
 *  consumers import through the separate `@modoki/engine/runtime/rendering` entry — is not used as
 *  a first-entry here. Those cannot participate in a cycle that breaks the BARREL's exports (if
 *  they could, the barrel would import them), but a cycle purely among them would go unseen.
 *  Widening this to all ~348 runtime files was rejected for now: many are `.tsx`/`three/webgpu`
 *  modules that do not import in the node test env, and the resulting failures would be
 *  environmental noise rather than signal.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(HERE, '../../src/runtime');
const BARREL = path.join(RUNTIME_ROOT, 'index.ts');

/** Top-level folder a runtime file belongs to; a file directly at `runtime/` root is grouped
 *  under `<root>` (those are `config`, `version`, `appServices`, … — P3c moves them into
 *  `core/`, at which point they simply start reporting under `core`). */
function groupOf(absFile: string): string {
  const rel = path.relative(RUNTIME_ROOT, absFile);
  const parts = rel.split(path.sep);
  return parts.length === 1 ? '<root>' : parts[0];
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Every relative specifier the barrel statically imports or re-exports, resolved to a file.
 *  `import type` / `export type` statements are INCLUDED on purpose: they are erased at
 *  compile time, but this test is about what happens when the module is loaded FIRST, and a
 *  type-only re-export still names a module a consumer may legitimately enter at. */
function barrelEntries(): string[] {
  const src = fs.readFileSync(BARREL, 'utf8');
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:import|export)[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) specs.add(m[1]); // side-effect import
  const files = new Set<string>();
  for (const s of specs) {
    const r = resolveSpecifier(BARREL, s);
    if (r && r !== BARREL) files.add(r);
  }
  return [...files].sort();
}

/** Fallback entry for a top-level folder the barrel never reaches: its own `index.ts`, if any. */
function folderIndexEntries(covered: Set<string>): { entries: string[]; untestable: string[] } {
  const entries: string[] = [];
  const untestable: string[] = [];
  for (const d of fs.readdirSync(RUNTIME_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || covered.has(d.name)) continue;
    const idx = path.join(RUNTIME_ROOT, d.name, 'index.ts');
    if (fs.existsSync(idx)) entries.push(idx);
    else untestable.push(d.name);
  }
  return { entries, untestable };
}

const fromBarrel = barrelEntries();
const coveredGroups = new Set(fromBarrel.map(groupOf));
const { entries: fallbacks, untestable } = folderIndexEntries(coveredGroups);
const ALL_ENTRIES = [...fromBarrel, ...fallbacks];

/** entry file -> group, grouped for readable per-folder test cases. */
const BY_GROUP = new Map<string, string[]>();
for (const f of ALL_ENTRIES) {
  const g = groupOf(f);
  if (!BY_GROUP.has(g)) BY_GROUP.set(g, []);
  BY_GROUP.get(g)!.push(f);
}
const GROUPS = [...BY_GROUP.keys()].sort();

/** Import `entry` into a fresh module registry, THEN the barrel, and return the names of any
 *  barrel export that came out `undefined`. */
async function undefinedExportsWithEntryFirst(entry: string): Promise<string[]> {
  vi.resetModules();
  // `instanceGuard` console.errors on every re-evaluation of the barrel (it counts copies of the
  // runtime). Re-evaluating IS the point here, so reset its counter to keep the run quiet — this
  // is test-local global state, not a change to the guard's behaviour.
  (globalThis as Record<string, unknown>).__MODOKI_RUNTIME_INSTANCES__ = 0;
  await import(/* @vite-ignore */ entry);
  const mod = (await import(/* @vite-ignore */ BARREL)) as Record<string, unknown>;
  return Object.keys(mod).filter((k) => mod[k] === undefined).sort();
}

describe('runtime barrel — import-order independence', () => {
  it('derives a non-trivial entry set covering every top-level runtime folder', () => {
    expect(ALL_ENTRIES.length).toBeGreaterThan(100);
    const onDisk = fs
      .readdirSync(RUNTIME_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    // Any folder listed here has NO entry point this test can enter at — record it in the plan
    // doc rather than letting it disappear silently.
    expect(untestable, 'top-level runtime folders with no barrel-reachable module and no index.ts').toEqual([]);
    for (const folder of onDisk) expect(GROUPS, `folder ${folder} has no entry module`).toContain(folder);
  });

  describe.each(GROUPS)('entering at %s', (group) => {
    it('leaves every barrel export defined', async () => {
      const broken: Record<string, string[]> = {};
      for (const entry of BY_GROUP.get(group)!) {
        const bad = await undefinedExportsWithEntryFirst(entry);
        if (bad.length) broken[path.relative(RUNTIME_ROOT, entry)] = bad;
      }
      expect(
        broken,
        'Importing these modules BEFORE the barrel left some barrel exports `undefined` — an ' +
          'order-sensitive ESM circular import. The listed exports are the victims, not the ' +
          'cause: find the cycle that contains the entry module (docs/architecture-layers.md, ' +
          'engine/tests/architecture/cycles-baseline.json) and invert it.',
      ).toEqual({});
    });
  });
});
