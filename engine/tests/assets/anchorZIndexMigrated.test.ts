/** Corpus guard for the `UIAnchor.zIndex` removal (SCENE_FORMAT_VERSION 12→13).
 *
 *  Two separate claims, because they fail for different reasons:
 *
 *  1. **No game or demo content still authors `UIAnchor.zIndex`.** The codemod
 *     (`engine/scripts/migrate-anchor-zindex.mjs`) moved all 88 keys onto `UIElement.zIndex`.
 *     Re-introducing one is not a validation error — the field no longer exists on the trait, so
 *     `serialize.ts` would silently DROP it on the next save (it writes the koota schema's keys,
 *     not the file's) and koota's generated setter ignores it at spawn. Silent both ways, which is
 *     exactly why it needs a guard rather than a warning.
 *
 *  2. **The scenes that DO still carry it are migratable.** `engine/tests/e2e/fixtures/**` is
 *     deliberately left at `version: 9` — those fixtures earn their keep by driving the whole
 *     migration ladder on every e2e run, and stamping them current would have quietly retired that
 *     coverage. So instead of asserting they are clean, this test calls
 *     `migrateUIAnchorZIndexInTraits` DIRECTLY on each fixture's `traits` bag and asserts the
 *     authored stacking SURVIVES onto `UIElement.zIndex`.
 *
 *  ⚠️ What this test does NOT prove: it never calls `loadSceneFile`, so it cannot see whether the
 *  real loader actually WIRES this helper in — it only proves the fixtures' data is migratable and
 *  that the helper preserves the value when called. It once kept passing 2/2 after a reviewer
 *  deleted `migrateV12toV13(data);` from `loadSceneFile.ts`. The test that DOES drive the real
 *  loader (and goes red on that mutation) is
 *  `engine/packages/modoki/tests/runtime/loadSceneFile.test.ts:1734-1821`
 *  (`describe('migrateV12toV13 (UIAnchor.zIndex removal)')`) — this test is a corpus/fixture check
 *  alongside it, not a substitute for it. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { migrateUIAnchorZIndexInTraits } from '../../packages/modoki/src/runtime/loaders/uiAnchorZIndexMigration';
import { hasAnyProject } from '../helpers/repoLayout';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Ent = { name?: string; traits?: Record<string, unknown> };

/** All scene/prefab files in the repo, enumerated through GIT rather than the filesystem, so
 *  gitignored build output (`games/*\/ads/` from a `--target playable` export, `dist/`,
 *  `release/`) can never be mistaken for authored content — a filesystem walk made this guard
 *  MACHINE-DEPENDENT, red only on a clone that had run a playable export, which reads as "the
 *  merge broke it" rather than "the guard is looking outside the repo". Full reasoning:
 *  `engine/tests/architecture/docCitations.test.ts`'s `repoFiles()`. `--others
 *  --exclude-standard` deliberately includes new UNTRACKED scenes, since an unstaged scene is
 *  exactly when this guard is most useful. */
let allSceneAndPrefabFiles: string[] | undefined;
function repoSceneAndPrefabFiles(): string[] {
  if (allSceneAndPrefabFiles) return allSceneAndPrefabFiles;
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
  allSceneAndPrefabFiles = out
    .filter((p) => p.endsWith('.scene.json') || p.endsWith('.prefab.json'))
    .map((p) => path.join(REPO, p))
    // A tracked file can be absent from the working tree mid-rebase or after a manual delete;
    // reading it would throw and fail the guard for a reason that has nothing to do with the fix.
    .filter((p) => fs.existsSync(p));
  return allSceneAndPrefabFiles;
}

function sceneFiles(root: string): string[] {
  const rootSegs = path.relative(REPO, root).split(path.sep);
  return repoSceneAndPrefabFiles().filter((p) => {
    const segs = path.relative(REPO, p).split(path.sep);
    return rootSegs.every((seg, i) => segs[i] === seg);
  });
}

type Hit = { ent: Ent; anchor: Record<string, unknown>; location: string };

function anchorZIndexBag(bag: unknown): Record<string, unknown> | undefined {
  if (!bag || typeof bag !== 'object') return undefined;
  const anchor = (bag as Record<string, unknown>)['UIAnchor'];
  if (anchor && typeof anchor === 'object' && 'zIndex' in (anchor as object)) {
    return anchor as Record<string, unknown>;
  }
  return undefined;
}

/** Walks the same five places `migrate-anchor-zindex.mjs`'s `visitEntry()` does — that function is
 *  the canonical statement of where a `UIAnchor.zIndex` can hide (`traits`, `overrides[localId]`,
 *  `added[]`/`children[]` subtrees, `nestedOverrides[path][localId]`) and why each one is live; this
 *  just mirrors its reach instead of re-deriving it. One shape it's worth flagging here because it's
 *  easy to get wrong reading this function alone: `nestedOverrides` is path-keyed over a localId map
 *  (`{path: {localId: {TraitName: fields}}}`), so unlike `overrides` it takes TWO `Object.entries`
 *  calls to reach the trait bag. Every step is `typeof x === 'object'`-guarded because entities and
 *  override bags are arbitrary JSON on disk — a malformed file must produce zero hits, not a throw
 *  that takes the whole gate down for an unrelated reason. */
function visitEntity(entry: unknown, hits: Hit[]): void {
  if (!entry || typeof entry !== 'object') return;
  const ent = entry as Ent;

  const traitsAnchor = anchorZIndexBag(ent.traits);
  if (traitsAnchor) hits.push({ ent, anchor: traitsAnchor, location: 'traits' });

  const overrides = (entry as Record<string, unknown>)['overrides'];
  if (overrides && typeof overrides === 'object') {
    for (const [overrideLocalId, bag] of Object.entries(overrides)) {
      const anchor = anchorZIndexBag(bag);
      if (anchor) hits.push({ ent, anchor, location: `overrides[${overrideLocalId}]` });
    }
  }

  const added = (entry as Record<string, unknown>)['added'];
  if (Array.isArray(added)) {
    for (const child of added) visitEntity(child, hits);
  }
  const children = (entry as Record<string, unknown>)['children'];
  if (Array.isArray(children)) {
    for (const child of children) visitEntity(child, hits);
  }

  const nestedOverrides = (entry as Record<string, unknown>)['nestedOverrides'];
  if (nestedOverrides && typeof nestedOverrides === 'object') {
    for (const [nestedPath, pathBag] of Object.entries(nestedOverrides)) {
      if (!pathBag || typeof pathBag !== 'object') continue;
      for (const [nestedLocalId, bag] of Object.entries(pathBag)) {
        const anchor = anchorZIndexBag(bag);
        if (anchor) hits.push({ ent, anchor, location: `nestedOverrides['${nestedPath}'][${nestedLocalId}]` });
      }
    }
  }
}

function entitiesWithAnchorZIndex(file: string): Hit[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { entities?: Ent[] };
  const hits: Hit[] = [];
  for (const ent of data.entities ?? []) visitEntity(ent, hits);
  return hits;
}

describe('UIAnchor.zIndex is gone from authored content (#762 follow-up)', () => {
  it('no scene or prefab under games/ or demos/ still authors UIAnchor.zIndex', () => {
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const root of ['games', 'demos']) {
      for (const file of sceneFiles(path.join(REPO, root))) {
        scanned.push(file);
        for (const { ent, location } of entitiesWithAnchorZIndex(file)) {
          // `traits` is the common case and reads the same as before this widening; every other
          // location gets a suffix naming exactly which override/subtree carried it, matching the
          // codemod's own location vocabulary (`migrate-anchor-zindex.mjs`'s `visitEntry`).
          const suffix = location === 'traits' ? '' : ` (${location})`;
          offenders.push(`${path.relative(REPO, file)} → entity ${JSON.stringify(ent.name ?? '?')}${suffix}`);
        }
      }
    }
    // A corpus of NOTHING passes the assertion below vacuously, and enumerating through git
    // adds a fresh way to reach that state silently (run outside a checkout, or an `ls-files`
    // flag that stops matching) on top of the ways a filesystem walk already had. So pin that
    // the walk found something whenever there is anything to find.
    //
    // `hasAnyProject()` (loose) NOT `hasInternalGames()` (strict), deliberately — see those
    // helpers' notes on choosing between them. This guard's corpus is `games/` AND `demos/`,
    // and while the public snapshot ships no `games/` at all it does ship two demos whose
    // scenes this legitimately covers, so the loose check is the one that stays meaningful
    // there instead of skipping the only corpus the public gate has.
    if (hasAnyProject()) {
      expect(scanned.length, 'the scene/prefab walk returned NOTHING, so the assertion below '
        + 'cannot fail — the enumeration is broken, not the corpus clean').toBeGreaterThan(0);
    }
    expect(offenders, 'UIAnchor.zIndex no longer exists on the trait, so this value is dropped on '
      + 'the next save and ignored at spawn — both silently. Author UIElement.zIndex instead:\n'
      + offenders.join('\n')).toEqual([]);
  });

  it('the deliberately-old e2e fixtures still migrate their stacking onto UIElement.zIndex', () => {
    const files = sceneFiles(path.join(REPO, 'engine/tests/e2e/fixtures'))
      .filter((f) => entitiesWithAnchorZIndex(f).length > 0);

    // If this ever hits zero the fixtures were migrated in place, which retires the migration-ladder
    // coverage they exist for — that is a change to make deliberately, not to discover here.
    expect(files.length, 'expected at least one old e2e fixture still exercising the v12→v13 step')
      .toBeGreaterThan(0);

    for (const file of files) {
      for (const { ent, anchor } of entitiesWithAnchorZIndex(file)) {
        const authored = anchor.zIndex;
        const traits = ent.traits!;
        migrateUIAnchorZIndexInTraits(traits);

        const element = traits['UIElement'] as Record<string, unknown> | undefined;
        const where = `${path.relative(REPO, file)} → entity ${JSON.stringify(ent.name ?? '?')}`;
        expect(anchor, `${where}: the anchor key must be gone after migrating`).not.toHaveProperty('zIndex');
        if (authored) {
          // A truthy anchor value is what rendered before the removal, so it must survive.
          expect(element?.zIndex, `${where}: authored stacking ${String(authored)} was lost`).toBe(authored);
        }
      }
    }
  });
});
