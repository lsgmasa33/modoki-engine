/** Committed `.scene.json` files are already in the order `orderEntitiesForSave` would
 *  write them in (QA-HIER-0002 — see `entityOrder.ts`'s docblock for the full rule and
 *  why it exists).
 *
 *  This is a GUARD, not a rewriter: it does not touch any scene file. A failure here means
 *  the entity array on disk was written by an OLDER order (or hand-edited out of it) — the
 *  fix is to open the file in the editor and save it, which re-canonicalizes the whole
 *  array through the current rule, NOT to relax this test. It reuses the SAME
 *  `orderEntitiesForSave` the serializer and the Hierarchy panel call, so it cannot drift
 *  from the comparator that actually gets used.
 *
 *  ⚠️ Sharing the comparator is NOT the same as sharing the answer — the hard part of this
 *  guard is reconstructing the serializer's INPUTS from a file, and that is where it went
 *  wrong once (see `adaptEntity`). When it cannot reconstruct them faithfully it SKIPS the
 *  file and says so; it never guesses a sort key. A wrong oracle is worse than a missing
 *  one, because it fails the file the editor just wrote correctly. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { orderEntitiesForSave } from '../../packages/modoki/src/runtime/core/ecs/entityOrder';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** Where authored scenes and prefabs live: games, demos, the scaffolder template, and the
 *  engine's own test fixtures.
 *
 *  Git-enumerated (#771/#799) rather than a hand-rolled recursive walk with its own
 *  build-output skip list. `android`/`ios` are excluded explicitly because they are TRACKED
 *  native mirrors that would hold a COPY of an authored scene/prefab; `node_modules`/`dist`/
 *  `build`/`ads`/`subgame-dist` need no entry at all — every one of them is gitignored
 *  (`ads/` at `.gitignore:7`, `subgame-dist/` at `.gitignore:8`), so git enumeration excludes
 *  a build-output copy for free rather than needing a segment on this list. */
const ASSET_ROOTS = ['games', 'demos', 'engine/templates', 'engine/tests/fixtures'];

function filesWithSuffix(suffix: string): string[] {
  return repoFiles({
    under: ASSET_ROOTS,
    match: (rel) => rel.endsWith(suffix),
    exclude: ['android', 'ios'],
    floor: 0,
  }).map(({ abs }) => abs);
}

const sceneFiles = (): string[] => filesWithSuffix('.scene.json');

interface EntityAttrs { guid?: string; parentId?: string; sortOrder?: number }

interface SceneEntity {
  name?: string;
  /** A prefab-instance root's identity lives HERE, at the top level. */
  guid?: string;
  /** GUID of the source prefab, on a prefab-instance root entry. */
  prefab?: string;
  /** Per-localId field overrides for a prefab instance. */
  overrides?: Record<string, { EntityAttributes?: EntityAttrs } | undefined>;
  traits?: { EntityAttributes?: EntityAttrs };
}

interface PrefabEntity {
  localId?: number;
  traits?: { EntityAttributes?: EntityAttrs; PrefabInstance?: { source?: string } };
  overrides?: SceneEntity['overrides'];
}

interface PrefabFile { id?: string; rootLocalId?: number; entities?: PrefabEntity[] }

/** Every `*.prefab.json` under the asset roots, keyed by GUID — needed because a
 *  prefab-instance root's `sortOrder` is not in the scene file at all. */
const prefabsByGuid: Map<string, PrefabFile> = (() => {
  const map = new Map<string, PrefabFile>();
  for (const f of filesWithSuffix('.prefab.json')) {
    try {
      const data: PrefabFile = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data.id) map.set(data.id, data);
    } catch { /* a malformed prefab is some other guard's problem */ }
  }
  return map;
})();

/** The effective `sortOrder` of a prefab instance's ROOT: the prefab template's own root
 *  value, with the instance's override on that root winning. Follows a nested chain (a
 *  prefab whose root is itself an instance).
 *
 *  Returns `null` when it cannot resolve — a missing prefab file, a missing `rootLocalId`,
 *  or a cycle. The caller then SKIPS the whole scene file. Returning 0 here is precisely
 *  the bug this function exists to fix; do not "simplify" the null away. */
function prefabRootSortOrder(
  prefabGuid: string,
  overrides: SceneEntity['overrides'],
  seen = new Set<string>(),
): number | null {
  if (seen.has(prefabGuid)) return null;
  seen.add(prefabGuid);
  const prefab = prefabsByGuid.get(prefabGuid);
  if (!prefab || prefab.rootLocalId === undefined) return null;

  const override = overrides?.[String(prefab.rootLocalId)]?.EntityAttributes?.sortOrder;
  if (typeof override === 'number') return override;

  const root = prefab.entities?.find((e) => e.localId === prefab.rootLocalId);
  if (!root) return null;
  const nested = root.traits?.PrefabInstance?.source;
  if (nested) return prefabRootSortOrder(nested, root.overrides, seen);
  return root.traits?.EntityAttributes?.sortOrder ?? 0;
}

/** ⚠️ A prefab-instance root's sort keys are NOT all in its scene entry, and reading only
 *  `entry.traits.EntityAttributes` gets BOTH of them wrong:
 *
 *  - **guid** — identity is at the top level (`entry.guid`); serialize.ts never bakes it into
 *    `EntityAttributes` (it is never an override). The loader stamps it into the live world as
 *    a minimal `EntityAttributes({guid: entry.guid})`, which is what `guidForId` reads at save.
 *  - **sortOrder** — serialize.ts writes a captured prefab root's `EntityAttributes` as a
 *    MINIMAL `{parentId?, editorFolder?}`; `sortOrder` is never written there. The live value
 *    is the prefab template's root value, overridden by `entry.overrides[rootLocalId]`.
 *
 *  Both were got wrong while fixing #500, and content comparison cannot catch it: a reorder is
 *  content-preserving by construction, so "same entities, same fields" stays true while the
 *  ORDER is wrong. Reading `attrs.sortOrder ?? 0` scored `Warp.scene.json`'s `Mars_planet`
 *  (real value 91, via an override) as 0 and moved it from index 15 to index 3 — in a file the
 *  editor had written CORRECTLY — and the guard then certified the damage as canonical.
 *
 *  Returns `null` when a key cannot be reconstructed; the caller skips the file. */
function adaptEntity(entry: SceneEntity) {
  const attrs = entry.traits?.EntityAttributes;
  const guid = entry.guid || attrs?.guid || '';
  let sortOrder: number;
  if (entry.prefab) {
    const resolved = prefabRootSortOrder(entry.prefab, entry.overrides);
    if (resolved === null) return null;
    sortOrder = resolved;
  } else {
    sortOrder = attrs?.sortOrder ?? 0;
  }
  return { key: guid, parentKey: attrs?.parentId || null, sortOrder, name: entry.name ?? '', guid };
}

type Adapted = NonNullable<ReturnType<typeof adaptEntity>>;

/** Adapt a whole file, or `null` if ANY entity is unresolvable — order is a whole-array
 *  property, so one unknown sort key makes the entire comparison meaningless. */
function adaptFile(entities: SceneEntity[]): Adapted[] | null {
  const out: Adapted[] = [];
  for (const e of entities) {
    const a = adaptEntity(e);
    if (!a) return null;
    out.push(a);
  }
  return out;
}

function readScenes(): { file: string; entities: SceneEntity[]; adapted: Adapted[] | null }[] {
  const out: { file: string; entities: SceneEntity[]; adapted: Adapted[] | null }[] = [];
  for (const file of sceneFiles()) {
    let data: { entities?: SceneEntity[] };
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // not valid JSON — some other guard's problem, not this one's
    }
    const entities = data.entities;
    if (!Array.isArray(entities) || entities.length < 2) continue;
    out.push({ file, entities, adapted: adaptFile(entities) });
  }
  return out;
}

describe('committed scenes are already in canonical entity-write order', () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join('/');

  it('finds scenes to scan (sanity: the guard is actually looking)', () => {
    expect(sceneFiles().length).toBeGreaterThan(0);
  });

  it('resolves the prefabs it needs (sanity: skipping is rare, not the norm)', () => {
    const scenes = readScenes();
    const skipped = scenes.filter((s) => s.adapted === null).map((s) => rel(s.file));
    // A skip is SOUND but blind. If this ever trips, the prefab resolution above has gone
    // stale against the format — fix it rather than raising the threshold.
    expect(skipped, 'scene files whose prefab sort keys could not be resolved').toEqual([]);
  });

  it('every scene file\'s entity array already matches orderEntitiesForSave', () => {
    const offenders: string[] = [];
    for (const { file, adapted } of readScenes()) {
      if (!adapted) continue; // reported by the sanity test above
      const canonical = orderEntitiesForSave(adapted, (e) => e);
      let mismatches = 0;
      for (let i = 0; i < adapted.length; i++) if (adapted[i] !== canonical[i]) mismatches++;
      if (mismatches > 0) {
        offenders.push(`${rel(file)} — ${mismatches}/${adapted.length} entities out of position`);
      }
    }
    expect(
      offenders,
      'These scene files\' entity arrays are not in the current canonical write order '
        + '(QA-HIER-0002, entityOrder.ts). Opening one in the editor and saving it will '
        + 're-canonicalize the whole array — that produces a whole-file diff, which is expected '
        + 'and is the fix. Do NOT relax this test to make it pass, and do NOT reorder the file '
        + 'with a script unless that script resolves prefab sort keys the same way adaptEntity '
        + 'does — a naive reorder silently corrupts prefab-instance placement.',
    ).toEqual([]);
  });

  /** The guard above only proves the file MATCHES the rule — not that the rule PICKED the
   *  order. Two siblings that tie on all three keys (same sortOrder, same guid, same name)
   *  compare equal, so their relative order falls out of `Array.prototype.sort`'s stability
   *  over the INPUT — and the serializer's input is live-ECS order, the very thing
   *  QA-HIER-0002 removes. Such a pair would sail through the guard above and still churn.
   *
   *  It is reachable: entities with no `EntityAttributes` at all (a `PrefabInstance`- or
   *  `Time`-only entry) never get a guid minted, so they tie at `('', 0)` and are separated
   *  only by name. */
  it('no two siblings tie on every sort key (order is DETERMINED, not merely matched)', () => {
    const ties: string[] = [];
    for (const { file, adapted } of readScenes()) {
      if (!adapted) continue;
      const seen = new Map<string, number>();
      for (const a of adapted) {
        const k = JSON.stringify([a.parentKey ?? '', a.sortOrder, a.guid, a.name]);
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      for (const [k, n] of seen) if (n > 1) ties.push(`${rel(file)} — ${n}x ${k}`);
    }
    expect(
      ties,
      'These siblings tie on sortOrder, guid AND name, so nothing decides their relative '
        + 'order — the saved order would depend on live ECS iteration and can churn between '
        + 'saves. Give one of them a distinct guid (an entity with no EntityAttributes never '
        + 'gets one minted) or a distinct name.',
    ).toEqual([]);
  });
});
