/** Shared override-key vocabulary for the Apply-to-Prefab / Revert-Overrides surfaces.
 *
 *  A "key" identifies one diff between a live prefab instance and its prefab base —
 *  a field override, an added subtree, a removed member, or a removed component — in
 *  the same four string shapes `applyToPrefabSelective`/`revertOverridesSelective`
 *  already consume:
 *   - `"localId.traitName.fieldName"` — a field override.
 *   - `"+added.<guid>"`               — an added child subtree.
 *   - `"-removed.<localId>"`          — a deleted prefab member.
 *   - `"-trait.<localId>.<name>"`     — a component removed from a surviving member.
 *
 *  This module used to be inlined in `ApplyPrefabDialog.tsx` (the human "Apply to
 *  Prefab" / "Revert Overrides" panel) — `buildTree()` + the four string templates.
 *  It moved out so a SECOND caller (the `modoki_prefab {prefabAction:'overrides'}`
 *  agent op, which has no dialog to build a tree in) can enumerate the exact same
 *  keys the dialog checkboxes carry, rather than reimplementing the walk and
 *  drifting from it the next time one of the two changes. One builder, one set of
 *  key shapes, two consumers. */

import { getTraitByName, getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import {
  collectComparableTraits, getOverrideValues, captureInstanceStructure,
  isTemplateExcludedField, type PrefabFile,
} from './prefab';

// ── Key-format helpers — the ONE place these four string shapes are written ──

export function fieldKey(localId: number, trait: string, field: string): string {
  return `${localId}.${trait}.${field}`;
}
export function addedKey(guid: string): string {
  return `+added.${guid}`;
}
export function removedEntityKey(localId: number): string {
  return `-removed.${localId}`;
}
export function removedTraitKey(localId: number, trait: string): string {
  return `-trait.${localId}.${trait}`;
}

// ── Per-field override tree (moved verbatim from ApplyPrefabDialog's buildTree) ──

export interface FieldNode {
  field: string;
  current: unknown;
  base: unknown;
  key: string; // fieldKey(localId, traitName, fieldName)
}
export interface TraitNode {
  trait: string;
  fields: FieldNode[];
}
export interface EntityOverrideNode {
  ecsId: number;
  parentEcsId: number; // live EntityAttributes.parentId — lets a caller nest children under parents
  localId: number;
  name: string;
  traits: TraitNode[];
}

/** Walk every live member of the instance rooted at `rootInstanceId`, diff each
 *  against its prefab base, and return one node per member that has at least one
 *  overridden field (traits/fields nested underneath). Members with no diffs are
 *  omitted entirely — same as the dialog's tree, which only ever showed overridden
 *  rows. */
export function collectInstanceOverrideFields(rootInstanceId: number, prefab: PrefabFile): EntityOverrideNode[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const allTraits = getAllTraits();
  const entityNameMeta = getTraitByName('EntityAttributes');

  const entries: EntityOverrideNode[] = [];
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;
    const ecsId = entity.id();

    // Snapshot live trait data for comparison — through the SHARED builder the serializer
    // uses. This built its own bag from `readTraitData` (the curated meta.fields subset), so
    // an override on any field a custom Inspector section owns (Animator.clips) or any AoS
    // field (SkinnedMeshRenderer.materials, AnimationLibrary.animSets) was absent from the
    // comparison: the dialog reported it as un-overridden and the user could not apply it,
    // while the scene serializer stored it correctly. QA-CTX-0003 close-out sweep.
    const currentTraits = collectComparableTraits(ecsId, allTraits);
    const diffs = getOverrideValues(localId, currentTraits, prefab);
    if (Object.keys(diffs).length === 0) return;

    // Entity display name: prefer live EntityAttributes.name; fall back to prefab name.
    // Also capture the live parentId so a caller can nest children under parents.
    let name = '';
    let parentEcsId = 0;
    if (entityNameMeta) {
      const ea = readTraitData(ecsId, entityNameMeta);
      if (ea?.name) name = ea.name as string;
      if (typeof ea?.parentId === 'number') parentEcsId = ea.parentId as number;
    }
    if (!name) {
      const prefabEntity = prefab.entities.find((e) => e.localId === localId);
      name = (prefabEntity?.name as string) || `localId ${localId}`;
    }

    const prefabEntity = prefab.entities.find((e) => e.localId === localId);
    const traitNodes: TraitNode[] = [];
    for (const [traitName, fields] of Object.entries(diffs)) {
      const fieldNodes: FieldNode[] = [];
      const base = (prefabEntity?.traits[traitName] as Record<string, unknown>) || {};
      for (const [field, current] of Object.entries(fields)) {
        fieldNodes.push({ field, current, base: base[field], key: fieldKey(localId, traitName, field) });
      }
      if (fieldNodes.length > 0) traitNodes.push({ trait: traitName, fields: fieldNodes });
    }
    if (traitNodes.length > 0) entries.push({ ecsId, parentEcsId, localId, name, traits: traitNodes });
  });

  entries.sort((a, b) => a.localId - b.localId);
  return entries;
}

// ── Flat key enumeration (fields + structural), for a caller that only needs the
//    key SET — the agent `prefab overrides` op, and `applyToPrefabSelective`'s "act
//    on everything" default. ──

export interface InstanceOverrideKeys {
  /** `"localId.traitName.fieldName"` keys. */
  fields: string[];
  /** `"+added.<guid>"` keys. */
  added: string[];
  /** `"-removed.<localId>"` keys. */
  removedEntities: string[];
  /** `"-trait.<localId>.<name>"` keys. */
  removedTraits: string[];
  /** All of the above, concatenated — what `applyToPrefabSelective`/
   *  `revertOverridesSelective` accept as `selectedKeys`. */
  all: string[];
  /** The subset of `fields` that REVERT can act on but APPLY cannot, because the field is
   *  deliberately kept out of a written template (`isTemplateExcludedField` — a runtime
   *  read-back, or the scene-only `EntityAttributes.editorFolder`).
   *
   *  These are real overrides and belong in `all`: reverting one is meaningful (reset this
   *  instance's folder back to the base). But `applyToPrefabSelective` `continue`s past them
   *  WITHOUT counting them, so an apply that "succeeds" may quietly not have written one.
   *  Surfacing the set is what lets the apply path report honestly instead of echoing the
   *  caller's request back as `appliedKeys`. */
  applyExcluded: string[];
  /** Count of added subtrees that could NOT be given an addressable key because the live
   *  entity has no guid yet (`EntityAttributes.guid` is minted lazily — an entity created in
   *  this session and never saved has `''`).
   *
   *  They are OMITTED from `added`/`all` rather than keyed as `+added.`, because that string
   *  is ambiguous in a way that mis-targets: `applyToPrefabSelective` builds `addedByGuid`
   *  from the same value, so a second unguided addition OVERWRITES the first (only one gets
   *  inserted), and on the revert side `subtractRevertedStructure`'s `has(n.guid)` test
   *  matches BOTH, so selecting the single key would tear down two subtrees the caller could
   *  never have distinguished. A key that cannot name one thing is worse than no key. */
  unaddressableAdded: number;
}

export function collectInstanceOverrideKeys(rootInstanceId: number, prefab: PrefabFile): InstanceOverrideKeys {
  const entities = collectInstanceOverrideFields(rootInstanceId, prefab);
  const fields: string[] = [];
  const applyExcluded: string[] = [];
  for (const e of entities) {
    for (const t of e.traits) {
      const meta = getTraitByName(t.trait);
      for (const f of t.fields) {
        fields.push(f.key);
        if (meta && isTemplateExcludedField(meta, f.field)) applyExcluded.push(f.key);
      }
    }
  }

  const structure = captureInstanceStructure(rootInstanceId, prefab);
  // Drop unguided additions rather than emit an ambiguous `+added.` — see the field's doc above.
  const addressableAdded = structure.added.filter((node) => !!node.guid);
  const unaddressableAdded = structure.added.length - addressableAdded.length;
  const added = addressableAdded.map((node) => addedKey(node.guid));
  const removedEntities = structure.removed.map((localId) => removedEntityKey(localId));
  const removedTraits: string[] = [];
  for (const [localIdStr, names] of Object.entries(structure.removedTraits)) {
    const localId = Number(localIdStr);
    for (const trait of names) removedTraits.push(removedTraitKey(localId, trait));
  }

  return {
    fields, added, removedEntities, removedTraits,
    all: [...fields, ...added, ...removedEntities, ...removedTraits],
    applyExcluded, unaddressableAdded,
  };
}
