/**
 * #1376 — a game or demo re-acquires a runtime prefab through `requestPrefab`, never a hand-written
 * latch around `acquirePrefab`.
 *
 * Seven spawners across four projects hand-copied that latch from prose in docs/prefabs.md, and
 * every copy got at least one of its three pieces of state wrong (no in-flight dedup #1373, a
 * `.catch` that can never fire #1375, a give-up on the first transient failure #1359). The engine
 * helper carries all three once; this guard is what keeps the eighth spawner from writing its own.
 *
 * A direct `acquirePrefab(` call is allowed only in a preload that AWAITS a batch — that is not a
 * latch, it is a load — and each allowed site is listed below by file and enclosing function, with
 * why. Found by the AST, not a regex, so a mention in a comment or a string is not a call.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { calleeName, enclosingFunction, findNodes, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject, hasInternalGames } from '../helpers/repoLayout';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** One row per direct call, keyed `file::function`, SPENT per occurrence. */
const EXEMPT: { item: string; count?: number; reason: string }[] = [
  { item: 'games/sling/runtime/systems.ts::loadField', count: 4,
    reason: 'bootstrap preload: every kit, brush, fence and ramp prefab awaited in one Promise.all before the field builds' },
  { item: 'games/sling/runtime/systems.ts::slingSystem',
    reason: 'bootstrap preload: the enemy prefabs and the wave chart load as one task set, and prefabsReady waits for all of it' },
];

/** ⚠️ The OSS snapshot ships no `games/`, so a row naming one is unsatisfiable there (see
 *  gitReadIsBounded.test.ts for the incident that taught this). */
const rootIsPresent = (item: string): boolean => hasInternalGames() || !item.startsWith('games/');

function functionName(n: ts.Node): string {
  const fn = enclosingFunction(n);
  if (ts.isSourceFile(fn)) return '<module>';
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  // An arrow or function expression: name it by what it is assigned to, else by ITS enclosing one.
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText();
  if (p && ts.isPropertyAssignment(p)) return p.name.getText();
  return functionName(fn);
}

interface Site { key: string; line: number }

export function directAcquireSites(code: string, rel: string): Site[] {
  const sf = parseSource(code, rel);
  return findNodes(sf, ts.isCallExpression)
    .filter((c) => calleeName(c) === 'acquirePrefab')
    .map((c) => ({ key: `${rel}::${functionName(c)}`, line: lineOf(c) }));
}

// Only where a game or demo exists to scan — the public engine snapshot ships neither.
const files = hasAnyProject() ? repoFiles({
  under: [path.join(REPO_ROOT, 'games'), path.join(REPO_ROOT, 'demos')],
  match: /\.tsx?$/,
  exclude: ['node_modules', 'dist', 'tests', 'ios', 'android'],
  // 276 here today (20 of them demos); floored far under, so only a broken enumeration trips it.
  // The OSS snapshot ships two demos with 4 files between them, so there the floor only rejects zero.
  floor: hasInternalGames() ? 200 : 1,
}).map(({ abs }: { abs: string }) => abs) : [];

const sites = files.flatMap((abs) => {
  const code = fs.readFileSync(abs, 'utf8');
  if (!code.includes('acquirePrefab')) return [];
  return directAcquireSites(code, path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
});

describe('#1376 — runtime prefab re-acquires go through requestPrefab', () => {
  it.skipIf(!hasAnyProject())('no game or demo calls acquirePrefab outside an awaited batch preload', () => {
    assertExemptionLedger({
      label: 'EXEMPT in prefabRequestSites',
      population: sites.map((s) => ({ item: s.key, site: `${s.key.split('::')[0]}:${s.line}` })),
      exempt: EXEMPT.filter((r) => rootIsPresent(r.item)),
      scanned: files.length,
      floor: hasInternalGames() ? 200 : 1,
      fix: 'Re-acquire a runtime prefab with requestPrefab(owner, guid, { world }) from @modoki/engine/runtime —\n'
        + 'it carries the in-flight dedup, the give-up budget and the report that every hand-written latch\n'
        + 'got wrong (#1376). See docs/prefabs.md § "A prefab EDIT replaces the runtime cache entry".',
    });
  });

  it('the detector sees a call, and only a call', () => {
    const code = [
      '// acquirePrefab(OWNER, guid) in a comment',
      "const s = 'acquirePrefab(OWNER, guid)';",
      'function spawn() { void acquirePrefab(OWNER, guid).finally(() => {}); }',
      'const heal = () => engine.acquirePrefab(OWNER, guid);',
    ].join('\n');
    expect(directAcquireSites(code, 'x.ts').map((s) => s.key)).toEqual(['x.ts::spawn', 'x.ts::heal']);
  });
});
