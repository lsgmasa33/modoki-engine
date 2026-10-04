/** The #2001 checks the fuzzer runs against the instance model (#2009; design docs/plans/prefab-instance-model.md § 3.5,
 *  § 6, § 10.2): the store covers every live stored root, P1 (a record's projection is a function of the record) and P5
 *  (a record-neutral op leaves every record as it was).
 *
 *  The checks reach the model through SEAMS the fuzz test installs (`installShadow`): `records` (the `InstanceStore`), `skip`
 *  (a record no check compares, and why) and `project` (each record projected from the store into a scratch world, beside
 *  the live subtree, `s5Seams.ts`). Until a seam is installed, its check does not run, and the runner counts that instead
 *  (`checksRun`): a check that never runs guards nothing, and must say so.
 *
 *  I25 (the shadow: what the door recorded is what the old capture read off the live tree) ran from S4 to #2001 S8b, and
 *  went when the record became the one truth: a record may now hold what the capture cannot state (a Missing Prefab
 *  row's removal, #2058), and no save reads the capture any more.
 *
 *  P1 projects into a SCRATCH world, never the live one: a live reprojection renumbers the members' ECS ids, and the ops
 *  pick their targets in id order, so it moved every seed and every pinned repro off its path (#2028, measured). */

import type { InstanceRecord, OverrideList, SceneTargetRecord } from '../../../packages/modoki/src/runtime/prefab/instanceRecord';
import { firstDiff } from './checks';
import { authored, piOf } from './harness';
import { isStoredRoot } from '../../../packages/modoki/src/runtime/core/assetRefRules';
import { findEntity } from '@modoki/engine/runtime';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { templateKeyOf } from '../../../packages/modoki/src/runtime/core/templateIdentity';

export interface ShadowSeams {
  /** Every stored instance's record, as the store holds it now. */
  records(): readonly InstanceRecord[];
  /** Why no check compares `rec` (its prefab, or an enclosing frame's, unresolved or trashed), or undefined. Counted per
   *  reason. */
  skip?: (rec: InstanceRecord) => string | undefined;
  /** The live subtree of record `rec` and its projection from the store, as trees keyed by guid; `{ skip }` with the
   *  reason it is not compared; undefined for a record projected with its owner (a nested one). */
  project?: (rec: InstanceRecord) => Promise<{ live: Record<string, unknown>; projected: Record<string, unknown> } | { skip: string } | undefined>;
}

let installed: ShadowSeams | null = null;

/** Install (or, with null, remove) the model's seams. A build step calls this from the fuzz test's setup. */
export function installShadow(seams: ShadowSeams | null): void { installed = seams; }
export function shadowSeams(): ShadowSeams | null { return installed; }

/** The guids of every live STORED instance root — a scene entry or a reference node the scene added, a Missing Prefab
 *  placeholder included (rule 9 keeps its record) — which the store must hold a record for. */
export function liveStoredRoots(): string[] {
  return authored().filter((e) => {
    if (!e.guid) return false;
    const pi = piOf(e.id);
    // A template-added REFERENCE node is a root too, but its template supplies it: it is a node of its enclosing frame,
    // its members key under `…/a+<key>/…` in that frame's record, and it owns no record of its own (hub, 2026-10-02).
    if (pi) return isStoredRoot(pi as never, e.id) && !templateKeyOf(findEntity(e.id) as never);
    // A placeholder carries no PrefabInstance (`keepUnresolvedEntry`, `spawnUnresolvedReference`), so it is found by its
    // marker: a scene entry, or a node the scene added — not one a template supplies, which carries a template key.
    const ent = findEntity(e.id);
    return !!ent && !!unresolvedRefOf(ent as never) && !templateKeyOf(ent as never);
  }).map((e) => e.guid!);
}

/** A record as data, modulo its identity pins (`guid`, `name`: rule 5's pins are not overrides, § 2.1). A record that
 *  holds nothing but pins is no record. `own` is a set, sorted by guid: an added node's order is its own `sortOrder`,
 *  scene content (plan § 3, the `m_AddedGameObjects` row) — § 2.5 gives the list's shape, not a meaning for its order. */
function overridesOf(rec: SceneTargetRecord): Record<string, unknown> | null {
  const { guid: _g, name: _n, ...rest } = rec;
  if (rest.own) rest.own = [...rest.own].sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
  const out = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : null;
}

function canonList(list: OverrideList): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...list.rows.keys()].sort()) {
    const rec = overridesOf(list.rows.get(key)!);
    if (rec) out[key] = rec;
  }
  return out;
}

/** P5's comparison (design § 3.5, the rule-3 audit): the first difference between a record's list before a record-neutral
 *  op and after it, modulo identity pins (a reload re-pins nothing, but the pins are not the list's records), or null. */
export function p5Diff(before: OverrideList, after: OverrideList): string | null {
  return firstDiff(canonList(before), canonList(after));
}
