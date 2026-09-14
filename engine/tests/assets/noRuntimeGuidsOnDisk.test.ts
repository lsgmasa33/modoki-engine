/** No committed project file may hold a RUNTIME guid (#1210).
 *
 *  A runtime guid (`00000000-GGGG-GGGG-0000-NNNNNNNNNNNN`, `isRuntimeGuid`) is the address
 *  `spawnEntity` mints for an entity spawned without one. It is valid only until its world is
 *  swapped out, and the counter behind it restarts every session, so a runtime guid written to a
 *  file names a DIFFERENT entity the next time anything reads it — silently.
 *
 *  The save paths re-mint over one and `assertNoRuntimeGuids` trips on the way out, so this should
 *  never fire. It is the last line: it catches a writer neither of those reached (a hand edit, an
 *  agent's `write_asset`, a tool that writes JSON without going through the serializer). Every
 *  `.json` under the project roots is scanned as TEXT, not just scenes and prefabs — a timeline
 *  binding or a config resource can carry an entity guid as easily. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { hasAnyProject } from '../helpers/repoLayout';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { findRuntimeGuids } from '../../packages/modoki/src/runtime/core/assetRefRules';

function jsonFiles(root: string): { abs: string; rel: string }[] {
  return repoFiles({ under: root, match: (rel: string) => rel.endsWith('.json'), floor: 0 });
}

describe('runtime guids stay off disk (#1210)', () => {
  it('no .json under games/, demos/ or the starter template holds a runtime guid', () => {
    const offenders: string[] = [];
    let scanned = 0;
    let scenesAndPrefabs = 0;
    for (const root of [...PROJECT_ROOT_DIRS, 'engine/templates/starter']) {
      for (const f of jsonFiles(root)) {
        scanned++;
        if (f.rel.endsWith('.scene.json') || f.rel.endsWith('.prefab.json')) scenesAndPrefabs++;
        const text = fs.readFileSync(f.abs, 'utf8');
        if (!text.includes('00000000-')) continue; // cheap reject: most files never match
        for (const hit of findRuntimeGuids(text)) offenders.push(`${f.rel}: ${hit.guid}`);
      }
    }
    // A corpus of nothing passes vacuously — pin that the walk found real content.
    if (hasAnyProject()) {
      expect(scenesAndPrefabs, 'the walk found no scene or prefab, so the assertion below cannot fail — '
        + 'the enumeration is broken, not the corpus clean').toBeGreaterThan(0);
    }
    expect(scanned).toBeGreaterThan(0); // the starter template alone always has .json files
    expect(offenders, 'a runtime guid is valid only until reload; re-mint it (open the scene and save, '
      + 'or replace it with a real guid) before committing:\n' + offenders.join('\n')).toEqual([]);
  });
});
