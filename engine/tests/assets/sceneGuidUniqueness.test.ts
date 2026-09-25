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
 *  repo-wide. Sharing a guid ACROSS scenes exists here and is not a defect — it is LEGACY
 *  (a scene-file duplicate copied guids verbatim until #1293; a new duplicate remints them),
 *  and some of it is load-bearing —
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
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { REPO_ROOT, hasAnyProject, hasInternalGames } from '../helpers/repoLayout';
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
 *  rule and is not what this invariant is about.
 *
 *  ⚠️ **`members[*].guid` IS in scope, and it is a second channel of the same invariant** (scene
 *  v16, #1468). A member row states the guid its member answers to, so a guid appearing in a row
 *  AND on an entity — or in two rows — is two entities in one scene sharing one address, exactly
 *  what this file exists to stop. Added on the Phase 2B close-out review's finding, while the answer
 *  is provably zero: no authored prefab is v5 yet, so no committed scene has rows. The moment Phase
 *  4's precondition lands (migrate the corpus to v5) this stops being vacuous — and the only other
 *  detector is `dropCollidingPins`, which runs at LOAD, in the editor's console, not in the gate. */
function duplicatesIn(file: string): { dups: string[]; guids: number; attrGuids: number; missing: string[]; rows: number } {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entities: Array<Record<string, unknown>> = data.entities ?? [];
  const byGuid = new Map<string, string[]>();
  const missing: string[] = [];
  let guids = 0;
  let attrGuids = 0;
  let rows = 0;
  /** Member rows wherever they sit: on an instance entry, and on a reference node at any depth. */
  const walkRows = (node: Record<string, unknown> | undefined, where: string): void => {
    if (!node || typeof node !== 'object') return;
    const members = node.members as Record<string, { guid?: string; name?: string }> | undefined;
    if (members && typeof members === 'object') {
      for (const [key, row] of Object.entries(members)) {
        const g = row?.guid;
        if (typeof g !== 'string' || !g) continue;
        // ⚠️ Counted in `rows`, NOT in `guids`. The two existing read paths are floored SEPARATELY on
        // purpose (see the floor below), so one channel cannot hold the combined total above zero
        // while the other reads nothing — and feeding rows into `guids` would give the ROW channel
        // that power the moment the corpus has rows. It also stops `guids + missing` being an entity
        // count, which the second test's population floor relies on.
        rows++;
        const arr = byGuid.get(g);
        const label = `${where} member ${row.name || key}`;
        if (arr) arr.push(label); else byGuid.set(g, [label]);
      }
    }
    // ⚠️ `children` too, not just `added`: `snapshotSubtree` puts a `captureChild` result there, and
    // `captureChild` returns a reference NODE for a dragged-in instance — which carries `members`.
    // The first cut of this walk missed it, and `toTemplateNodes` (touched in the same change) does
    // recurse `children`, so the two walks disagreed about where a reference node can live.
    for (const child of (node.added as Record<string, unknown>[] | undefined) ?? []) walkRows(child, where);
    for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) walkRows(child, where);
    const slots = node.nestedStructure as Record<string, { added?: Record<string, unknown>[] }> | undefined;
    if (slots && typeof slots === 'object') {
      for (const delta of Object.values(slots)) for (const child of delta?.added ?? []) walkRows(child, where);
    }
  };
  for (const e of entities) {
    const ea = (e.traits as Record<string, unknown> | undefined)?.['EntityAttributes'] as
      Record<string, unknown> | undefined;
    const guid = (ea?.guid as string) || (e.guid as string) || '';
    if (!guid) { missing.push((ea?.name as string) || (e.name as string) || '(unnamed)'); continue; }
    guids++;
    if (ea?.guid) attrGuids++;
    const name = (ea?.name as string) || (e.name as string) || '(unnamed)';
    const arr = byGuid.get(guid);
    if (arr) arr.push(name); else byGuid.set(guid, [name]);
  }
  for (const e of entities) walkRows(e, (((e.traits as Record<string, unknown> | undefined)?.['EntityAttributes'] as Record<string, unknown> | undefined)?.name as string) || (e.name as string) || '(unnamed)');
  const dups = [...byGuid.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([guid, names]) => `${guid} → ${names.join(' + ')}`);
  return { dups, guids, attrGuids, missing, rows };
}

describe.skipIf(!hasAnyProject())('entity guids are unique within a scene file', () => {
  it('finds scenes to scan (sanity: the guard is actually looking)', () => {
    expect(sceneFiles().length).toBeGreaterThan(0);
  });

  it('no scene file spawns two entities with the same guid', () => {
    const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
    const scanned = sceneFiles().map((f) => ({ file: rel(f), ...duplicatesIn(f) }));
    const offenders = scanned
      .filter((r) => r.dups.length)
      .map((r) => `${r.file}: ${r.dups.join('; ')}`);
    // Non-vacuity floor (#1105): a guid read path that drifted skips those entities, which reads as
    // "no duplicates". The two paths are floored SEPARATELY: the top-level fallback alone carries
    // enough guids (29 measured) to hold a combined total above zero while the dominant
    // EntityAttributes.guid path (1,661 measured) reads nothing.
    const total = (key: 'guids' | 'attrGuids') => scanned.reduce((n, r) => n + r[key], 0);
    expect(total('guids'), 'no entity guids read from any scene — the guid read path is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(0);
    if (hasInternalGames()) {
      expect(total('attrGuids'), 'far fewer EntityAttributes.guid values read than the scenes hold — that read path is broken; fix it, do not delete this assertion')
        .toBeGreaterThan(500);
    }
    expect(
      offenders,
      'Two entities in ONE scene share a guid, so findEntityByGuid picks an arbitrary '
        + 'winner and any child naming that guid as its parentId is ambiguous. Almost '
        + 'always a copy-pasted entity that kept the original\'s guid — mint a fresh v4 '
        + 'guid for the COPY (the later/renamed one), and check nothing else in the '
        + 'project referenced it first.',
    ).toEqual([]);
  });

  /** #1268. The sibling invariant, and the reason it lives here: the duplicate check above
   *  `continue`s past an entry with no guid, so the population this asserts on was the one
   *  thing this file deliberately could not see.
   *
   *  A committed entry with no guid is not inert. Since #1248 every spawned entity gets
   *  `EntityAttributes`, and an entry with none takes a RUNTIME guid at spawn — which
   *  `durableGuid()` reads as absent, so the first save mints a random v4 over it. A different
   *  one in every clone, so two clones saving the same untouched scene conflict; and because
   *  `compareSiblings` tiebreaks on `guid.localeCompare`, the entity moves in the file too.
   *  34 entries across 34 files were in exactly that state until the re-save in #1268.
   *
   *  The loader now DERIVES a guid for such an entry (`deriveAuthoredEntityGuids`) so every
   *  clone at least agrees on the value — but a derived guid is meant to be stored on the next
   *  save, not re-derived forever (the prefab-member address space that is re-derived every
   *  load is what #1272/#1278/#1284 are about). This guard is what keeps the stored half true:
   *  without it, a scene arriving from an old branch reintroduces the trap silently. */
  it('every committed scene entity carries a guid', () => {
    const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
    const scanned = sceneFiles().map((f) => ({ file: rel(f), ...duplicatesIn(f) }));
    const offenders = scanned
      .filter((r) => r.missing.length)
      .map((r) => `${r.file}: ${r.missing.join(', ')}`);
    // Non-vacuity floor: if the read path breaks, every entry looks guid-LESS rather than
    // guid-ful, so this assertion fails loudly instead of passing — but floor the entity count
    // anyway, so a glob that stops matching cannot read as "no offenders".
    const entities = scanned.reduce((n, r) => n + r.guids + r.missing.length, 0);
    expect(entities, 'no scene entities scanned at all — the file glob is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(0);
    expect(
      offenders,
      'A committed scene entry has no guid. The first save in ANY clone will mint a random one '
        + 'for it and move it in the file, so two clones saving the same untouched scene produce '
        + 'conflicting diffs (#1268). Fix by opening the scene in the editor and saving it once — '
        + 'the loader derives a stable guid, and the save stores it. Do not hand-write a v4 guid: '
        + 'another clone would derive a different value for the same entry.',
    ).toEqual([]);
  });

  /** ⚠️ The member-row channel is VACUOUS on today's corpus — no authored prefab is v5, so no
   *  committed scene has rows and the scan above finds none to compare. A scan that can see nothing
   *  reports "no duplicates" for the same reason a broken one does, so the detector is proved on a
   *  synthetic document instead. This is the positive case; the corpus run is the negative one.
   *
   *  Delete this only when the corpus genuinely has rows AND the floor above counts them. */
  it('the member-row scan detects a duplicate (the channel is vacuous on today`s corpus)', () => {
    const file = path.join(makeScratchDir('row-uniqueness'), 'probe.scene.json');
    const SHARED = 'aaaaaaaa-0000-4000-8000-00000000beef';
    {
      fs.writeFileSync(file, JSON.stringify({
        version: 16,
        entities: [
          // A row and a top-level entity claiming one guid — two entities, one address.
          { traits: { EntityAttributes: { name: 'Plain', guid: SHARED } } },
          {
            prefab: 'aaaaaaaa-0000-4000-8000-0000000000p1', guid: 'aaaaaaaa-0000-4000-8000-0000000000r1',
            traits: { EntityAttributes: { name: 'Inst' } },
            members: { '/aaaaaaaa-0000-4000-8000-0000000000n1': { guid: SHARED, name: 'Member' } },
          },
        ],
      }));
      const r = duplicatesIn(file);
      expect(r.rows, 'the walk must have SEEN the row, or the duplicate below proves nothing').toBe(1);
      expect(r.dups.join(' ')).toContain(SHARED);
      expect(r.dups.join(' ')).toContain('Member');
    }
  });

  it('the member-row scan reaches a REFERENCE node`s rows too, at depth', () => {
    // The other half of the walk: a reference node is an instance and carries its own rows, inside
    // `added` and inside a `nestedStructure` slot. A scan that stopped at the entry would miss them.
    const file = path.join(makeScratchDir('row-uniqueness-nested'), 'probe.scene.json');
    const SHARED = 'aaaaaaaa-0000-4000-8000-00000000cafe';
    {
      fs.writeFileSync(file, JSON.stringify({
        version: 16,
        entities: [{
          prefab: 'aaaaaaaa-0000-4000-8000-0000000000p2', guid: 'aaaaaaaa-0000-4000-8000-0000000000r2',
          traits: { EntityAttributes: { name: 'Inst' } },
          added: [{ prefab: 'aaaaaaaa-0000-4000-8000-0000000000p3', guid: 'aaaaaaaa-0000-4000-8000-0000000000r3',
            members: { '/aaaaaaaa-0000-4000-8000-0000000000n2': { guid: SHARED, name: 'Deep' } } }],
          nestedStructure: { '2': { added: [{ prefab: 'aaaaaaaa-0000-4000-8000-0000000000p4', guid: 'aaaaaaaa-0000-4000-8000-0000000000r4',
            members: { '/aaaaaaaa-0000-4000-8000-0000000000n3': { guid: SHARED, name: 'Deeper' } } }] } },
          // A plain added node whose CHILD is a reference node — `snapshotSubtree`'s shape.
          children: [{ children: [{ prefab: 'aaaaaaaa-0000-4000-8000-0000000000p5', guid: 'aaaaaaaa-0000-4000-8000-0000000000r5',
            members: { '/aaaaaaaa-0000-4000-8000-0000000000n4': { guid: SHARED, name: 'Child' } } }] }],
        }],
      }));
      const r = duplicatesIn(file);
      expect(r.rows).toBe(3);
      expect(r.dups.join(' ')).toContain('Deep');
      expect(r.dups.join(' ')).toContain('Deeper');
      expect(r.dups.join(' '), 'a reference node inside `children` is reached too').toContain('Child');
    }
  });
});
