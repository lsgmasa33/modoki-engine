/**
 * Every committed `.prefab.json` declares a format version the engine actually writes.
 *
 * ⚠️ **This guard shipped with the WRONG rule, and the wrong rule is the more interesting half.**
 * It originally pinned every prefab to `version: 1`, on the belief — recorded in #344's commit
 * message, in two Court docs, and in issues #363/#364 — that a prefab at version 2 "fails to cache,
 * silently". It does not. Nothing in the loading path reads `version` at all: `fetchPrefab`
 * (`runtime/loaders/meshTemplateCache.ts`) caches whatever parses, and `PrefabFile.version` is
 * typed `1 | 2` precisely because **the editor writes 2 itself** — `editor/scene/prefab.ts` sets
 * `version: nestedRefs.size > 0 ? 2 : 1`, i.e. 2 means "this prefab nests another prefab", and its
 * own comment notes that "a v1 file is a valid v2 file and no migration is needed".
 *
 * Measured 2026-08-26 in a live editor (#364): `games/space-console`'s spaceship prefab — which
 * HAS nested rows and was written at 2 by the editor in `982c3fc68` — spawns byte-identically at
 * version 1 and at version 2, in all three of that game's scenes, root + mesh + both nested Engine
 * Flame instances, with no warning on the console. So the old rule would have gone red on correct
 * engine output the first time anyone re-saved a nested prefab.
 *
 * What IS worth guarding is the mistake #344 actually made: treating `version` as a REVISION
 * number of the file ("this is take 2 of the tile"). That is caught here by tying 2 to the thing
 * it means. A nested prefab left at 1 is tolerated, not flagged, because v1 is a valid v2 file and
 * one committed prefab (`games/court/.../level-page.prefab.json`) is authored that way and works.
 *
 * If a real format migration ever lands, add its number to `PREFAB_FORMAT_VERSIONS` in the same
 * change that teaches the loader to read it — and if that is what you are doing, this test failing
 * is the reminder that the loader half is not optional.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { hasAnyProject } from '../helpers/repoLayout';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** The versions the editor writes. Not a per-file revision number. */
const PREFAB_FORMAT_VERSIONS = [1, 2];

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

interface PrefabDoc { version?: unknown; entities?: { prefab?: unknown }[] }

function read(abs: string): { rel: string; data: PrefabDoc } | null {
  const rel = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
  try {
    return { rel, data: JSON.parse(fs.readFileSync(abs, 'utf-8')) as PrefabDoc };
  } catch {
    return null; // an unparseable prefab is a louder failure the loader already reports
  }
}

describe('committed prefabs declare a format version the engine writes', () => {
  // Gated and asserted for the same reason `prefabInertSize.test.ts` does it: the public RELEASE
  // snapshot on `main` ships no projects, and a guard that scans nothing passes vacuously — which
  // is worse than no guard, because it reads as coverage.
  it.skipIf(!hasAnyProject())('found prefabs to scan (sanity: the guard is not passing vacuously)', () => {
    expect(prefabs.length).toBeGreaterThan(0);
  });

  it(`every .prefab.json is version ${PREFAB_FORMAT_VERSIONS.join(' or ')}`, () => {
    const findings: string[] = [];
    for (const abs of prefabs) {
      const doc = read(abs);
      if (!doc) continue;
      if (!PREFAB_FORMAT_VERSIONS.includes(doc.data.version as number)) {
        findings.push(`${doc.rel} → version ${JSON.stringify(doc.data.version)}`);
      }
    }
    expect(
      findings,
      'A prefab\'s `version` is the FORMAT marker, not a revision of the file. The editor writes '
      + `only ${PREFAB_FORMAT_VERSIONS.join(' or ')} (2 = the prefab nests another), and no reader `
      + 'understands anything else. Restructure a prefab freely; leave `version` alone.\n'
      + findings.join('\n'),
    ).toEqual([]);
  });

  it('version 2 is only on a prefab that actually nests another', () => {
    const findings: string[] = [];
    for (const abs of prefabs) {
      const doc = read(abs);
      if (!doc || doc.data.version !== 2) continue;
      const nests = (doc.data.entities ?? []).some((e) => e?.prefab !== undefined);
      if (!nests) findings.push(doc.rel);
    }
    expect(
      findings,
      'These prefabs declare version 2 but nest no other prefab, so 2 was not written by the '
      + 'editor — it was almost certainly typed by hand as a REVISION number ("take 2 of this '
      + 'file"). It is not that. `editor/scene/prefab.ts` writes `nestedRefs.size > 0 ? 2 : 1`; a '
      + 'flat prefab is version 1. This is the exact edit #344 made to Court\'s level tile.\n'
      + findings.join('\n'),
    ).toEqual([]);
  });
});
