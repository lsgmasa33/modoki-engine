/** An entity guid must be unique WITHIN a scene file.
 *
 *  A guid is the only stable address an entity has — `findEntityByGuid` backs every
 *  agent tool aim, `EntityAttributes.parentId` is a guid reference in the v12 shape, and
 *  the prefab/override machinery keys on it. Two entries in ONE scene answering to the
 *  same guid therefore mean an arbitrary winner for every lookup and an ambiguous parent
 *  for every child that points at it. Nothing in the load path catches this: the two
 *  dedup filters in `SceneManager` (`filterPersistentDuplicates`,
 *  `filterDuplicateChainGuids`) both compare a scene against something ELSE already
 *  loaded — a carried persistent entity, or an earlier scene in the same chain — so a
 *  collision inside one file passes straight through and both entities spawn.
 *
 *  It is a copy-paste defect, and it is not hypothetical. Two were found by sweeping for
 *  it on 2026-08-18 (Testboard bug 1ZKKvYtC90o6Lmfdu9BZ, work-qa):
 *   - `games/iap-test/main.scene.json` — "Cycle Hold" carried "Restore Purchases"' guid,
 *     a straight duplicate of the row above it (identical sortOrder, identical UIElement).
 *   - `games/3d-test/tropical-island.scene.json` — "Hello Buton" shared a guid with
 *     "Play Buton" in the sibling `2D Animation.scene.json`, both misspelled the same way.
 *
 *  ⚠️ SCOPE, and this is the load-bearing half: the guard is deliberately PER FILE, not
 *  repo-wide. Sharing a guid ACROSS scenes is normal here and is not a defect —
 *  `games/sling`'s Lvl-0001/Lvl-0002 are level variants of the same authored entities,
 *  `games/space-console`'s three scenes share one UI shell, and the `Persistent`
 *  carry-across-swap mechanism REQUIRES both scene files to name the entity by the same
 *  guid for `filterPersistentDuplicates` to recognise it. The 2026-08-18 sweep found ~80
 *  cross-scene shares and only two same-file ones; a repo-wide uniqueness rule would fail
 *  on the design and teach the next reader that the design is wrong. Cross-scene stays
 *  uncovered on purpose — the honest signal there is "different entity NAME", which is
 *  too weak to fail a build on (an entity legitimately renamed in one scene looks
 *  identical to a copy-paste collision).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, hasAnyProject } from '../helpers/repoLayout';
import { discoverProjects } from '../../scripts/projectRoots.mjs';

/** Every committed scene: each project's own scenes plus the scaffolder template's
 *  (which seeds every project ever created, so a collision there is unbounded). */
function sceneFiles(): string[] {
  const out: string[] = [];
  const dirs = discoverProjects(REPO_ROOT).map((p: { dir: string }) => path.join(p.dir, 'runtime/assets/scenes'));
  dirs.push(path.join(REPO_ROOT, 'engine/templates/starter/runtime/assets/scenes'));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.scene.json')) out.push(path.join(dir, f));
  }
  return out;
}

/** Guids appearing more than once in one file, each with the names that claim it.
 *
 *  Reads the guid the way the loader does — `EntityAttributes.guid` first, falling back to
 *  a top-level `guid` — so a scene on either shape is covered. Top-level `entities[]` only:
 *  a prefab instance's `added[]` subtree carries its own guids under a different ownership
 *  rule and is not what this invariant is about. */
function duplicatesIn(file: string): string[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entities: Array<Record<string, unknown>> = data.entities ?? [];
  const byGuid = new Map<string, string[]>();
  for (const e of entities) {
    const ea = (e.traits as Record<string, unknown> | undefined)?.['EntityAttributes'] as
      Record<string, unknown> | undefined;
    const guid = (ea?.guid as string) || (e.guid as string) || '';
    if (!guid) continue;
    const name = (ea?.name as string) || (e.name as string) || '(unnamed)';
    const arr = byGuid.get(guid);
    if (arr) arr.push(name); else byGuid.set(guid, [name]);
  }
  return [...byGuid.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([guid, names]) => `${guid} → ${names.join(' + ')}`);
}

describe.skipIf(!hasAnyProject())('entity guids are unique within a scene file', () => {
  it('finds scenes to scan (sanity: the guard is actually looking)', () => {
    expect(sceneFiles().length).toBeGreaterThan(0);
  });

  it('no scene file spawns two entities with the same guid', () => {
    const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
    const offenders = sceneFiles()
      .map((f) => ({ file: rel(f), dups: duplicatesIn(f) }))
      .filter((r) => r.dups.length)
      .map((r) => `${r.file}: ${r.dups.join('; ')}`);
    expect(
      offenders,
      'Two entities in ONE scene share a guid, so findEntityByGuid picks an arbitrary '
        + 'winner and any child naming that guid as its parentId is ambiguous. Almost '
        + 'always a copy-pasted entity that kept the original\'s guid — mint a fresh v4 '
        + 'guid for the COPY (the later/renamed one), and check nothing else in the '
        + 'project referenced it first.',
    ).toEqual([]);
  });
});
