/**
 * No asset GUID may be DEFINED in two projects (#1584).
 *
 * A dev scan of the monorepo manifest (`buildManifest(…, heal=true)` in
 * `engine/plugins/vite-asset-scanner.ts`) resolves a duplicate GUID by keeping it on the
 * lexicographically-FIRST path and writing a fresh id into every other file. It rewrites only the
 * asset's own id, never the references to it — so when a project is copied verbatim, the heal
 * re-mints whichever copy sorts LATER. For `games/slime-shooter` copied from `games/wordweave`,
 * that was Weaveling: its scenes would have kept the old GUIDs, which then resolve only to the
 * copy's files, and a Weaveling production build (flat scan, one project) drops those assets.
 * Sprite-slice GUIDs have no file of their own, so the heal never reaches them at all.
 *
 * `assetRefIntegrity.test.ts` cannot see this: it resolves refs against ONE repo-wide GUID set, so
 * a cross-project ref passes. Hence this guard — duplicates within a single project are the
 * heal's business; duplicates ACROSS projects are always a copy that was not re-minted.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { readAssetGuid, detectType } from '../../plugins/vite-asset-scanner';
import { projectAssetRoots } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject } from '../helpers/repoLayout';

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

describe('asset GUIDs are unique across projects (#1584)', () => {
  it('crossProjectDuplicates flags a GUID two projects define, and not one defined once each', () => {
    const a = { project: 'games/a', guids: new Map([['g1', 'x.png'], ['g2', 'y.png']]) };
    const b = { project: 'games/b', guids: new Map([['g1', 'x.png'], ['g3', 'z.png']]) };
    expect([...crossProjectDuplicates([a, b]).keys()]).toEqual(['g1']);
    expect(crossProjectDuplicates([a, { project: 'games/b', guids: new Map([['g3', 'z.png']]) }]).size).toBe(0);
  });

  it.skipIf(!hasAnyProject())('no GUID is defined in two projects', () => {
    const perProject = projectAssetRoots(REPO_ROOT).map((r: { urlPrefix: string; absDir: string }) => ({
      project: r.urlPrefix.replace(/\/assets$/, '').slice(1),
      guids: definedGuids(r.absDir),
    }));
    // Sanity: the scan found GUIDs at all, or an empty scan would pass vacuously.
    expect(perProject.reduce((n, p) => n + p.guids.size, 0)).toBeGreaterThan(0);
    const dups = crossProjectDuplicates(perProject);
    expect([...dups].slice(0, 20).map(([g, where]) => `${g} ← ${where.join(' | ')}`)).toEqual([]);
  });
});
