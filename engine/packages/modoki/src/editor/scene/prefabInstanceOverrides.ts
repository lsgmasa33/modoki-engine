/** Field overrides on a live instance: the per-field diff against its template, the mark gate, and capturing and
 *  applying the override map.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { readTraitDataFull, writeTraitField, findEntity } from '../../runtime/core/ecs/entityUtils';
import { markOverride, getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { isPersistentTraitField, isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { type PrefabFile, valuesEqual } from './prefab';
import { baseTokenResolver } from './prefabTokens';
import { instanceMovedMembers } from './prefabMembers';

/** Get override values: fields that differ from the prefab source.
 *  Returns a nested record keyed by traitName → fieldName → live value. */
export function getOverrideValues(
  entityLocalId: number,
  currentTraits: Record<string, Record<string, unknown>>,
  prefab: PrefabFile,
  /** Resolves the member tokens a base value holds against this instance (`baseTokenResolver`), so a
   *  ref the template names by path compares equal to the guid it resolved to (#1352). Without it a
   *  token-bearing base field reads as overridden on every instance. */
  resolveBase?: (value: unknown) => unknown,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const prefabEntity = prefab.entities.find((e) => e.localId === entityLocalId);
  if (!prefabEntity) return result;

  for (const [traitName, currentData] of Object.entries(currentTraits)) {
    if (traitName === 'PrefabInstance') continue;
    const prefabData = prefabEntity.traits[traitName];

    // Trait the prefab doesn't define at this localId → the user added it to the
    // instance (root OR child). Capture the whole trait so it round-trips. This is
    // the unified "added-trait override" path; it replaces the old root-only
    // rootExtraTraits mechanism (the loader still reads rootExtraTraits for legacy
    // scenes). Added tags land here too with currentData === {} → captured as {name: {}}.
    if (prefabData === undefined) {
      // Capture the whole added trait, minus pure runtime read-back fields
      // (runtimeOnly) — persisting e.g. SkeletalAnimator.time / RigidBody.isSleeping
      // would bake a nondeterministic frame into the scene override.
      const addMeta = getTraitByName(traitName);
      const captured: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(currentData)) {
        if (addMeta?.fields[k]?.runtimeOnly) continue;
        captured[k] = v;
      }
      result[traitName] = captured;
      continue;
    }
    // Tag the prefab already defines at this localId: nothing to capture (it comes
    // from the prefab). Removing a prefab-defined tag on an instance isn't tracked,
    // same as removing any prefab-defined trait.
    if (prefabData === true) continue;

    const original = prefabData as Record<string, unknown>;
    // ⚠️ A field ABSENT from the base is not "unknown" — it is the trait's schema DEFAULT, because
    // that is exactly what the loader rebuilds it as (`meta.trait(partialData)`, koota fills the
    // rest). Skipping it instead (the old `origValue !== undefined` gate alone) makes a real
    // instance override invisible to every RAW caller of this function: the Inspector's
    // "overridden" highlight, and the Apply-to-Prefab / Revert-Overrides dialogs, which build their
    // checkbox tree from these diffs — so the field cannot be applied or reverted at all. The SAVE
    // path escapes it only because `captureInstanceOverrides` folds marked fields back in.
    //
    // This became reachable when `serializePrefab` started dropping BLANK asset refs (a prefab with
    // no material no longer writes `material: ""`), but it was always latent: any prefab authored
    // without a field hits it.
    const baseSchema = (getTraitByName(traitName)?.trait as { schema?: Record<string, unknown> } | undefined)?.schema;
    for (const [field, value] of Object.entries(currentData)) {
      if (field === 'parentId') continue; // parentId is remapped, skip
      // guid is per-instance identity — minted when the instance is created/saved,
      // while prefab files clear it (templates carry no identity). It legitimately
      // differs from the base but must NEVER be treated as an override: applying it
      // back would write one instance's guid into the prefab base and make every
      // future instance collide on the same guid. Since v16 it is also a ROW
      // (`captureInstanceMembers`), so both exclusions of it now hold for one reason:
      // the guid is written in exactly one channel (#1468).
      if (traitName === 'EntityAttributes' && field === 'guid') continue;
      const rawOrig = field in original ? original[field] : baseSchema?.[field];
      const origValue = resolveBase ? resolveBase(rawOrig) : rawOrig;
      if (origValue !== undefined && !valuesEqual(value, origValue)) {
        if (!result[traitName]) result[traitName] = {};
        result[traitName][field] = value;
      }
    }
  }

  return result;
}

/** Build the `currentTraits` bag `getOverrideValues` compares against the prefab base.
 *
 *  `readTraitDataFull`, NOT `readTraitData`: the latter returns only the curated Inspector
 *  subset in `meta.fields`, so every persistent field a custom Inspector section owns
 *  (`Animator.clips`, `AudioSource.clips`) and every AoS field (`AnimationLibrary.animSets`,
 *  `SkinnedMeshRenderer.materials`, `UIAction.onClickSet`) would be ABSENT from the
 *  comparison — reported as "not overridden" whatever its value. Runtime-only read-back
 *  fields are then stripped, or a live playhead would read as an override on every instance.
 *
 *  Shared rather than inlined because the Apply/Revert DIALOG built this bag with the
 *  curated read while the serializer used the full one, so the dialog under-reported exactly
 *  those fields and a user could not apply them (found by the QA-CTX-0003 close-out sweep —
 *  the third site where that same substitution has bitten). One builder, one answer. */
export function collectComparableTraits(
  ecsId: number,
  allTraits: TraitMeta[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const meta of allTraits) {
    if (meta.name === 'PrefabInstance') continue;
    const data = readTraitDataFull(ecsId, meta);
    if (!data) continue;
    for (const field of Object.keys(data)) {
      if (isRuntimeOnlyField(meta, field)) delete data[field];
    }
    out[meta.name] = data;
  }
  return out;
}

/** The RAW by-value diff as "traitName.fieldName" strings: every field that differs from `prefab`, marked or not. Not
 *  what any surface shows — the Inspector highlight and the override list pass the save's mark gate (#1717,
 *  {@link memberOverrideKeys}, `gateOnMarks`); this stays as the unit under `getOverrideValues`' own tests. */
export function getOverrides(
  entityLocalId: number,
  currentTraits: Record<string, Record<string, unknown>>,
  prefab: PrefabFile,
  resolveBase?: (value: unknown) => unknown,
): Set<string> {
  const overrides = new Set<string>();
  const values = getOverrideValues(entityLocalId, currentTraits, prefab, resolveBase);
  for (const [traitName, fields] of Object.entries(values)) {
    for (const field of Object.keys(fields)) {
      overrides.add(`${traitName}.${field}`);
    }
  }
  return overrides;
}

/** The MARK GATE: of a member's value diffs (`getOverrideValues`), drop every prefab-DEFINED field that carries no
 *  override mark. In place. The ONE rule the scene save and every override surface share — the Apply/Revert list, the
 *  agent `overrides`, the Inspector's highlight (#1717: those diffed by value alone, so a value that differs with no mark
 *  was listed and highlighted, and the file never held it). Unity's model: only a RECORDED modification is an override.
 *
 *  getOverrideValues reports every field whose live value differs from the prefab base — but a divergence alone is NOT
 *  an override: when a prefab is RE-IMPORTED and its base changes under an un-edited instance (e.g. the FBX-wrapper bake
 *  rewriting root-bone scale/rot), the instance's still-old values diverge from the new base and would be frozen as
 *  spurious overrides, breaking the instance (mesh collapses) while a fresh instance renders. A real override is one the
 *  user explicitly made, which is recorded as a mark (every editor instance write marks, #1709; scene load re-seeds marks
 *  from stored overrides). Two kinds are kept whatever the marks say:
 *  - an ADDED trait or tag (the base does not define it at this member): structural, captured whole;
 *  - the Transform of a member `moved` inside its instance (#1437): its local pose is relative to a parent the prefab
 *    never gave it, so every field that differs from the base is part of the move, and none of it needs a mark. Moved
 *    back home, the gate applies again, so a round trip pins nothing. */
export function gateOnMarks(
  diffs: Record<string, Record<string, unknown>>,
  markSet: ReadonlySet<string> | null | undefined,
  baseEntity: { traits: Record<string, unknown> } | undefined,
  /** Whether the member is moved inside its instance — asked only when a Transform field differs with no mark. */
  moved: () => boolean,
): void {
  for (const [traitName, fields] of Object.entries(diffs)) {
    const prefabData = baseEntity?.traits[traitName];
    if (prefabData === undefined || prefabData === true) continue; // added trait/tag — keep
    if (traitName === 'Transform' && Object.keys(fields).some((f) => !markSet?.has(`Transform.${f}`)) && moved()) continue;
    for (const field of Object.keys(fields)) {
      if (!markSet?.has(`${traitName}.${field}`)) delete fields[field];
    }
    if (Object.keys(fields).length === 0) delete diffs[traitName];
  }
}

/** Fold into `diffs` every MARKED field whose value COINCIDES with the base, so the value diff did not report it (e.g.
 *  after the base was edited to match): a marked field is a recorded override, whatever its value (#1709), and it is
 *  given its current value. In place. The save's rule, and the listing's (#1717) — except, under an enclosing row, a
 *  field that row states: the layer's values arrive marked as well (docs/prefabs.md I2), and would read as this
 *  instance's own. */
export function foldMarkedEqual(
  diffs: Record<string, Record<string, unknown>>,
  markSet: ReadonlySet<string> | null | undefined,
  currentTraits: Record<string, Record<string, unknown>>,
  /** What the layers enclosing the instance state on this member (`enclosingRowOverrides(root)[localId]`): a mark on a
   *  field they state is theirs, not the instance's own, so it is not folded in. Per FIELD, as the save's subtraction
   *  is (`subtractChainOverrides`) — a layer stating one field does not hide the instance's own mark on another. */
  layerStates?: Record<string, Record<string, unknown>>,
): void {
  if (!markSet) return;
  for (const markKey of markSet) {
    const dot = markKey.indexOf('.');
    const traitName = markKey.slice(0, dot);
    const field = markKey.slice(dot + 1);
    if (traitName === 'PrefabInstance') continue;
    // A member's guid is per-instance identity, and since v16 it is a ROW (`captureInstanceMembers`)
    // — so it must be written in exactly one place. Emitting it here too would put the same value
    // in two channels with no rule for which wins, and an edit to one would be silently discarded
    // by the other on the next load. #1468 asked for this line to be reconciled; the reconciliation
    // is that it stays, with the reason upgraded from "it is nothing" to "it is a row".
    if (traitName === 'EntityAttributes' && field === 'guid') continue;
    if (diffs[traitName] && field in diffs[traitName]) continue; // already captured
    const stated = layerStates?.[traitName];
    if (stated && typeof stated === 'object' && field in stated) continue; // the enclosing layer's value (a tag's may be `true`)
    const cur = currentTraits[traitName]?.[field];
    if (cur === undefined) continue;
    (diffs[traitName] ??= {})[field] = cur;
  }
}

export function captureInstanceOverrides(
  rootInstanceId: number,
  prefab: PrefabFile,
): Record<number, Record<string, Record<string, unknown>>> {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return {};

  const allTraits = getAllTraits();
  const result: Record<number, Record<string, Record<string, unknown>>> = {};
  const resolveBase = baseTokenResolver(rootInstanceId);

  // Which members sit somewhere their own template does not put them: the gate's Transform exemption (`instanceMovedMembers`).
  const movedOf = instanceMovedMembers(rootInstanceId, prefab);

  // Walk every entity that belongs to this instance via PrefabInstance.rootInstanceId
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;

    // Snapshot live trait data for comparison. Read what the trait PERSISTS (its
    // koota schema), exactly as serializeScene does — NOT the meta.fields subset.
    // AoS traits need it for their non-scalar fields (AnimationLibrary's
    // animSets/boneMaps, SkinnedMeshRenderer's materials, UIAction's onClickSet —
    // the bone-map-lost-on-save bug), and SoA traits need it too: a schema field
    // can be absent from meta.fields because a custom Inspector section owns it
    // (Animator.clips/clip) or it has no row at all (EntityAttributes.editorFolder),
    // and the curated read made those invisible to the diff, so a save dropped them.
    // runtimeOnly fields are excluded here — live read-back (Animator.activeClip,
    // SkeletalAnimator.time) must never be frozen into a file as an override, and
    // excluding it at the READ means no later path can resurrect it. Tags: the read
    // returns {} for a tag the entity has (null if absent), so an added tag shows up
    // as `{name: {}}`. See runtime/core/ecs/traitSchema.ts.
    const currentTraits = collectComparableTraits(entity.id(), allTraits);

    const diffs = getOverrideValues(localId, currentTraits, prefab, resolveBase);
    const markSet = getOverrideMarkSet(entity);

    // The MARK GATE (`gateOnMarks`): a divergence alone is not an override, only a recorded (marked) one is.
    gateOnMarks(diffs, markSet, prefab.entities.find((e) => e.localId === localId), () => movedOf(entity.id(), !!diffs['Transform']));

    // A MARKED value equal to its base is a recorded override too (`foldMarkedEqual`).
    foldMarkedEqual(diffs, markSet, currentTraits);

    if (Object.keys(diffs).length > 0) {
      result[localId] = diffs;
    }
  });

  return result;
}

/** Apply a captured override map to a prefab instance, locating entities by
 *  matching `PrefabInstance.localId` within the same `rootInstanceId`. Silently
 *  skips entries whose localId/trait/field no longer exists in the live world. */
export function applyOverridesByRootInstance(
  rootInstanceId: number,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
): void {
  if (!overrides || Object.keys(overrides).length === 0) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Build localId → ecsId map for this instance
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });

  for (const [localIdStr, traitMap] of Object.entries(overrides)) {
    const localId = Number(localIdStr);
    const ecsId = localToEcs.get(localId);
    if (!ecsId) {
      console.debug(`[Prefab] override skipped: no entity for localId ${localId} in instance ${rootInstanceId}`);
      continue;
    }
    const member = findEntity(ecsId);
    if (!member) continue;
    for (const [traitName, fields] of Object.entries(traitMap)) {
      const meta = getTraitByName(traitName);
      if (!meta) {
        console.debug(`[Prefab] override skipped: unknown trait ${traitName}`);
        continue;
      }
      if (meta.category === 'tag') {
        // Added-tag override: ensure the tag is present on the instance. writeTraitField
        // adds the tag for a truthy value (field name is ignored for tags).
        writeTraitField(ecsId, meta, '', true);
        markOverride(member, traitName, '');
        continue;
      }
      // Accept any field the trait PERSISTS (its koota schema), so a re-apply keeps
      // an AoS trait's non-scalar fields AND a SoA field that has no Inspector row
      // (Animator.clips/clip, EntityAttributes.editorFolder). A field the schema does
      // not declare is still skipped — that's the stale/renamed case the old guard
      // wanted. See runtime/core/ecs/traitSchema.ts.
      const known: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        if (!isPersistentTraitField(meta, field)) {
          console.debug(`[Prefab] override skipped: unknown field ${traitName}.${field}`);
          continue;
        }
        known[field] = value;
      }
      const entity = member;
      if (!entity.has(meta.trait)) {
        // Added-trait override (root or child): the instance carries a trait the
        // prefab lacks at this localId. Add it whole so prefab refresh preserves it.
        entity.add(meta.trait(known));
      } else {
        for (const [field, value] of Object.entries(known)) {
          writeTraitField(ecsId, meta, field, value);
        }
      }
      // Seed explicit marks from the override map so these fields survive a later
      // serialize even if the prefab base is edited to coincide with them.
      for (const field of Object.keys(known)) markOverride(member, traitName, field);
    }
  }
}
