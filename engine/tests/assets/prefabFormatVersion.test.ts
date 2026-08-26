/**
 * Every committed `.prefab.json` declares the ONE prefab format version the loader understands.
 *
 * ⚠️ **This exists because bumping it broke a shipping screen SILENTLY.** Court's #344 collapsed
 * `level-tile.prefab.json` from eight entities to four and set `"version": 2` on the file, reading
 * it as "revision 2 of this prefab". It is not that — it is the FORMAT marker, there is no prefab
 * migration ladder (unlike scenes, which have one up to v8 in `loadSceneFile.ts`), and every one of
 * the ~90 committed prefabs in this repo says `1`. The loader did not throw, did not warn, and did
 * not log: the prefab simply never cached, so `entryPrefabProvider.spawnInstance` returned 0
 * forever and the pooled level selector rendered an EMPTY GRID. Nothing went red — not `npm run
 * verify`, not the 40 tests written for that feature, not a prefab validation pass — because every
 * one of them reads the prefab FILE, and the file was well-formed. Only opening the selector in a
 * running editor showed it.
 *
 * So this guard is deliberately dumber than a schema check and aimed at exactly one thing: a
 * number nobody may invent. If a real format migration ever lands, raise `PREFAB_FORMAT_VERSION`
 * here in the same change that teaches the loader to read both — and if that is what you are doing,
 * this test failing is the reminder that the loader half is not optional.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { hasAnyProject } from '../helpers/repoLayout';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** The only value the prefab loader understands. Not a per-file revision number. */
const PREFAB_FORMAT_VERSION = 1;

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    // Same exclusions as `prefabInertSize.test.ts`: dist/ and the native mirrors hold BUILD COPIES,
    // so scanning them double-reports every finding and can report a stale copy.
    if (e.isDirectory()) {
      if (['dist', 'node_modules', 'ios', 'android'].includes(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (e.name.endsWith('.prefab.json')) {
      yield path.join(dir, e.name);
    }
  }
}

const prefabs = (discoverProjects(PROJECT_ROOT) as { dir: string }[])
  .flatMap((p) => [...walk(p.dir)])
  .concat([...walk(path.join(PROJECT_ROOT, 'engine', 'templates'))]);

describe('committed prefabs declare the loader\'s format version', () => {
  // Gated and asserted for the same reason `prefabInertSize.test.ts` does it: the public RELEASE
  // snapshot on `main` ships no projects, and a guard that scans nothing passes vacuously — which
  // is worse than no guard, because it reads as coverage.
  it.skipIf(!hasAnyProject())('found prefabs to scan (sanity: the guard is not passing vacuously)', () => {
    expect(prefabs.length).toBeGreaterThan(0);
  });

  it(`every .prefab.json is version ${PREFAB_FORMAT_VERSION}`, () => {
    const findings: string[] = [];
    for (const abs of prefabs) {
      let data: { version?: unknown };
      try {
        data = JSON.parse(fs.readFileSync(abs, 'utf-8'));
      } catch {
        continue; // an unparseable prefab is a louder failure the loader already reports
      }
      const rel = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
      if (data.version !== PREFAB_FORMAT_VERSION) {
        findings.push(`${rel} → version ${JSON.stringify(data.version)}`);
      }
    }
    expect(
      findings,
      'A prefab\'s `version` is the FORMAT marker, not a revision of the file. There is no prefab '
      + 'migration ladder, so an unexpected value makes the prefab fail to cache — SILENTLY, with '
      + 'no throw and no log, so anything pooled from it (a UIEntries grid) renders empty while '
      + 'every file-level test stays green. Restructure a prefab freely; leave `version` alone.\n'
      + findings.join('\n'),
    ).toEqual([]);
  });
});
