/** Guard: every tsconfig that COMPILES files opts out of ambient `@types` hoovering.
 *
 *  `tsc` auto-includes every `@types/*` package it can see unless `skipLibCheck` or an
 *  explicit `types` array says otherwise. That makes a build depend on packages it never
 *  imports — including transitive ones nobody chose.
 *
 *  Measured 2026-08-02 (merging origin/win): the #57 dep bump hoisted `minimatch`
 *  3.1.5 → 10.2.5 to the repo root. Nothing here asks for `@types/glob`, but
 *  `@gltf-transform/cli` drags in `@types/glob@8.1.0` — deprecated and frozen, since glob
 *  ships its own types from v9 — which still references `minimatch.IOptions` /
 *  `minimatch.IMinimatch`, dropped in v10. The four tsconfigs with neither opt-out (the
 *  only four in the repo) all died on a type error inside a package none of them import.
 *
 *  Why that is worse than a build break: it happens in `postinstall` → `build:plugins`, so
 *  `npm install` could not complete, and `bootstrap-game-deps.mjs` SWALLOWED the per-game
 *  half and reported success — leaving `capacitor-adjust` with a `dist/esm` (tsc ran) but
 *  no `dist/plugin.cjs.js` (rollup never did). A half-built dist reads as present, and the
 *  failure resurfaced downstream as `Failed to resolve import "capacitor-adjust"`, which is
 *  CLAUDE.md RULE 1's symptom for a MISSING dist — sending you back to re-run the install
 *  that just claimed it worked.
 *
 *  The rule: a tsconfig with `include`/`files` (i.e. one that compiles something) must set
 *  `skipLibCheck` or `types`, directly or through `extends`. Solution-style configs
 *  (`"files": []` + `references`) compile nothing and are exempt by construction. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(__dirname, '../../..');

/** Roots that hold FIRST-PARTY tsconfigs. `release/`, `node_modules/` and `dist/` are build
 *  output and vendored code — gitignored, not ours to fix, and present only on some machines, so
 *  git enumeration (#771/#799) excludes them for free rather than needing a skip-list entry. */
const ROOTS = ['engine', 'games', 'demos'] as const;

// `floor: 0` deliberately: this runs at MODULE scope, and a checkout shipping neither `games/`
// nor `demos/` (the public OSS snapshot) must not fail COLLECTION over it — the real non-vacuity
// pin is the `.length > 5` sanity test below, which still holds against `engine/` alone.
function tsconfigs(): string[] {
  return repoFiles({
    under: [...ROOTS],
    match: (rel) => /^tsconfig.*\.json$/.test(rel.split('/').pop()!),
    exclude: ['node_modules', 'dist', 'release'],
    floor: 0,
  }).map(({ abs }) => abs).sort();
}

/** JSON with comments — tsconfigs are jsonc in practice, and this repo's use BOTH `//` and
 *  `/* *\/` (engine/tsconfig.app.json has a `/* Bundler mode *\/` header).
 *
 *  A regex stripper is not good enough here, and that is not a hypothetical: the first cut
 *  of this guard stripped only `//`, so every config with a block comment failed to parse,
 *  fell into a `catch` that returned "no opt-out", and was reported as an OFFENDER — with
 *  `engine/tsconfig.app.json`, which sets both `skipLibCheck` AND `types`, at the top of
 *  the list. A guard that misreads its input accuses the wrong file. Hence a real scanner
 *  that tracks string state, so a `//` inside a path is not mistaken for a comment.
 *
 *  Parse failure THROWS rather than returning a default: an unreadable config is a broken
 *  guard, and it must say so instead of quietly becoming a finding. */
function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

function readJsonc(file: string): Record<string, unknown> {
  const raw = stripJsonComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`could not parse ${path.relative(repoRoot, file)}: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}

/** Walks the `extends` chain — an opt-out inherited from a base config counts. */
function optsOut(file: string, seen = new Set<string>()): boolean {
  const abs = path.resolve(file);
  if (seen.has(abs)) return false; // cyclic extends — treat as no opt-out rather than hang
  seen.add(abs);
  // A MISSING base (a path we cannot resolve) is "no opt-out"; a malformed one throws via
  // readJsonc, because that is a broken guard rather than a finding.
  if (!fs.existsSync(abs)) return false;
  const json = readJsonc(abs);
  const co = (json.compilerOptions ?? {}) as Record<string, unknown>;
  if (co.skipLibCheck === true || Array.isArray(co.types)) return true;
  const ext = json.extends;
  if (typeof ext !== 'string' || ext.startsWith('@') || !ext.startsWith('.')) return false;
  const target = ext.endsWith('.json') ? ext : `${ext}.json`;
  return optsOut(path.join(path.dirname(abs), target), seen);
}

/** Compiles nothing → cannot pull in ambient types. */
function isSolutionConfig(file: string): boolean {
  const json = readJsonc(file);
  const files = json.files;
  return Array.isArray(files) && files.length === 0 && Array.isArray(json.references);
}

describe('tsconfigs opt out of ambient @types', () => {
  it('every compiling tsconfig sets skipLibCheck or types', () => {
    const offenders = tsconfigs()
      .filter((f) => !isSolutionConfig(f))
      .filter((f) => !optsOut(f))
      .map((f) => path.relative(repoRoot, f));
    expect(
      offenders,
      'these compile against every @types/* in node_modules, so an unrelated transitive ' +
        'types package can break their build — set "skipLibCheck": true (or an explicit "types")',
    ).toEqual([]);
  });

  it('finds the tsconfigs it claims to (the walker is not silently empty)', () => {
    // A guard that scans zero files passes cheerfully — the exact failure mode
    // testTypecheckCoverage.test.ts exists to prevent for the typecheck programs.
    expect(tsconfigs().length).toBeGreaterThan(5);
  });
});
