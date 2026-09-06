/** Guard: the §5 closed error-code set stays closed, and every code in it is actually EMITTED
 *  somewhere real — not merely declared.
 *
 *  Why this exists (QA-TOOL-0003): `docs/mcp-tool-conventions.md` §5 documents a CLOSED set of
 *  failure codes, and `ERROR_CODES` (`engine/tools/shared/mcpResult.ts`) is its single source of
 *  truth. Three codes — `AMBIGUOUS`, `AMBIGUOUS_SURFACE`, `OCCLUDED` — sat in that set for months
 *  with no call site that ever produced them: every refusal they were meant to name (an ambiguous
 *  `name`, a missing `surface`, a click a surface's own hit-test would refuse) arrived as the
 *  generic `REFUSED_BY_OP` instead, indistinguishable from any other refusal without
 *  string-matching prose — exactly what a closed code set exists to prevent. MEASURED live: with
 *  two entities named `DUP_probe`, both `modoki_set_transform {entity:{name:'DUP_probe'}}` and
 *  `modoki_tap {entity:{name:'DUP_probe', surface:'game-3d'}}` returned `error.code =
 *  'REFUSED_BY_OP'`.
 *
 *  A source guard is the right shape (same rationale as `mcpFormatterGuard.test.ts`): the
 *  invariant is a property of the SURFACE ("every documented code has a real producer"), not of
 *  any one call site, so no per-tool test would catch a code quietly going stale. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../../tools/shared/mcpResult';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs/mcp-tool-conventions.md');

/** Parse the `Closed code set (…): \`A\` · \`B\` · …` line straight out of the doc, rather than
 *  hand-copying it into the test — a hand-copied list is exactly the kind of second source that
 *  goes stale the moment either side is edited alone. */
function docCodes(): string[] {
  const src = fs.readFileSync(DOC_PATH, 'utf-8');
  const m = src.match(/Closed code set[^:]*:\s*([\s\S]*?)\.\n/);
  if (!m) throw new Error(`could not find the "Closed code set" line in ${DOC_PATH} §5 — has it been reworded?`);
  return [...m[1].matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]);
}

/** Where a code can legitimately be EMITTED (as opposed to merely declared in `ERROR_CODES`
 *  itself). Matches the four surfaces named in the QA-TOOL-0003 brief. */
const SCAN_DIRS = ['tools/modoki-mcp/src', 'tools/shared', 'app', 'plugins'].map((d) => path.join(REPO_ROOT, 'engine', d));

/** Every `.ts`/`.tsx` across all of `SCAN_DIRS`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 169 measured today. */
function allSourceFiles(dirs: string[]): string[] {
  return repoFiles({ under: dirs, match: /\.(ts|tsx)$/, floor: 100 }).map(({ abs }) => abs);
}

/** The DECLARATION — not the whole file — is excluded from the reachability scan. Matching
 *  `ERROR_CODES`'s own array (and its per-entry explanatory comments) against itself would make
 *  every code trivially "reachable" without a single call site ever producing it, which is the
 *  exact defect this guard exists to catch. But `mcpResult.ts` is also a legitimate PRODUCER —
 *  `encode()` stamps `code:'TOO_LARGE'` into the over-cap envelope — so excluding the file
 *  wholesale would make that real emission invisible and demand a fake one elsewhere. Cut the
 *  declaration block out and scan what is left. */
const MCP_RESULT_PATH = path.join(REPO_ROOT, 'engine/tools/shared/mcpResult.ts');

function withoutDeclaration(src: string): string {
  const start = src.indexOf('export const ERROR_CODES');
  if (start === -1) throw new Error('ERROR_CODES declaration not found in mcpResult.ts — has it moved?');
  const end = src.indexOf('] as const;', start);
  if (end === -1) throw new Error('ERROR_CODES declaration is not the expected `[…] as const;` array');
  return src.slice(0, start) + src.slice(end);
}

describe('the §5 error-code set (docs/mcp-tool-conventions.md) stays closed and reachable', () => {
  it('the doc\'s closed set and ERROR_CODES agree exactly, in both directions', () => {
    expect([...docCodes()].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('sources() actually finds real files (this guard must not fail open)', () => {
    const found = allSourceFiles(SCAN_DIRS);
    expect(found.length).toBeGreaterThan(50);
  });

  /** The one code set that CANNOT import `ERROR_CODES`: `sceneMutate.ts` lives in
   *  `@modoki/engine`'s published root (`rootDir: "./src"`), so a relative import escaping to
   *  `engine/tools/shared` would break its build. It therefore spells the values out locally,
   *  and its docstring claimed the reachability guard below kept them honest — it does not.
   *  That guard's SCAN_DIRS never included `packages/modoki/src`, and it passes for an
   *  unrelated reason: the same two literals also appear in `app/debug/entityResolve.ts`. A
   *  typo in the duplicated union would have gone uncaught. This is the check that actually
   *  enforces the claim. (Found by the close-out review of the commit that added it.) */
  it('sceneMutate.ts\'s locally-spelled EntityResolveCode is a real subset of ERROR_CODES', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'engine/packages/modoki/src/runtime/scene/sceneMutate.ts'), 'utf-8');
    const m = src.match(/export type EntityResolveCode\s*=([^;]+);/);
    expect(m, 'EntityResolveCode declaration not found — has it moved or been renamed?').toBeTruthy();
    const codes = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(codes.length, 'parsed no members out of the union').toBeGreaterThan(0);
    const strays = codes.filter((c) => !(ERROR_CODES as readonly string[]).includes(c));
    expect(
      strays,
      `EntityResolveCode names ${strays.join(', ')}, which ERROR_CODES does not — the two ` +
      `sets have drifted. The duplication is deliberate (see that file's comment); keeping ` +
      `it honest is this test's job.`,
    ).toEqual([]);
  });

  it('every code in ERROR_CODES is emitted by a real call site, not just declared', () => {
    // A quoted literal (`'CODE'`) is deliberately the bar, not a bare word — the codes are used
    // as string literal values (`code: 'AMBIGUOUS'`), and matching bare identifiers would also
    // match the code's own name inside an unrelated comment or variable name.
    const files = allSourceFiles(SCAN_DIRS);
    const sources = files.map((f) => {
      const src = fs.readFileSync(f, 'utf-8');
      return f === MCP_RESULT_PATH ? withoutDeclaration(src) : src;
    });

    const unreachable = ERROR_CODES.filter((code) => !sources.some((src) => src.includes(`'${code}'`)));
    expect(
      unreachable,
      `these ERROR_CODES entries have no emitting call site outside their own declaration: ` +
      `${unreachable.join(', ')}. A documented-but-unemitted code is a claim the caller can react ` +
      `to that the surface never actually makes — either wire a producer for it, or it should not ` +
      `be in the closed set.`,
    ).toEqual([]);
  });
});
