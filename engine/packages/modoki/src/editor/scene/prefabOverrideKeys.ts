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
 *   - `"+trait.<member>.<name>"`       — a TAG (#1491) or a COMPONENT (#1663) added to a member: ONE row,
 *                                        as Unity lists an added component. Revert removes it whole; Apply
 *                                        writes it whole (its field keys, `planApply`). Listed per field, a
 *                                        field's Revert reset it to the schema default and left it listed.
 *   - `"~moved.<member>"`              — a member moved to another parent inside the instance (#1437).
 *   - `"~moved.<row>.<row>…:<member>"` — a NESTED instance's member moved out of it, the rows naming the
 *                                        nested instance frame by frame.
 *
 *  This module used to be inlined in `ApplyPrefabDialog.tsx` (the human "Apply to
 *  Prefab" / "Revert Overrides" panel) — `buildTree()` + the four string templates.
 *  It moved out so a SECOND caller (the `modoki_prefab {prefabAction:'overrides'}`
 *  agent op, which has no dialog to build a tree in) can enumerate the exact same
 *  keys the dialog checkboxes carry, rather than reimplementing the walk and
 *  drifting from it the next time one of the two changes. One builder
 *  (`collectInstanceOverrideListing`), one set of key shapes, two consumers. */

import { getTraitByName, getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData, getAllEntities } from '../../runtime/core/ecs/entityUtils';
import type { AddedEntity } from '../../runtime/loaders/loadSceneFile';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import {
  collectComparableTraits, getOverrideValues, ownInstanceStructure, baseTokenResolver, instanceBase, gateOnMarks, instanceMovedMembers, foldMarkedEqual, enclosingRowOverrides,
  isTemplateExcludedField, nestedFrameMoves, getCachedPrefabSync, type PrefabFile, type ApplyResult,
} from './prefab';
import { memberRef, toLocalIdKey, nestedKeyRef } from './overrideKeyGrammar';
import { ownedFrames, levelDoc } from './prefabBase';

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
/** A tag (#1491) or a component (#1663) the instance's member has and its row does not — keyed
 *  `+trait.<member>.<name>`, one row whatever its fields. */
export interface AddedTagNode {
  localId: number;
  entityName: string;
  /** The tag's or the component's name. */
  tag: string;
  key: string;
  /** A component's overridden fields (a tag has none): what a nested instance's Apply key is spelled by. */
  fields?: string[];
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
  const movedOf = instanceMovedMembers(rootInstanceId, prefab);
  const layerRows = enclosingRowOverrides(rootInstanceId);
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
    // Only what the save keeps (#1717): the save's mark gate, so a value that differs with no mark is neither listed nor
    // applied, and a MARKED value equal to its base is listed, as the save keeps it — except a field an enclosing row
    // states, whose value arrives marked too and would be listed as this instance's own.
    const marks = getOverrideMarkSet(entity);
    gateOnMarks(diffs, marks, base.entities.find((e) => e.localId === localId), () => movedOf(ecsId, !!diffs['Transform']));
    foldMarkedEqual(diffs, marks, currentTraits, layerRows?.[localId]);
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
      // A component the row lacks is the instance's ADDITION, one row (#1663).
      if (!prefabEntity || !(traitName in prefabEntity.traits)) {
        addedTags.push({ localId, entityName: name, tag: traitName, key: addedTagKey(refOf(localId), traitName), fields: Object.keys(fields) });
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

// ── The listing: every override on an instance, as display nodes carrying their keys. ONE builder (#1671) — the
//    dialog renders it, the agent op flattens it to keys (`collectInstanceOverrideKeys`); the dialog used to re-walk the
//    structure itself and drifted (#1661: it listed and pre-checked fields Apply cannot write). ──

/** `"-removed.<member>"` — a deleted prefab member. */
export interface RemovedEntityNode { localId: number; name: string; key: string }
/** `"-trait.<member>.<name>"` — a component removed from a surviving member. */
export interface RemovedTraitNode { localId: number; entityName: string; trait: string; key: string }
/** `"~moved.<member>"` (#1437), or a nested instance's member moved out of it (`~moved.<chain>:<member>`). */
export interface MovedNode { localId: number; name: string; parentName: string; key: string }
/** `"+added.<guid>"` — an added child subtree. */
export interface AddedNode { node: AddedEntity; key: string }

export interface InstanceOverrideListing {
  entities: EntityOverrideNode[];
  addedTags: AddedTagNode[];
  added: AddedNode[];
  removedEntities: RemovedEntityNode[];
  removedTraits: RemovedTraitNode[];
  moved: MovedNode[];
  /** U14 (#1693): each NESTED instance's own edits — its fields, added tags and removed components — keyed from this
   *  instance: `<nested row chain>:<the nested instance's key>` (`nestedKeyRef`). Apply writes them into THIS
   *  instance's prefab by default, as overrides on the row it holds for that instance; Revert does not take them (it
   *  reverts on the nested instance itself). */
  nested: string[];
  /** The field keys REVERT can act on but APPLY cannot, because the field is deliberately kept out of a written
   *  template (`isTemplateExcludedField` — a runtime read-back, or the scene-only `EntityAttributes.editorFolder`).
   *  Real overrides: reverting one is meaningful (reset this instance's folder back to the base). But Apply `continue`s
   *  past them without counting them, so a surface offering Apply must not offer these (`listingFor`, #1661). */
  applyExcluded: string[];
  /** Count of added subtrees that could NOT be given an addressable key because the live
   *  entity has no guid yet (`EntityAttributes.guid` is minted lazily — an entity created in
   *  this session and never saved has `''`).
   *
   *  They are OMITTED from `added` rather than keyed as `+added.`, because that string
   *  is ambiguous in a way that mis-targets: `applyToPrefabSelective` builds `addedByGuid`
   *  from the same value, so a second unguided addition OVERWRITES the first (only one gets
   *  inserted), and on the revert side `subtractRevertedStructure`'s `has(n.guid)` test
   *  matches BOTH, so selecting the single key would tear down two subtrees the caller could
   *  never have distinguished. A key that cannot name one thing is worse than no key. */
  unaddressableAdded: number;
}

export function collectInstanceOverrideListing(rootInstanceId: number, prefab: PrefabFile): InstanceOverrideListing {
  const { entities, addedTags } = collectInstanceOverrideTree(rootInstanceId, prefab);
  const applyExcluded: string[] = [];
  for (const e of entities) {
    for (const t of e.traits) {
      const meta = getTraitByName(t.trait);
      for (const f of t.fields) if (meta && isTemplateExcludedField(meta, f.field)) applyExcluded.push(f.key);
    }
  }

  // Only what THIS instance changed (#1506): a nested instance's enclosing rows author structure of their own, and a
  // key for it here is one Apply writes into `prefab` — a row's removed trait stripped from every instance of it.
  const structure = ownInstanceStructure(rootInstanceId, prefab);
  // Drop unguided additions rather than emit an ambiguous `+added.` — see the field's doc above.
  const added = structure.added.filter((node) => !!node.guid).map((node) => ({ node, key: addedKey(node.guid) }));
  const unaddressableAdded = structure.added.length - added.length;
  const refOf = documentMemberRefs(prefab);
  const prefabName = (localId: number) => prefab.entities.find((e) => e.localId === localId)?.name || `localId ${localId}`;
  const removedEntities = structure.removed.map((localId) => ({ localId, name: prefabName(localId), key: removedEntityKey(refOf(localId)) }));
  const removedTraits: RemovedTraitNode[] = [];
  for (const [localIdStr, names] of Object.entries(structure.removedTraits)) {
    const localId = Number(localIdStr);
    for (const trait of names) removedTraits.push({ localId, entityName: prefabName(localId), trait, key: removedTraitKey(refOf(localId), trait) });
  }
  const live = getAllEntities();
  const nameOfGuid = new Map(live.filter((e) => e.guid).map((e) => [e.guid!, e.name]));
  const moved: MovedNode[] = Object.entries(structure.moved).map(([localIdStr, parentGuid]) => {
    const localId = Number(localIdStr);
    return { localId, name: prefabName(localId), parentName: nameOfGuid.get(parentGuid) || '(unknown)', key: movedKey(refOf(localId)) };
  });
  // …and a nested instance's member moved OUT of it, which only this outer instance's prefab can record.
  const nameOfId = new Map(live.map((e) => [e.id, e.name]));
  for (const m of nestedFrameMoves(rootInstanceId)) {
    moved.push({ localId: m.lid, name: nameOfId.get(m.memberEcs) || `localId ${m.lid}`, parentName: nameOfGuid.get(m.parentGuid) || '(unknown)', key: m.ref });
  }

  // U14: what each nested instance changed of its own, measured against its own base (the rows enclosing it included).
  const nested: string[] = [];
  const piMeta = getTraitByName('PrefabInstance');
  for (const { frame, chain } of piMeta ? ownedFrames(rootInstanceId) : []) {
    const src = (readTraitData(frame, piMeta!)?.source as string) || '';
    const doc = src ? levelDoc(frame, src).doc : null;
    if (!doc) continue;
    const inner = collectInstanceOverrideTree(frame, doc);
    const own: string[] = [];
    for (const e of inner.entities) for (const t of e.traits) for (const f of t.fields) {
      if (!isTemplateExcludedField(getTraitByName(t.trait)!, f.field)) own.push(f.key);
    }
    // An added component's Apply here writes each field as an override on the row that holds the nested instance, which
    // takes field keys: its row is spelled as them.
    for (const t of inner.addedTags) {
      if (!t.fields) { own.push(t.key); continue; }
      const member = t.key.slice('+trait.'.length, -(t.tag.length + 1));
      for (const f of t.fields) if (!isTemplateExcludedField(getTraitByName(t.tag)!, f)) own.push(fieldKey(member, t.tag, f));
    }
    const ref = documentMemberRefs(doc);
    const st = ownInstanceStructure(frame, doc);
    for (const [lidStr, names] of Object.entries(st.removedTraits)) {
      for (const t of names) own.push(removedTraitKey(ref(Number(lidStr)), t));
    }
    for (const lid of st.removed) own.push(removedEntityKey(ref(lid)));
    for (const k of own) nested.push(nestedKeyRef(prefab, chain, k, getCachedPrefabSync));
  }

  return { entities, addedTags, added, removedEntities, removedTraits, moved, nested, applyExcluded, unaddressableAdded };
}

/** What a surface offering `mode` lists: Apply leaves out the fields it cannot write (#1661) — listed, they were
 *  pre-checked and then skipped with no word — and Revert leaves out the nested instances' own edits, which it reverts
 *  on the nested instance itself. */
export function listingFor(listing: InstanceOverrideListing, mode: 'apply' | 'revert'): InstanceOverrideListing {
  if (mode === 'revert') return { ...listing, nested: [] };
  const excluded = new Set(listing.applyExcluded);
  const entities = listing.entities
    .map((e) => ({ ...e, traits: e.traits.map((t) => ({ ...t, fields: t.fields.filter((f) => !excluded.has(f.key)) })).filter((t) => t.fields.length > 0) }))
    .filter((e) => e.traits.length > 0);
  return { ...listing, entities, applyExcluded: [] };
}

/** Every key a listing carries, nested ones included. */
export function listingKeys(l: InstanceOverrideListing): string[] {
  return [
    ...l.entities.flatMap((e) => e.traits.flatMap((t) => t.fields.map((f) => f.key))),
    ...l.added.map((n) => n.key), ...l.removedEntities.map((n) => n.key), ...l.removedTraits.map((n) => n.key),
    ...l.addedTags.map((n) => n.key), ...l.moved.map((n) => n.key), ...l.nested,
  ];
}

// ── Flat key enumeration, for a caller that only needs the key SET — the agent `prefab overrides` / apply / revert op ──

export interface InstanceOverrideKeys {
  /** `"<member>.traitName.fieldName"` keys (`<member>`: see the module header). */
  fields: string[];
  /** `"+added.<guid>"` keys. */
  added: string[];
  /** `"-removed.<member>"` keys. */
  removedEntities: string[];
  /** `"-trait.<member>.<name>"` keys. */
  removedTraits: string[];
  /** `"+trait.<member>.<name>"` keys — a tag (#1491) or a component (#1663) added to a member. */
  addedTags: string[];
  /** `"~moved.<member>"` keys — a member moved to another parent inside the instance (#1437) — and
   *  `"~moved.<nested row chain>:<member>"` for a NESTED instance's member moved out of it. Revert puts it
   *  back; Apply writes it into this prefab (a move it cannot express comes back in `ApplyResult.skipped`,
   *  with the reason). */
  moved: string[];
  /** All of the above, concatenated — what `applyToPrefabSelective`/
   *  `revertOverridesSelective` accept as `selectedKeys`. */
  all: string[];
  /** {@link InstanceOverrideListing.nested} — not in `all`. */
  nested: string[];
  /** {@link InstanceOverrideListing.applyExcluded} — a subset of `fields`, and in `all`: surfacing the set is what lets
   *  the agent's apply report honestly instead of echoing the caller's request back as `appliedKeys`. */
  applyExcluded: string[];
  /** {@link InstanceOverrideListing.unaddressableAdded}. */
  unaddressableAdded: number;
}

export function collectInstanceOverrideKeys(rootInstanceId: number, prefab: PrefabFile): InstanceOverrideKeys {
  const l = collectInstanceOverrideListing(rootInstanceId, prefab);
  const fields = l.entities.flatMap((e) => e.traits.flatMap((t) => t.fields.map((f) => f.key)));
  const added = l.added.map((n) => n.key);
  const removedEntities = l.removedEntities.map((n) => n.key);
  const removedTraits = l.removedTraits.map((n) => n.key);
  const addedTags = l.addedTags.map((n) => n.key);
  const moved = l.moved.map((n) => n.key);
  return {
    fields, added, removedEntities, removedTraits, addedTags, moved,
    all: [...fields, ...added, ...removedEntities, ...removedTraits, ...addedTags, ...moved],
    nested: l.nested, applyExcluded: l.applyExcluded, unaddressableAdded: l.unaddressableAdded,
  };
}

/** What an Apply did NOT do, in a sentence for the person who asked (#1437), or null when it did everything: the keys
 *  it skipped, each with its reason (a legacy move among them, #1868). */
export function applyOutcomeNotice(result: Pick<ApplyResult, 'skipped' | 'refused'>): string | null {
  // A REFUSAL is not a partial outcome and must not be worded as one: the line below would call it a "move" or a
  // "change" (#1468). Reported alone, and first, because there is nothing else to say. The reason says what landed
  // itself: a multi-file refusal can leave a file written that its rollback could not put back (#1732), so the frame
  // around it no longer claims "nothing was applied" for every refusal.
  if (result.refused) return `Apply to Prefab refused: ${result.refused.replace(/\.$/, '')}.`;
  const parts: string[] = [];
  const skipped = result.skipped ?? [];
  // "move" only when every skipped key IS one: a tag (#1491) or a key naming no member is not.
  const noun = skipped.every((x) => x.key.startsWith('~moved.')) ? 'move' : 'change';
  if (skipped.length) parts.push(`${skipped.length} ${noun}${skipped.length === 1 ? ' was' : 's were'} not applied: ${skipped.map((x) => x.reason).join('; ')}`);
  return parts.length ? `Apply to Prefab: ${parts.join('. ')}.` : null;
}

export { nestedFrameMoves };
