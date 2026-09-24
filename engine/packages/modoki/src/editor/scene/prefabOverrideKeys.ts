/** Shared override-key vocabulary for the Apply-to-Prefab / Revert-Overrides surfaces.
 *
 *  A "key" identifies one diff between a live prefab instance and its prefab base —
 *  a field override, an added subtree, a removed member, or a removed component — in
 *  the string shapes `applyToPrefabSelective`/`revertOverridesSelective` consume.
 *  `<member>` is the member's minted `nodeGuid`, or its `localId` when its template
 *  predates prefab v5 (#1468 Phase 4 — `overrideKeyGrammar.ts` says why; both spellings
 *  are accepted everywhere):
 *   - `"<member>.traitName.fieldName"` — a field override.
 *   - `"+added.<guid>"`                — an added child subtree.
 *   - `"-removed.<member>"`            — a deleted prefab member.
 *   - `"-trait.<member>.<name>"`       — a component removed from a surviving member.
 *   - `"+trait.<member>.<tag>"`        — a TAG added to a member (#1491). A tag has no fields, so it
 *                                        cannot ride a field key; an added COMPONENT still does, since
 *                                        Apply seeds its whole bag from them.
 *   - `"~moved.<member>"`              — a member moved to another parent inside the instance (#1437).
 *   - `"~moved.<row>.<row>…:<member>"` — a NESTED instance's member moved out of it, the rows naming the
 *                                        nested instance frame by frame.
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
  collectComparableTraits, getOverrideValues, captureInstanceStructure, baseTokenResolver, instanceBase,
  isTemplateExcludedField, nestedFrameMoves, getCachedPrefabSync, type PrefabFile, type ApplyResult,
} from './prefab';
import { memberRef, toLocalIdKey } from './overrideKeyGrammar';

// ── Key-format helpers — the ONE place these four string shapes are written ──

/** `member` is {@link memberRef}'s answer — the member's `nodeGuid`, or its localId (#1468 Phase 4). */
export function fieldKey(member: number | string, trait: string, field: string): string {
  return `${member}.${trait}.${field}`;
}
export function addedKey(guid: string): string {
  return `+added.${guid}`;
}
export function removedEntityKey(member: number | string): string {
  return `-removed.${member}`;
}
export function removedTraitKey(member: number | string, trait: string): string {
  return `-trait.${member}.${trait}`;
}
export function addedTagKey(member: number | string, tag: string): string {
  return `+trait.${member}.${tag}`;
}
export function movedKey(member: number | string): string {
  return `~moved.${member}`;
}

/** The member part of a key for row `localId`, read from `prefab` — the SAME document the capture diffs
 *  the live tree against and the consumers resolve keys in, so a key always names the member the capture
 *  meant. ⚠️ Deliberately NOT the live member's own `PrefabInstance.nodeGuid` (tried in the Phase 4
 *  close-out, and reverted): while the cached template is newer than the live tree — a kept base scene
 *  carried across a prefab reload, a deferred reload — the capture itself diffs each live localId
 *  against another member's row (#1169's false-override class), and an identity-correct key then
 *  resolved to a DIFFERENT localId than the capture used: Revert moved A's override onto B. A key cannot
 *  be more right than the capture it names; that window needs the capture translated, not the key. */
export function documentMemberRefs(prefab: PrefabFile): (localId: number) => string {
  return (localId) => memberRef(prefab, localId);
}

/** One spelling for a key, so a key a caller spelled by localId and the same key listed by `nodeGuid`
 *  compare EQUAL (#1468 Phase 4): its localId form against `prefab`. The agent op validates a caller's
 *  keys against the listed set with this. A key naming a member `prefab` does not have maps to a value
 *  no listed key can have, so it reads as unknown rather than as whatever holds that number now. */
export function canonicalOverrideKey(key: string, prefab: PrefabFile): string {
  return toLocalIdKey(key, prefab, getCachedPrefabSync) ?? `\0unresolved:${key}`;
}

// ── Per-field override tree (moved verbatim from ApplyPrefabDialog's buildTree) ──

export interface FieldNode {
  field: string;
  current: unknown;
  base: unknown;
  key: string; // fieldKey(documentMemberRefs(prefab)(localId), traitName, fieldName)
}
export interface TraitNode {
  trait: string;
  fields: FieldNode[];
}
/** A tag the instance's member has and its row does not (#1491) — keyed `+trait.<member>.<tag>`. */
export interface AddedTagNode {
  localId: number;
  entityName: string;
  tag: string;
  key: string;
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
  return collectInstanceOverrideTree(rootInstanceId, prefab).entities;
}

/** {@link collectInstanceOverrideFields}, plus the member diffs that are not fields: an added TAG
 *  (#1491). The capture holds one as `{Tag: {}}` — a real override the scene save keeps — and the field
 *  walk used to drop it for having no fields, so no surface listed it and it could be neither applied nor
 *  reverted. ONE walk yields both, so the dialog and the agent op cannot disagree about which tags exist. */
export function collectInstanceOverrideTree(rootInstanceId: number, prefab: PrefabFile): {
  entities: EntityOverrideNode[]; addedTags: AddedTagNode[];
} {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { entities: [], addedTags: [] };
  const allTraits = getAllTraits();
  const entityNameMeta = getTraitByName('EntityAttributes');

  const entries: EntityOverrideNode[] = [];
  const addedTags: AddedTagNode[] = [];
  const resolveBase = baseTokenResolver(rootInstanceId); // #1352: a base ref held as a member token
  const refOf = documentMemberRefs(prefab);
  // A NESTED instance's base is its template under the rows enclosing it (#1492) — what it shows with no override
  // of its own. Against the bare template, a field the outer row sets was listed as this instance's override, and a
  // value Apply kept because a row shadows it (equal to the template now) was not listed at all.
  const base = instanceBase(rootInstanceId, prefab);
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
    const diffs = getOverrideValues(localId, currentTraits, base, resolveBase);
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

    const prefabEntity = base.entities.find((e) => e.localId === localId);
    const traitNodes: TraitNode[] = [];
    for (const [traitName, fields] of Object.entries(diffs)) {
      if (getTraitByName(traitName)?.category === 'tag') {
        addedTags.push({ localId, entityName: name, tag: traitName, key: addedTagKey(refOf(localId), traitName) });
        continue;
      }
      const fieldNodes: FieldNode[] = [];
      const base = (prefabEntity?.traits[traitName] as Record<string, unknown>) || {};
      for (const [field, current] of Object.entries(fields)) {
        fieldNodes.push({ field, current, base: base[field], key: fieldKey(refOf(localId), traitName, field) });
      }
      if (fieldNodes.length > 0) traitNodes.push({ trait: traitName, fields: fieldNodes });
    }
    if (traitNodes.length > 0) entries.push({ ecsId, parentEcsId, localId, name, traits: traitNodes });
  });

  entries.sort((a, b) => a.localId - b.localId);
  addedTags.sort((a, b) => a.localId - b.localId || a.tag.localeCompare(b.tag));
  return { entities: entries, addedTags };
}

// ── Flat key enumeration (fields + structural), for a caller that only needs the
//    key SET — the agent `prefab overrides` op, and `applyToPrefabSelective`'s "act
//    on everything" default. ──

export interface InstanceOverrideKeys {
  /** `"<member>.traitName.fieldName"` keys (`<member>`: see the module header). */
  fields: string[];
  /** `"+added.<guid>"` keys. */
  added: string[];
  /** `"-removed.<member>"` keys. */
  removedEntities: string[];
  /** `"-trait.<member>.<name>"` keys. */
  removedTraits: string[];
  /** `"+trait.<member>.<tag>"` keys — a tag added to a member (#1491). */
  addedTags: string[];
  /** `"~moved.<member>"` keys — a member moved to another parent inside the instance (#1437) — and
   *  `"~moved.<nested row chain>:<member>"` for a NESTED instance's member moved out of it. Revert puts it
   *  back; Apply writes it into this prefab (a move it cannot express comes back in `ApplyResult.skipped`,
   *  with the reason). */
  moved: string[];
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
  const tree = collectInstanceOverrideTree(rootInstanceId, prefab);
  const entities = tree.entities;
  const addedTags = tree.addedTags.map((t) => t.key);
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
  const refOf = documentMemberRefs(prefab);
  const removedEntities = structure.removed.map((localId) => removedEntityKey(refOf(localId)));
  const removedTraits: string[] = [];
  for (const [localIdStr, names] of Object.entries(structure.removedTraits)) {
    const localId = Number(localIdStr);
    for (const trait of names) removedTraits.push(removedTraitKey(refOf(localId), trait));
  }
  // …and a nested instance's member moved OUT of it, which only this outer instance's prefab can record.
  const moved = [
    ...Object.keys(structure.moved).map((localId) => movedKey(refOf(Number(localId)))),
    ...nestedFrameMoves(rootInstanceId).map((m) => m.ref),
  ];

  return {
    fields, added, removedEntities, removedTraits, addedTags, moved,
    all: [...fields, ...added, ...removedEntities, ...removedTraits, ...addedTags, ...moved],
    applyExcluded, unaddressableAdded,
  };
}

/** What an Apply did NOT do, in a sentence for the person who asked (#1437), or null when it did everything:
 *  moves the prefab could not express, and other files whose refs to moved members were not repaired. */
export function applyOutcomeNotice(result: Pick<ApplyResult, 'skipped' | 'memberPathsChanged' | 'fileRepair' | 'refused'>): string | null {
  // A REFUSAL is not a partial outcome and must not be worded as one: nothing was applied, and the
  // line below would call it a "move" or a "change" (#1468). Reported alone, and first, because there
  // is nothing else to say.
  if (result.refused) return `Apply to Prefab: nothing was applied — ${result.refused}.`;
  const parts: string[] = [];
  const skipped = result.skipped ?? [];
  // "move" only when every skipped key IS one: a tag (#1491) or a key naming no member is not.
  const noun = skipped.every((x) => x.key.startsWith('~moved.')) ? 'move' : 'change';
  if (skipped.length) parts.push(`${skipped.length} ${noun}${skipped.length === 1 ? ' was' : 's were'} not applied: ${skipped.map((x) => x.reason).join('; ')}`);
  if (result.memberPathsChanged) {
    if (result.fileRepair === null) parts.push('references to the moved members in other files could NOT be repaired — see the console');
    else if (result.fileRepair?.held.length) parts.push(`references in ${result.fileRepair.held.join(', ')} were not repaired: open with unsaved edits`);
  }
  return parts.length ? `Apply to Prefab: ${parts.join('. ')}.` : null;
}

export { nestedFrameMoves };
