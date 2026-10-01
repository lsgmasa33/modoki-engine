/** #1937 C-A step 7, T12: every place a prefab document enters a cache, or a Node reader predicts derived guids from one,
 *  reads it ADMITTED (`admitPrefabDocument`): a document declaring an identifier twice is refused there, and a keyless
 *  template node carries the key every other reader mints for it (I7). A census, as `rowLookupCensus.test.ts` is: the
 *  shape check (`isPrefabDocument`) marks a seat, so a file asking it must admit too, and a NEW one is a seat to review
 *  — add it here once it admits.
 *
 *  ⚠️ FILE-granular, not per call site: a second seat added to a file that already admits is not caught (a mutation that
 *  bypassed `admitAtSeat` at one call in meshTemplateCache.ts stayed green). The seats' own tests carry that
 *  (`documentIdentitySeats.test.ts`). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const ENGINE = path.resolve(__dirname, '../..');
const ADMITS = /\b(admitPrefabDocument|admitAtSeat|admittedPrefab)\(/;

/** Production source under engine/ (tests excluded: a test may ask the shape check of a fixture). */
const files = (): string[] => repoFiles({ under: ['engine/packages/modoki/src', 'engine/plugins', 'engine/app', 'engine/electron', 'engine/tools'], match: /\.(ts|tsx|mts)$/, exclude: ['node_modules', 'dist'], floor: 500 })
  .filter(({ rel }: { rel: string }) => !rel.endsWith('.d.ts'))
  .map(({ abs }: { abs: string }) => abs);
const rel = (p: string) => path.relative(ENGINE, p).split(path.sep).join('/');

/** The seats, each reviewed: it admits what it seats — a two-way exact baseline (a new file asking the shape check, or
 *  a listed one that stopped asking, fails). The definitions are not seats. */
const SEATS = new Set([
  'packages/modoki/src/runtime/loaders/meshTemplateCache.ts',
  'packages/modoki/src/editor/scene/prefabCommit.ts',
  'packages/modoki/src/editor/scene/prefabCache.ts',
  'plugins/asset-tree-shaker.ts',
  'plugins/backend/prefabIdentityGuard.ts',
]);
/** The shape check's definition, and admission itself (it asks the shape check first). */
const DEFINITIONS = new Set(['packages/modoki/src/runtime/loaders/prefabDocumentShape.ts', 'packages/modoki/src/runtime/loaders/documentIdentity.ts']);

describe('every prefab seat and Node reader admits what it reads (#1937 T12)', () => {
  const sources = files();

  // Mutation: add an `isPrefabDocument(` call to another runtime file — it is listed here; drop `admitAtSeat` from
  // meshTemplateCache — it is listed as not admitting.
  it('a file asking the shape check is a reviewed seat, and it admits', () => {
    const asking = sources.filter((f) => /\bisPrefabDocument\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(asking.sort(), 'a new seat: make it admit, then list it; a listed one that no longer asks: drop it').toEqual([...SEATS, ...DEFINITIONS].sort());
    expect([...SEATS].filter((f) => !ADMITS.test(fs.readFileSync(path.join(ENGINE, f), 'utf8'))), 'a seat that does not admit').toEqual([]);
  });

  /** The body of the first `{…}` block after `marker`, by brace count (string contents do not hold braces here). */
  const bodyAfter = (text: string, marker: string): string => {
    const at = text.indexOf(marker);
    expect(at, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
    const open = text.indexOf('{', at + marker.length);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
    }
    return '';
  };

  // Close-out review #3: the walk reports, the BUILD hook throws (the walk also serves the editor's Clean Up, which must
  // answer). Mutation: drop the throw from vite-asset-scanner's build hook — a damaged prefab ships.
  it('the production build throws on the walk\'s damaged prefabs', () => {
    const scanner = fs.readFileSync(path.join(ENGINE, 'plugins/vite-asset-scanner.ts'), 'utf8');
    expect(scanner).toMatch(/const damagedError = damagedPrefabBuildError\(result\);\s*if \(damagedError\) throw damagedError;/);
  });

  // Mutations: either reader returns its raw parse (no `admittedPrefab`) — named here.
  it('the Node readers that predict derived guids admit: the remint/validate resolver and /api/validate-prefab\'s', () => {
    const router = fs.readFileSync(path.join(ENGINE, 'plugins/backend/editorBackendRouter.ts'), 'utf8');
    expect(bodyAfter(router, 'export function makePrefabResolver(ctx: BackendContext): PrefabResolver')).toMatch(ADMITS);
    expect(bodyAfter(router, "if (urlPath === '/api/validate-prefab' && method === 'GET')")).toMatch(ADMITS);
  });
});
