/** Field overrides on a live instance: the per-field diff against its template, the mark gate, and capturing and
 *  applying the override map.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { rowAt } from '../../runtime/loaders/prefabOverrides';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { readTraitDataFull } from '../../runtime/core/ecs/entityUtils';
import { isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { type PrefabFile, valuesEqual } from './prefab';
import { baseTokenResolver } from './prefabTokens';
import { instanceMovedMembers } from './prefabMembers';
import { overrideKeysOf } from '../instance/instanceOverrideView';

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
  const prefabEntity = rowAt(prefab, entityLocalId);
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
 *  what any surface shows — the Inspector highlight and the override list show the record (#1717, #1914 R3c,
 *  {@link memberOverrideKeys}, {@link recordedOverrides}); this stays as the unit under `getOverrideValues`' own tests. */
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

/** A member's RECORDED overrides (#1914 R3c): what the scene save writes, the Apply/Revert listing and the agent
 *  `overrides` list, and the Inspector highlights — one rule for all of them (#1717: they once diffed by value alone, so
 *  a value that differed with no record was listed and highlighted, and the file never held it).
 *
 *  The record is the member's marks, each field with its LIVE value whatever it equals (owner rulings F1, F3: Unity
 *  keeps an override "also if the value in the Prefab Asset changes"). A mark is the instance's OWN record at every
 *  depth: a load marks only what the writer states, never an enclosing layer's value (#1914 R1, § I2), and an editor
 *  write records what it made differ (`recordOverridesByDiff`, R2). No value decides a record here. Before R3c the save
 *  derived the same set from the value diff — a mark gate over it, then a fold of the marked fields equal to the base —
 *  and a re-imported template whose base moved under an unedited instance stays out for the same reason it did then:
 *  nothing recorded it.
 *
 *  Two things no record names, read from `diffs` (`getOverrideValues`), the only use left of the value diff:
 *  - a component the base does not define at this member (an ADDED trait or tag): structural, captured whole;
 *  - the Transform of a member `moved` inside its instance (#1437): its local pose is relative to a parent the prefab
 *    never gave it, so every field that differs from the base is part of the move. Moved back home, only the record
 *    applies again, so a round trip pins nothing.
 *
 *  Returned in the one key order a save writes ({@link inCanonicalOrder}). */
export function recordedOverrides(
  diffs: Record<string, Record<string, unknown>>,
  markSet: ReadonlySet<string> | null | undefined,
  baseEntity: { traits: Record<string, unknown> } | undefined,
  /** Whether the member is moved inside its instance — asked only when a Transform field differs with no record. */
  moved: () => boolean,
  currentTraits: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [traitName, fields] of Object.entries(diffs)) {
    const prefabData = baseEntity?.traits[traitName];
    const added = prefabData === undefined || prefabData === true;
    if (added || (traitName === 'Transform' && Object.keys(fields).some((f) => !markSet?.has(`Transform.${f}`)) && moved())) {
      out[traitName] = { ...fields };
    }
  }
  for (const markKey of markSet ?? []) {
    const dot = markKey.indexOf('.');
    const traitName = markKey.slice(0, dot);
    const field = markKey.slice(dot + 1);
    if (traitName === 'PrefabInstance') continue;
    // A member's guid is per-instance identity, and since v16 it is a ROW (`captureInstanceMembers`)
    // — so it must be written in exactly one place. Emitting it here too would put the same value
    // in two channels with no rule for which wins, and an edit to one would be silently discarded
    // by the other on the next load.
    if (traitName === 'EntityAttributes' && field === 'guid') continue;
    // A tag's record (`Tag.`): the tag itself while the member has it, whatever the base gives (#1914: a tag the scene
    // recorded stays the scene's when a row adds it too).
    if (!field) { if (currentTraits[traitName] && getTraitByName(traitName)?.category === 'tag') out[traitName] ??= {}; continue; }
    const cur = currentTraits[traitName]?.[field];
    if (cur === undefined) continue; // a field of a trait the member no longer has
    (out[traitName] ??= {})[field] = cur;
  }
  return inCanonicalOrder(out, currentTraits);
}

/** `prefab` with `overrides` (a chain's per-localId statements, tokens resolved) folded into its rows: a tag set, every
 *  other trait's fields laid over the row's own. What a nested instance shows with no record of its own. */
export function withOverridesFolded(prefab: PrefabFile, overrides: Record<number, Record<string, Record<string, unknown>>> | undefined): PrefabFile {
  if (!overrides || !Object.keys(overrides).length) return prefab;
  return {
    ...prefab,
    entities: prefab.entities.map((e) => {
      const over = overrides[e.localId];
      if (!over) return e;
      const traits: Record<string, unknown> = { ...e.traits };
      for (const [trait, fields] of Object.entries(over)) {
        const own = traits[trait];
        traits[trait] = getTraitByName(trait)?.category === 'tag' ? true
          : { ...(own && typeof own === 'object' ? own as Record<string, unknown> : {}), ...fields };
      }
      return { ...e, traits } as typeof e;
    }),
  };
}

/** `diffs` in the ONE key order a save writes (#1896): traits in the order {@link collectComparableTraits} reads them
 *  (the registry's), each trait's fields in the order it read them (the schema's — `writtenTraitKeys`' order for a
 *  plain entity; an AoS trait's live order). {@link recordedOverrides} builds the object in HISTORY order (the record's
 *  insertion order). That order is what the session happened to record first, and a reload re-reads the record in file
 *  order with a rotation key pulling in its whole group (`ROTATION_MARKS`), so a save → reload → save rewrote `{rx,x,ry,rz}` as
 *  `{rx,ry,rz,x}` with no value changed. */
function inCanonicalOrder(
  diffs: Record<string, Record<string, unknown>>,
  currentTraits: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const ordered = <T>(o: Record<string, T>, order: Record<string, unknown> | undefined): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const k of Object.keys(order ?? {})) if (k in o) out[k] = o[k]!;
    for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k]!; // nothing today: every key comes from `order`
    return out;
  };
  const byTrait = ordered(diffs, currentTraits);
  for (const t of Object.keys(byTrait)) byTrait[t] = ordered(byTrait[t]!, currentTraits[t]);
  return byTrait;
}

export function captureInstanceOverrides(
  rootInstanceId: number,
  prefab: PrefabFile,
  /** What the instance shows with no record of its own, when that is more than `prefab`: a nested instance's template
   *  under the chain enclosing it (`withOverridesFolded`), so a component or value the chain gives is base, not added. */
  base: PrefabFile = prefab,
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

    // The member's record (`recordedOverrides`): only a recorded field is an override, with its live value.
    const diffs = getOverrideValues(localId, currentTraits, base, resolveBase);
    const recorded = recordedOverrides(diffs, overrideKeysOf(entity), rowAt(base, localId), () => movedOf(entity.id(), !!diffs['Transform']), currentTraits);
    if (Object.keys(recorded).length > 0) result[localId] = recorded;
  });

  return result;
}

