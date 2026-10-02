/**
 * No asset GUID may be DEFINED in two asset roots (#1584, #2005) — two projects, or a project and the engine's
 * built-in root.
 *
 * A dev scan of the monorepo manifest (`buildManifest(…, heal=true)` in `engine/plugins/vite-asset-scanner.ts`)
 * resolves a duplicate GUID by keeping it on ONE file — the prior owner its machine-local record names (#1996), or,
 * with no decisive record, an engine built-in and then the path that sorts first — and writing a fresh id into every
 * other file. It rewrites only the asset's own id, never the references to it — so when a project is copied verbatim,
 * the heal can re-mint the ORIGINAL. For `games/slime-shooter` copied from `games/wordweave`, path order picked
 * Weaveling: its scenes would have kept the old GUIDs, which then resolve only to the copy's files, and a Weaveling
 * production build (flat scan, one project) drops those assets. Sprite-slice GUIDs had no heal at all before #1996.
 * So the heal never touches a cross-project pair (`manifestProjectOf` differs) and leaves it to this guard.
 *
 * ⚠️ **The engine root is one of the roots (#2005).** The repo-root host sees `/modoki/…` and `/games/<id>/…` as two
 * projects and heals nothing, but the editor opened on that game serves it at `/assets/…`, which is the same project
 * (`''`) as `/modoki/…` — so that editor DOES heal the pair. Its record is machine-local, so every clone's editor heals
 * a committed engine↔game duplicate on its own, each writing its own `randomUUID()` into the same committed file: git
 * churn and a merge conflict between the worker branches, and when the engine copy is the one re-minted, a committed
 * built-in changing its id. Failing `verify` here makes the one deliberate re-mint happen on the clone that made the
 * copy.
 *
 * `assetRefIntegrity.test.ts` cannot see this: it resolves refs against ONE repo-wide GUID set, so a cross-project ref
 * passes. Hence this guard — duplicates within a single root are the heal's business; duplicates ACROSS roots are
 * always a copy that was not re-minted.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { readAssetGuid, detectType, resolveModokiAssetsDir } from '../../plugins/vite-asset-scanner';
import { projectAssetRoots } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject } from '../helpers/repoLayout';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every GUID defined under one project's `runtime/assets`: each asset's own id, plus the explicit
 *  sprite-slice GUIDs a texture sidecar carries (`sprites[].guid`). */
export function definedGuids(absDir: string): Map<string, string> {
  const out = new Map<string, string>(); // guid → repo-relative file
  for (const { rel, abs } of repoFiles({ under: absDir, match: (r: string) => !r.split('/').some((s) => s.startsWith('.')), floor: 0 })) {
    const type = detectType(rel, path.extname(rel).toLowerCase());
    if (!type) continue;
    const own = readAssetGuid(abs, type);
    if (own) out.set(own.toLowerCase(), rel);
    const sidecar = abs + '.meta.json';
    if (!fs.existsSync(sidecar)) continue;
    try {
      const sprites = (JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as { sprites?: Array<{ guid?: unknown }> }).sprites;
      for (const s of Array.isArray(sprites) ? sprites : []) {
        if (typeof s.guid === 'string' && GUID_RE.test(s.guid)) out.set(s.guid.toLowerCase(), `${rel} (sprite)`);
      }
    } catch { /* an unparseable sidecar is assetRefIntegrity's finding, not this guard's */ }
  }
  return out;
}

/** GUID → the projects defining it, for every GUID defined in more than one. */
export function crossProjectDuplicates(perProject: Array<{ project: string; guids: Map<string, string> }>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { project, guids } of perProject) {
    for (const [g, file] of guids) {
      const list = owners.get(g) ?? [];
      list.push(`${project}: ${file}`);
      owners.set(g, list);
    }
  }
  return new Map([...owners].filter(([, list]) => new Set(list.map((l) => l.split(':')[0])).size > 1));
}

/** The asset roots the guard compares: the engine's built-in root, then every project's (#2005). The engine root is
 *  resolved from `repoRoot` alone — never the scanner's other candidates (its own module URL, the cwd), which would find
 *  THIS checkout's engine for a fixture repo. */
export function guardedAssetRoots(repoRoot: string): Array<{ project: string; absDir: string }> {
  const engine = resolveModokiAssetsDir(repoRoot, '', repoRoot);
  return [
    ...(engine ? [{ project: 'engine', absDir: engine }] : []),
    ...projectAssetRoots(repoRoot).map((r: { urlPrefix: string; absDir: string }) => ({
      project: r.urlPrefix.replace(/\/assets$/, '').slice(1),
      absDir: r.absDir,
    })),
  ];
}

describe('asset GUIDs are unique across asset roots: projects and the engine built-ins (#1584, #2005)', () => {
  it('crossProjectDuplicates flags a GUID two projects define, and not one defined once each', () => {
    const a = { project: 'games/a', guids: new Map([['g1', 'x.png'], ['g2', 'y.png']]) };
    const b = { project: 'games/b', guids: new Map([['g1', 'x.png'], ['g3', 'z.png']]) };
    expect([...crossProjectDuplicates([a, b]).keys()]).toEqual(['g1']);
    expect(crossProjectDuplicates([a, { project: 'games/b', guids: new Map([['g3', 'z.png']]) }]).size).toBe(0);
  });

  it('the engine built-in root is a guarded root, so an engine↔game duplicate is flagged (#2005)', () => {
    // A fixture repo: today's corpus has no engine↔game pair, so the corpus test below cannot show the engine root is
    // compared at all. (`definedGuids` reads through `repoFiles`, which only walks THIS work tree, so the fixture stops
    // at the roots; the duplicate check over them is the generic one tested above.)
    const repo = makeScratchDir('guid-uniq-');
    try {
      for (const d of ['engine/packages/modoki/src/runtime/assets', 'games/x/runtime/assets', 'games/y/src']) {
        fs.mkdirSync(path.join(repo, d), { recursive: true });
      }
      const roots = guardedAssetRoots(repo);
      expect(roots).toEqual([
        { project: 'engine', absDir: path.join(repo, 'engine/packages/modoki/src/runtime/assets') },
        { project: 'games/x', absDir: path.join(repo, 'games/x/runtime/assets') },
      ]);
      const g = new Map([['g1', 'icons/star.png']]);
      const dups = crossProjectDuplicates(roots.map((r) => ({ project: r.project, guids: g })));
      expect(dups.get('g1')).toEqual(['engine: icons/star.png', 'games/x: icons/star.png']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasAnyProject())('no GUID is defined in two asset roots', () => {
    const roots = guardedAssetRoots(REPO_ROOT);
    // The engine root is what #2005 added; without it the guard is back to comparing projects only.
    expect(roots[0]?.project).toBe('engine');
    const perProject = roots.map((r) => ({ project: r.project, guids: definedGuids(r.absDir) }));
    // Sanity: the scan found GUIDs at all, or an empty scan would pass vacuously.
    expect(perProject.reduce((n, p) => n + p.guids.size, 0)).toBeGreaterThan(0);
    const dups = crossProjectDuplicates(perProject);
    expect([...dups].slice(0, 20).map(([g, where]) => `${g} ← ${where.join(' | ')}`)).toEqual([]);
  });
});
