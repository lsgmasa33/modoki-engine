/**
 * `parseInstanceRecord`: one owner's stored statements → an `InstanceRecord` (#2001 S1, #2006).
 *
 * Every form a released or past editor wrote converts here, once, into the one in-memory form
 * (format rule, docs/prefabs.md § High-level rules). Design: docs/plans/prefab-instance-model.md
 * § 5.2 (the conversion table) as amended by § 10.3–10.5 (binding).
 *
 * The owners: a scene ENTRY, a scene REFERENCE NODE (a nested instance the scene added), and a prefab
 * reference ROW / template reference node (TEMPLATE form). Pure: reads only the owner and the reader, and
 * never mutates either. Dead code at this commit: nothing calls it.
 *
 * ── How one owner's statements become records ──
 * An owner states its instance in up to two generations of channels:
 * - LEGACY, keyed by a document's localIds: `overrides`, `removed`, `removedTraits`, `added`, `moved`
 *   (this frame), and path-keyed `nestedOverrides` / `nestedStructure` (frames below);
 * - ROWS (`members`, scene v16+ / prefab v6+), keyed by minted identity.
 * Today's fold (prefabOverrides.ts `foldStructureLayers`) applies ONE owner's legacy channels first and its
 * rows over them, field by field. The parser keeps that order, so a row wins wherever both state the same
 * part of the same target, and the load warns (§ 10.3, review R5).
 *
 * Statements are additive at the owner's own top frame (a document's own rows remove and add nothing), so
 * they convert one for one. Two shapes state a WHOLE list instead, and replaced what the layers under the
 * owner (the "chain") gave that member or frame: a `nestedStructure` slot, and a v16 row's `added` /
 * `removedTraits`. These "pins" convert to records that make the chain's result equal the pin's (§ 5.2):
 * the chain is folded with the existing fold, template layers only (`chainWalk`).
 *
 * ── What cannot be named ──
 * Format rule (hub refinement, 2026-10-02, #2006): a legacy record is converted when its target can be
 * NAMED. When it cannot (an unparseable value; an instance or nested frame whose prefab is missing or
 * damaged; a localId that names no row of a present document) it is held VERBATIM in `held`, written
 * back, and converted on the first save after it becomes nameable. One exception, the same ruling's
 * (2): a legacy ADDED node anchored on a localId that names no row re-anchors at the instance root, as
 * today's load shows it (loadSceneFile.ts "re-anchored to root"), and is stored on `"/"` from then on.
 */
import type { AddedEntity, NestedStructureDelta, SceneEntityEntry, SceneMemberRow } from '../loaders/loadSceneFile';
import { emptyDocMap } from '../core/docKeys';
import { INSTANCE_MODEL_SCENE_VERSION } from '../core/version';
import { deriveMemberGuidAvoiding, memberPathSteps, nodeRowComponent, nodeRowKey, parseSteps } from '../core/assetRefRules';
import { restoreMalformed, splitMalformedChannels } from '../loaders/malformedChannels';
import { memberPathRecords } from '../loaders/memberPaths';
import { placedAnchor } from '../loaders/memberTranslation';
import { isMemberToken, memberToken, parseMemberToken } from '../core/templateRefs';
import { foldStructureLayers, frameKeyIndex, overRowsOf } from '../loaders/prefabOverrides';
import {
  DERIVED_NODE_GUID, HELD_REMAINDER, RAW_TEMPLATE_NODE, ROOT_ROW_KEY,
  type AddedNodeRef, type HeldData, type TemplateHeldData, type InstanceRecord, type LegacyChannels, type ParsedInstance, type ParseWarning,
  type Placement, type PrefabDoc, type PrefabDocRow, type PrefabReader, type RecordTraits, type RowKey,
  type SceneOwnedNode, type TargetRecordOf, type TemplateAddedNode, type TemplateOverrideList, type TemplateTargetRecord,
} from './instanceRecord';
import {
  frameOf, componentOf, keyOfLid, childFrame, frameAtPath, chainStep, chainAt, rowTarget, rowOfComponent, badRows, canonicalRowKey,
  type Frame, type Lists, type Layer, type Chain,
} from '../loaders/frameChain';
export { preV5NodeGuid, frameOf, componentOf, type Frame } from '../loaders/frameChain';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ── The record builder ──────────────────────────────────────────────────────────────────────────────

type Source = 'legacy' | 'row';
type AnyRecord = TargetRecordOf<unknown>;

/** Accumulates one owner's records. Legacy statements first, then rows; a row stating a part legacy already
 *  stated wins and warns (§ 10.3). */
class ListBuilder<Own> {
  readonly rows = new Map<RowKey, TargetRecordOf<Own>>();
  private readonly legacyParts = new Set<string>();
  private readonly warnings: ParseWarning[];
  constructor(warnings: ParseWarning[]) { this.warnings = warnings; }

  /** The row states its parent in a form held verbatim: it still replaces a legacy channel's parent (the row wins). */
  heldParent(key: RowKey): void {
    this.note(key, 'parent', 'row');
    const r = this.rows.get(key);
    if (r) delete r.parent;
  }

  rec(key: RowKey): TargetRecordOf<Own> {
    let r = this.rows.get(key);
    if (!r) this.rows.set(key, (r = {}));
    return r;
  }

  private note(key: RowKey, part: string, from: Source): void {
    const id = `${key}\u0000${part}`;
    if (from === 'legacy') { this.legacyParts.add(id); return; }
    if (!this.legacyParts.delete(id)) return;
    this.warnings.push({ code: 'rowWins', key, message: `${key}: a legacy channel and a member row both state ${part}; the row wins` });
  }

  field(key: RowKey, trait: string, field: string, value: unknown, from: Source): void {
    this.note(key, `traits.${trait}.${field}`, from);
    const r = this.rec(key);
    const traits = (r.traits ??= emptyDocMap() as RecordTraits);
    const bag = traits[trait];
    (traits[trait] = isRecord(bag) ? bag : emptyDocMap())[field] = value;
  }

  /** A trait's data as stated (field by field), or a tag / stated-empty component (`true` / `null` / `{}`). */
  traitData(key: RowKey, trait: string, data: unknown, from: Source): void {
    if (isRecord(data) && Object.keys(data).length) {
      for (const [f, v] of Object.entries(data)) this.field(key, trait, f, v, from);
      return;
    }
    // A component stated with no field (a tag, or a stated-empty bag): it is still a statement that the
    // component is there, which is what an added tag component is (§ 2.5).
    this.note(key, `traits.${trait}`, from);
    const traits = (this.rec(key).traits ??= emptyDocMap() as RecordTraits);
    if (traits[trait] === undefined) traits[trait] = isRecord(data) ? emptyDocMap() : true;
  }

  traitRemoval(key: RowKey, trait: string, on: boolean, from: Source, beside = false): void {
    if (beside && on) this.besideRemovals.add(`${key}\u0000${trait}`);
    this.note(key, `traitRemovals.${trait}`, from);
    (this.rec(key).traitRemovals ??= emptyDocMap() as Record<string, boolean>)[trait] = on;
  }

  /** Legacy parts stated from the frame ABOVE a nested root, at the reference row's localId (`besideLegacy`, #2019). */
  private readonly besideOwn = new Set<Own>();
  /** Nodes a member ROW's whole list states (`pinAdded` records them as `legacy` own): a later row at the same key —
   *  an alias — never replaces them, so the result does not depend on row order (close-out review). */
  private readonly rowStated = new Set<Own>();
  stating = false;
  private readonly besideRemovals = new Set<string>();
  /** Is `trait`'s removal at `key` a legacy part kept beside a row's whole list (#2019)? */
  keptBeside(key: RowKey, trait: string): boolean { return this.besideRemovals.has(`${key}\u0000${trait}`); }

  /** Drop every legacy trait-removal record of `key` (a row's whole list replaces them), but those kept `beside`. */
  dropLegacyRemovals(key: RowKey, beside = false): void {
    const r = this.rows.get(key);
    for (const t of Object.keys(r?.traitRemovals ?? {})) {
      if (beside && this.besideRemovals.has(`${key}\u0000${t}`)) continue;
      if (this.legacyParts.delete(`${key}\u0000traitRemovals.${t}`)) {
        delete r!.traitRemovals![t];
        this.warnings.push({ code: 'rowWins', key, message: `${key}: a member row's removedTraits list replaces the legacy removedTraits` });
      }
    }
    if (r?.traitRemovals && !Object.keys(r.traitRemovals).length) delete r.traitRemovals;
  }

  removed(key: RowKey, on: boolean, from: Source): void {
    this.note(key, 'removed', from);
    this.rec(key).removed = on;
  }

  parent(key: RowKey, value: string, from: Source): void {
    this.note(key, 'parent', from);
    this.rec(key).parent = value;
  }

  own(key: RowKey, nodes: Own[], from: Source, beside = false): void {
    if (!nodes.length) return;
    if (beside) for (const n of nodes) this.besideOwn.add(n);
    if (this.stating || from === 'row') for (const n of nodes) this.rowStated.add(n);
    if (from === 'legacy') this.legacyParts.add(`${key}\u0000own`);
    const r = this.rec(key);
    (r.own ??= []).push(...nodes);
  }

  /** A row's whole `added` list replaces the legacy nodes anchored at `key` (today's fold: `row.added` replaces the
   *  lower layer's nodes at that member). Returns the dropped nodes. */
  replaceLegacyOwn(key: RowKey, beside = false): Own[] {
    // Once per key: a second row at the same key (an alias) replaces nothing again (close-out review).
    if (!this.legacyParts.delete(`${key}\u0000own`)) return [];
    const r = this.rows.get(key)!;
    const kept = (r.own ?? []).filter((n) => this.rowStated.has(n) || (beside && this.besideOwn.has(n)));
    const dropped = (r.own ?? []).filter((n) => !kept.includes(n));
    if (kept.length) r.own = kept; else delete r.own;
    if (!dropped.length) return [];
    this.warnings.push({ code: 'rowWins', key, message: `${key}: a member row's whole added list replaces ${dropped.length} legacy added node(s)` });
    return dropped;
  }

  pin(key: RowKey, field: 'guid' | 'name', value: string): void {
    (this.rec(key) as AnyRecord)[field] = value;
  }

  /** Replay `other`'s records into this builder as statements of `from`. `under`: as a LOWER layer than this builder's
   *  ROW-sourced parts, which keep their value — a reference copy under the owner's own rows into its frame, which today
   *  applies after the copy, its OVER rows (close-out review F2). Its legacy parts do not win: a slot's copy of the same
   *  node is replaced by the row's copy, as today's fold replaces it (re-review N1). */
  absorb(other: ListBuilder<Own>, from: Source, under = false): void {
    for (const [key, r] of other.rows) {
      const mine = this.rows.get(key);
      const byRow = (part: string, present: boolean): boolean => under && present && !this.legacyParts.has(`${key}\u0000${part}`);
      // Identity pins are not layered: the copy's pin overwrites, as before #2027. Nothing observes which one wins (the
      // oracle ignores guids), so no layering is claimed for them.
      if (r.guid !== undefined) this.pin(key, 'guid', r.guid);
      if (r.name !== undefined) this.pin(key, 'name', r.name);
      for (const [t, data] of Object.entries(r.traits ?? {})) {
        const bag = mine?.traits?.[t];
        if (isRecord(data) && Object.keys(data).length) {
          for (const [f, v] of Object.entries(data)) if (!byRow(`traits.${t}.${f}`, isRecord(bag) && f in bag)) this.field(key, t, f, v, from);
        } else if (!byRow(`traits.${t}`, bag !== undefined)) this.traitData(key, t, data, from);
      }
      for (const [t, on] of Object.entries(r.traitRemovals ?? {})) if (!byRow(`traitRemovals.${t}`, mine?.traitRemovals?.[t] !== undefined)) this.traitRemoval(key, t, on, from);
      if (r.removed !== undefined && !byRow('removed', mine?.removed !== undefined)) this.removed(key, r.removed, from);
      if (r.own) this.own(key, r.own, from);
      if (r.parent !== undefined && !byRow('parent', mine?.parent !== undefined)) this.parent(key, r.parent, from);
    }
  }
}

/** Sparse verbatim store for what cannot be named (format rule, hub refinement, 2026-10-02, #2006). */
class Pending {
  readonly channels: Record<string, unknown> = {};
  put(path: (string | number)[], value: unknown): void {
    let at = this.channels;
    for (const step of path.slice(0, -1).map(String)) at = (at[step] ??= emptyDocMap()) as Record<string, unknown>;
    at[String(path[path.length - 1])] = structuredClone(value);
  }
  push(path: (string | number)[], value: unknown): void {
    let at = this.channels;
    const steps = path.map(String);
    for (const step of steps.slice(0, -1)) at = (at[step] ??= emptyDocMap()) as Record<string, unknown>;
    const last = steps[steps.length - 1]!;
    ((at[last] ??= []) as unknown[]).push(structuredClone(value));
  }
  /** Mark the held container at `container` as a whole list's REMAINDER (`HELD_REMAINDER`). */
  mark(container: (string | number)[]): void {
    let at = this.channels;
    for (const step of container.map(String)) at = (at[step] ??= emptyDocMap()) as Record<string, unknown>;
    at[HELD_REMAINDER] = true;
  }
  get empty(): boolean { return !Object.keys(this.channels).length; }
}

// ── Converting one owner ────────────────────────────────────────────────────────────────────────────

/** How a form spells an added node. */
interface Form<Own> {
  template: boolean;
  /** `node`, added under the target `anchorKey` names. */
  ownNode(node: AddedEntity, anchorKey: RowKey): Own;
}

interface Ctx<Own> {
  read: PrefabReader;
  out: ListBuilder<Own>;
  pending: Pending;
  warnings: ParseWarning[];
  form: Form<Own>;
  /** Scene form: each linked scene-owned node's content, by guid. */
  ownContent: Map<string, SceneOwnedNode>;
  /** The instance's top frame: every row key is absolute from its root. */
  top: Frame;
  /** A scene owner's own rows (an entry's or a reference node's, not a reference copy's): where a stray form is held as
   *  today ignores it (#2020) and a pre-v20 legacy part sits beside a row (#2019). */
  ownerRows?: boolean;
  /** A scene ENTRY's own rows: where a member-token `parent` names nothing (#2022 items 5-6). A reference node's row
   *  tokens are moves — the v20 writer spells its converted `templateMoved` that way (close-out review). */
  entryRows?: boolean;
  /** A scene file written before the instance model (v20): where a stray row form is read as today reads it (#2020). */
  preV20?: boolean;
  /** Converting a scene reference COPY (`referenceCopy`): its structure is ONE statement (#2027). */
  copy?: CopySession;
}

/** A scene reference copy's structure, stated whole: the nodes of its own frame pair as ONE list, as today's fold pairs
 *  them (`pairWithBase`). */
interface CopySession {
  /** The copy's own frame. */
  frame: string;
  /** Its nodes as today's fold of the copy lists them (the top-level `added` a member row's `added` replaces, then each
   *  row's `added` and `own`), each the copy's own statement, with the localId it anchors at. */
  list: AddedEntity[];
  anchor: Map<AddedEntity, number>;
  /** The member rows whose `added` / `own` that list already holds. */
  rows: Set<string>;
  /** Every template key the copy states a node with, in any of its lists: such a node in `d` is the copy's, not one a
   *  document supplies (re-review N3). */
  keys: Set<string>;
}

/** The channels an owner states: legacy ones about its own top frame and the frames below it, and its rows. */
export interface OwnerChannels {
  overrides?: SceneEntityEntry['overrides'];
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  moved?: Record<number, string>;
  nestedOverrides?: SceneEntityEntry['nestedOverrides'];
  nestedStructure?: SceneEntityEntry['nestedStructure'];
  members?: Record<string, SceneMemberRow>;
}

type Path = (string | number)[];

interface OwnerOpts {
  /** The owner's own frame lists state the WHOLE frame and replaced the chain's: a scene-form copy of a template
   *  reference node, whose structure "is the copy's own" (`baseLayersOf`). They convert as a slot does. */
  whole?: boolean;
  /** Rows carry identity pins (scene form). */
  pins: boolean;
  /** Fields the caller converts itself (the scene root's default overrides). */
  skip?: (key: RowKey, trait: string, field: string) => boolean;
  /** Where in the owner a held value sits (its channel path). */
  at: (...p: Path) => Path;
}

/** One owner's statements about frame `f` (its own) and below, converted into `ctx.out`. Legacy first, rows over them:
 *  the order today's fold applies one layer in (`foldStructureLayers`: `layer.values`, then `foldMemberRowChannels`). */
function convertOwner<Own>(ctx: Ctx<Own>, f: Frame, o: OwnerChannels, opts: OwnerOpts): void {
  // Deeper frames' values first: today's spawner applies the owner's `overrides` after the nested expansions it spawns,
  // so on a nested ROOT (`overrides[lidR]` and `nestedOverrides["R"][innerRoot]`, one target) the frame-level value wins.
  for (const [path, values] of Object.entries(o.nestedOverrides ?? {})) {
    const at = frameAtPath(f, path, ctx.read);
    if (!('frame' in at)) { ctx.pending.put(opts.at('nestedOverrides', path), values); continue; }
    legacyValues(ctx, at.frame, values as Record<string, unknown>, (lid) => opts.at('nestedOverrides', path, lid));
  }
  legacyValues(ctx, f, o.overrides as Record<string, unknown> | undefined, (lid) => opts.at('overrides', lid), opts.skip);
  if (opts.whole && !isRemainder(o)) {
    slotLists(ctx, f, o, (...p) => opts.at(...p));
  } else if (opts.whole) {
    remainderLists(ctx, f, o, (...p) => opts.at(...p));
  } else {
    legacyRemoved(ctx, f, o.removed, opts.at('removed'));
    legacyRemovedTraits(ctx, f, o.removedTraits, (lid) => opts.at('removedTraits', lid));
    legacyAdded(ctx, f, o.added);
  }
  legacyMoved(ctx, f, o.moved, (lid) => opts.at('moved', lid));
  for (const [path, s] of Object.entries(o.nestedStructure ?? {})) {
    const at = frameAtPath(f, path, ctx.read);
    if (!('frame' in at) || !isRecord(s)) { ctx.pending.put(opts.at('nestedStructure', path), s); continue; }
    const slotAt = (...p: Path) => opts.at('nestedStructure', path, ...p);
    if (isRemainder(s)) remainderLists(ctx, at.frame, s, slotAt);
    else slotLists(ctx, at.frame, s, slotAt);
    // A slot is whole: a held move alone would read back as a slot that states nothing else (#2007 review, item 1).
    legacyMoved(ctx, at.frame, (s as NestedStructureDelta).moved, (lid) => slotAt('moved', lid), slotAt());
  }
  convertRows(ctx, f.prefix, o.members, opts.pins);
}

/** Legacy field values on frame `f`'s members (`overrides`, or one path of `nestedOverrides`). */
function legacyValues<Own>(
  ctx: Ctx<Own>, f: Frame, values: Record<string, unknown> | undefined, pendingAt: (lid: string) => Path,
  skip?: (key: RowKey, trait: string, field: string) => boolean,
): void {
  for (const [lid, bag] of Object.entries(values ?? {})) {
    const key = /^\d+$/.test(lid) ? keyOfLid(f, Number(lid)) : null;
    if (key === null) { ctx.pending.put(pendingAt(lid), bag); continue; }
    for (const [trait, data] of Object.entries((bag ?? {}) as Record<string, unknown>)) {
      if (isRecord(data) && Object.keys(data).length) {
        for (const [field, v] of Object.entries(data)) if (!skip?.(key, trait, field)) ctx.out.field(key, trait, field, v, 'legacy');
      } else ctx.out.traitData(key, trait, data, 'legacy');
    }
  }
}

/** Is a legacy part of frame `f` anchored at `lid` stated from the frame ABOVE a nested root — at the reference row's
 *  localId, not at a frame's own root? Today keeps those beside a row's whole list before v20 (#2019). */
const besideAt = (f: Frame, lid: unknown): boolean => typeof lid === 'number' && lid !== f.rootLid && !!f.byLid.get(lid)?.prefab;

/** Legacy `added` nodes of frame `f` (additive: a document's own frame adds nothing of itself), each anchored at its
 *  `parentLocalId`. */
function legacyAdded<Own>(ctx: Ctx<Own>, f: Frame, nodes: readonly AddedEntity[] | undefined): void {
  for (const node of nodes ?? []) {
    // A localId that names no row: re-anchored at the instance ROOT and stored there from now on, as today's load shows
    // it (format rule, hub refinement 2026-10-02, #2006 (2); loadSceneFile.ts "re-anchored to root").
    const key = keyOfLid(f, node.parentLocalId) ?? (f.prefix || ROOT_ROW_KEY);
    ctx.out.own(key, [ctx.form.ownNode(node, key)], 'legacy', besideAt(f, node.parentLocalId));
  }
}

/** Legacy `removed` of frame `f` (additive). */
function legacyRemoved<Own>(ctx: Ctx<Own>, f: Frame, removed: readonly number[] | undefined, pendingAt: Path): void {
  for (const lid of removed ?? []) {
    const key = keyOfLid(f, lid);
    if (key === null) ctx.pending.push(pendingAt, lid);
    else ctx.out.removed(key, true, 'legacy');
  }
}

/** Legacy `removedTraits` of frame `f` (additive): each named trait removed. */
function legacyRemovedTraits<Own>(ctx: Ctx<Own>, f: Frame, lists: Record<number, string[]> | undefined, pendingAt: (lid: string) => Path): void {
  for (const [lid, names] of Object.entries(lists ?? {})) {
    const key = /^\d+$/.test(lid) ? keyOfLid(f, Number(lid)) : null;
    if (key === null) { ctx.pending.put(pendingAt(lid), names); continue; }
    for (const t of names ?? []) ctx.out.traitRemoval(key, t, true, 'legacy', besideAt(f, Number(lid)));
  }
}

/** Legacy `moved` of frame `f` (member localId → its new parent: a guid in scene form, #1437): a legacy `parent` record
 *  (U7: kept, revertable, never written by a gesture). */
function legacyMoved<Own>(ctx: Ctx<Own>, f: Frame, moved: Record<number, string> | undefined, pendingAt: (lid: string) => Path, remainderOf?: Path): void {
  for (const [lid, parent] of Object.entries(moved ?? {})) {
    const key = /^\d+$/.test(lid) ? keyOfLid(f, Number(lid)) : null;
    if (key === null || typeof parent !== 'string') { ctx.pending.put(pendingAt(lid), parent); if (remainderOf) ctx.pending.mark(remainderOf); continue; }
    ctx.out.parent(key, parent, 'legacy');
  }
}

/** A frame's three lists stated WHOLE (a `nestedStructure` slot, or a scene-form reference-node copy): they replaced
 *  the chain's, so each converts as a PIN against the chain at that frame (§ 5.2). */
function slotLists<Own>(ctx: Ctx<Own>, f: Frame, s: Pick<NestedStructureDelta, 'added' | 'removed' | 'removedTraits'>, at: (...p: Path) => Path): void {
  const chain = chainAt(ctx.top, f.prefix, ctx.read);
  if (!('frame' in chain)) {
    for (const k of ['added', 'removed', 'removedTraits'] as const) if (s[k] !== undefined) ctx.pending.put(at(k), s[k]);
    return;
  }
  // removed: each it names is removed; each the chain removed that it does not name is restored.
  const named = new Set<number>();
  for (const lid of s.removed ?? []) {
    const key = keyOfLid(f, lid);
    if (key === null) { ctx.pending.push(at('removed'), lid); ctx.pending.mark(at()); continue; }
    named.add(lid);
    ctx.out.removed(key, true, 'legacy');
  }
  for (const lid of chain.lists.removed ?? []) {
    if (named.has(lid)) continue;
    const key = keyOfLid(f, lid);
    if (key !== null) ctx.out.removed(key, false, 'legacy');
  }
  // removedTraits: true for each named trait; false for each trait the chain removed that the list does not name.
  const stated = (s.removedTraits ?? {}) as Record<string, string[]>;
  for (const [lid, names] of Object.entries(stated)) {
    const key = /^\d+$/.test(lid) ? keyOfLid(f, Number(lid)) : null;
    if (key === null || !Array.isArray(names)) { ctx.pending.put(at('removedTraits', lid), names); ctx.pending.mark(at()); continue; }
    for (const t of names) if (typeof t === 'string') ctx.out.traitRemoval(key, t, true, 'legacy', besideAt(f, Number(lid)));
  }
  for (const [lid, names] of Object.entries(chain.lists.removedTraits ?? {})) {
    const key = keyOfLid(f, Number(lid));
    if (key === null) continue;
    const mine = new Set(stated[lid] ?? []);
    for (const t of names) if (!mine.has(t)) ctx.out.traitRemoval(key, t, false, 'legacy');
  }
  // A reference copy's own frame: its rows' nodes are part of the one list (#2027).
  if (ctx.copy && f.prefix === ctx.copy.frame) pinAdded(ctx, chain, ctx.copy.list, undefined, at('added'), false, ctx.copy.anchor);
  else pinAdded(ctx, chain, s.added ?? [], undefined, at('added'));
}

/** Does this held container stand for a whole list's REMAINDER (`HELD_REMAINDER`)? */
const isRemainder = (o: unknown): boolean => isRecord(o) && o[HELD_REMAINDER] === true;

/** A whole-list container's held REMAINDER, read back (hub ruling 2026-10-02, #2006, option C): ADDITIVELY. Each
 *  element is its own record — a removal, a component removal, a node copy paired with its chain node — or is held
 *  again, marker kept. It says nothing about the chain's other entries: they were converted the first time. */
function remainderLists<Own>(ctx: Ctx<Own>, f: Frame, s: Pick<NestedStructureDelta, 'added' | 'removed' | 'removedTraits'>, at: (...p: Path) => Path): void {
  const chain = chainAt(ctx.top, f.prefix, ctx.read);
  if (!('frame' in chain)) {
    for (const k of ['added', 'removed', 'removedTraits'] as const) if (s[k] !== undefined) ctx.pending.put(at(k), s[k]);
    ctx.pending.mark(at());
    return;
  }
  for (const lid of Array.isArray(s.removed) ? s.removed : []) {
    const key = typeof lid === 'number' ? keyOfLid(f, lid) : null;
    if (key === null) { ctx.pending.push(at('removed'), lid); ctx.pending.mark(at()); } else ctx.out.removed(key, true, 'legacy');
  }
  for (const [lid, names] of Object.entries(isRecord(s.removedTraits) ? s.removedTraits : {})) {
    const key = /^\d+$/.test(lid) ? keyOfLid(f, Number(lid)) : null;
    if (key === null || !Array.isArray(names)) { ctx.pending.put(at('removedTraits', lid), names); ctx.pending.mark(at()); continue; }
    for (const t of names) if (typeof t === 'string') ctx.out.traitRemoval(key, t, true, 'legacy', besideAt(f, Number(lid)));
  }
  pinAdded(ctx, chain, Array.isArray(s.added) ? s.added : [], undefined, at('added'), true);
}

/** PIN conversion of a whole added list (§ 5.2): `list` replaced the chain's nodes of the chain's frame anchored at
 *  `anchorLid` (every anchor when undefined: a slot). A node pairs with the chain node it replaced as today's fold pairs
 *  them (`pairWithBase`: same key, among the replaced nodes, same prefab-ness); a paired node becomes that node's ROW,
 *  every field it states recorded; each replaced chain node nothing pairs with is removed; every other node is an own
 *  node. A node in `anchors` (a reference copy's row node, #2027) hangs at that localId when it pairs with nothing. */
function pinAdded<Own>(ctx: Ctx<Own>, chain: Chain, list: readonly AddedEntity[], anchorLid: number | undefined, at: Path, additive = false, anchors?: ReadonlyMap<AddedEntity, number>): void {
  const f = chain.frame;
  const lower = chain.lists.added ?? [];
  const replaced = lower.filter((n) => anchorLid === undefined || n.parentLocalId === anchorLid);
  const index = frameKeyIndex(lower as (AddedEntity & { key?: string })[]);
  const paired = new Set<AddedEntity>();
  const keyOfNode = (n: AddedEntity): string => (typeof (n as { key?: string }).key === 'string' ? (n as { key: string }).key : '');
  // A replaced keyless node is removed by the name the fold shows it under (`keylessNodeKey`), when it has one.
  const removeNode = (n: AddedEntity): void => { const k = keyOfNode(n) || keylessNodeKey(n); if (k) ctx.out.removed(`${f.prefix}/${nodeRowComponent(k)}`, true, 'legacy'); };

  const visit = (node: AddedEntity, anchorKey: RowKey, candidates: readonly AddedEntity[]): void => {
    const k = keyOfNode(node);
    const hit = k ? index.get(k) : undefined;
    if (!hit || !candidates.includes(hit) || (hit.prefab ?? '') !== (node.prefab ?? '')) {
      ctx.out.own(anchorKey, [ctx.form.ownNode(node, anchorKey)], 'legacy', candidates === replaced && besideAt(f, anchorLid ?? node.parentLocalId));
      return;
    }
    paired.add(hit);
    const rowKey = `${f.prefix}/${nodeRowComponent(k)}`;
    if (!ctx.form.template && typeof node.guid === 'string' && node.guid) ctx.out.pin(rowKey, 'guid', node.guid);
    if (hit.prefab) { referenceCopy(ctx, chain, k, node, at); return; }
    for (const [trait, data] of Object.entries(node.traits ?? {})) ctx.out.traitData(rowKey, trait, data, 'legacy');
    // A plain copy spawns from its own statement (no base node, `pairWithBase`): a component it does not state is gone.
    for (const t of Object.keys(hit.traits ?? {})) if (!(t in (node.traits ?? {}))) ctx.out.traitRemoval(rowKey, t, true, 'legacy');
    const kids = hit.children ?? [];
    for (const child of node.children ?? []) visit(child, rowKey, kids);
    for (const c of kids) if (!paired.has(c)) removeNode(c);
  };
  for (const node of list) visit(node, keyOfLid(f, anchors?.get(node) ?? anchorLid ?? node.parentLocalId) ?? (f.prefix || ROOT_ROW_KEY), replaced);
  // A held REMAINDER is not the whole list: the chain nodes it does not name were converted already (`HELD_REMAINDER`).
  if (!additive) for (const n of replaced) if (!paired.has(n)) removeNode(n);
}

/** A whole-list copy of a template REFERENCE node `a+key` in `chain`'s frame. Scene form: its values layer over the
 *  chain node's (`BASE_NODE`), its structure is whole, so it converts as an owner of that node's frame with `whole`
 *  lists. All or nothing: if any part of it cannot be named, the copy is held verbatim where it was stated. */
function referenceCopy<Own>(ctx: Ctx<Own>, chain: Chain, key: string, node: AddedEntity, at: Path): void {
  if (ctx.form.template) { templateReferenceCopy(ctx, chain, key, node, at); return; }
  const sub = chainStep(chain, nodeRowComponent(key), ctx.read);
  // Held whole, as a remainder of the list it was stated in (`HELD_REMAINDER`).
  const hold = (): void => { ctx.pending.push(at, node); ctx.pending.mark(at.slice(0, -1)); };
  if (!('frame' in sub)) { hold(); return; }
  // Its `templateMoved` tokens are written from the COPY's frame, and a scene record's token is read from the instance's
  // top frame: no record can carry them, so the copy is held whole rather than lose them (#2007 review, item 8).
  if (isRecord(node.templateMoved) && Object.keys(node.templateMoved).length) { hold(); return; }
  // A copy with a channel in no shape a reader takes is held whole, verbatim, rather than read lossily (I18; close-out
  // review round 2: a value read as a tag, a malformed row skipped).
  if (splitMalformedChannels(node).malformed.length || badRows(node.members)) { hold(); return; }
  // Its member rows' token parents are written from the copy's frame, like its `templateMoved`: no record carries them.
  // Before v20 today applies the copy's other statements and ignores the tokens, so the copy CONVERTS with them taken
  // out, and only they are held — as a REMAINDER of the list, read back additively (hub ruling Q1 2026-10-02, option C).
  // From v20 no writer states a copy at all: held whole, as any copy no record can carry.
  const tokens = isRecord(node.members) ? Object.entries(node.members).filter(([, r]) => isRecord(r) && typeof r.parent === 'string' && isMemberToken(r.parent)) : [];
  if (tokens.length && !ctx.preV20) { hold(); return; }
  const converted: AddedEntity = tokens.length
    ? { ...node, members: Object.fromEntries(Object.entries(node.members!).map(([k, r]) => (tokens.some(([t]) => t === k) ? [k, (({ parent: _p, ...rest }) => rest)(r as Record<string, unknown>)] : [k, r]))) as never }
    : node;
  // Its warnings stand only if it converts: held whole, nothing it says about its content happened (close-out review).
  const warnings: ParseWarning[] = [];
  // Its structure is ONE statement, over the chain minus the chain node's own structure (#2027): today folds the copy's
  // lists alone over the document, the chain node giving values only (`baseLayersOf`). D is that fold.
  const dLayers: Layer[] = [{ slots: converted.nestedStructure, rows: converted.members, values: converted.overrides, valuePaths: converted.nestedOverrides }];
  const dFold = foldStructureLayers(sub.frame.doc as never, dLayers, 0, { added: converted.added, removed: converted.removed, removedTraits: converted.removedTraits });
  const d: Chain = { frame: sub.frame, lists: dFold.channels as Lists, state: { layers: dLayers, forwardRoots: dFold.forwardRoots as Chain['state']['forwardRoots'] } };
  const scratch: Ctx<Own> = { ...ctx, warnings, out: new ListBuilder<Own>(warnings), pending: new Pending(), ownContent: new Map(), ownerRows: false, entryRows: false, copy: copySession(sub.frame, converted) };
  convertOwner(scratch, sub.frame, converted, { whole: true, pins: true, at: (...p) => p });
  const base = frameKeyIndex(chain.lists.added as (AddedEntity & { key?: string })[] | undefined).get(key);
  if (!restoreChainStructure(scratch, sub, d, [sub.frame.docGuid], reachOf(base)) || !scratch.pending.empty) { hold(); return; }
  ctx.warnings.push(...warnings);
  // UNDER what the owner already stated into the copy's frame: today applies the owner's rows there after the copy (its
  // OVER rows), whatever the key order its rows are read in (close-out review F2).
  ctx.out.absorb(scratch.out, 'legacy', true);
  if (tokens.length) {
    // A well-formed copy of the same node stating only the tokens, so any reader takes it as a copy and holds it again.
    const { parentLocalId, guid, key: k, prefab, name } = node;
    ctx.pending.push(at, { parentLocalId, guid, key: k, prefab, name, traits: {}, children: [], members: Object.fromEntries(tokens.map(([k, r]) => [k, { parent: (r as { parent: string }).parent }])) });
    ctx.pending.mark(at.slice(0, -1));
    ctx.warnings.push({ code: 'pendingLegacy', key, message: `a copy of template node ${key} states member parents as tokens no reader resolves; the copy converts and they are kept` });
  }
  for (const [g, n] of scratch.ownContent) if (!ctx.ownContent.has(g)) ctx.ownContent.set(g, n);
}

/** The copy's own-frame nodes as ONE list (#2027, seeds 551/566/418(a)), as today's fold of the copy lists them
 *  (`foldMemberRowChannels`), each the copy's own statement: the top-level `added` nodes no member row's whole `added`
 *  replaced, then every plain member row's `added` and `own`, at the row's member. Which nodes a row replaced is decided
 *  by today's own test on their anchors, not read off the fold's output, which clones a node a row reaches (close-out
 *  review F1). A nested reference row's lists belong to its own frame. */
function copySession(f: Frame, copy: AddedEntity): CopySession {
  const top = copy.added ?? [];
  const topKeys = frameKeyIndex(top as (AddedEntity & { key?: string })[]);
  const replaced = new Set<AddedEntity>();
  const s: CopySession = { frame: f.prefix, list: [], anchor: new Map(), rows: new Set(), keys: new Set() };
  const keysOf = (list: unknown): void => {
    for (const n of Array.isArray(list) ? list : []) {
      if (!isRecord(n)) continue;
      if (typeof n.key === 'string' && n.key) s.keys.add(n.key);
      keysOf(n.children);
    }
  };
  keysOf(copy.added);
  for (const row of Object.values(isRecord(copy.members) ? copy.members : {})) if (isRecord(row)) { keysOf(row.added); keysOf(row.own); }
  for (const slot of Object.values(isRecord(copy.nestedStructure) ? copy.nestedStructure : {})) if (isRecord(slot)) keysOf(slot.added);
  for (const [rawKey, row] of Object.entries(isRecord(copy.members) ? copy.members : {})) {
    const comp = /^\/[^/]+$/.test(rawKey) ? rawKey.slice(1) : null;
    const member = comp && !nodeRowKey(comp) ? rowOfComponent(f, comp) : undefined;
    if (!isRecord(row) || !member || typeof member.localId !== 'number' || member.prefab || member.localId === f.rootLid) continue;
    const lid = member.localId;
    s.rows.add(rawKey);
    if (Array.isArray(row.added)) {
      const named = new Set(row.added.map((n) => (isRecord(n) && typeof n.key === 'string' ? n.key : '')).filter(Boolean));
      for (const n of top) {
        const k = typeof (n as { key?: unknown }).key === 'string' ? (n as { key: string }).key : '';
        if (n.parentLocalId === lid || (!!k && named.has(k) && topKeys.get(k) === n && placedAnchor(f.doc as never, n.parentLocalId) === lid)) replaced.add(n);
      }
    }
    for (const n of [...(Array.isArray(row.added) ? row.added : []), ...(Array.isArray(row.own) ? row.own : [])] as AddedEntity[]) {
      s.list.push(n);
      s.anchor.set(n, lid);
    }
  }
  s.list.unshift(...top.filter((n) => !replaced.has(n)));
  return s;
}

/** Where the copied chain node's own statements reach, keyed from its frame: a member-row key (its rows and the rows the
 *  layers above state into it) or a `nestedStructure` localId path. */
interface Reach { key: (rel: string) => boolean; path: (lids: string) => boolean }

function reachOf(node: AddedEntity | null | undefined): Reach {
  // Structure only: the chain node's VALUES apply under the copy as well (`baseLayersOf`), so a row stating only values
  // cannot make the restore wrong, and is no reason to hold the copy (re-review N2).
  const structural = (r: unknown): boolean => isRecord(r) && (['removed', 'removedTraits', 'traitRemovals', 'added', 'own'] as const).some((f) => r[f] !== undefined);
  const keys: string[] = Object.entries(node?.members ?? {}).filter(([, r]) => structural(r)).map(([k]) => k);
  for (const o of node ? overRowsOf<AddedEntity>(node) : []) {
    keys.push(...Object.entries(o.rows ?? {}).filter(([, r]) => structural(r)).map(([k]) => k));
    if (structural(o.rootRow)) keys.push('/');
  }
  const paths = Object.keys(node?.nestedStructure ?? {});
  return {
    key: (rel) => keys.some((k) => k === rel || k.startsWith(`${rel}/`)),
    path: (lids) => paths.some((p) => p === lids || p.startsWith(`${lids}.`)),
  };
}

/** Under a scene copy, the chain node's own STRUCTURE does not apply (today: `baseLayersOf`, values only; #2027, seed
 *  1231): at every frame of the copy, a removal, a component removal or a node on which the chain and the copy's fold `d`
 *  disagree, and which no statement of the copy already decides, is stated back to what `d` shows. The copy's own
 *  statements are recorded as written; this pass adds only what the copy left unsaid, and nothing both folds agree on.
 *  `docs`: the documents containing frame `c`, its own last (a cycle is a document containing itself, § 10.4b — not a
 *  document repeated on the hang path). `rel` / `lids`: the frame's key and localId path from the copy's frame. False when
 *  a frame the chain node's statements reach cannot be read: the copy is then held whole (all or nothing; review F5). */
function restoreChainStructure<Own>(ctx: Ctx<Own>, c: Chain, d: Chain, docs: readonly string[], reach: Reach, rel = '', lids: string | null = ''): boolean {
  const f = c.frame;
  const rec = (k: RowKey): AnyRecord | undefined => ctx.out.rows.get(k);
  const dRemoved = new Set(d.lists.removed ?? []);
  for (const lid of c.lists.removed ?? []) {
    const k = dRemoved.has(lid) ? null : keyOfLid(f, lid);
    if (k !== null && rec(k)?.removed === undefined) ctx.out.removed(k, false, 'legacy');
  }
  for (const [lid, names] of Object.entries(c.lists.removedTraits ?? {})) {
    const k = keyOfLid(f, Number(lid));
    if (k === null) continue;
    const shown = new Set(d.lists.removedTraits?.[Number(lid)] ?? []);
    for (const t of names) if (!shown.has(t) && rec(k)?.traitRemovals?.[t] === undefined) ctx.out.traitRemoval(k, t, false, 'legacy');
  }
  const cKeys = frameKeyIndex(c.lists.added as (AddedEntity & { key?: string })[] | undefined);
  const dKeys = frameKeyIndex(d.lists.added as (AddedEntity & { key?: string })[] | undefined);
  const nodeKey = (key: string): RowKey => `${f.prefix}/${nodeRowComponent(key)}`;
  // A node only the chain has goes; a node a DOCUMENT supplies (template form, no guid) that the chain removed comes back.
  for (const [key, n] of cKeys) if (n && !dKeys.has(key) && rec(nodeKey(key))?.removed === undefined) ctx.out.removed(nodeKey(key), true, 'legacy');
  for (const [key, n] of dKeys) if (n && !n.guid && !cKeys.has(key) && !ctx.copy?.keys.has(key) && rec(nodeKey(key))?.removed === undefined) ctx.out.removed(nodeKey(key), false, 'legacy');
  // Down: every nested row of the document, and every reference node a document supplies to both folds. One the copy
  // restates is a scene statement in `d`, guid and all: a copy of its own (`referenceCopy`). A supplied node is nested in
  // the document that wrote it, one that contains this frame, so its cycle test leaves this frame's own document out.
  const down: { comp: string; docs: readonly string[]; lids: string | null }[] = [];
  for (const [lid, row] of f.byLid) {
    if (row.prefab && lid !== f.rootLid && !docs.includes(row.prefab)) down.push({ comp: componentOf(f, lid)!, docs, lids: lids === null ? null : lids ? `${lids}.${lid}` : String(lid) });
  }
  const writers = docs.slice(0, -1);
  for (const [key, n] of dKeys) {
    if (n?.prefab && !n.guid && cKeys.get(key)?.prefab === n.prefab && !writers.includes(n.prefab)) down.push({ comp: nodeRowComponent(key), docs: writers, lids: null });
  }
  for (const step of down) {
    const cs = chainStep(c, step.comp, ctx.read);
    const ds = chainStep(d, step.comp, ctx.read);
    const at = `${rel}/${step.comp}`;
    if ('frame' in cs && 'frame' in ds) {
      if (!restoreChainStructure(ctx, cs, ds, [...step.docs, cs.frame.docGuid], reach, at, step.lids)) return false;
    } else if (('unresolved' in cs || 'unresolved' in ds) && (reach.key(at) || (step.lids !== null && reach.path(step.lids)))) return false;
  }
  return true;
}

/** One chain step per localId of a `.`-joined path. */
function walkLids(c: Chain, path: string, read: PrefabReader): Chain | null {
  let at = c;
  for (const step of parseSteps(path)) {
    const comp = typeof step === 'number' && Number.isInteger(step) ? componentOf(at.frame, step) : null;
    if (!comp) return null;
    const next = chainStep(at, comp, read);
    if (!('frame' in next)) return null;
    at = next;
  }
  return at;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A TEMPLATE-form whole-list copy of chain reference node N (`a+key`). Today it replaces N wholesale: `pairWithBase` pairs
 *  scene-form copies only, so the copy has no base and none of the inner layers' rows into N, and whatever N's layer
 *  stated that the copy does not falls back to N's document. The list has no "unset" record (Unity has none: an outer
 *  layer can only STATE a value), so each such field is recorded with the value it SHOWS today, and the load warns
 *  (rule 1 + rule 6, hub 2026-10-02, #2006 gap A). Built as: C = the chain at N's frame (N's own layer and the inner
 *  layers' rows), D = the copy folded alone as the node; at every frame either speaks about, the lists pin to D's and a
 *  field is recorded where the copy states it or C and D disagree. All or nothing: unnameable → the copy is held. */
function templateReferenceCopy<Own>(ctx: Ctx<Own>, chain: Chain, key: string, copy: AddedEntity, at: Path): void {
  const comp = nodeRowComponent(key);
  const c = chainStep(chain, comp, ctx.read);
  const n = frameKeyIndex(chain.lists.added as (AddedEntity & { key?: string })[] | undefined).get(key);
  if (!('frame' in c) || !n) { ctx.pending.push(at, copy); ctx.pending.mark(at.slice(0, -1)); return; }
  const dLayers: Layer[] = [{ slots: copy.nestedStructure, rows: copy.members, values: copy.overrides, valuePaths: copy.nestedOverrides }];
  const folded = foldStructureLayers(c.frame.doc as never, dLayers, 0, { added: copy.added, removed: copy.removed, removedTraits: copy.removedTraits });
  const d: Chain = { frame: c.frame, lists: folded.channels as Lists, state: { layers: dLayers, forwardRoots: folded.forwardRoots as Chain['state']['forwardRoots'] } };
  const paths = new Set<string>(['']);
  for (const src of [n, copy]) for (const m of [src.nestedOverrides, src.nestedStructure]) for (const p of Object.keys(m ?? {})) paths.add(p);
  const scratch: Ctx<Own> = { ...ctx, out: new ListBuilder<Own>(ctx.warnings), pending: new Pending(), ownContent: new Map() };
  const erased: string[] = [];
  for (const p of paths) {
    const cp = p ? walkLids(c, p, ctx.read) : c;
    const dp = p ? walkLids(d, p, ctx.read) : d;
    if (!cp || !dp) { ctx.pending.push(at, copy); ctx.pending.mark(at.slice(0, -1)); return; }
    const f = cp.frame;
    const own = (p ? copy.nestedOverrides?.[p] : copy.overrides) as Record<string, Record<string, Record<string, unknown>>> | undefined;
    // Structure: the lists today shows, pinned against the chain.
    slotLists(scratch, f, { added: dp.lists.added ?? [], removed: dp.lists.removed ?? [], removedTraits: dp.lists.removedTraits ?? {} }, () => ['_']);
    // Values.
    const lids = new Set([...Object.keys(cp.lists.overrides ?? {}), ...Object.keys(dp.lists.overrides ?? {})]);
    for (const lid of lids) {
      const k = keyOfLid(f, Number(lid));
      if (k === null) continue;
      const base = (f.byLid.get(Number(lid))?.traits ?? {}) as Record<string, unknown>;
      const cv = (cp.lists.overrides?.[Number(lid)] ?? {}) as Record<string, Record<string, unknown>>;
      const dv = (dp.lists.overrides?.[Number(lid)] ?? {}) as Record<string, Record<string, unknown>>;
      for (const t of new Set([...Object.keys(cv), ...Object.keys(dv)])) {
        for (const fld of new Set([...Object.keys(cv[t] ?? {}), ...Object.keys(dv[t] ?? {})])) {
          const docVal = isRecord(base[t]) ? (base[t] as Record<string, unknown>)[fld] : undefined;
          const shown = dv[t] && fld in dv[t]! ? dv[t]![fld] : docVal;
          const before = cv[t] && fld in cv[t]! ? cv[t]![fld] : docVal;
          const stated = !!own?.[lid]?.[t] && fld in own[lid]![t]!;
          if (!stated && same(shown, before)) continue;
          if (shown !== undefined) {
            scratch.out.field(k, t, fld, shown, 'legacy');
            if (!stated) erased.push(`${k} ${t}.${fld}`);
          } else if (!(t in base) && !(t in dv)) {
            // N added a component its document lacks; the copy does not: today it is not there.
            scratch.out.traitRemoval(k, t, true, 'legacy');
            erased.push(`${k} ${t}`);
          }
        }
      }
    }
  }
  if (!scratch.pending.empty) { ctx.pending.push(at, copy); ctx.pending.mark(at.slice(0, -1)); return; }
  ctx.out.absorb(scratch.out, 'legacy');
  if (erased.length) {
    ctx.warnings.push({ code: 'pendingLegacy', key: `${chain.frame.prefix}/${comp}`, message: `a template copy of ${key} restates none of ${erased.join(', ')}; recorded with the value each shows today (#2006 gap A)` });
  }
}

/** Is `key` a nested reference ROW whose frame no document gives (a Missing Prefab placeholder), in a frame that does? */
function placeholderRow<Own>(ctx: Ctx<Own>, key: RowKey): boolean {
  const comps = key.split('/').filter(Boolean);
  const last = comps[comps.length - 1];
  if (!last || nodeRowKey(last)) return false;
  const outer = chainAt(ctx.top, comps.length > 1 ? `/${comps.slice(0, -1).join('/')}` : '', ctx.read);
  if (!('frame' in outer) || !rowOfComponent(outer.frame, last)?.prefab) return false;
  return !('frame' in chainStep(outer, last, ctx.read));
}

/** A template-form key through the owner's OWN added nodes (`/a+<key>/…`): the template chain lists no such node, so
 *  `rowTarget` cannot name it, and that is no reason to hold the row (close-out review round 3). */
const ownAddedKey = <Own>(ctx: Ctx<Own>, key: RowKey): boolean => ctx.form.template && !!nodeRowKey(key.split('/').filter(Boolean)[0] ?? '');

/** The guid of the ONE scene-owned node a row on a template-node key (`…/a+<k>`) reaches, in scene form, when the chain at
 *  that frame names no node `k` — or undefined. A key on a scene's own node is no writer's (a hand edit or merge into an
 *  entry's legacy `added`); today's fold listed the scene's nodes with the template's (`frameKeyIndex`), so the row
 *  applied to it, and a key two nodes carry named neither (#1937 T6). Format rule: the record converts to what today
 *  shows. */
function ownKeyedNode<Own>(ctx: Ctx<Own>, key: RowKey): string | undefined {
  if (ctx.form.template) return undefined;
  const comps = key.split('/').filter(Boolean);
  const k = nodeRowKey(comps[comps.length - 1] ?? '');
  if (!k) return undefined;
  const chain = chainAt(ctx.top, comps.length > 1 ? `/${comps.slice(0, -1).join('/')}` : '', ctx.read);
  if ('frame' in chain && frameKeyIndex(chain.lists.added as (AddedEntity & { key?: string })[] | undefined).has(k)) return undefined;
  const holders = [...ctx.ownContent].filter(([, n]) => (n as { key?: unknown }).key === k);
  return holders.length === 1 ? holders[0]![0] : undefined;
}

/** A row whose key runs THROUGH a scene-owned reference node {@link ownKeyedNode} names (`…/a+<k>/<rest>`): the row is
 *  the node's own, stated from its frame (`rest`), as a scene-added reference node's rows are (`parseReferenceNode`). The
 *  shape an entry's legacy `added` of keyed template nodes takes in a prefab's own edit world (#1914 R3b F2), which
 *  today's load read as the entry's root frame. Undefined when the key does not run through one. */
function ownKeyedReach<Own>(ctx: Ctx<Own>, key: RowKey): { guid: string; rest: string } | undefined {
  if (ctx.form.template) return undefined;
  const comps = key.split('/').filter(Boolean);
  const at = comps.findIndex((c) => !!nodeRowKey(c));
  if (at < 0 || at === comps.length - 1) return undefined;
  const guid = ownKeyedNode(ctx, `/${comps.slice(0, at + 1).join('/')}`);
  if (!guid || typeof (ctx.ownContent.get(guid) as { prefab?: unknown }).prefab !== 'string') return undefined;
  return { guid, rest: `/${comps.slice(at + 1).join('/')}` };
}

/** Row `row` stated into the scene-owned reference node `guid`'s own rows at `rest` ({@link ownKeyedReach}): merged
 *  field by field over any row the node states there. A copy: the file's node object is not written to. */
function foldRowIntoOwnNode<Own>(ctx: Ctx<Own>, guid: string, rest: string, row: Record<string, unknown>): void {
  const node = ctx.ownContent.get(guid)! as SceneOwnedNode & { members?: Record<string, unknown> };
  const members: Record<string, unknown> = { ...(isRecord(node.members) ? node.members : {}) };
  const was = isRecord(members[rest]) ? members[rest] as Record<string, unknown> : {};
  const traits = { ...(isRecord(was.traits) ? was.traits : {}) } as Record<string, unknown>;
  for (const [t, data] of Object.entries(isRecord(row.traits) ? row.traits : {})) traits[t] = isRecord(data) && isRecord(traits[t]) ? { ...traits[t] as object, ...data } : data;
  members[rest] = { ...was, ...row, ...(Object.keys(traits).length ? { traits } : {}) };
  const copy = { ...node, members } as SceneOwnedNode;
  if ((node as unknown as Record<symbol, unknown>)[DERIVED_NODE_GUID]) Object.defineProperty(copy, DERIVED_NODE_GUID, { value: true, enumerable: false });
  ctx.ownContent.set(guid, copy);
}

/** A row's trait values folded into the statement of the scene-owned node `guid` ({@link ownKeyedNode}): the node is
 *  scene content, stated whole, so its values carry no records. A copy: the file's node object is not written to. */
function foldIntoOwnNode<Own>(ctx: Ctx<Own>, guid: string, traits: Record<string, unknown>): void {
  const node = ctx.ownContent.get(guid)!;
  const merged: Record<string, unknown> = { ...(isRecord(node.traits) ? node.traits : {}) };
  for (const [t, data] of Object.entries(traits)) merged[t] = isRecord(data) && isRecord(merged[t]) ? { ...merged[t] as object, ...data } : data;
  const copy = { ...node, traits: merged } as SceneOwnedNode;
  if ((node as unknown as Record<symbol, unknown>)[DERIVED_NODE_GUID]) Object.defineProperty(copy, DERIVED_NODE_GUID, { value: true, enumerable: false });
  ctx.ownContent.set(guid, copy);
}

/** v16/v17 member rows (`members`), keyed from frame `prefix`: field records, removals, own nodes and pins carry over;
 *  the two whole-list fields convert as pins against the chain (§ 5.2 rows "row `added`", "member-row `removedTraits`").
 *  `parent` is the legacy move. Applied AFTER the owner's legacy channels: a row wins (§ 10.3). */
function convertRows<Own>(ctx: Ctx<Own>, prefix: string, rows: Record<string, SceneMemberRow> | undefined, pins: boolean): void {
  for (const [rawKey, row] of Object.entries(rows ?? {})) {
    if (!isRecord(row) || !rawKey.startsWith('/')) continue;
    const key = canonicalKey(ctx, prefix + rawKey);
    const into = ownKeyedReach(ctx, key);
    if (into) { foldRowIntoOwnNode(ctx, into.guid, into.rest, row as Record<string, unknown>); continue; }
    if (pins) {
      if (typeof row.guid === 'string') ctx.out.pin(key, 'guid', row.guid);
      if (typeof row.name === 'string') ctx.out.pin(key, 'name', row.name);
    }
    const own = isRecord(row.traits) ? ownKeyedNode(ctx, key) : undefined;
    if (own) foldIntoOwnNode(ctx, own, row.traits as Record<string, unknown>);
    else if (isRecord(row.traits)) for (const [t, data] of Object.entries(row.traits)) ctx.out.traitData(key, t, data, 'row');
    // The two whole lists convert AGAINST the chain. A target no chain names — in a frame no document gives (missing or
    // damaged), or a gone member — leaves them nothing to convert against: held verbatim, marker kept, as today keeps
    // the row (rule 9; close-out review rounds 2-4: converting it pinned a template copy as a scene-owned node and
    // dropped the list's restores). Not a template key through the owner's OWN added nodes, which no chain lists.
    const unnamed = (Array.isArray(row.added) || Array.isArray(row.removedTraits)) && rowTarget(ctx, key) === null && !ownAddedKey(ctx, key);
    if (unnamed) {
      // AT a Missing Prefab placeholder (the reference row itself), the user's own nodes are nameable: a keyless node
      // with a guid links there and shows, as in the legacy `added` and v17 `own` forms (§ 10.4b's visible fix, "in
      // every file form", #2025). The rest stays held as the WHOLE list it was, the user's nodes taken out — even empty:
      // it still says which of the missing document's nodes it replaced, which pins them once that document returns.
      const atPlaceholder = !ctx.form.template && Array.isArray(row.added) && placeholderRow(ctx, key);
      const own: Own[] = [];
      const rest = atPlaceholder ? (row.added as unknown[]).filter((n) => {
        if (!isRecord(n) || (typeof n.key === 'string' && n.key) || typeof n.guid !== 'string' || !n.guid) return true;
        // A guid another statement already links stays held: one node, one link (close-out review).
        if (ctx.ownContent.has(n.guid) && ctx.ownContent.get(n.guid) !== (n as unknown)) return true;
        own.push(ctx.form.ownNode(n as unknown as AddedEntity, key));
        return false;
      }) : row.added;
      if (own.length) {
        if (!isRemainder(row)) for (const d of ctx.out.replaceLegacyOwn(key, besideLegacy(ctx))) {
          const g = (d as { guid?: unknown }).guid;
          if (typeof g === 'string' && !own.some((o) => (o as { guid?: unknown }).guid === g)) ctx.ownContent.delete(g);
        }
        ctx.out.own(key, own, 'row');
      }
      if (Array.isArray(rest)) ctx.pending.put(['members', rawKey, 'added'], rest);
      if (Array.isArray(row.removedTraits)) ctx.pending.put(['members', rawKey, 'removedTraits'], row.removedTraits);
      if (isRemainder(row)) ctx.pending.mark(['members', rawKey]);
    } else if (Array.isArray(row.removedTraits)) {
      // A whole-list `removedTraits` on a plain template-added node (`…/a+<key>`) is a form no gesture writes (#2020:
      // those rows are diffed node by node, as `traitRemovals`). Today's loader ignores it there, and its next save drops
      // it; so it is held verbatim, not applied, and the load warns — at every version, since no writer (the v20 one
      // included) states it, and a held value written back must read back held (close-out review). On a template-added
      // REFERENCE node it is that frame's root row, which today applies.
      const stray = ctx.ownerRows && !!nodeRowKey(key.split('/').filter(Boolean).pop() ?? '') && !('frame' in chainAt(ctx.top, key, ctx.read));
      if (stray) {
        ctx.pending.put(['members', rawKey, 'removedTraits'], row.removedTraits);
        ctx.warnings.push({ code: 'pendingLegacy', key, message: `a whole removedTraits list on a template-added node is a form no editor writes; kept, not applied (#2020)` });
      } else wholeRemovedTraits(ctx, key, row.removedTraits);
    }
    if (isRecord(row.traitRemovals)) for (const [t, on] of Object.entries(row.traitRemovals)) if (typeof on === 'boolean') ctx.out.traitRemoval(key, t, on, 'row');
    if (typeof row.removed === 'boolean') ctx.out.removed(key, row.removed, 'row');
    // A reference copy's row in its own frame: its nodes are in the copy's one list, paired there (#2027).
    const inCopyList = !!ctx.copy?.rows.has(rawKey);
    if (Array.isArray(row.added) && !unnamed && !inCopyList) wholeAdded(ctx, key, row.added, ['members', rawKey, 'added'], isRemainder(row));
    if (Array.isArray(row.own) && !inCopyList) {
      // A copy restates the chain node it replaced, keyed, in whichever list (`pairWithBase` pairs `own` as `added`).
      const target = ctx.copy ? rowTarget(ctx, key) : null;
      if (target && target.lid !== null) {
        ctx.out.stating = true;
        try { pinAdded(ctx, target.chain, row.own, target.lid, ['members', rawKey, 'own'], true); } finally { ctx.out.stating = false; }
      } else ctx.out.own(key, row.own.map((n) => ctx.form.ownNode(n, key)), 'row');
    }
    if (typeof row.parent === 'string') {
      // A scene row states its parent by GUID. A member token written there is a legacy form no gesture writes (#1869):
      // today's drain resolves it from frame root 0, naming nothing, and the member stays. Held verbatim and unused, not
      // resolved (hub ruling on #2022 items 5-6). A reference node's converted `templateMoved` is added later, as moves.
      if (ctx.entryRows && isMemberToken(row.parent)) {
        ctx.pending.put(['members', rawKey, 'parent'], row.parent);
        // An alias row (`/R/<innerRoot>`) is one today ignores: held, but it replaces nothing (close-out review).
        if (key === prefix + rawKey) ctx.out.heldParent(key);
        ctx.warnings.push({ code: 'pendingLegacy', key, message: `a scene row states its parent as a member token (${row.parent}); no reader resolves it there, so it is kept and the member stays` });
      } else ctx.out.parent(key, row.parent, 'row');
    }
  }
}

/** A hand-written `/<row>/<innerRoot>` alias names the nested root `/<row>` (§ 2.1): canonicalised, with a warning. */
function canonicalKey<Own>(ctx: Ctx<Own>, key: RowKey): RowKey {
  const canon = canonicalRowKey(ctx.top, key, ctx.read);
  if (canon === key) return key;
  ctx.warnings.push({ code: 'aliasCanonicalised', key: canon, message: `${key} names its frame's root; read as ${canon}` });
  return canon;
}

/** A row's `removedTraits` (v16): the whole list for its member, over the chain's. Named → removed; the chain removed
 *  and it does not name → restored. It replaces the owner's own legacy list for that member (today's fold). */
/** Before v20, a row's whole list at a NESTED ROOT sits beside the legacy part stated from the frame ABOVE it (at the
 *  reference row's localId, `besideAt`) instead of replacing it (#2019, hub ruling 2026-10-02): today's own editor
 *  wrote both there and today shows both. A part the nested frame states at its own root is replaced, as at a plain
 *  anchor (close-out review); from v20 a row wins over any legacy channel, which only a stray writer leaves (§ 10.3). */
const besideLegacy = <Own>(ctx: Ctx<Own>): boolean => !!ctx.ownerRows && !!ctx.preV20;

function wholeRemovedTraits<Own>(ctx: Ctx<Own>, key: RowKey, list: readonly string[]): void {
  const beside = besideLegacy(ctx);
  ctx.out.dropLegacyRemovals(key, beside);
  const named = new Set(list.filter((t) => typeof t === 'string'));
  for (const t of named) ctx.out.traitRemoval(key, t, true, 'row');
  const target = rowTarget(ctx, key);
  if (!target || target.lid === null) return;
  // The row's restore of a chain removal it does not name does not undo a legacy removal kept beside it (#2019 review).
  for (const t of target.chain.lists.removedTraits?.[target.lid] ?? []) if (!named.has(t) && !(beside && ctx.out.keptBeside(key, t))) ctx.out.traitRemoval(key, t, false, 'row');
}

/** A row's `added` (v16): the whole list of nodes under its member, over the chain's (§ 5.2 "pin conversion"). It
 *  replaces the owner's own legacy nodes anchored there (today's fold: `row.added` replaces the lower layer's). */
function wholeAdded<Own>(ctx: Ctx<Own>, key: RowKey, list: readonly AddedEntity[], at: Path, remainder = false): void {
  // A held REMAINDER of a row's list replaces nothing: it is read back additively (`HELD_REMAINDER`). The legacy nodes
  // a whole list replaces leave `ownContent` too, so nothing holds content no link names (close-out review); a node the
  // row's list states again is put back by its own conversion below.
  if (!remainder) {
    for (const d of ctx.out.replaceLegacyOwn(key, besideLegacy(ctx))) {
      const g = (d as { guid?: unknown }).guid;
      if (!ctx.form.template && typeof g === 'string') ctx.ownContent.delete(g);
    }
  }
  const target = rowTarget(ctx, key);
  if (!target || target.lid === null) {
    // Under a template-added node: its children are the node's own list, not a chain member's anchor.
    ctx.out.own(key, list.map((n) => ctx.form.ownNode(n, key)), 'row');
    return;
  }
  ctx.out.stating = true;
  try { pinAdded(ctx, target.chain, list, target.lid, at, remainder); } finally { ctx.out.stating = false; }
}

// ── Template moves (member path → member token) ─────────────────────────────────────────────────────

/** The row key a member IDENTITY (`memberPathRecords`: localIds one per frame, `a+<key>` for a keyed node) names in the
 *  instance whose top frame is `top`. Null when it names nothing. */
export function identityToKey(top: Frame, identity: string, read: PrefabReader): RowKey | null {
  const parts = identity.split('/').filter(Boolean);
  if (!parts.length) return ROOT_ROW_KEY;
  let f = top;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (part.startsWith('a+')) {
      const key = `${f.prefix}/${part}`;
      if (last) return key;
      const c = chainAt(top, key, read);
      if (!('frame' in c)) return null;
      f = c.frame;
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    if (last) return keyOfLid(f, Number(part));
    const next = childFrame(f, Number(part), read);
    if (!('frame' in next)) return null;
    f = next.frame;
  }
  return null;
}

/** Member path (from the frame root of an instance of `docGuid` with `owner`'s structure) → its identity. */
export function memberIdentities(docGuid: string, owner: OwnerChannels, read: PrefabReader): Map<string, string> {
  const readRaw = (g: string): unknown => { const r = read(g); return 'doc' in r ? r.doc : null; };
  return memberPathRecords({ prefab: docGuid, guid: 'anchor', added: owner.added, nestedStructure: owner.nestedStructure, members: owner.members }, readRaw).self;
}

/** Template moves (`templateMoved` on a template reference node, or one reference row's share of its document's
 *  `moved`): `parent` member tokens on the template list (§ 5.2). A move of a keyed node (#1883 ruling C) is kept the
 *  same way and reported unused by the fold. A path that names no member is held verbatim. */
function templateMoves<Own>(ctx: Ctx<Own>, docGuid: string, owner: OwnerChannels, moves: Record<string, string> | undefined, at: (path: string) => Path): void {
  if (!moves || !Object.keys(moves).length) return;
  const ids = memberIdentities(docGuid, owner, ctx.read);
  for (const [path, token] of Object.entries(moves)) {
    const id = ids.get(path);
    const key = id === undefined ? null : identityToKey(ctx.top, id, ctx.read);
    if (key === null || key === ROOT_ROW_KEY || typeof token !== 'string') { ctx.pending.put(at(path), token); continue; }
    ctx.out.parent(key, token, 'legacy');
  }
}

// ── Forms ───────────────────────────────────────────────────────────────────────────────────────────

/** `derive`: the guid today's load gives a scene-added node that states none, under the target `anchorKey` names. */
function sceneForm(ownContent: Map<string, SceneOwnedNode>, warnings: ParseWarning[], derive?: (anchorKey: RowKey) => string): Form<AddedNodeRef> {
  return {
    template: false,
    ownNode(node, anchorKey) {
      // A node that states no guid (files before v12, or hand-written) is linked by a guid DERIVED from what the file
      // states, never minted (rule 5, hub 2026-10-02, #2006 gap B, re-ruled after a live test: today's load mints a fresh
      // one on every load, so the parser derives a stable one). The writer pins it from then on.
      const stated = typeof node.guid === 'string' ? node.guid : '';
      const guid = stated || (derive?.(anchorKey) ?? '');
      if (!guid) {
        warnings.push({ code: 'unparsed', message: `a scene-added node "${String(node.name ?? '')}" has no guid and none derives` });
        return { guid };
      }
      if (ownContent.has(guid) && ownContent.get(guid) !== node) warnings.push({ code: 'unparsed', message: `scene-owned node ${guid} is stated twice; the first statement is kept` });
      else ownContent.set(guid, stated ? node : Object.defineProperty({ ...node, guid }, DERIVED_NODE_GUID, { value: true, enumerable: false }));
      return { guid };
    },
  };
}

/** Every non-empty `guid` string the owner states, at any depth: what a derive must not collide with. */
function statedGuids(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) statedGuids(x, out);
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) { if (k === 'guid' && typeof x === 'string' && x) out.add(x); else statedGuids(x, out); }
  return out;
}

/** The deriver of `sceneForm` for an instance of `top` rooted at `rootGuid`: a plain added node with no guid steps by 0
 *  below its anchor, as the live derive steps an entity with no `PrefabInstance` (`memberStepId`), salted past every
 *  guid the file states and every one already derived (`deriveMemberGuidAvoiding`, #1882). */
function addedNodeDeriver(
  top: Frame, source: string, rootGuid: string, owner: OwnerChannels, read: PrefabReader, elsewhere?: (guid: string) => boolean,
): (anchorKey: RowKey) => string {
  let paths: Map<RowKey, string> | undefined;
  // #1882's collision rule: never a guid another entity holds — the file's own statements, and (`elsewhere`) the rest of
  // the scene. On a collision the NEW node moves to a salted seed; the holder keeps its guid.
  const stated = statedGuids(owner, new Set([rootGuid]));
  const held = { has: (g: string): boolean => stated.has(g) || !!elsewhere?.(g), add: (g: string): void => { stated.add(g); } };
  return (anchorKey) => {
    if (!rootGuid) return '';
    if (!paths) {
      paths = new Map([[ROOT_ROW_KEY, '']]);
      for (const [path, id] of memberIdentities(source, {}, read)) {
        const key = identityToKey(top, id, read);
        if (key !== null && !paths.has(key)) paths.set(key, path);
      }
    }
    const at = paths.get(anchorKey);
    if (at === undefined) return '';
    const { guid } = deriveMemberGuidAvoiding(rootGuid, [...memberPathSteps(at), 0], (g) => held.has(g));
    held.add(guid);
    return guid;
  };
}

/** The name a KEYLESS template-added node (a legacy document's) is addressed by in its frame: the guid it states, if any.
 *  Not a template key — the node carries none, and the capture mints one — only what the fold shows it under and a whole
 *  list above it removes it by (#2028: the old fold dropped such a node, today's load shows it). */
export function keylessNodeKey(node: { key?: unknown; guid?: unknown }): string {
  const raw = (node as Record<symbol, unknown>)[RAW_TEMPLATE_NODE] as { guid?: unknown } | undefined;
  const guid = raw ? raw.guid : node.guid;
  return !(typeof node.key === 'string' && node.key) && typeof guid === 'string' ? guid : '';
}

function templateForm(read: PrefabReader, warnings: ParseWarning[]): Form<TemplateAddedNode> {
  const convert = (node: AddedEntity): TemplateAddedNode => {
    const out: TemplateAddedNode = {
      key: typeof node.key === 'string' ? node.key : '',
      name: typeof node.name === 'string' ? node.name : '',
      traits: (isRecord(node.traits) ? node.traits : {}) as RecordTraits,
      children: (node.children ?? []).map(convert),
    };
    Object.defineProperty(out, RAW_TEMPLATE_NODE, { value: node, enumerable: false });
    if (typeof node.prefab === 'string') {
      out.prefab = node.prefab;
      const nested = parseTemplateOwner(node, node.prefab, read, node.templateMoved, 'templateMoved');
      warnings.push(...nested.warnings);
      if (nested.list.rows.size) out.members = Object.fromEntries(nested.list.rows);
      if (nested.list.held) out.held = nested.list.held;
    }
    return out;
  };
  return { template: true, ownNode: convert };
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────────

/** Split off what no reader takes (F-CB1(a)): kept verbatim under its channel name. */
/** A `members` channel holding a key no row reader takes (not `/`-rooted) or a row that is not a record. */


/** Values `splitMalformedChannels` does not inspect, in shapes no reader takes, moved out to `unparsed` (I18; the close-out
 *  review and #2008): a member row's non-boolean `traitRemovals` value, a non-record `templateMoved`. Each was dropped silently before. */
function malformedValues<T extends object>(clean: T, unparsed: Record<string, unknown>, original: T): T {
  const o = clean as Record<string, unknown>;
  const origRows = (original as Record<string, unknown>).members;
  let out = o;
  const take = (): Record<string, unknown> => (out === o ? (out = { ...o }) : out);
  if (o.templateMoved !== undefined && !isRecord(o.templateMoved)) { unparsed.templateMoved = o.templateMoved; delete take().templateMoved; }
  if (isRecord(o.members)) {
    let rows: Record<string, unknown> | undefined;
    for (const [k, row] of Object.entries(o.members)) {
      if (!isRecord(row) || !k.startsWith('/')) {
        // A row no reader takes, kept verbatim rather than skipped (close-out review round 2).
        // The ORIGINAL row, whole: the shared splitter may already have moved a malformed part of it out.
        ((unparsed.members ??= emptyDocMap()) as Record<string, unknown>)[k] = structuredClone(isRecord(origRows) ? origRows[k] : row);
        const rest = { ...(rows ?? (o.members as object)) } as Record<string, unknown>;
        delete rest[k];
        rows = rest;
        continue;
      }
      const bad: Record<string, unknown> = {};
      if (isRecord(row.traitRemovals)) for (const [t, on] of Object.entries(row.traitRemovals)) if (typeof on !== 'boolean') ((bad.traitRemovals ??= emptyDocMap()) as Record<string, unknown>)[t] = on;
      if (!Object.keys(bad).length) continue;
      // Merged into what the shared splitter already moved out of this row, never assigned over it.
      const held = (((unparsed.members ??= emptyDocMap()) as Record<string, unknown>)[k] ??= emptyDocMap()) as Record<string, unknown>;
      held.traitRemovals = { ...(isRecord(held.traitRemovals) ? held.traitRemovals : {}), ...structuredClone(bad.traitRemovals as object) };
      const fixed: Record<string, unknown> = { ...row };
      if (bad.traitRemovals) fixed.traitRemovals = Object.fromEntries(Object.entries(row.traitRemovals as object).filter(([, on]) => typeof on === 'boolean'));
      (rows ??= { ...(o.members as object) })[k] = fixed;
    }
    if (rows) take().members = rows;
  }
  return out as T;
}

function unparsedOf<T extends object>(owner: T, warnings: ParseWarning[]): { clean: T; unparsed?: Record<string, unknown> } {
  const { clean: split, malformed } = splitMalformedChannels(owner);
  const unparsed: Record<string, unknown> = {};
  restoreMalformed(unparsed, malformed);
  const clean = malformedValues(split, unparsed, owner);
  if (!Object.keys(unparsed).length) return { clean };
  warnings.push({ code: 'unparsed', message: `kept verbatim, no reader takes: ${Object.keys(unparsed).join(', ')}` });
  return { clean, unparsed };
}

const LEGACY_FIELDS = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'nestedOverrides', 'nestedStructure'] as const;

/** Rule 9: an instance whose prefab is missing or damaged keeps its list untouched. Legacy channels are held verbatim
 *  (a localId names nothing without its document); rows are keyed by identity and carry over, except the two
 *  whole-list fields, which convert against the chain: those rows are held whole. */
function unresolvedOwner<Own>(clean: OwnerChannels, out: ListBuilder<Own>, form: Form<Own>, pins: boolean, extra: Partial<Record<string, unknown>> = {}): LegacyChannels | undefined {
  const pending: Record<string, unknown> = {};
  for (const f of LEGACY_FIELDS) if (clean[f] !== undefined) pending[f] = structuredClone(clean[f]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) pending[k] = structuredClone(v);
  for (const [key, row] of Object.entries(clean.members ?? {})) {
    if (!isRecord(row)) continue;
    if (Array.isArray(row.added) || Array.isArray(row.removedTraits)) {
      const kept = structuredClone(row);
      // The "/" row's root defaults have one home, the placement, held row or not (#2008 round 3, D1's sibling): they
      // leave for the "/" record, which `takeRootDefaults` moves to the placement.
      const ea = pins && key === ROOT_ROW_KEY && isRecord(kept.traits) ? kept.traits.EntityAttributes : undefined;
      if (isRecord(ea)) {
        for (const f of ROOT_DEFAULT_FIELDS) if (f in ea) { out.field(key, 'EntityAttributes', f, ea[f], 'row'); delete ea[f]; }
        if (!Object.keys(ea).length) delete (kept.traits as Record<string, unknown>).EntityAttributes;
        if (!Object.keys(kept.traits as object).length) delete kept.traits;
      }
      ((pending.members ??= emptyDocMap()) as Record<string, unknown>)[key] = kept;
      continue;
    }
    if (pins && typeof row.guid === 'string') out.pin(key, 'guid', row.guid);
    if (pins && typeof row.name === 'string') out.pin(key, 'name', row.name);
    if (isRecord(row.traits)) for (const [t, data] of Object.entries(row.traits)) out.traitData(key, t, data, 'row');
    if (isRecord(row.traitRemovals)) for (const [t, on] of Object.entries(row.traitRemovals)) if (typeof on === 'boolean') out.traitRemoval(key, t, on, 'row');
    if (typeof row.removed === 'boolean') out.removed(key, row.removed, 'row');
    if (Array.isArray(row.own)) out.own(key, row.own.map((n) => form.ownNode(n, key)), 'row');
    if (typeof row.parent === 'string') out.parent(key, row.parent, 'row');
  }
  return Object.keys(pending).length ? pending as LegacyChannels : undefined;
}

/** Links at `/` the user's own nodes a missing root's held channels state AT it, and takes them out of what is held. A
 *  node links only by a stated guid (none is guessed without the document, rule 5) and only once (one node, one link).
 *  The legacy `added` channel names its anchor by localId, so it links only when the entry STATES the root's localId
 *  (`rootLid`, null otherwise — the v20 writer states none, and a guessed 1 would move a node under a child, rule 5),
 *  and not when the `/` row states a whole list, which replaces those nodes once the document returns (§ 10.3). */
function atMissingRoot<Own>(pending: Record<string, unknown>, rootLid: number | null, out: ListBuilder<Own>, form: Form<Own>, ownContent: Map<string, SceneOwnedNode>): void {
  const linkable = (n: unknown): n is AddedEntity => isRecord(n) && !(typeof n.key === 'string' && n.key) && typeof n.guid === 'string' && !!n.guid
    && !(ownContent.has(n.guid) && ownContent.get(n.guid) !== (n as unknown));
  const link = (nodes: AddedEntity[], from: 'legacy' | 'row'): void => { if (nodes.length) out.own(ROOT_ROW_KEY, nodes.map((n) => form.ownNode(n, ROOT_ROW_KEY)), from); };
  const members = isRecord(pending.members) ? pending.members : undefined;
  const row = members && isRecord(members[ROOT_ROW_KEY]) ? members[ROOT_ROW_KEY] as Record<string, unknown> : undefined;
  const rowReplaces = !!row && Array.isArray(row.added) && !isRemainder(row as SceneMemberRow);
  if (Array.isArray(pending.added) && rootLid !== null && !rowReplaces) {
    const at = (pending.added as unknown[]).filter((n): n is AddedEntity => linkable(n) && n.parentLocalId === rootLid);
    link(at, 'legacy');
    pending.added = (pending.added as unknown[]).filter((n) => !at.includes(n as AddedEntity));
    if (!(pending.added as unknown[]).length) delete pending.added;
  }
  if (!row) return;
  if (Array.isArray(row.own)) {
    const at = (row.own as unknown[]).filter(linkable);
    link(at, 'row');
    row.own = (row.own as unknown[]).filter((n) => !at.includes(n as AddedEntity));
    if (!(row.own as unknown[]).length) delete row.own;
  }
  if (Array.isArray(row.added)) {
    const at = (row.added as unknown[]).filter(linkable);
    link(at, 'row');
    row.added = (row.added as unknown[]).filter((n) => !at.includes(n as AddedEntity));
  }
}

/** The scene root's default overrides (`Placement`), never list records on `"/"`. `guid` is the entry's, always. */
const ROOT_DEFAULT_FIELDS = new Set(['parentId', 'sortOrder', 'editorFolder', 'sourceScene', 'name', 'guid']);

/** Options for a scene-form parse. */
export interface ParseOptions {
  /** The guid of the entity a stored `EntityAttributes.parentId` names (a scene-file id in files before v12, a guid
   *  since). Default: the value when it is a string, else `''`. */
  parentGuid?: (ref: unknown) => string;
  /** The scene file held `embeddedPrefabs` (§ 5.4): noted, never read for expansion. */
  sceneHadCopies?: boolean;
  /** Guids other entities of the scene hold: a derived link never takes one (#1882). */
  held?: (guid: string) => boolean;
  /** The scene file's stated `version`. From `INSTANCE_MODEL_SCENE_VERSION` on, an entry's own `name` (and stored
   *  `EntityAttributes.name`) is not read: the `"/"` row is the root name's one home, and the entry's name "equals the
   *  record, and nothing reads it" (hub ruling 2026-10-02, design § 10.4). REQUIRED (hub, 2026-10-02): the version picks
   *  readings (#2019's beside, the entry's name), and a silent default picks one for a caller that forgot to say. */
  sceneVersion: number;
}

type RootBag = Record<string, unknown>;
const attrs = (traits: unknown): RootBag | undefined => {
  const ea = isRecord(traits) ? traits.EntityAttributes : undefined;
  return isRecord(ea) ? ea : undefined;
};

/** One scene-form owner: an ENTRY (`entry: true`) or a REFERENCE NODE. */
function parseSceneOwner(owner: SceneEntityEntry | AddedEntity, entry: boolean, read: PrefabReader, opts: ParseOptions, parent: string): ParsedInstance {
  const warnings: ParseWarning[] = [];
  const { clean, unparsed } = unparsedOf(owner as SceneEntityEntry, warnings);
  const held: HeldData = {};
  if (unparsed) held.unparsed = unparsed;
  if (opts.sceneHadCopies) {
    held.ignoredCopies = true;
    warnings.push({ code: 'ignoredCopies', message: 'this scene holds backups of prefabs that are no longer used; they will be dropped at the next save' });
  }
  const traits = (isRecord(owner.traits) ? owner.traits : {}) as Record<string, unknown>;
  const pi = isRecord(traits.PrefabInstance) ? traits.PrefabInstance : undefined;
  const source = typeof owner.prefab === 'string' ? owner.prefab : typeof pi?.source === 'string' ? pi.source : '';
  const rootGuid = typeof owner.guid === 'string' ? owner.guid : '';
  const ea = attrs(traits);
  // A v20 entry's own name is the record's echo; nothing reads it (`ParseOptions.sceneVersion`).
  const v20 = entry && opts.sceneVersion >= INSTANCE_MODEL_SCENE_VERSION;
  const ownName = !v20 && typeof owner.name === 'string' && owner.name ? owner.name : undefined;
  const rootNamed = (rowDefaults: RootBag): void => {
    if (v20 && str(rowDefaults.name) === undefined) warnings.push({ code: 'rootNameMissing', key: ROOT_ROW_KEY, message: 'a v20 entry states no "/" name; the root shows the template root\'s' });
  };
  const ownContent = new Map<string, SceneOwnedNode>();
  const out = new ListBuilder<AddedNodeRef>(warnings);
  const got = read(source);
  const form = sceneForm(ownContent, warnings, 'doc' in got ? addedNodeDeriver(frameOf('', got.doc, source), source, rootGuid, clean as OwnerChannels, read, opts.held) : undefined);

  if (!('doc' in got)) {
    // The placeholder's placement, as it is shown today (`keepUnresolvedEntry`, `spawnUnresolvedReference`): the stored
    // EntityAttributes first, then the root override, read through the root localId the entry names.
    const rootLid = typeof pi?.localId === 'number' ? pi.localId : 1;
    const rootOv = attrs((clean.overrides as Record<string, unknown> | undefined)?.[rootLid]);
    let pending = unresolvedOwner(clean, out, form, true, entry ? {} : { templateMoved: (clean as unknown as AddedEntity).templateMoved });
    // AT this placeholder — the instance root, always nameable — the user's own nodes link at `/` and show, in every file
    // form: the legacy `added` at the root localId, a held `/` row's `own`, and the keyless nodes of its whole `added`
    // (#2018; hub ruling Q3 on #2025, which also corrects (a): a reference node's LINK is projected too, so its record —
    // its own whenever its prefab resolves, #1831 hunt seed 7078a — hangs from the placeholder). The rest stays held: a
    // node anchored inside the missing frame waits, and a whole list keeps what it replaced, even emptied.
    if (pending) atMissingRoot(pending as Record<string, unknown>, typeof pi?.localId === 'number' ? pi.localId : null, out, form, ownContent);
    // Everything it held may have linked: then nothing is held, and nothing is said to be (close-out review).
    if (pending && !Object.keys(pending).length) pending = undefined;
    const rowDefaults = takeRootDefaults(out, held, warnings);
    rootNamed(rowDefaults);
    const name = str(rowDefaults.name) ?? str(rootOv?.name) ?? ownName ?? (v20 ? undefined : str(ea?.name)) ?? 'Missing Prefab';
    const sortOrder = num(rowDefaults.sortOrder) ?? num(ea?.sortOrder) ?? num(rootOv?.sortOrder) ?? 0;
    if (pending) {
      held.pendingLegacy = pending;
      warnings.push({ code: 'pendingLegacy', message: `prefab ${source} did not resolve; its legacy channels are kept verbatim (rule 9)` });
    }
    const placement: Placement = { parent, sortOrder, name, ...folderOf(ea, rowDefaults) };
    return { record: { rootGuid, source, placement, list: { rows: out.rows }, held }, ownContent, warnings };
  }

  const top = frameOf('', got.doc, source);
  const pending = new Pending();
  const ctx: Ctx<AddedNodeRef> = { read, out, pending, warnings, form, ownContent, top, ownerRows: true, entryRows: entry, preV20: opts.sceneVersion < INSTANCE_MODEL_SCENE_VERSION };
  const rootOv = attrs((clean.overrides as Record<string, unknown> | undefined)?.[top.rootLid]);
  if (rootOv && 'parentId' in rootOv) {
    // No writer states it (`getOverrideValues` skips it) and no reader takes it as a parent: kept verbatim (F-CB1(a)).
    (held.unparsed ??= {}).overrides = { ...(held.unparsed.overrides as object ?? {}), [top.rootLid]: { EntityAttributes: { parentId: rootOv.parentId } } };
    warnings.push({ code: 'unparsed', key: ROOT_ROW_KEY, message: 'a root override states EntityAttributes.parentId; kept verbatim, the placement is the entry\'s' });
  }
  // The entry's root Transform (the legacy root-Transform channel) lands first; the root override wins over it
  // (`instantiatePrefabIntoWorld`: "an override on Transform fields wins over the legacy root-Transform-only mechanism").
  const rootTf = entry && isRecord(traits.Transform) ? traits.Transform : undefined;
  const templateRoot = top.byLid.get(top.rootLid);
  if (rootTf && isRecord(templateRoot?.traits?.Transform)) {
    for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz']) if (rootTf[k] !== undefined) out.field(ROOT_ROW_KEY, 'Transform', k, rootTf[k], 'legacy');
  }
  const skip = (key: RowKey, trait: string, field: string): boolean => key === ROOT_ROW_KEY && trait === 'EntityAttributes' && ROOT_DEFAULT_FIELDS.has(field);
  convertOwner(ctx, top, clean, { pins: true, skip, at: (...p) => p });
  // A scene reference node's `templateMoved` (`spawnReferenceNode` applies it for any reference node): its member tokens
  // become `parent` records, which the fold resolves as template moves (#2007 review, item 8). It was dropped before.
  if (!entry) templateMoves(ctx, source, clean as OwnerChannels, (clean as unknown as AddedEntity).templateMoved, (path) => ['templateMoved', path]);
  // The entry's extra root traits are applied LAST and win (SceneManager's `rootExtraTraits`).
  if (entry) for (const [t, data] of Object.entries(traits)) if (t !== 'PrefabInstance' && t !== 'Transform' && t !== 'EntityAttributes') out.traitData(ROOT_ROW_KEY, t, data, 'legacy');
  if (!pending.empty) {
    held.pendingLegacy = pending.channels as LegacyChannels;
    warnings.push({ code: 'pendingLegacy', message: 'legacy records whose target cannot be named are kept verbatim' });
  }
  const tAttrs = attrs(templateRoot?.traits);
  const templateName = (typeof tAttrs?.name === 'string' ? tAttrs.name : undefined) ?? (typeof templateRoot?.name === 'string' ? templateRoot.name : '');
  const rowDefaults = takeRootDefaults(out, held, warnings);
  // Root name (hub ruling 2026-10-02, rule 1 + U10b): the "/" row (v20; a row wins over a legacy channel, § 10.3), else
  // the root override, else the entry's own name (before v20 only), else the template root's. A reference NODE's own
  // `name` is not one: today's load never applies it to an expanded node (only its placeholder shows it), so the name it
  // shows now is the template root's (#2028).
  rootNamed(rowDefaults);
  const name = str(rowDefaults.name) ?? str(rootOv?.name) ?? (entry ? ownName : undefined) ?? templateName;
  // sortOrder: the "/" row, else the override, else the entry's stored order (where v20 writes the placement, § 2.2;
  // #2008 P2 D2), else the template root's (§ 10.4, review L4).
  // From v20 the entry's stored order IS the placement the writer wrote: it outranks a legacy root override still held
  // and written back (close-out review round 2: a reorder made while the prefab was missing).
  const stored = entry ? num(ea?.sortOrder) : undefined;
  const sortOrder = num(rowDefaults.sortOrder) ?? (v20 ? stored ?? num(rootOv?.sortOrder) : num(rootOv?.sortOrder) ?? stored) ?? num(tAttrs?.sortOrder) ?? 0;
  const placement: Placement = { parent, sortOrder, name, ...folderOf(entry ? ea : undefined, { ...rootOv, ...rowDefaults }) };
  return { record: { rootGuid, source, placement, list: { rows: out.rows }, held }, ownContent, warnings };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `editorFolder` and `sourceScene`: the entry's stored value wins over a root override's (SceneManager patches the
 *  root after the overrides). `''` is absent: it is what an ungrouped root, and a primary scene's root, holds. */
function folderOf(ea: RootBag | undefined, rootOv: RootBag | undefined): { editorFolder?: string; sourceScene?: string } {
  const pick = (f: string): string | undefined => (typeof ea?.[f] === 'string' && ea[f] ? ea[f] as string
    : typeof rootOv?.[f] === 'string' && rootOv[f] ? rootOv[f] as string : undefined);
  const folder = pick('editorFolder'), scene = pick('sourceScene');
  return { ...(folder ? { editorFolder: folder } : {}), ...(scene ? { sourceScene: scene } : {}) };
}

/** The `"/"` row's root default fields, taken OUT of the list (#2008 P2, D1). The placement is their one home in memory
 *  (hub ruling 2026-10-02, rule 1 + U10b), and a v20 file states the root's name on that row (`Placement.name`), so a
 *  reader that left it there would hold it twice. An emptied EntityAttributes, traits bag and row go with them. A
 *  `parentId` is kept verbatim, as the root override's is (F-CB1(a)): no reader takes it as a parent. */
function takeRootDefaults(out: ListBuilder<AddedNodeRef>, held: HeldData, warnings: ParseWarning[]): RootBag {
  const taken: RootBag = {};
  const row = out.rows.get(ROOT_ROW_KEY);
  const ea = row?.traits?.EntityAttributes;
  if (!row || !isRecord(ea)) return taken;
  for (const f of ROOT_DEFAULT_FIELDS) if (f in ea) { taken[f] = ea[f]; delete ea[f]; }
  if ('parentId' in taken) {
    // Merged into what is already held there (a malformed sibling row, #2008 round 3), never assigned over it.
    const rows = ((held.unparsed ??= {}).members ??= emptyDocMap()) as Record<string, unknown>;
    const traits = ((((rows[ROOT_ROW_KEY] ??= emptyDocMap()) as Record<string, unknown>).traits ??= emptyDocMap()) as Record<string, unknown>);
    ((traits.EntityAttributes ??= emptyDocMap()) as Record<string, unknown>).parentId = taken.parentId;
    warnings.push({ code: 'unparsed', key: ROOT_ROW_KEY, message: 'the root row states EntityAttributes.parentId; kept verbatim, the placement is the entry\'s' });
  }
  if (!Object.keys(ea).length) delete row.traits!.EntityAttributes;
  if (row.traits && !Object.keys(row.traits).length) delete row.traits;
  if (!Object.keys(row).length) out.rows.delete(ROOT_ROW_KEY);
  return taken;
}

/** A scene ENTRY → its `InstanceRecord` (§ 5.2, every legacy form). */
export function parseInstanceRecord(entry: SceneEntityEntry, read: PrefabReader, opts: ParseOptions): ParsedInstance {
  const ea = attrs(entry.traits);
  const ref = ea?.parentId;
  const parent = opts.parentGuid ? opts.parentGuid(ref) : typeof ref === 'string' ? ref : '';
  return parseSceneOwner(entry, true, read, opts, parent);
}

/** A scene REFERENCE NODE (a nested instance the scene added, an `AddedEntity` with `prefab` and a guid) → its own
 *  `InstanceRecord`, linked into its anchor's `own` by its guid (§ 2.5). Its parent is where it is linked, so the caller
 *  names it (`''` when the link alone places it). */
export function parseReferenceNode(node: AddedEntity, read: PrefabReader, opts: ParseOptions & { parent?: string }): ParsedInstance {
  return parseSceneOwner(node, false, read, opts, opts.parent ?? '');
}

/** A TEMPLATE owner (a prefab reference row, or a template reference node): its nested instance's list, keyed from
 *  its child document `childGuid`, with no pins (I8). `moves` are its template moves (member path → member token). */
function parseTemplateOwner(
  owner: PrefabDocRow | AddedEntity, childGuid: string, read: PrefabReader, moves: Record<string, string> | undefined, movesChannel: string,
): { list: TemplateOverrideList; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const { clean, unparsed } = unparsedOf(withTagsAsBags(owner) as SceneEntityEntry, warnings);
  if (movesChannel === 'templateMoved') moves = (clean as unknown as AddedEntity).templateMoved;
  const held: TemplateHeldData = {};
  const list = (): TemplateOverrideList => ({ rows: out.rows as Map<RowKey, TemplateTargetRecord>, ...(Object.keys(held).length ? { held } : {}) });
  if (unparsed) held.unparsed = unparsed;
  const out = new ListBuilder<TemplateAddedNode>(warnings);
  const form = templateForm(read, warnings);
  const got = read(childGuid);
  if (!('doc' in got)) {
    const pending = unresolvedOwner(clean as OwnerChannels, out, form, false, moves ? { [movesChannel]: moves } : {});
    if (pending) held.pendingLegacy = pending;
    return { list: list(), warnings };
  }
  const top = frameOf('', got.doc, childGuid);
  const pending = new Pending();
  const ctx: Ctx<TemplateAddedNode> = { read, out, pending, warnings, form, ownContent: new Map(), top };
  convertOwner(ctx, top, clean as OwnerChannels, { pins: false, at: (...p) => p });
  templateMoves(ctx, childGuid, clean as OwnerChannels, moves, (path) => [movesChannel, path]);
  if (!pending.empty) held.pendingLegacy = pending.channels as LegacyChannels;
  return { list: list(), warnings };
}

/** A TEMPLATE owner's tag values spelled `true` as the empty bag every writer produces: today's spawner reads a document's
 *  rows unsplit and adds the tag for either spelling (#1673's T1), where the shared split takes `true` for malformed (it is,
 *  in a scene owner, which today keeps it unapplied). A copy; the document is not touched. */
function withTagsAsBags<T extends object>(owner: T): T {
  const bags = (by: unknown): unknown => {
    if (!isRecord(by)) return by;
    let out: Record<string, unknown> | undefined;
    for (const [lid, bag] of Object.entries(by)) {
      if (!isRecord(bag) || !Object.values(bag).includes(true)) continue;
      (out ??= { ...by })[lid] = Object.fromEntries(Object.entries(bag).map(([t, v]) => [t, v === true ? {} : v]));
    }
    return out ?? by;
  };
  const o = owner as Record<string, unknown>;
  const overrides = bags(o.overrides);
  let nested = o.nestedOverrides;
  if (isRecord(nested)) {
    let copy: Record<string, unknown> | undefined;
    for (const [k, frame] of Object.entries(nested)) { const b = bags(frame); if (b !== frame) (copy ??= { ...nested })[k] = b; }
    nested = copy ?? nested;
  }
  return overrides === o.overrides && nested === o.nestedOverrides ? owner : { ...o, overrides, nestedOverrides: nested } as T;
}

/** Every reference row of prefab document `doc` (guid `docGuid`) → its nested instance's TEMPLATE list (§ 5.2, the
 *  template rows). The document-level `moved` (v4) is split across the rows: each move lands on the list of the
 *  reference row whose frame holds the moved member, its token rebased one frame up (`^`: it was written from the
 *  document's root). A move naming no nested member is held verbatim in `docHeld`. */
export function parseTemplateLists(doc: PrefabDoc, docGuid: string, read: PrefabReader): {
  rows: Map<number, { list: TemplateOverrideList; warnings: ParseWarning[] }>;
  docHeld?: { moved?: Record<string, string>; unparsed?: { moved: unknown } };
} {
  const rows = new Map<number, { list: TemplateOverrideList; warnings: ParseWarning[] }>();
  const top = frameOf('', doc, docGuid);
  // The document's moves, by the reference row whose frame they reach into.
  const share = new Map<number, Record<string, string>>();
  let docHeld: Record<string, string> | undefined;
  // A document-level `moved` in no shape a reader takes is kept verbatim (I18; #2008), not dropped.
  const docUnparsed = doc.moved !== undefined && !isRecord(doc.moved) ? { moved: doc.moved as unknown } : undefined;
  const moved = doc.moved && isRecord(doc.moved) ? doc.moved : undefined;
  if (moved && Object.keys(moved).length) {
    const readRaw = (g: string): unknown => { const r = read(g); return 'doc' in r ? r.doc : null; };
    const ids = memberPathRecords({ prefab: docGuid, guid: 'anchor' }, readRaw).self;
    for (const [path, token] of Object.entries(moved)) {
      const id = ids.get(path);
      const parts = id?.split('/').filter(Boolean) ?? [];
      const rowLid = parts.length >= 2 && /^\d+$/.test(parts[0]!) ? Number(parts[0]) : NaN;
      const row = top.byLid.get(rowLid);
      const t = typeof token === 'string' ? parseMemberToken(token) : null;
      const inner = row?.prefab ? innerMemberPath(path, rowLid, ids) : null;
      if (!row?.prefab || !t || inner === null) { (docHeld ??= emptyDocMap())[path] = token; continue; }
      (share.get(rowLid) ?? share.set(rowLid, emptyDocMap()).get(rowLid)!)[inner] = memberToken(t.up + 1, t.path);
    }
  }
  for (const row of doc.entities ?? []) {
    if (!row?.prefab || typeof row.localId !== 'number' || row.localId === top.rootLid) continue;
    rows.set(row.localId, parseTemplateOwner(row, row.prefab, read, share.get(row.localId), 'moved'));
  }
  const held = { ...(docHeld ? { moved: docHeld } : {}), ...(docUnparsed ? { unparsed: docUnparsed } : {}) };
  return { rows, ...(Object.keys(held).length ? { docHeld: held } : {}) };
}

/** `path` (a member path from the document's root) as a path from the root of nested row `rowLid`'s frame: the
 *  member-path walk the derive uses ({@link memberPathRecords}) gives a nested root's members its row's path plus
 *  their own, so the inner path is what follows the row's. Null when `path` does not run through the row. */
function innerMemberPath(path: string, rowLid: number, ids: Map<string, string>): string | null {
  for (const [p, id] of ids) {
    if (id !== `/${rowLid}`) continue;
    if (path.startsWith(`${p}.`)) return path.slice(p.length + 1);
  }
  return null;
}

/** A prefab document's reference row → its nested instance's TEMPLATE list (no document-level moves: see
 *  {@link parseTemplateLists}). */
export function parseTemplateList(row: PrefabDocRow, read: PrefabReader): { list: TemplateOverrideList; warnings: ParseWarning[] } {
  if (!row.prefab) return { list: { rows: new Map() }, warnings: [] };
  return parseTemplateOwner(row, row.prefab, read, undefined, 'moved');
}

export type { InstanceRecord };
