/** Apply: planning which live overrides go into which prefab file, and committing that plan.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandedPrefabRefs } from '../../runtime/loaders/prefabNesting';
import { whyWorldNotAuthored, notAuthoredExit } from './authoredWorld';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { worldIdentityParents, identitySubtree } from '../../runtime/core/ecs/identityParents';
import { toLocalIdKeys, memberRef, splitNestedKey, nestedKeyRef } from './overrideKeyGrammar';
import { memberPathRecords, type PrefabReader } from '../../runtime/loaders/memberPaths';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, readTraitDataFull, findEntity } from '../../runtime/core/ecs/entityUtils';
import { newGuid, isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { memberPathSteps, addedKeyStep } from '../../runtime/core/assetRefRules';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';
import { localIdCounter, advanceLocalIdCounter } from '../../runtime/core/localIdCounter';
import { commitPrefabWrites } from './prefabCommit';
import { isPersistentTraitField } from '../../runtime/core/ecs/traitSchema';
import type { AddedEntity, NestedOverridePaths } from '../../runtime/loaders/loadSceneFile';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { frameBase, ownedRootAt, type FrameBase } from './prefabBase';
import { templateValueWriter } from './prefabTemplateValue';
import {
  chainSlots, memberKeyAt, writeStated, dropStated, writeRemoval, writeMemberRemoval, writeAddedNode, addedNodeRefusal, statedFields, traitInside,
  resolveKeyLevel, carrierOf, nodeSlot, type ApplyTargets, type LevelSlot,
} from './prefabApplyTargets';
import { conflictRefusal, effectsFingerprint, prefabFileName, formatEffectValue, REMOVED_VALUE, type ApplyConflict, type EditEffect, type KeyEffect } from './prefabApplyEffects';
import { parseMemberToken, memberPathLookup, type MemberStep } from '../../runtime/core/templateRefs';
import {
  guidForEntityId, isTemplateExcludedField, localToEcsGuid, type PrefabEntity, type PrefabFile, resolveInstanceContext,
  valuesEqual, warnInertPrefabSizes,
} from './prefab';
import { getCachedPrefabSync, getPrefabSource, preloadNestedPrefabsForSubtree, wouldCreateCycle } from './prefabCache';
import { settleSwallowedKeptState } from './prefabTokens';
import { collectComparableTraits } from './prefabInstanceOverrides';
import { captureInstanceStructure, toTemplateNodes } from './prefabCapture';
import { declaredTemplateKeys, type TemplateKeyDoc } from '../../runtime/loaders/templateKeyRecovery';
import { layerAuthoredStructureKeys } from './prefabChain';
import {
  collectInstanceRoots, framesBuiltFromOtherRows, missingNestedFrameKeys, missingPrefabInstance, missingSourceRefusal,
  staleFramesRefusal,
} from './prefabFrames';
import { refreshInstances } from './prefabRebuild';
import {
  carryPromotedGuids, deletePromotedNodes, insertAddedSubtree, movedRowsOf, promoteReferenceMoves,
  rehangPromotionSurvivors, snapshotPromotedGuids,
} from './prefabApplyStructure';

/** Does this added subtree hold an instance of `target` — a promotion that would make the prefab contain
 *  itself (#1446)? Only the slots that expand count ({@link expandedPrefabRefs}), never trait data. The expansion refuses a cyclic row, so the promoted instance came back empty after the refresh and
 *  the user's instance was gone. A scene may hold one — it expands fine there; only the file cannot. */
function addedNestsPrefab(node: AddedEntity, target: string): boolean {
  return expandedPrefabRefs([node]).some((ref) => wouldCreateCycle(target, ref));
}

/** Apply the selected overrides back to the source prefab file. `selectedKeys`
 *  holds a mix of (`<member>`: a nodeGuid, or a localId — `prefabOverrideKeys.ts`; both are
 *  turned into the localId form against this document on entry):
 *   - `"<member>.traitName.fieldName"` — overlay a live field value;
 *   - `"+added.<guid>"`               — insert an added child subtree;
 *   - `"-removed.<member>"`           — delete a prefab member (+ descendants);
 *   - `"-trait.<member>.<name>"`      — delete a component from a member;
 *   - `"+trait.<member>.<tag>"`       — add a TAG to a member (#1491);
 *   - `"~moved.<member>"` / `"~moved.<rows>:<member>"` — a move (#1437).
 *  Unselected diffs stay as per-instance overrides on the live instance. */
/** Outcome of an apply: how many live "added" subtrees were promoted into the
 *  prefab (and thus deleted from the scene). When > 0 the caller must re-save the
 *  current scene — those entities are now prefab members, so the scene's stale
 *  `added` structural overrides would otherwise re-spawn them as duplicates on
 *  the next load. */
export interface ApplyResult {
  promotedAdditions: number;
  /** True iff at least one override/structural change was actually written to the
   *  prefab. False ⇒ no-op apply (not an instance, nothing selected, write failed) —
   *  the caller must NOT push an undo entry. */
  applied: boolean;
  /** Source ref + before/after prefab snapshots, present only when `applied`. Lets
   *  the undo layer record a faithful before/after without re-reading state. */
  source?: string;
  prefabBefore?: PrefabFile;
  prefabAfter?: PrefabFile;
  /** Every prefab file the Apply wrote, innermost first (#1693): the frame's own template and/or an enclosing prefab
   *  (an override on its row, or U13's revert of one). `prefabBefore`/`prefabAfter` are the first of them. */
  writes?: { source: string; before: PrefabFile; after: PrefabFile }[];
  /** Each applied key, in the caller's spelling, and the prefab it was written to. */
  targets?: { key: string; target: string }[];
  /** U13: enclosing overrides this Apply reverted because the applied value would otherwise be shadowed, per prefab. */
  alsoReverted?: { source: string; keys: string[] }[];
  /** What each selected key did, as the plan computed it and the commit wrote it (#1736): every surface renders these. */
  effects?: KeyEffect[];
  /** Keys that state one slot with different values (#1736). Present only on a refusal: a conflict applies nothing. */
  conflicts?: ApplyConflict[];
  /** Every `validatePrefabData` warning `warnInertPrefabSizes` reported for the written template (an
   *  inert size is one kind, not the only one), present only when `applied`. The editor Console
   *  already shows them; this is for a caller whose reader is not the Console — the agent `apply` op
   *  answers with them (#1258). */
  warnings?: string[];
  /** Selected keys the apply could not write, each with the reason: a move it cannot express yet, a key
   *  naming no member, a tag it cannot add or a tag spelled as a field (#1491). Not every unwritable key
   *  lands here — a field the trait does not persist, or a key whose member or trait is gone, is still
   *  passed over quietly. */
  skipped?: { key: string; reason: string }[];
  /** Set when the apply REFUSED outright, with the reason for a human (#1468). Distinct from
   *  `skipped`, which means "everything else landed, these keys did not" — every reporter words it
   *  as a *move* that was not applied, because that is the only thing that has ever populated it.
   *  A refusal is the opposite shape: nothing landed, and there was no move. Sharing the channel
   *  produced "1 move was not applied: prefab format 6 is newer than 5", which is wrong twice over. */
  refused?: string;
}

/** Shared no-op result so every early return is consistent. */
const NOOP_APPLY: ApplyResult = { promotedAdditions: 0, applied: false };

/** Deep-copy a live trait bag before it is written into a prefab TEMPLATE.
 *  Mirrors `cloneTraitValues`, kept local so this module doesn't grow another
 *  entityUtils import. Falls back to the original bag if a value refuses to
 *  clone (a class instance, a function) — such a field can't be JSON-serialized
 *  into a prefab anyway, so the fallback costs nothing that wasn't already lost. */
function clonePersistable(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return data;
  try {
    return structuredClone(data);
  } catch {
    return data;
  }
}

/** What an Apply writes, computed and not yet written (#1693): every prefab document it changes, and what the rebuild
 *  after the write needs. {@link planApply} decides WHAT (keys, values, targets); {@link commitApplyPlan} does the
 *  write, the caches and the rebuild — the half #1692's `commitPrefabWrite` takes over. */
export interface ApplyPlan {
  /** Every prefab document this Apply changes, innermost first. `expected` is the document the plan read; `before`
   *  is its pristine copy (the undo snapshot), `doc` the new content. */
  writes: {
    source: string; expected: PrefabFile; before: PrefabFile; doc: PrefabFile; role: 'frame' | 'outer';
    /** The frames whose OWN edits this file took, and the keys (`localId.Trait.field`, `+trait.localId.Tag`): the refresh
     *  takes them out of those frames' captures (#1469, U15) — a U14 key written into a nested frame's own prefab. */
    appliedFrom?: { rootId: number; fields: ReadonlySet<string> }[];
  }[];
  rebuild: {
    rootInstanceId: number;
    /** `localId.Trait.field` the Apply copied from the source instance into its template: subtracted from its capture. */
    appliedFields: Set<string>;
    /** Live roots of the promoted added nodes, deleted before the refresh re-expands them as members. */
    liveAddedRootsToDelete: number[];
    promotedRows: Map<string, number>;
    promotedRefRows: Map<string, number>;
    /** Added nodes written as overrides on an enclosing prefab's row (#1715), by the guid of that level's instance root:
     *  each node's template key → its live guid, for the carry after that prefab's refresh. */
    keyedPromotions: Map<string, Map<string, string>>;
  };
  skipped: { key: string; reason: string }[];
  /** Each applied key (the caller's spelling) and the prefab it was written to (#1693). */
  applied: { key: string; target: string }[];
  /** U13: the enclosing overrides an Apply to an inner prefab reverted, per prefab (#1693). */
  alsoReverted: { source: string; keys: string[] }[];
  /** What each selected key does (#1736), in the caller's spelling — the one statement every surface renders. */
  effects: KeyEffect[];
  /** Slots two keys write with different values (#1736). Non-empty → the Apply is refused whole. */
  conflicts: ApplyConflict[];
}

/** What an Apply WOULD do, computed by the same plan the commit executes and written nowhere (#1736): the dialog's rows
 *  and footer and the agent op's `dryRun`/`overrides` render it. `files` is every prefab file the plan writes, innermost
 *  first. `fingerprint` is what the dialog hands back to `applyToPrefabSelective`, which refuses when the fresh plan
 *  differs from the one shown. */
export interface ApplyPreview {
  refused?: string;
  effects: KeyEffect[];
  conflicts: ApplyConflict[];
  skipped: { key: string; reason: string }[];
  files: { source: string; name: string; file: string }[];
  fingerprint: string;
}

export async function previewApply(rootInstanceId: number, selectedKeys: Set<string>, targets?: ApplyTargets): Promise<ApplyPreview> {
  const plan = await planApply(rootInstanceId, new Set(selectedKeys), targets, { dryRun: true });
  if ('result' in plan) {
    const r = plan.result;
    const effects = r.effects ?? [];
    return { ...(r.refused ? { refused: r.refused } : {}), effects, conflicts: r.conflicts ?? [], skipped: r.skipped ?? [], files: [], fingerprint: effectsFingerprint(effects) };
  }
  // A plan with a conflict writes NOTHING (the commit refuses it), so it names no file: a "Writes:" footer beside
  // "Cannot apply" said the opposite of what Apply does.
  const files = plan.conflicts.length ? [] : plan.writes.map((w) => {
    const path = isGuid(w.source) ? resolveRef(w.source) ?? w.source : w.source;
    return { source: w.source, name: w.doc.name || w.source, file: prefabFileName(path) };
  });
  return { effects: plan.effects, conflicts: plan.conflicts, skipped: plan.skipped, files, fingerprint: effectsFingerprint(plan.effects) };
}

export async function applyToPrefabSelective(
  rootInstanceId: number,
  selectedKeys: Set<string>,
  /** Where each key is written (#1693): a prefab on the instance's chain. Absent → each key's default. */
  targets?: ApplyTargets,
  /** `ApplyPreview.fingerprint` of what the caller SHOWED (#1736): a fresh plan that differs is refused, not written. */
  opts: { expect?: string } = {},
): Promise<ApplyResult> {
  // Both refusals are decided on a DRY plan (#1736 review): the writing plan's promotion stamps template keys on the live
  // nodes, a change no undo records, which a refused Apply left behind.
  const dry = await planApply(rootInstanceId, new Set(selectedKeys), targets, { dryRun: true });
  // A refusal or a no-op is answered from the DRY plan too: the writing plan could only reach it after promoting.
  if ('result' in dry) {
    const r = dry.result;
    if (r.refused) console.warn(`[Prefab] apply refused: ${r.refused}`);
    for (const { key, reason } of r.skipped ?? []) console.warn(`[Prefab] ${key} was not applied: ${reason}`);
    return r;
  }
  // Two keys stating one slot with different values: no silent last-write-wins (#1727). Nothing is written.
  if (dry.conflicts.length) return { ...NOOP_APPLY, refused: conflictRefusal(dry.conflicts), effects: dry.effects, conflicts: dry.conflicts };
  if (opts.expect !== undefined && effectsFingerprint(dry.effects) !== opts.expect) {
    return { ...NOOP_APPLY, refused: 'what this Apply would do changed since it was shown — review it again', effects: dry.effects };
  }
  const plan = await planApply(rootInstanceId, selectedKeys, targets);
  if ('result' in plan) return plan.result;
  if (plan.conflicts.length) return { ...NOOP_APPLY, refused: conflictRefusal(plan.conflicts), effects: plan.effects, conflicts: plan.conflicts };
  return commitApplyPlan(plan);
}

/** The computing half of Apply: reads the instance and the prefab, and returns the documents to write — or, for a
 *  refusal or a no-op, the result to answer with. Writes nothing. */
async function planApply(
  rootInstanceId: number,
  selectedKeys: Set<string>,
  targets?: ApplyTargets,
  /** A dry run (#1736, `previewApply`): the same plan, and nothing stamped on the live world or logged. */
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ApplyPlan | { result: ApplyResult }> {
  // ⚠️ Read the instance's values only from an AUTHORED world (#1548). Apply copies live trait values
  // into the template, and a pose or a Play value on the instance shows up as an override the dialog
  // pre-checks — so this wrote a preview frame into a .prefab.json every scene shares, which no ⏹ Exit
  // can revert. Refused here, the one function both the dialog and the agent `prefab apply` reach.
  const notAuthored = whyWorldNotAuthored();
  if (notAuthored) {
    return { result: { ...NOOP_APPLY, refused: `the live world is not authored (${notAuthored}) — ${notAuthoredExit(notAuthored) ?? 'exit the preview / stop Play first, or a pose would be written into the prefab'}` } };
  }
  // An `+added` node that holds something a template cannot take is SKIPPED with the reason, and the other keys land
  // (refused whole, the dialog's default Apply All and the agent's key-less `apply` landed nothing, #1831 close-out
  // re-review). What an `+added` key promotes is the node's IDENTITY subtree (I6), so that is what is asked, not the key's
  // text (a placeholder under a plain added node is named by no key of its own) and not the live tree (a placeholder under
  // a member moved into the node is that member's, and stays behind when the node is promoted). Two things it can hold:
  // - a reference to a missing prefab (#1699): it holds its edits as a scene record, which a template cannot take (I8);
  //   promoted, an empty reference row was written into the prefab and the node left the instance;
  // - a live frame KEPT after its prefab was trashed (#1862), which is no placeholder: promoted, the same empty reference
  //   row was written, and the rebuild took the frame and its members out of the world (close-out review).
  const idParents = worldIdentityParents(getCurrentWorld());
  const byName = new Map(getAllEntities().map((e) => [e.id, e.name] as const));
  const keptAddedKeys = new Map<string, string>();
  const piMeta = getTraitByName('PrefabInstance');
  for (const key of selectedKeys) {
    const g = /(?:^|:)\+added\.([^:]+)$/.exec(key)?.[1];
    const node = g ? (findEntityByGuid(g) as { id(): number } | undefined)?.id() : undefined;
    if (!node) continue;
    const nodeName = byName.get(node) ?? '';
    const inside = (id: number) => (nodeName && nodeName !== byName.get(id) ? ` (inside "${nodeName}")` : '');
    for (const id of identitySubtree(getCurrentWorld(), [node], idParents)) {
      if (unresolvedRefOf(findEntity(id))) {
        keptAddedKeys.set(key, `"${byName.get(id) ?? ''}"${inside(id)} is a reference to a missing prefab, so it cannot be written into a template until that prefab resolves. Leave "${nodeName || byName.get(id) || ''}" unchecked, or restore the prefab first`);
        break;
      }
      const d = piMeta ? readTraitData(id, piMeta) as { source?: string; rootInstanceId?: number } | null : null;
      if (!d?.source || d.rootInstanceId !== id || await getPrefabSource(d.source)) continue;
      keptAddedKeys.set(key, `${missingPrefabInstance(id, d.source)}${inside(id)}, so it cannot be written into a template until that prefab is back`);
      break;
    }
  }
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) {
    if (!dryRun) console.warn('[Prefab] Selected entity is not a prefab instance');
    return { result: NOOP_APPLY };
  }
  const { source } = ctx;

  const oldPrefab = await getPrefabSource(source);
  if (!oldPrefab) {
    // A frame kept live after its prefab was trashed (#1862), a nested one or #1738's top-level one: there is no document
    // to write into. Said, as Revert says it (`revertRefusal`), where this used to answer a bare `applied: false`.
    const why = missingSourceRefusal(ctx.rootInstanceId, source, 'apply');
    if (!dryRun) console.warn(`[Prefab] cannot apply: ${why}`);
    return { result: { ...NOOP_APPLY, refused: why } };
  }

  if (selectedKeys.size === 0) {
    if (!dryRun) console.log('[Prefab] Nothing selected; aborting apply.');
    return { result: NOOP_APPLY };
  }

  // ⚠️ REFUSE a document a NEWER build wrote (#1468). Apply rewrites the whole file and stamps this
  // serializer's version onto it (below), which on a too-new document is a DOWNGRADE — the stamp
  // then claims a shape this build cannot produce, and the fields it added are attributed to a
  // serializer that never wrote them. `plugins/prefabWriteGuard.ts` would refuse the write anyway,
  // but a 409 arrives after the live world has already been mutated by the promotion pass, leaving
  // the editor holding changes the file rejected. Refusing here is the same verdict, delivered
  // before anything moves. Older documents are unaffected and still stamp forward: this is a
  // one-sided comparison, never `!==` — every authored prefab in the corpus is below the constant.
  if (typeof oldPrefab.version === 'number' && oldPrefab.version > PREFAB_FORMAT_VERSION) {
    if (!dryRun) console.error(
      `[Prefab] cannot apply to "${source}" — it was written by a newer build (prefab format ` +
      `${oldPrefab.version}; this build writes ${PREFAB_FORMAT_VERSION}). Applying would rewrite ` +
      'the document with this build\'s serializer and re-stamp it downwards, discarding whatever ' +
      'the newer format added. Update this build, or apply from the build that wrote the file.',
    );
    return { result: {
      ...NOOP_APPLY,
      refused: `"${source}" was written by a newer build (prefab format ${oldPrefab.version}; this build writes ${PREFAB_FORMAT_VERSION})`,
    } };
  }

  // ⚠️ REFUSE an instance built from a document that numbers its rows differently from `oldPrefab` (#1483):
  // every live value below is read by `PrefabInstance.localId` and written into `oldPrefab`'s row of that
  // number, which would be another member's. A hot reload rebuilds such an instance (`rebaseStaleInstances`);
  // this is the backstop for any path that leaves one behind.
  const staleFrames = framesBuiltFromOtherRows(rootInstanceId);
  if (staleFrames.length) {
    const why = staleFramesRefusal(staleFrames);
    if (!dryRun) console.error(`[Prefab] cannot apply: ${why}`);
    return { result: { ...NOOP_APPLY, refused: why } };
  }

  // Warm THIS instance's live subtree before the structural capture below (#1284). The
  // per-root loop further down is a different set and comes far too late: `captureNestedRef`
  // runs inside the capture at `const structure = ...`, and on a cold cache it returns null
  // and the user-added nested subtree is dropped from `added[]` entirely.
  await preloadNestedPrefabsForSubtree(rootInstanceId);

  // A key into a nested frame whose prefab was trashed (#1862 keeps that frame live) cannot be translated against a
  // document, and was reported as a stale key ("the template has changed since the key was listed"), which it is not.
  // Each such key is skipped with the true reason and the rest still land: refusing the whole Apply turned the dialog's
  // default Apply All (and the agent's `apply` with no `keys`) from a partial success into nothing (close-out review).
  // A new set, never the caller's: the writing plan is handed the caller's own.
  const missingFrameKeys = await missingNestedFrameKeys(rootInstanceId, oldPrefab, selectedKeys);
  for (const [k, why] of keptAddedKeys) missingFrameKeys.set(k, why);
  if (missingFrameKeys.size) selectedKeys = new Set([...selectedKeys].filter((k) => !missingFrameKeys.has(k)));

  // Deep-clone the old prefab and overlay selected live values onto it. A second
  // pristine clone is the `before` snapshot for undo (oldPrefab itself isn't mutated,
  // but cloning guards against any aliasing into the cache).
  const newPrefab: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  // Stamp the format version: this rewrites the WHOLE document with today's serializer
  // semantics, so leaving a legacy `1` on it would be the #379 dishonesty in the other
  // direction — a v2-written file claiming v1. Found by the #379 close-out review, which
  // caught that the sweep for writers grepped for the token `version` and so could not see
  // a writer whose defect is that it never mentions it.
  newPrefab.version = PREFAB_FORMAT_VERSION;
  // NOT stamped on the undo snapshot: Apply's undo replays the BEFORE bytes, and
  // those must be what was actually on disk, version included.
  const prefabBefore: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  // A file with no id gets one HERE, on both sides, rather than from the write (which would stamp `newPrefab` alone).
  // The member-path repair below keys on `newPrefab.id` and ran for nothing on an id-less file, while its undo reversed
  // it; and the undo writes `prefabBefore` back with redo expecting exactly those bytes (#1664), so an id-less before
  // side made every undo re-mint the file's guid and every redo refuse as "changed on disk".
  if (!newPrefab.id) prefabBefore.id = newPrefab.id = newGuid();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { result: NOOP_APPLY };
  const eaMetaForApply = getTraitByName('EntityAttributes');

  // Build localId → ecsId map for this instance so we can read live values
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });

  // Live member guid → its path in this instance, for the value overlay below (#1352).
  const instancePaths = new Map<string, MemberStep[]>();
  if (eaMetaForApply) {
    for (const [key, target] of memberPathIndex(getCurrentWorld(), rootInstanceId)) {
      const guid = target ? (target.get(eaMetaForApply.trait) as { guid?: string }).guid : '';
      if (guid) instancePaths.set(guid, memberPathSteps(key));
    }
  }
  // Every live value this Apply writes into the template goes through ONE writer (#1659): exclusion and member tokens.
  const writer = templateValueWriter(rootInstanceId);
  const rootLid = newPrefab.rootLocalId ?? 1;
  const promotedPaths = new Map<number, MemberStep[]>();
  const promotion = {
    writer,
    pathOfRow: (lid: number): MemberStep[] | undefined => {
      if (lid === rootLid) return [];
      const known = promotedPaths.get(lid);
      if (known) return known;
      const ecs = localToEcs.get(lid);
      return ecs ? writer.pathOf(guidForEntityId(ecs)) : undefined;
    },
    rowPaths: promotedPaths,
    promoted: [] as { row: PrefabFile['entities'][number]; at: number }[],
    readOnly: dryRun,
  };

  // Capture the live structural diff so `+added`/`-removed`/`-trait` keys can be
  // resolved to concrete subtrees / localIds.
  const frame = frameBase(rootInstanceId);
  const structure = captureInstanceStructure(rootInstanceId, oldPrefab);
  const addedByGuid = new Map<string, AddedEntity>();
  for (const node of structure.added) addedByGuid.set(node.guid, node);

  let writtenCount = 0;
  // Every `localId.Trait.field` whose value this apply copied from THIS instance into its row (#1469). The
  // refresh below subtracts them from this instance's capture: they are the template now, not an override.
  const appliedFields = new Set<string>();
  const liveAddedRootsToDelete: number[] = []; // live ecs roots whose adds were applied
  // Above the document's high-water mark, not its rows (#1774): a number an EARLIER write freed at the top is below the
  // mark. Taken before this Apply's removals, so it never hands out a number it frees itself either.
  const nextLocalId = { v: localIdCounter(newPrefab) };
  const skipped: { key: string; reason: string }[] = [...missingFrameKeys].map(([key, reason]) => ({ key, reason }));
  const innerTags: { key: string; lid: number; tag: string }[] = [];
  const innerRemovals: { key: string; lid: number; trait: string }[] = [];
  /** The frame's own field keys, each with the fields it took out of the instance (`appliedFields`): U13 per key. */
  const innerFields: { key: string; lid: number; trait: string; fields: string[] }[] = [];
  const promotedRows = new Map<string, number>(); // live guid of a promoted added node → its new row
  const promotedRefRows = new Map<string, number>(); // …and of a promoted reference node → its nested row (#1660)
  const keyedPromotions = new Map<string, Map<string, string>>(); // …and of a node written on an enclosing row (#1715)
  // The row a live entity of THIS frame is: the root, a member, or an owned nested root (its row).
  const rowOfEcs = new Map<number, number>([[rootInstanceId, newPrefab.rootLocalId ?? 1]]);
  for (const [lid, ecs] of localToEcs) rowOfEcs.set(ecs, lid);
  for (const [ecs, row] of structure.ownedNested) rowOfEcs.set(ecs, row);

  // Every key in its localId form against the document this instance was expanded from (#1468 Phase 4,
  // `overrideKeyGrammar.ts`): a key names its member by `nodeGuid` where it can, which survives a template
  // renumber between listing the keys and applying them; from here on a localId is right because it is
  // read against the one document in hand. A key naming a member this document does not have is reported,
  // never guessed at.
  const canon = toLocalIdKeys(selectedKeys, oldPrefab, getCachedPrefabSync);
  selectedKeys = canon.keys;
  for (const key of canon.unresolved) skipped.push({ key, reason: 'it names no member of this prefab — the template has changed since the key was listed' });
  // An ADDED component is one row, `+trait.<member>.<Trait>` (#1663): written as every field of it, which is what applying
  // its fields did (the first seeds the whole bag), and reported in the row's spelling.
  for (const key of [...selectedKeys]) {
    const m = /^\+trait\.(\d+)\.([^.:]+)$/.exec(key);
    const meta = m ? getTraitByName(m[2]!) : undefined;
    if (!m || !meta || meta.category === 'tag') continue;
    const ecsId = localToEcs.get(Number(m[1]));
    const bag = ecsId === undefined ? undefined : collectComparableTraits(ecsId, [meta])[meta.name];
    selectedKeys.delete(key);
    // Skipped HERE, never passed on (close-out review): sent to an enclosing prefab, a row left unexpanded reached that
    // level's `+trait.` write, which states a TAG — it wrote `{}` and re-added the component the user had removed.
    if (!bag) { skipped.push({ key, reason: ecsId === undefined ? 'its member is not part of this prefab instance' : `the member no longer has ${meta.name}` }); continue; }
    const spelled = canon.original.get(key) ?? key;
    for (const field of Object.keys(bag)) {
      const k = `${m[1]}.${meta.name}.${field}`;
      selectedKeys.add(k);
      if (!canon.original.has(k)) canon.original.set(k, spelled);
    }
  }
  // Written into this prefab, an outer row's removal reaches every instance of it (#1506).
  for (const key of layerAuthoredStructureKeys(rootInstanceId, oldPrefab, structure)) {
    if (!selectedKeys.delete(key)) continue;
    skipped.push({ key: canon.original.get(key) ?? key, reason: 'the prefab enclosing this instance authors it, not this instance' });
  }

  // ── What each key does (#1736): recorded where it is written, so every surface renders this plan, never re-derives it ──
  const ownName = oldPrefab.name || source;
  const effectOf = new Map<string, KeyEffect>();
  const setEffect = (key: string, target: string, targetName: string, asOverride: boolean, effect: EditEffect): void => {
    effectOf.set(key, { key, target, targetName, asOverride, effect, alsoReverts: [] });
  };
  /** The live member's name, else its row's. */
  function memberNameIn(frameRoot: number, frameDoc: PrefabFile, lid: number): string {
    const ecs = memberOf(frameRoot, lid);
    const live = ecs && eaMetaForApply ? (readTraitData(ecs, eaMetaForApply)?.name as string) : '';
    return live || frameDoc.entities.find((e) => e.localId === lid)?.name || `member ${lid}`;
  }
  /** What a SLOT is (#1736, #1728): one field of one member, stated in one document at one place in it — the row
   *  `rowLid` and the path below it for an override on an enclosing prefab, none for a template's own row. The pool
   *  hands out one document object per prefab, so the object names the prefab. A statement is never keyed coarser
   *  than this: keyed by document alone, one frame's write was taken for another frame's (#1728). */
  const docIds = new WeakMap<PrefabFile, number>();
  let nextDocId = 0;
  const docId = (d: PrefabFile): number => {
    let i = docIds.get(d);
    if (i === undefined) docIds.set(d, (i = nextDocId++));
    return i;
  };
  const slotOf = (d: PrefabFile, rowLid: number | '', path: readonly number[], lid: number, trait: string, field: string): string =>
    `${docId(d)}|${rowLid}|${path.join('.')}|${lid}|${trait}|${field}`;
  const REMOVED = REMOVED_VALUE;
  /** Every key that states each slot, with its value — ALL of them, not the first: kept to the first, a third key equal
   *  to the first was never compared, and a 5/5/9 slot named two of its three keys (#1736 review). */
  const claims = new Map<string, { key: string; value: unknown; label: string; targetName: string }[]>();
  const claim = (slot: string, value: unknown, key: string, label: string, targetName: string): void => {
    const list = claims.get(slot) ?? [];
    if (!list.some((c) => c.key === key)) list.push({ key, value, label, targetName });
    claims.set(slot, list);
  };
  /** Once every key has claimed: a slot keys state with more than one value is a conflict naming EVERY key that states it
   *  (#1727) — and so is a field of a trait another key removes whole. Equal values write once. */
  const findConflicts = (): Map<string, ApplyConflict> => {
    const out = new Map<string, ApplyConflict>();
    for (const [slot, list] of claims) {
      if (list.some((c) => !valuesEqual(c.value, list[0]!.value))) {
        out.set(slot, { slot: list[0]!.label, targetName: list[0]!.targetName, keys: list.map((c) => ({ key: c.key, value: c.value })) });
      }
    }
    for (const [slot, list] of claims) {
      const removers = slot.endsWith('|*') ? list.filter((c) => c.value === REMOVED) : [];
      if (!removers.length) continue;
      const prefix = slot.slice(0, -1);
      for (const [other, writers] of claims) {
        if (other === slot || !other.startsWith(prefix)) continue;
        const against = writers.filter((w) => removers.some((r) => r.key !== w.key));
        if (!against.length) continue;
        const c = out.get(slot) ?? { slot: removers[0]!.label, targetName: removers[0]!.targetName, keys: list.map((x) => ({ key: x.key, value: x.value })) };
        for (const w of against) if (!c.keys.some((k) => k.key === w.key)) c.keys.push({ key: w.key, value: w.value });
        out.set(slot, c);
      }
    }
    return out;
  };
  /** The fields a whole component shows the reader: the LIVE values of what is written (the template holds tokens). */
  const shown = (live: Record<string, unknown>, written: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.keys(written).map((k) => [k, live[k]]));

  // WHERE each key is written (#1693, owner ruling C / U12): the frame's own template (level n), or as an override on
  // the row an enclosing prefab on the chain holds for this frame (level < n) — Unity's "Apply as override in Prefab".
  const slots = frame ? chainSlots(frame) : [];
  const n = frame ? frame.levels.length - 1 : 0;
  const sameSource = (a: string, b: string) => a === b || (isGuid(a) && resolveRef(a) === b) || (isGuid(b) && resolveRef(b) === a);
  const outerKeys: { key: string; slot: LevelSlot }[] = [];
  const nestedKeys: string[] = [];
  const appliedTargets: { key: string; target: string }[] = [];
  for (const key of [...selectedKeys]) {
    // A nested frame's own edit (U14): written below, in its frame's chain.
    if (splitNestedKey(key)) { selectedKeys.delete(key); nestedKeys.push(key); continue; }
    const original = canon.original.get(key) ?? key;
    const asked = targets?.perKey?.[original] ?? targets?.perKey?.[key] ?? targets?.default;
    const level = frame ? resolveKeyLevel(frame, slots, oldPrefab, key, asked, sameSource, (k) => addedByGuid.get(k.slice('+added.'.length))) : n;
    if (typeof level !== 'number') { selectedKeys.delete(key); skipped.push({ key, reason: level.skip }); continue; }
    if (level < n) { selectedKeys.delete(key); outerKeys.push({ key, slot: slots.find((sl) => sl.level === level)! }); }
  }

  for (const key of selectedKeys) {
    // A member moved inside its instance (#1437) is a statement only a file from before #1869 can hold: no gesture moves a
    // prefab's object any more. It is not applied (hub ruling B on #1868): a prefab keeps its objects where it placed
    // them, as Unity's does, and Applying one re-pathed the member in every other file that names it. Revert puts the
    // member back, and the move stays in the scene meanwhile.
    if (key.startsWith('~moved.')) { skipped.push({ key, reason: MOVED_MEMBER_NOT_APPLIED }); continue; }
    // Structural: insert an added subtree.
    if (key.startsWith('+added.')) {
      const guid = key.slice('+added.'.length);
      const node = addedByGuid.get(guid);
      if (!node) continue;
      if (addedNestsPrefab(node, oldPrefab.id || source)) { skipped.push({ key, reason: 'it holds an instance of this prefab, and a prefab cannot contain itself' }); continue; }
      const rowLid = nextLocalId.v;
      insertAddedSubtree(newPrefab, node, node.parentLocalId, nextLocalId, promotedRows, promotedRefRows, promotion);
      if (node.prefab) promoteReferenceMoves(newPrefab, node, rowLid, localToEcs, instancePaths, dryRun);
      setEffect(key, source, ownName, false, { op: 'addNode', name: node.name });
      const liveEcs = localToEcsGuid(guid);
      if (liveEcs) liveAddedRootsToDelete.push(liveEcs);
      writtenCount++;
      continue;
    }
    // Structural: remove a prefab member (and its descendants).
    if (key.startsWith('-removed.')) {
      const localId = Number(key.slice('-removed.'.length));
      // The cascade stops at a MOVED member, as the loader's does (#1437): it lives elsewhere, and so does
      // everything below it. Its row goes up to the nearest row that stays — a re-parent, so its refs follow.
      const moved = movedRowsOf(newPrefab, structure.moved);
      const parentOf = new Map(newPrefab.entities.map((e) => [e.localId, ((e.traits.EntityAttributes as { parentId?: number } | undefined)?.parentId) ?? 0]));
      const drop = new Set<number>();
      const kept: number[] = [];
      const cut = (lid: number) => {
        drop.add(lid);
        for (const [child, parent] of parentOf) {
          if (parent !== lid || drop.has(child)) continue;
          if (moved.has(child)) kept.push(child);
          else cut(child);
        }
      };
      cut(localId);
      // A row below it that a move placed elsewhere (#1437) stays, so it would be RE-HUNG under the nearest row that does,
      // which re-paths it in every other file that names it. Only a file from before #1869 holds such a move (no gesture
      // makes one now), and it is not applied, for the move-key reason above: the move is reverted first.
      if (kept.length) { skipped.push({ key, reason: MOVED_MEMBER_UNDER_REMOVAL }); continue; }
      const before = newPrefab.entities.length;
      newPrefab.entities = newPrefab.entities.filter((e) => !drop.has(e.localId));
      if (newPrefab.entities.length !== before) {
        writtenCount++;
        setEffect(key, source, ownName, false, { op: 'removeMember', member: oldPrefab.entities.find((e) => e.localId === localId)?.name || `member ${localId}` });
      }
      continue;
    }
    // Structural: remove a component from a member.
    if (key.startsWith('-trait.')) {
      const [, localIdStr, traitName] = key.split('.');
      const prefabEntity = newPrefab.entities.find((e) => e.localId === Number(localIdStr));
      if (prefabEntity && traitName in prefabEntity.traits) {
        delete prefabEntity.traits[traitName];
        writtenCount++;
        appliedTargets.push({ key, target: source });
        innerRemovals.push({ key, lid: Number(localIdStr), trait: traitName! });
        const member = memberNameIn(rootInstanceId, oldPrefab, Number(localIdStr));
        setEffect(key, source, ownName, false, { op: 'removeComponent', member, trait: traitName! });
        claim(slotOf(newPrefab, '', [], Number(localIdStr), traitName!, '*'), REMOVED, key, `${member} · ${traitName}`, ownName);
      }
      continue;
    }
    // Structural: add a TAG to a member (#1491). A tag has no fields, so no field key can carry it.
    if (key.startsWith('+trait.')) {
      const [, localIdStr, tagName] = key.split('.');
      const tagMeta = getTraitByName(tagName);
      const prefabEntity = newPrefab.entities.find((e) => e.localId === Number(localIdStr));
      const ecsId = localToEcs.get(Number(localIdStr));
      if (!tagMeta || tagMeta.category !== 'tag') { skipped.push({ key, reason: `${tagName} is not a registered tag` }); continue; }
      if (!prefabEntity || !ecsId) { skipped.push({ key, reason: 'its member is not part of this prefab instance' }); continue; }
      if (!findEntity(ecsId)?.has(tagMeta.trait)) { skipped.push({ key, reason: `the member no longer has ${tagName}` }); continue; }
      if (prefabEntity.traits[tagName] === undefined) {
        prefabEntity.traits[tagName] = true;
        writtenCount++;
      }
      innerTags.push({ key, lid: Number(localIdStr), tag: tagName });
      appliedTargets.push({ key, target: source });
      const tagMember = memberNameIn(rootInstanceId, oldPrefab, Number(localIdStr));
      setEffect(key, source, ownName, false, { op: 'addTag', member: tagMember, tag: tagName });
      claim(slotOf(newPrefab, '', [], Number(localIdStr), tagName, '*'), true, key, `${tagMember} · ${tagName}`, ownName);
      continue;
    }

    // Value override: overlay a live field value.
    const [localIdStr, traitName, fieldName] = key.split('.');
    const localId = Number(localIdStr);
    const ecsId = localToEcs.get(localId);
    if (!ecsId) continue;
    const meta = getTraitByName(traitName);
    if (!meta) continue;
    // A tag has no field to overlay: its key is `+trait.` (#1491). Named rather than dropped, so a caller
    // that spelled it as a field is told why nothing happened instead of reading a bare no-op.
    if (meta.category === 'tag') { skipped.push({ key, reason: `${traitName} is a tag — apply it as +trait.<member>.${traitName}` }); continue; }
    // Accept any field the trait PERSISTS, and read the same way. Both used to key
    // on meta.fields, so applying an override over a field owned by a custom
    // Inspector section (Animator.clips/clip) was skipped HERE and would have read
    // undefined anyway — "Apply to Prefab" reported success and changed nothing.
    // See runtime/core/ecs/traitSchema.ts.
    if (!isPersistentTraitField(meta, fieldName)) continue;
    if (isTemplateExcludedField(meta, fieldName)) continue; // read-back / scene-only: never in a template

    // CLONE: readTraitDataFull hands back LIVE references into the trait store, and
    // widening the read above admitted AoS object/array fields (AnimationLibrary's
    // animSets/boneMaps) that the meta.fields gate used to exclude. Storing one in
    // the prefab would alias the template to THIS instance through prefabCache —
    // editing the instance would silently rewrite the template. Scalars are
    // unaffected; the clone is per applied field, not per frame.
    const liveData = clonePersistable(readTraitDataFull(ecsId, meta));
    if (!liveData) continue;
    // A ref to another member of this instance goes into the template as a member token (#1352).
    const liveValue = writer.value(liveData[fieldName]);

    const prefabEntity = newPrefab.entities.find((e) => e.localId === localId);
    if (!prefabEntity) continue;
    let traitBag = prefabEntity.traits[traitName];
    if (traitBag === true) continue; // already a tag in the prefab — nothing to set
    const took: string[] = [];
    if (!traitBag) {
      // Added component: the prefab lacks this trait at this localId, so the user
      // added it on the instance. Seed the prefab with the WHOLE live trait so
      // applying actually persists the new component — without this the trait was
      // silently dropped (the ShipShake bug). Subsequent field keys for the same
      // trait then overlay onto this bag. runtimeOnly fields are dropped: a
      // template must not carry one instance's read-back frame.
      // Through the one writer (#1659): a member ref among the OTHER fields names this instance's member otherwise.
      traitBag = writer.bag(meta, liveData);
      // Every field of the component leaves the source (#1469) — a blank asset ref the writer leaves out of the template
      // too: the template's default IS blank, and a kept override of it pinned the instance against a later ref.
      for (const k of Object.keys(liveData)) if (!isTemplateExcludedField(meta, k)) took.push(k);
      prefabEntity.traits[traitName] = traitBag;
    }
    (traitBag as Record<string, unknown>)[fieldName] = liveValue;
    if (!took.includes(fieldName)) took.push(fieldName);
    for (const k of took) appliedFields.add(`${localId}.${traitName}.${k}`);
    innerFields.push({ key, lid: localId, trait: traitName, fields: took });
    writtenCount++;
    appliedTargets.push({ key, target: source });
    // Decided against the document as READ, not as this Apply has changed it so far (#1727: a second key of the same
    // component found the first one's bag and said "set field" of a component it was adding).
    const member = memberNameIn(rootInstanceId, oldPrefab, localId);
    const adds = oldPrefab.entities.find((e) => e.localId === localId)?.traits[traitName] === undefined;
    const bag = traitBag as Record<string, unknown>;
    setEffect(key, source, ownName, false, adds
      ? { op: 'addComponent', member, trait: traitName, fields: shown(liveData, bag) }
      : { op: 'setField', member, trait: traitName, field: fieldName, to: liveData[fieldName] });
    for (const f of adds ? Object.keys(bag) : [fieldName]) {
      claim(slotOf(newPrefab, '', [], localId, traitName, f), bag[f], key, `${member} · ${traitName}.${f}`, ownName);
    }
  }

  // ── Writes at a level of a frame's chain (#1693): the keys written as overrides on an enclosing prefab's row, a nested
  //    frame's own edits (U14), then U13 ──
  /** Every document an enclosing write touches, by prefab — the frame's OWN prefab is `newPrefab` itself, so a U14 write
   *  into it and the frame's own keys land in one document. `level` orders the files innermost first. */
  const pool = new Map<string, { source: string; levels: number[]; expected: PrefabFile; before: PrefabFile; doc: PrefabFile; dirty: boolean; appliedFrom: Map<number, Set<string>> }>();
  let outerRefusal = '';
  /** A pooled document: `pristine` is it as read (what an effect is decided against, #1727), `doc` what this Apply
   *  writes. `took`/`kept` add and take back a frame's own edit the refresh subtracts (U15; #1731 keeps one). */
  interface PoolDoc { doc: PrefabFile; pristine: PrefabFile; mark: () => void; took: (frame: number, key: string) => void; kept: (frame: number, key: string) => void }
  const docFor = async (src: string, level: number, root: number): Promise<PoolDoc | null> => {
    if (sameSource(src, source)) return { doc: newPrefab, pristine: oldPrefab, mark: () => { writtenCount++; }, took: () => {}, kept: () => {} };
    let e = pool.get(src);
    if (!e) {
      const expected = await getPrefabSource(src);
      const stale = framesBuiltFromOtherRows(root);
      if (!expected || stale.length) { outerRefusal ||= expected ? staleFramesRefusal(stale) : `Prefab "${src}" is not loaded`; return null; }
      const doc = JSON.parse(JSON.stringify(expected)) as PrefabFile;
      // Claims v8, so its write states the mark: `contentFor` owns that for every writer (#1797), from the rows here.
      doc.version = PREFAB_FORMAT_VERSION;
      const before = JSON.parse(JSON.stringify(expected)) as PrefabFile;
      // An id-less file gets its id HERE, on both sides, as the frame's own document does above (#1729): minted by the
      // write alone, the undo put `before` back with no id, the next write minted another, and redo always refused.
      if (!doc.id) before.id = doc.id = newGuid();
      e = { source: src, levels: [], expected, before, doc, dirty: false, appliedFrom: new Map() };
      pool.set(src, e);
    }
    // EVERY level this document is reached at (#1715): the refresh order reads the deepest, not the first.
    e.levels.push(level);
    const entry = e;
    return {
      doc: entry.doc, pristine: entry.expected, mark: () => { entry.dirty = true; },
      took: (frame, key) => { const set = entry.appliedFrom.get(frame) ?? new Set<string>(); set.add(key); entry.appliedFrom.set(frame, set); },
      kept: (frame, key) => { entry.appliedFrom.get(frame)?.delete(key); },
    };
  };
  /** A frame's chain, for the writes made in it: the opened frame's own, or a nested frame's (U14). */
  interface ChainCtx { base: FrameBase; slots: LevelSlot[]; frameDoc: PrefabFile; frameRoot: number; n: number; chain: number[] }
  /** A frame-local key as THIS instance's listing spells it: through the row chain for a nested frame (U14). */
  const listedKey = (ctx: ChainCtx, inner: string): string => (ctx.chain.length ? nestedKeyRef(oldPrefab, ctx.chain, inner, getCachedPrefabSync) : inner);
  /** What each key wrote at each level, for U13: `fields` undefined = the whole trait (a tag, a removal). `keep` puts a
   *  field back into the frame's capture — its own edit stays (#1731) — where the key took it out (U15). */
  const written: { key: string; ctx: ChainCtx; level: number; lid: number; trait: string; fields?: string[]; keep?: (localKey: string) => void }[] = [];
  /** Every SLOT this Apply itself wrote into an enclosing document (`slotOf`, `*` = the whole trait): U13 never drops
   *  those — one component's fields split across two targets would otherwise undo the outer half (review of P5–P6). By
   *  slot, not by document: keyed `source|lid|trait|field`, one frame's write there hid ANOTHER frame's U13 drop (#1728). */
  const wroteAt = new Set<string>();
  const ownCtx: ChainCtx | null = frame ? { base: frame, slots, frameDoc: oldPrefab, frameRoot: rootInstanceId, n, chain: [] } : null;
  if (ownCtx) {
    const keepOwn = (k: string) => { appliedFields.delete(k); };
    for (const w of innerFields) written.push({ ctx: ownCtx, level: n, ...w, keep: keepOwn });
    for (const t of innerTags) written.push({ key: t.key, ctx: ownCtx, level: n, lid: t.lid, trait: t.tag });
    // A REMOVED component too: an enclosing row that still sets a field of it would add it back — partly — on every other
    // instance of the enclosing prefab (a row override of a component the member lacks adds it: #1658's own mechanism).
    for (const r of innerRemovals) written.push({ key: r.key, ctx: ownCtx, level: n, lid: r.lid, trait: r.trait });
  }

  /** ONE template-value writer per enclosing level's instance root, shared by every key written there: a node this Apply
   *  adds at that level is `promote`d on it before any value there is tokenized, so a ref to it from another key's node
   *  is a token too (close-out review: a writer per key left sibling added nodes naming each other by live guid). The
   *  frame's OWN level is `writer` itself — a U14 key's default write lands in this document, beside the promotion's rows,
   *  and a fresh writer there never saw their `promote` (#1659's cross-instance ref, close-out re-review). */
  const levelWriters = new Map<number, ReturnType<typeof templateValueWriter>>([[rootInstanceId, writer]]);
  const writerAt = (root: number) => {
    let w = levelWriters.get(root);
    if (!w) levelWriters.set(root, (w = templateValueWriter(root)));
    return w;
  };
  /** Each `+added.` key an enclosing level takes, as the template node it becomes (fresh keys, `toTemplateNodes`) and
   *  each node's template key → live guid, for the carry. */
  const outerAdded = new Map<string, { tpl: AddedEntity; keyed: Map<string, string> }>();
  /** Per target prefab, the template keys it declares, plus every key this Apply has written into it: a promotion may not
   *  write a key twice into one document (#1809), across promotions of one Apply as within one. */
  const declaredBy = new Map<string, Set<string>>();
  /** Promote the added node `key` names — every node of its subtree — at level `level`'s writer, at its `+key` path. */
  const promoteOuterAdded = (key: string, ctx: ChainCtx, level: number): void => {
    const node = addedByGuid.get(key.slice('+added.'.length));
    const slot = ctx.slots.find((sl) => sl.level === level);
    if (!node || !slot || addedNodeRefusal(slot, ctx.frameDoc, node)) return;
    const levelWriter = writerAt(ctx.base.levels[level]!.root);
    // A live marker naming a key the level's prefab already declares is stale (a detached node moved here), and mints:
    // carried, it was a second node with that key in one frame, and so on one guid (#1809).
    let declared = declaredBy.get(slot.source);
    if (!declared) {
      const levelDoc = getCachedPrefabSync(slot.source);
      declaredBy.set(slot.source, (declared = levelDoc ? declaredTemplateKeys(levelDoc as TemplateKeyDoc) : new Set()));
    }
    const tpl = toTemplateNodes([node], declared)![0]!;
    const keyed = new Map<string, string>();
    // Every node of the subtree, children too, derives from the FRAME ROOT's path plus its own key (#1809): a keyed
    // node's guid names its frame and its key, never its anchor or a keyed parent.
    const pathsFrom = (live: AddedEntity, t: AddedEntity, frame: MemberStep[] | undefined): void => {
      const steps = frame && t.key ? [...frame, addedKeyStep(t.key)] : undefined;
      if (live.guid && steps) levelWriter.promote(live.guid, steps);
      if (live.guid && t.key) keyed.set(t.key, live.guid);
      live.children.forEach((c, i) => { if (t.children[i]) pathsFrom(c, t.children[i]!, frame); });
    };
    const anchor = memberOf(ctx.frameRoot, node.parentLocalId);
    pathsFrom(node, tpl, anchor ? levelWriter.pathOf(guidForEntityId(ctx.frameRoot)) : undefined);
    outerAdded.set(key, { tpl, keyed });
  };

  /** Write `key` (a frame-local key: field, `+trait.`, `-trait.`, `-removed.`, `+added.`) of frame `ctx` at enclosing level `level` < ctx.n, as
   *  an override on the row that level holds for the frame. False when it was skipped (said in `skipped`). */
  const writeOuter = async (key: string, reportAs: string, ctx: ChainCtx, level: number): Promise<boolean> => {
    const slot = ctx.slots.find((sl) => sl.level === level)!;
    const at = await docFor(slot.source, level, ctx.base.levels[level]!.root);
    if (!at) return false;
    const carrier = at.doc.entities.find((x) => x.localId === slot.rowLid && x.prefab);
    if (!carrier) { skipped.push({ key: reportAs, reason: `its row is no longer in Prefab '${at.doc.name}'` }); return false; }
    const levelWriter = writerAt(ctx.base.levels[level]!.root);
    const tName = at.doc.name || slot.source;
    const here = (lid: number, trait: string, field: string) => slotOf(at.doc, slot.rowLid, slot.path, lid, trait, field);
    if (key.startsWith('+added.')) {
      // A node the scene added, added by this level (#1715, U12): a template node on the row — every instance of this
      // prefab gains it — with a fresh template key per node, never the live guid (#1387).
      const guid = key.slice('+added.'.length);
      const node = addedByGuid.get(guid);
      if (!node) return false;
      const why = addedNodeRefusal(slot, ctx.frameDoc, node);
      if (why) { skipped.push({ key: reportAs, reason: why }); return false; }
      // Every node's path at this level is already known (`promoteOuterAdded`, before any key was written), so a ref to a
      // node of this subtree or of another key's is a token; every value goes through this level's writer, applied in
      // the frame the node hangs in (as a field written here is).
      if (!outerAdded.has(key)) promoteOuterAdded(key, ctx, level);
      const { tpl, keyed } = outerAdded.get(key)!;
      const tokenize = (t: AddedEntity): void => {
        for (const [name, bag] of Object.entries(t.traits)) if (typeof bag === 'object') t.traits[name] = levelWriter.bag(getTraitByName(name), bag, ctx.frameRoot);
        t.children.forEach(tokenize);
      };
      tokenize(tpl);
      if (!writeAddedNode(carrier, slot.path, memberKeyAt(slot, ctx.frameDoc, node.parentLocalId), node.parentLocalId, tpl)) {
        skipped.push({ key: reportAs, reason: `Prefab '${at.doc.name}' cannot name the member it hangs under (a row on the way has no identity) — re-save it once` });
        return false;
      }
      const levelRoot = guidForEntityId(ctx.base.levels[level]!.root);
      const carried = keyedPromotions.get(levelRoot) ?? new Map<string, string>();
      for (const [k, g] of keyed) carried.set(k, g);
      keyedPromotions.set(levelRoot, carried);
      const liveEcs = localToEcsGuid(guid);
      if (liveEcs) liveAddedRootsToDelete.push(liveEcs);
      setEffect(reportAs, slot.source, tName, true, { op: 'addNode', name: node.name });
    } else if (key.startsWith('-removed.')) {
      // A member the scene deleted, removed by this level (U12): the row's own `removed`, or a member row deeper down.
      const lid = Number(key.slice('-removed.'.length));
      if (!writeMemberRemoval(carrier, slot.path, memberKeyAt(slot, ctx.frameDoc, lid), lid)) {
        skipped.push({ key: reportAs, reason: `Prefab '${at.doc.name}' cannot name that member (a row on the way has no identity) — re-save it once` });
        return false;
      }
      setEffect(reportAs, slot.source, tName, true, { op: 'removeMember', member: ctx.frameDoc.entities.find((e) => e.localId === lid)?.name || `member ${lid}` });
    } else if (key.startsWith('+trait.')) {
      const [, lidStr, tag] = key.split('.');
      const lid = Number(lidStr);
      writeStated(carrier, slot.path, memberKeyAt(slot, ctx.frameDoc, lid), lid, tag!, {});
      written.push({ key: reportAs, ctx, level, lid, trait: tag! });
      wroteAt.add(here(lid, tag!, '*'));
      const member = memberNameIn(ctx.frameRoot, ctx.frameDoc, lid);
      setEffect(reportAs, slot.source, tName, true, { op: 'addTag', member, tag: tag! });
      claim(here(lid, tag!, '*'), true, reportAs, `${member} · ${tag}`, tName);
    } else if (key.startsWith('-trait.')) {
      const [, lidStr, t] = key.split('.');
      const lid = Number(lidStr);
      const mk = memberKeyAt(slot, ctx.frameDoc, lid);
      // Said against the chain as READ (the carrier above is this Apply's copy): this level is what adds it → it stops.
      const stops = !!statedFields(carrierOf(ctx.base, slot) ?? carrier, slot.path, mk, lid, t!) && !traitInside(ctx.slots, ctx.base, ctx.frameDoc, level, lid, t!);
      // This level adds it: it stops adding it. Whatever still gives the member the component below this level is
      // removed by a statement here.
      if (statedFields(carrier, slot.path, mk, lid, t!)) dropStated(carrier, slot.path, mk, lid, t!);
      if (traitInside(ctx.slots, ctx.base, ctx.frameDoc, level, lid, t!) && !writeRemoval(carrier, slot.path, mk, lid, t!)) {
        skipped.push({ key: reportAs, reason: `Prefab '${at.doc.name}' cannot name that member (a row on the way has no identity) — re-save it once` });
        return false;
      }
      written.push({ key: reportAs, ctx, level, lid, trait: t! });
      wroteAt.add(here(lid, t!, '*'));
      const member = memberNameIn(ctx.frameRoot, ctx.frameDoc, lid);
      setEffect(reportAs, slot.source, tName, true, stops ? { op: 'stopAddingComponent', member, trait: t! } : { op: 'removeComponent', member, trait: t! });
      claim(here(lid, t!, '*'), REMOVED, reportAs, `${member} · ${t}`, tName);
    } else {
      const [lidStr, t, f] = key.split('.');
      const lid = Number(lidStr);
      const ecs = memberOf(ctx.frameRoot, lid);
      const meta = getTraitByName(t!);
      if (!ecs || !meta || meta.category === 'tag' || !isPersistentTraitField(meta, f!) || isTemplateExcludedField(meta, f!)) return false;
      const live = clonePersistable(readTraitDataFull(ecs, meta));
      if (!live) return false;
      // A component nothing inside this level gives the member is written WHOLE here (the truthful effect: this level
      // adds it); otherwise only the field, as an override.
      const edits = traitInside(ctx.slots, ctx.base, ctx.frameDoc, level, lid, t!, true);
      const fields = edits
        ? { [f!]: levelWriter.value(live[f!], ctx.frameRoot) }
        : levelWriter.bag(meta, live, ctx.frameRoot);
      writeStated(carrier, slot.path, memberKeyAt(slot, ctx.frameDoc, lid), lid, t!, fields);
      written.push({ key: reportAs, ctx, level, lid, trait: t!, fields: Object.keys(fields) });
      const member = memberNameIn(ctx.frameRoot, ctx.frameDoc, lid);
      setEffect(reportAs, slot.source, tName, true, edits
        ? { op: 'setField', member, trait: t!, field: f!, to: live[f!] }
        : { op: 'addComponent', member, trait: t!, fields: shown(live, fields) });
      for (const k of Object.keys(fields)) {
        wroteAt.add(here(lid, t!, k));
        claim(here(lid, t!, k), fields[k], reportAs, `${member} · ${t}.${k}`, tName);
      }
    }
    at.mark();
    appliedTargets.push({ key: reportAs, target: slot.source });
    return true;
  };
  /** The live member `lid` of frame `root` (its root for the root's own localId). */
  function memberOf(root: number, lid: number): number {
    if (root === rootInstanceId) return localToEcs.get(lid) ?? 0;
    let found = 0;
    getCurrentWorld().query(PrefabInstanceMeta!.trait).updateEach(([pi], entity) => {
      const d = pi as { rootInstanceId?: number; localId?: number };
      if (!found && d.rootInstanceId === root && d.localId === lid) found = entity.id();
    });
    return found;
  }

  if (ownCtx) for (const { key, slot } of outerKeys) if (key.startsWith('+added.')) promoteOuterAdded(key, ownCtx, slot.level);
  for (const { key, slot } of outerKeys) {
    if (!ownCtx) break;
    await writeOuter(key, key, ownCtx, slot.level);
    if (outerRefusal) break;
  }

  // U14 (owner, 2026-09-28): a NESTED frame's own edit, listed on this — its outer — instance, goes by default to THIS
  // instance's prefab, as an override on the row it holds for that frame; its own prefab only when picked (ruling C).
  /** The keys the last `writeTemplate` took out of its frame, for the refresh's subtraction. */
  const templateTook: string[] = [];
  for (const key of nestedKeys) {
    const parts = splitNestedKey(key)!;
    let nested = rootInstanceId;
    for (const step of memberPathSteps(parts.chain)) nested = nested && typeof step === 'number' ? ownedRootAt(nested, step) : 0;
    const fb = nested ? frameBase(nested) : null;
    const idx = fb ? fb.levels.findIndex((l) => l.root === rootInstanceId) : -1;
    const fDoc = fb ? await getPrefabSource(fb.levels[fb.levels.length - 1]!.source) : null;
    if (!fb || idx < 0 || !fDoc) { skipped.push({ key, reason: 'its nested instance is no longer part of this instance' }); continue; }
    const chainLids = memberPathSteps(parts.chain).filter((st): st is number => typeof st === 'number');
    const ctx: ChainCtx = { base: fb, slots: chainSlots(fb), frameDoc: fDoc, frameRoot: nested, n: fb.levels.length - 1, chain: chainLids };
    const original = canon.original.get(key) ?? key;
    const asked = targets?.perKey?.[original] ?? targets?.perKey?.[key] ?? targets?.default;
    // 'instance' is the prefab Apply was opened on, here as everywhere; 'frame' is the nested frame's own.
    const resolved = !asked || asked === 'instance' ? idx : resolveKeyLevel(fb, ctx.slots, fDoc, parts.inner, asked, sameSource);
    if (typeof resolved !== 'number') { skipped.push({ key, reason: resolved.skip }); continue; }
    if (resolved < idx) { skipped.push({ key, reason: 'that prefab is outside the instance this Apply was opened on — apply it from the instance that holds it' }); continue; }
    if (resolved < ctx.n) { await writeOuter(parts.inner, key, ctx, resolved); if (outerRefusal) break; continue; }
    // The nested frame's OWN template ("Apply to Prefab '<inner>'").
    const at = await docFor(fb.levels[ctx.n]!.source, ctx.n, nested);
    if (!at) break;
    if (!writeTemplate(parts.inner, key, ctx, at)) continue;
    // The source frame's own edit leaves it (#1469, U15): the refresh of that prefab takes it out of the frame's capture.
    for (const k of templateTook) at.took(nested, k);
    templateTook.length = 0;
    const took = at;
    const last = written[written.length - 1];
    if (last?.key === key) last.keep = (k) => took.kept(nested, k);
    at.mark();
    appliedTargets.push({ key, target: fb.levels[ctx.n]!.source });
  }
  if (outerRefusal) return { result: { ...NOOP_APPLY, refused: outerRefusal } };

  /** Write a frame-local `key` of nested frame `ctx` into its own template `at.doc` — a field (the whole component where
   *  the row lacks it), a tag, a removal — through the one template-value writer (#1659). */
  function writeTemplate(key: string, reportAs: string, ctx: ChainCtx, at: { doc: PrefabFile; pristine: PrefabFile }): boolean {
    const w = templateValueWriter(ctx.frameRoot);
    const parts = key.split('.');
    const tName = at.doc.name || ctx.base.levels[ctx.n]!.source;
    const here = (lid: number, trait: string, field: string) => slotOf(at.doc, '', [], lid, trait, field);
    if (key.startsWith('-removed.')) {
      skipped.push({ key: reportAs, reason: 'removing a member from the nested prefab itself is applied from the nested instance' });
      return false;
    }
    if (key.startsWith('+trait.') || key.startsWith('-trait.')) {
      const [, lidStr, t] = parts;
      const lid = Number(lidStr);
      const row = at.doc.entities.find((e) => e.localId === lid);
      if (!row) { skipped.push({ key: reportAs, reason: 'its member is no longer in that prefab' }); return false; }
      if (key.startsWith('+trait.')) row.traits[t!] = true;
      else delete row.traits[t!];
      written.push({ key: reportAs, ctx, level: ctx.n, lid, trait: t! });
      const member = memberNameIn(ctx.frameRoot, ctx.frameDoc, lid);
      const tag = key.startsWith('+trait.');
      setEffect(reportAs, ctx.base.levels[ctx.n]!.source, tName, false, tag ? { op: 'addTag', member, tag: t! } : { op: 'removeComponent', member, trait: t! });
      claim(here(lid, t!, '*'), tag ? true : REMOVED, reportAs, `${member} · ${t}`, tName);
      return true;
    }
    const [lidStr, t, f] = parts;
    const lid = Number(lidStr);
    const ecs = memberOf(ctx.frameRoot, lid);
    const meta = getTraitByName(t!);
    const row = at.doc.entities.find((e) => e.localId === lid);
    if (!ecs || !meta || !row || meta.category === 'tag' || !isPersistentTraitField(meta, f!) || isTemplateExcludedField(meta, f!)) return false;
    const live = clonePersistable(readTraitDataFull(ecs, meta));
    if (!live) return false;
    // Whether the component is ADDED is decided against the document as read (#1727): a second frame of the same
    // prefab found the first one's bag already written, took its own write for a one-field edit, and said so.
    const bag = at.pristine.entities.find((e) => e.localId === lid)?.traits[t!];
    const cur = row.traits[t!];
    if (bag === true || cur === true) return false;
    const fields = bag ? { [f!]: w.value(live[f!]) } : w.bag(meta, live);
    row.traits[t!] = { ...(cur || {}), ...fields };
    // Every field the template now holds leaves the frame — a whole component's blank asset refs included, as the seed's.
    for (const k of bag ? [f!] : Object.keys(live).filter((x) => !isTemplateExcludedField(meta, x))) templateTook.push(`${lid}.${t}.${k}`);
    written.push({ key: reportAs, ctx, level: ctx.n, lid, trait: t!, fields: Object.keys(fields) });
    const member = memberNameIn(ctx.frameRoot, ctx.frameDoc, lid);
    setEffect(reportAs, ctx.base.levels[ctx.n]!.source, tName, false, bag
      ? { op: 'setField', member, trait: t!, field: f!, to: live[f!] }
      : { op: 'addComponent', member, trait: t!, fields: shown(live, fields) });
    for (const k of Object.keys(fields)) claim(here(lid, t!, k), fields[k], reportAs, `${member} · ${t}.${k}`, tName);
    return true;
  }

  // U13 (owner, 2026-09-28): a value applied at one level REVERTS every enclosing override of it — they would shadow it,
  // and every instance of the outer prefabs shows the applied value. Supersedes #1492 ruling b.
  const alsoReverted = new Map<string, string[]>();
  const revertsOf = new Map<string, Map<string, { name: string; keys: string[]; what: string[] }>>();
  const notes = new Map<string, string>();
  for (const w of written) {
    for (const sl of w.ctx.slots) {
      if (sl.level >= w.level) continue;
      const mk = memberKeyAt(sl, w.ctx.frameDoc, w.lid);
      const cur = carrierOf(w.ctx.base, sl);
      if (!cur || !statedFields(cur, sl.path, mk, w.lid, w.trait)) continue;
      const at = await docFor(sl.source, sl.level, w.ctx.base.levels[sl.level]!.root);
      if (!at) break;
      const carrier = at.doc.entities.find((x) => x.localId === sl.rowLid && x.prefab);
      if (!carrier) continue;
      // Not what this same Apply wrote there itself — at THIS slot: this row, this path (#1728).
      const whole = slotOf(at.doc, sl.rowLid, sl.path, w.lid, w.trait, '*');
      const mine = (f: string) => wroteAt.has(slotOf(at.doc, sl.rowLid, sl.path, w.lid, w.trait, f)) || wroteAt.has(whole);
      const stated = Object.keys(statedFields(carrier, sl.path, mk, w.lid, w.trait) ?? {});
      const anyMine = stated.some(mine) || wroteAt.has(whole);
      const fields = w.fields ? w.fields.filter((f) => !mine(f)) : anyMine ? stated.filter((f) => !mine(f)) : undefined;
      if (fields && !fields.length) continue;
      if (dropStated(carrier, sl.path, mk, w.lid, w.trait, fields)) {
        at.mark();
        // Named as the frame's own listing names them (its member refs).
        const ref = memberRef(w.ctx.frameDoc, w.lid);
        const names = (fields ?? [undefined]).map((f) => listedKey(w.ctx, f ? `${ref}.${w.trait}.${f}` : `${ref}.${w.trait}`));
        const list = alsoReverted.get(sl.source) ?? [];
        list.push(...names);
        alsoReverted.set(sl.source, list);
        // …and per key: what THIS key's write reverts, for the row that shows it.
        const per = revertsOf.get(w.key) ?? new Map<string, { name: string; keys: string[]; what: string[] }>();
        const e = per.get(sl.source) ?? { name: at.doc.name || sl.source, keys: [], what: [] };
        e.keys.push(...names);
        const who = memberNameIn(w.ctx.frameRoot, w.ctx.frameDoc, w.lid);
        e.what.push(...(fields ?? [undefined]).map((f) => `its override of ${w.trait}${f ? `.${f}` : ''} on ${who}`));
        per.set(sl.source, e);
        revertsOf.set(w.key, per);
      }
    }
    // A template reference node above the chain states it too (#1731). It is not a place an Apply writes, so U13 cannot
    // drop its statement: the prefab IS written (every other instance takes the value), and THIS instance keeps the value
    // as its own edit — taken back out of the refresh's subtraction — rather than flipping to the node's. Said on the key.
    const node = w.ctx.base.node;
    if (node) {
      const ns = nodeSlot(w.ctx.base);
      const stated = statedFields(node, ns.path, memberKeyAt(ns, w.ctx.frameDoc, w.lid), w.lid, w.trait);
      const shadowed = stated ? (w.fields ? w.fields.filter((f) => f in stated) : Object.keys(stated)) : [];
      if (stated && (shadowed.length || !w.fields)) {
        for (const f of shadowed) w.keep?.(`${w.lid}.${w.trait}.${f}`);
        const what = shadowed.length ? shadowed.map((f) => `${w.trait}.${f} = ${formatEffectValue(stated[f])}`).join(', ') : w.trait;
        notes.set(w.key, `the template node holding this instance sets ${what} on it, and an Apply cannot write that node: every other instance takes the applied value, and this one keeps its own as an edit (still listed) — apply it from the instance that holds the node to change the node`);
      }
    }
  }
  if (outerRefusal) return { result: { ...NOOP_APPLY, refused: outerRefusal } };

  // The promoted rows' member refs, now that every promoted node has its path (#1659): a ref to another promoted node,
  // or to itself, names the row it became. A plain row's traits are values in the written frame; a reference row's
  // overrides in its own frame, and each nested path's in the frame that path reaches below it.
  for (const { row, at } of promotion.promoted) {
    if (!row.prefab) {
      for (const [name, bag] of Object.entries(row.traits)) if (bag !== true) row.traits[name] = writer.value(bag, at) as Record<string, unknown>;
      continue;
    }
    // The frames a value climbs out through, innermost first, ending at the written one: the node's own frame (the
    // row's expansion, once promoted), then the template's. A node the scene added is linked to no frame by a row yet,
    // so the loader's climber cannot be asked (review of P5–P6).
    if (row.overrides) row.overrides = writer.valueVia(row.overrides, at ? [at, rootInstanceId] : [rootInstanceId]) as typeof row.overrides;
    if (row.nestedOverrides && at) {
      const out: NestedOverridePaths = {};
      for (const [path, map] of Object.entries(row.nestedOverrides)) {
        const trail = [at];
        for (const step of memberPathSteps(path)) {
          const next = typeof step === 'number' ? ownedRootAt(trail[trail.length - 1]!, step) : 0;
          if (!next) break;
          trail.push(next);
        }
        out[path] = writer.valueVia(map, [...trail].reverse().concat(rootInstanceId)) as NestedOverridePaths[string];
      }
      row.nestedOverrides = out;
    }
  }

  // Every key's effect, in the caller's spelling (#1736): a key this Apply skipped says why; each conflict replaces the
  // effect of every key in it — the Apply is then refused whole, so none of them is written.
  const conflictsBySlot = findConflicts();
  const spell = (k: string) => canon.original.get(k) ?? k;
  for (const { key, reason } of skipped) if (!effectOf.has(key)) setEffect(key, '', '', false, { op: 'notApplied', reason });
  for (const [k, per] of revertsOf) {
    const e = effectOf.get(k);
    if (e) e.alsoReverts = [...per].map(([src, v]) => ({ source: src, name: v.name, keys: v.keys, what: v.what }));
  }
  for (const [k, note] of notes) { const e = effectOf.get(k); if (e) e.note = note; }
  const conflicts: ApplyConflict[] = [...conflictsBySlot.values()].map((c) => ({ ...c, keys: c.keys.map((x) => ({ key: spell(x.key), value: x.value })) }));
  /** A key as a reader tells it apart: its member, and for a nested instance's key the row that instance hangs from. */
  const whoOf = new Map<string, string>();
  for (const c of conflictsBySlot.values()) {
    for (const x of c.keys) {
      const e = effectOf.get(x.key)?.effect;
      const member = e && 'member' in e ? e.member : '';
      // The WHOLE row path: its last row alone named two instances nested one level further apart identically.
      const rows: string[] = [];
      const parts = splitNestedKey(x.key);
      let doc: PrefabFile | null | undefined = oldPrefab;
      for (const lid of parts ? memberPathSteps(parts.chain) : []) {
        const r: PrefabEntity | undefined = typeof lid === 'number' ? doc?.entities.find((en) => en.localId === lid) : undefined;
        rows.push(r?.name ?? '?');
        doc = r?.prefab ? getCachedPrefabSync(r.prefab) : null;
      }
      whoOf.set(x.key, rows.length ? `${member} under row '${rows.join(' › ')}'` : member || spell(x.key));
    }
  }
  // A key can be in SEVERAL conflicts (a field write against another value AND against a removal): its row names every
  // key it collides with, or resolving the one it showed only surfaced the next on the following preview.
  const conflictsOf = new Map<string, ApplyConflict[]>();
  for (const c of conflictsBySlot.values()) for (const x of c.keys) conflictsOf.set(x.key, [...(conflictsOf.get(x.key) ?? []), c]);
  for (const [k, cs] of conflictsOf) {
    const e = effectOf.get(k);
    if (!e) continue;
    const mine = cs[0]!.keys.find((x) => x.key === k)!;
    const withAll: { key: string; value: unknown; who: string }[] = [];
    for (const c of cs) {
      const me = c.keys.find((x) => x.key === k)!;
      // The keys that write ANOTHER value: an equal one beside this key is not what it collides with.
      for (const x of c.keys) {
        if (x.key === k || valuesEqual(x.value, me.value) || withAll.some((w) => w.key === spell(x.key))) continue;
        withAll.push({ key: spell(x.key), value: x.value, who: whoOf.get(x.key)! });
      }
    }
    e.effect = { op: 'conflict', slot: cs.map((c) => c.slot).join(', '), value: mine.value, with: withAll, wanted: e.effect };
  }
  // Once per key as the caller spelled it: an added component's row is several field keys here (#1663).
  const effects = [...new Map([...effectOf.values()].map((e) => [spell(e.key), { ...e, key: spell(e.key) }] as const)).values()];

  // Reported in the caller's own spelling, not the internal one it was turned into above.
  for (const x of skipped) x.key = spell(x.key);
  if (!dryRun) for (const { key, reason } of skipped) console.warn(`[Prefab] ${key} was not applied: ${reason}`);
  const outerWrites = [...pool.values()].filter((e) => e.dirty);
  if (writtenCount === 0 && !outerWrites.length) {
    if (!dryRun) console.log('[Prefab] No applicable overrides to apply.');
    return { result: { ...NOOP_APPLY, ...(skipped.length ? { skipped } : {}), ...(effects.length ? { effects } : {}) } };
  }

  const prefabId = newPrefab.id;
  const readNew: PrefabReader = (g) => (g === prefabId ? newPrefab : getCachedPrefabSync(g));
  // A move of the prefab's own whose member or new parent this apply removed names nothing now.
  if (newPrefab.moved && prefabId) {
    const paths = new Set(['', ...memberPathRecords({ prefab: prefabId }, readNew).self.keys()]);
    const live = Object.entries(newPrefab.moved).filter(([k, v]) => {
      const t = parseMemberToken(v);
      const has = (p: string) => (paths.has(p) ? true : undefined);
      return !!memberPathLookup(has, memberPathSteps(k)) && !!t && !t.up && !!memberPathLookup(has, t.path);
    });
    if (live.length !== Object.keys(newPrefab.moved).length) newPrefab.moved = live.length ? Object.fromEntries(live) : undefined;
    if (!newPrefab.moved) delete newPrefab.moved;
  }

  // The high-water mark (#1774): past every number this Apply handed out, and never below the document it lands over. An
  // enclosing document only loses an override here and mints nothing: its clone's mark, or the one the commit states
  // from its rows when the file had none (#1797).
  advanceLocalIdCounter(newPrefab, oldPrefab, nextLocalId.v);
  for (const x of appliedTargets) x.key = spell(x.key);
  const applied = [...new Map(appliedTargets.map((x) => [x.key, x] as const)).values()];
  return {
    // Innermost first, and the commit refreshes in this order, so each capture reads frames already rebuilt inside it.
    writes: innermostFirst([
      ...(writtenCount ? [{ level: n, w: { source, expected: oldPrefab, before: prefabBefore, doc: newPrefab, role: 'frame' as const } }] : []),
      ...outerWrites.map((e) => ({ level: Math.max(...e.levels), w: {
        source: e.source, expected: e.expected, before: e.before, doc: e.doc, role: 'outer' as const,
        ...(e.appliedFrom.size ? { appliedFrom: [...e.appliedFrom].map(([rootId, fields]) => ({ rootId, fields })) } : {}),
      } })),
    ], sameSource).map((x) => x.w),
    rebuild: { rootInstanceId, appliedFields, liveAddedRootsToDelete, promotedRows, promotedRefRows, keyedPromotions },
    skipped,
    applied,
    alsoReverted: [...alsoReverted].map(([src, keys]) => ({ source: src, keys })),
    effects,
    conflicts,
  };
}

/** The written documents in refresh order (#1715): a document ANOTHER written document contains — at any depth, read
 *  through the pending copies first — comes before it, since the outer one's refresh rebuilds the frames of the inner
 *  one inside it and a capture must read those already rebuilt. The deepest level a document was reached at breaks
 *  ties. Level alone is not enough: recorded at first use, P reached at depth 1 and at depth 2 tied with Q and Q went
 *  first; even the maximum orders O→P beside O→R→S→Q→P wrong (Q's 4 over P's 2, and Q contains P). */
export function innermostFirst<T extends { level: number; w: { source: string; doc: PrefabFile } }>(items: T[], same: (a: string, b: string) => boolean): T[] {
  const is = (ref: string, x: T) => same(ref, x.w.source) || (!!x.w.doc.id && ref === x.w.doc.id);
  const contains = (outer: T, inner: T): boolean => {
    const seen = new Set<string>();
    const walk = (doc: PrefabFile | null | undefined): boolean => {
      for (const ref of expandedPrefabRefs(doc?.entities ?? [])) {
        if (is(ref, inner)) return true;
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (walk(items.find((x) => is(ref, x))?.w.doc ?? getCachedPrefabSync(ref))) return true;
      }
      return false;
    };
    return walk(outer.w.doc);
  };
  const rest = [...items].sort((a, b) => b.level - a.level);
  const out: T[] = [];
  while (rest.length) {
    const i = rest.findIndex((x) => !rest.some((y) => y !== x && contains(x, y)));
    out.push(...rest.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/** Why an Apply leaves a legacy move out (#1868, hub ruling B): the member keeps the move as a scene statement, and
 *  Revert is the way out of it. */
const MOVED_MEMBER_NOT_APPLIED = 'a moved prefab object is not applied to its prefab (a prefab keeps its objects where it places them, as in Unity) — Revert the move to put it back';

const MOVED_MEMBER_UNDER_REMOVAL = 'a prefab object below it was moved (a file from before prefab objects stopped moving), and removing it would re-hang that object — Revert that move first (or, for a move the prefab file itself states, remove the row in prefab edit)';

/** The writing half of Apply: writes the plan's documents, sets the caches, and rebuilds every live instance. */
async function commitApplyPlan(plan: ApplyPlan): Promise<ApplyResult> {
  // The frame's own template, when a key was written to it; else the first enclosing prefab stands in for the
  // single-file fields of the result.
  const frameWrite = plan.writes.find((w) => w.role === 'frame');
  const { source, expected: oldPrefab, before: prefabBefore, doc: newPrefab } = frameWrite ?? plan.writes[0]!;
  const { rootInstanceId, appliedFields, liveAddedRootsToDelete, promotedRows, promotedRefRows, keyedPromotions } = plan.rebuild;
  const { skipped } = plan;

  const warnings = plan.writes.flatMap((w) => warnInertPrefabSizes(w.doc, w.source));

  // Who the promoted entities are, read while they still exist: the refresh re-expands each as a member with a
  // DERIVED guid, and `carryPromotedGuids` below gives it back the one every ref names (#1660).
  const promotedGuids = snapshotPromotedGuids(promotedRows, promotedRefRows);
  const rootGuid = guidForEntityId(rootInstanceId);
  // ONE step (#1692): the write only over the document this Apply read (I10), both caches, this refresh, then a rebase
  // of every other frame of the source still built from the old document — all in the world the Apply began in (I11).
  // Several files are ONE step (#1692's `commitPrefabWrites`): U13's second file, or an override on an enclosing prefab,
  // lands with the frame's own or not at all.
  const committed = await commitPrefabWrites(plan.writes.map((w) => ({ source: w.source, doc: w.doc, expected: w.expected })), {
    rebuild: async () => {
      // Delete the live plain entities for applied additions BEFORE any refresh, so the re-instantiated prefab member
      // replaces them instead of duplicating. Before the loop, not in the frame's turn: an added node written only into an
      // ENCLOSING prefab (#1715) has no frame turn, and that prefab's capture re-spawned it beside its template twin.
      // Non-applied additions stay live and are re-captured + re-spawned by the refresh.
      const survivors = deletePromotedNodes(liveAddedRootsToDelete);
      const follow = new Map<string, string>();
      // Every written file's instances, in the plan's order — innermost first — so each capture reads frames already
      // rebuilt inside it.
      for (const w of plan.writes) {
      if (w.role === 'outer') {
        const roots = collectInstanceRoots(w.source);
        for (const rootId of roots) await preloadNestedPrefabsForSubtree(rootId);
        refreshInstances(w.source, roots, w.expected, w.doc, new Map(), w.appliedFrom);
        continue;
      }
      // Every instance of this source, with NO exclusion — the clicked one goes through
      // capture/restore too. ⚠️ Matching the new base is NOT what takes an applied field out of its
      // override set (#1469): the field is still override-MARKED, the capture against the old document
      // keeps it, and the rebuild re-seeds the mark — so it was saved as an override nobody could see
      // (the listing diffs by value) and it pinned this instance against later template edits. The
      // refresh subtracts `appliedFields` from THIS instance's capture instead; other instances keep
      // their own overrides of the same field.
      const rootsToRefresh = collectInstanceRoots(source);
      // refreshInstances re-instantiates synchronously, so warm the LIVE tree of each instance (the commit already
      // warmed the new file's own reference rows). A user-added nested instance is not a row of newPrefab, so the file
      // walk never reaches it, and captureNestedInstanceOverrides would then drop its per-copy overrides with no
      // warning at all (#1284).
      for (const rootId of rootsToRefresh) await preloadNestedPrefabsForSubtree(rootId);
      refreshInstances(source, rootsToRefresh, oldPrefab, newPrefab, new Map(), { rootId: rootInstanceId, fields: appliedFields });
      for (const [from, to] of carryPromotedGuids(rootGuid, promotedGuids)) follow.set(from, to);
      rehangPromotionSurvivors(survivors, follow);
      // A promoted REFERENCE node's kept state went into its row (`insertAddedSubtree`'s bake); its identity stays in the
      // scene, on the stored root it is now a member of (#1802, owner ruling D) — the settle Create Prefab runs, which finds
      // each node by the guid `carryPromotedGuids` gave it back. Apply's undo reloads the scene from its snapshot.
      // By guid: the refresh rebuilt the instance, so `rootInstanceId` may name nothing now.
      const liveRoot = promotedRefRows.size && rootGuid ? localToEcsGuid(rootGuid) : 0;
      if (liveRoot) settleSwallowedKeptState(liveRoot);
      }
      // A node written on an ENCLOSING prefab's row (#1715) is a template-keyed node there: every instance derives its
      // guid, and no row can pin it, so its refs follow it to the derived one — after the last refresh, which rebuilt it.
      if (keyedPromotions.size) {
        for (const [levelRoot, keyed] of keyedPromotions) {
          for (const [from, to] of carryPromotedGuids(levelRoot, { plain: new Map(), refs: new Map(), keyed })) follow.set(from, to);
        }
        rehangPromotionSurvivors(survivors, follow);
      }
    },
  });
  if (!committed.ok) {
    // Several files (#1732): name the one that refused — not necessarily the first — and any the rollback could not put
    // back, which hold the Apply on disk while the editor still holds the document it read. "Nothing was applied" is
    // true only without those.
    const which = plan.writes.length > 1 && committed.failed ? `the prefab ${committed.failed}` : 'the prefab';
    const stranded = committed.stranded?.length
      ? ` ${committed.stranded.join(' and ')} ${committed.stranded.length === 1 ? 'was' : 'were'} written and could not be put back, so it holds the Apply on disk while the editor still shows it as it was: reopen the scene to pick that up before applying again.`
      : '';
    return committed.conflict
      ? { ...NOOP_APPLY, refused: `${which} changed on disk since the editor read it (a save elsewhere, an outside edit or a \`git pull\`), so it was left as it is.${stranded || ' Reopen the scene to pick up the change, then apply again.'}` }
      : { ...NOOP_APPLY, refused: `${which} file could not be written${committed.error ? ` (${committed.error})` : ''}, so ${stranded ? 'the Apply did not land.' + stranded : 'nothing was applied.'}` };
  }
  // The world the Apply began in was replaced while it wrote: the file holds the Apply, the new world was built from
  // it, and nothing here can be undone against that world. Said, not hidden (#1667).
  if (committed.worldLeft) {
    return { ...NOOP_APPLY, refused: 'the scene changed while the Apply wrote the prefab: the prefab was written, but the instances and the undo history of the scene it began in were not updated.' };
  }

  // Those promoted additions are now prefab members in the live world, but the scene file on disk still lists them as
  // `added` structural overrides. The Apply's undo entry dirties the scene, and Save writes it (#1868: Apply saves no
  // scene), so a later load does not re-spawn them on top of the now-expanded prefab member (the duplicate-flame bug).
  return {
    promotedAdditions: liveAddedRootsToDelete.length,
    applied: true,
    source,
    prefabBefore,
    // A copy of the bytes just written: the editor cache holds `newPrefab` itself, and an in-place change to it would
    // move the undo's expected hash off the disk (#1664).
    prefabAfter: JSON.parse(JSON.stringify(newPrefab)) as PrefabFile,
    // Every file, innermost first — an undo puts them all back (#1693: "Apply's undo restores the row as well").
    writes: plan.writes.map((w) => ({ source: w.source, before: w.before, after: JSON.parse(JSON.stringify(w.doc)) as PrefabFile })),
    targets: plan.applied,
    effects: plan.effects,
    ...(plan.alsoReverted.length ? { alsoReverted: plan.alsoReverted } : {}),
    warnings,
    ...(skipped.length ? { skipped } : {}),
  };
}
