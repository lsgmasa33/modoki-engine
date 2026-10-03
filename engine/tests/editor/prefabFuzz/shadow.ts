/** The #2001 checks the fuzzer runs against the NEW instance model (#2009; design docs/plans/prefab-instance-model.md
 *  § 3.5, § 6, § 10.2, § 10.5): P1 (a record's projection is a function of the record) and I25 (the shadow: what the door
 *  recorded is what today's capture reads off the live tree).
 *
 *  Written against S1's TYPES before anything implements them, so the checks reach the model through a SEAM the build
 *  installs one step at a time (`installShadow`):
 *  - S4 installs `records` (the `InstanceStore`), `captureList` (`parse(captureInstanceEntry(live))`) and `doors` — and, for
 *    its stale-record staging, `judge` and `unrecorded` (`s4Seams.ts`, #2014);
 *  - S5 installs `project`: each record projected from the store into a scratch world, beside the live subtree
 *    (`s5Seams.ts`);
 *  - each later step widens `doors` as an op's door lands. S8 removes `captureList` with the capture, and I25 with it.
 *  Until a seam is installed, its check does not run, and the runner counts that instead (`checksRun`): a check that never
 *  runs guards nothing, and must say so.
 *
 *  P1 projects into a SCRATCH world, never the live one: a live reprojection renumbers the members' ECS ids, and the ops
 *  pick their targets in id order, so it moved every seed and every pinned repro off its path (#2028, measured). */

import type { InstanceRecord, OverrideList, SceneTargetRecord } from '../../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { OpKind } from './ops';
import { firstDiff } from './checks';
import { authored, piOf } from './harness';
import { isStoredRoot } from '../../../packages/modoki/src/runtime/core/assetRefRules';
import { findEntity } from '@modoki/engine/runtime';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { templateKeyOf } from '../../../packages/modoki/src/runtime/core/templateIdentity';

export interface ShadowSeams {
  /** S4: every stored instance's record, as the store holds it now. */
  records(): readonly InstanceRecord[];
  /** S4: the list today's capture gives for the stored root `rootGuid`, parsed by S1's parser. null when the live world
   *  has no such root. It must be built from the LIVE tree, never from the store (§ 10.5: never compared with itself). */
  captureList?: (rootGuid: string) => OverrideList | null;
  /** S5: the live subtree of record `rec` and its projection from the store, as trees keyed by guid; `{ skip }` with the
   *  reason it is not compared; undefined for a record projected with its owner (a nested one). */
  project?: (rec: InstanceRecord) => Promise<{ live: Record<string, unknown>; projected: Record<string, unknown> } | { skip: string } | undefined>;
  /** The op kinds whose door writes the list at this step. I25 is meaningful only after them (§ 10.5): any other op
   *  changes the live tree with no door to record it, so a divergence there is the step's known gap, not a finding. */
  doors: ReadonlySet<OpKind>;
  /** S4–S7 (#2014): the list I25 compares for `rec`, or why it is not compared. Absent: `rec.list` as it is.
   *  - `{ skip }`: the record says nothing to compare. S4 stages the ops S7 moves onto records by marking their records
   *    STALE (`instanceStore.ts`), and the door re-seeds a stale record FROM the capture before it next writes it, so
   *    comparing one with the capture would compare the capture with itself (§ 10.5, review L10). Counted per reason.
   *  - a list: `rec.list` with the RULES' side applied where today's capture cannot write it (a hub ruling the capture
   *    predates, an open capture bug), each translation named and counted by the seam, as S2's oracle applies rulings
   *    B/D. Must be a fresh object: the comparison still checks the capture against `rec.list` itself. */
  judge?: (rec: InstanceRecord) => OverrideList | { skip: string };
  /** S4–S7 (#2014): why the live stored root `rootGuid` knowingly has no record yet, or undefined. An op S7 has not
   *  moved onto records (a paste of an instance, a delete's undo, Create Prefab) creates roots without the door; it names
   *  itself on each root it left unrecorded. Excused and counted; any other missing root still fails. */
  unrecorded?: (rootGuid: string) => string | undefined;
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

/** I25's comparison: the first difference between the record's list and the captured one, modulo identity pins, or null.
 *  Throws when the two share a row object: the capture then read the store, and the comparison could not fail. */
export function listDiff(recorded: OverrideList, captured: OverrideList): string | null {
  assertNotSelf(recorded, captured);
  return firstDiff(canonList(recorded), canonList(captured));
}

/** P5's comparison (design § 3.5, the rule-3 audit): the first difference between a record's list before a record-neutral
 *  op and after it, modulo identity pins (a reload re-pins nothing, but the pins are not the list's records), or null. */
export function p5Diff(before: OverrideList, after: OverrideList): string | null {
  return firstDiff(canonList(before), canonList(after));
}

/** Throws when the captured list shares the store's list or a row object of it: the capture then read the store. */
export function assertNotSelf(stored: OverrideList, captured: OverrideList): void {
  if (stored === captured || stored.rows === captured.rows) throw new Error('harness: I25 compared the record with itself (the capture returned the store\'s list)');
  for (const [key, row] of captured.rows) {
    if (stored.rows.get(key) === row) throw new Error(`harness: I25 compared the record with itself (row ${key} is the store's own object)`);
  }
}
