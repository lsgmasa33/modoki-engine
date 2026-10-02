/** The #2001 checks the fuzzer runs against the NEW instance model (#2009; design docs/plans/prefab-instance-model.md
 *  § 3.5, § 6, § 10.2, § 10.5): P1 (a record's projection is a function of the record) and I25 (the shadow: what the door
 *  recorded is what today's capture reads off the live tree).
 *
 *  Written against S1's TYPES before anything implements them, so the checks reach the model through a SEAM the build
 *  installs one step at a time (`installShadow`):
 *  - S4 installs `records` (the `InstanceStore`), `captureList` (`parse(captureInstanceEntry(live))`) and `doors`;
 *  - S5 installs `reproject` (`projectInstance(world, rec, reader, { mode: 'reproject', … })`);
 *  - each later step widens `doors` as an op's door lands. S8 removes `captureList` with the capture, and I25 with it.
 *  Until a seam is installed, its check does not run, and the runner counts that instead (`checksRun`): a check that never
 *  runs guards nothing, and must say so.
 *
 *  ⚠️ P1 reprojects every record after every op, which renumbers the members' ECS ids, and the ops pick their targets in
 *  id order: installing `reproject` changes every seed's path from there on (the respawn identity runs at the END of a run
 *  for that reason). Expected, and a reason to re-measure the verify seeds' reach when S5 lands. */

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
  /** S5: reproject one record in place, from the store. */
  reproject?: (rec: InstanceRecord) => void | Promise<void>;
  /** The op kinds whose door writes the list at this step. I25 is meaningful only after them (§ 10.5): any other op
   *  changes the live tree with no door to record it, so a divergence there is the step's known gap, not a finding. */
  doors: ReadonlySet<OpKind>;
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
    if (pi) return isStoredRoot(pi as never, e.id);
    // A placeholder carries no PrefabInstance (`keepUnresolvedEntry`, `spawnUnresolvedReference`), so it is found by its
    // marker: a scene entry, or a node the scene added — not one a template supplies, which carries a template key.
    const ent = findEntity(e.id);
    return !!ent && !!unresolvedRefOf(ent as never) && !templateKeyOf(ent as never);
  }).map((e) => e.guid!);
}

/** A record as data, modulo its identity pins (`guid`, `name`: rule 5's pins are not overrides, § 2.1). A record that
 *  holds nothing but pins is no record. Own nodes keep their authored order, which is part of the list (§ 2.5). */
function overridesOf(rec: SceneTargetRecord): Record<string, unknown> | null {
  const { guid: _g, name: _n, ...rest } = rec;
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
  if (recorded === captured || recorded.rows === captured.rows) throw new Error('harness: I25 compared the record with itself (the capture returned the store\'s list)');
  for (const [key, row] of captured.rows) {
    if (recorded.rows.get(key) === row) throw new Error(`harness: I25 compared the record with itself (row ${key} is the store's own object)`);
  }
  return firstDiff(canonList(recorded), canonList(captured));
}
