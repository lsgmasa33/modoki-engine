/**
 * The prefab INSTANCE RECORD: an instance IS its prefab plus its override list (#2001).
 *
 * Rules: docs/prefabs.md § High-level rules (owner, 2026-10-02). Design:
 * docs/plans/prefab-instance-model.md § 2 (the model), § 3.1 (the fold's output) and § 10.4 (binding
 * amendments). Every type here is plain data: no ECS entity, no live tree. The live entities are a
 * projection of (prefab chain, list) — rule 2 — so nothing here may be re-derived from them.
 *
 * TYPES ONLY at this commit. S1 (#2006) adds the parser, S2 (#2007) the fold, S3 (#2008) the writer.
 * Nothing calls these yet.
 *
 * Two forms of one grammar:
 * - SCENE form: the list of a stored instance root (a scene entry, or a reference node the scene added).
 *   Rows may carry identity pins, and `own` links scene-owned nodes by guid.
 * - TEMPLATE form: the list a prefab document's reference row carries for its nested instance. No pins
 *   (I8), and `own` holds the added nodes themselves, keyed by template key.
 */
import type { AddedEntity, SceneEntityEntry } from '../loaders/loadSceneFile';

// ── Row keys ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Names one target node inside an instance.
 * - `"/"` is the instance's own root.
 * - `"/<c1>/<c2>…"` has one component per FRAME, flat within that frame. A component is either a
 *   template row's `nodeGuid` or `"a+<templateKey>"` for a template-added node.
 *
 * A nested frame's root is named by its reference row's key in the enclosing frame (`/<rowNodeGuid>`),
 * never `/<rowNodeGuid>/<innerRootNodeGuid>` (`memberNodeId`, assetRefRules.ts). The parser canonicalises
 * the alias and warns.
 */
export type RowKey = string;
export const ROOT_ROW_KEY: RowKey = '/';

// ── Records ─────────────────────────────────────────────────────────────────────────────────────────

/** Trait data on a record: field → value, or `true` for a tag trait. */
export type RecordTraits = Record<string /*trait*/, Record<string /*field*/, unknown> | true>;

/**
 * Everything the list states about ONE target. A record is keyed by its target, so a target holds one
 * record per field, and rule 3's verbs (add a record, drop a record) are well defined.
 *
 * `Own` is the added-node shape: `AddedNodeRef` in scene form, `TemplateAddedNode` in template form.
 */
export interface TargetRecordOf<Own> {
  // ── identity (rule 5): pins, NOT overrides. Never listed, applied, reverted or counted as unused.
  //    Every parsed pin is kept verbatim, including the pin of a member that is gone (§ 10.4, review L2).
  guid?: string;
  name?: string;
  // ── overrides (rule 2) ──
  /** Property records. A trait the base lacks is an ADDED component; the fold classifies it. */
  traits?: RecordTraits;
  /** `true` removes a component; `false` restores one an INNER layer removed. */
  traitRemovals?: Record<string, boolean>;
  /** `true` removes the node (top-most removed member only; descendants cascade). `false` restores an
   *  inner layer's removal. Deleting a member KEEPS the records on and under it (rule 3, § 10.4). */
  removed?: boolean;
  /** Added children, in authored order. Appended after whatever inner layers added. */
  own?: Own[];
  /** LEGACY move, read and kept, revertable; no gesture writes one (U7, #1869). Scene form: the new
   *  parent's guid, which may name a scene-owned node (§ 10.4, review L8). Template form: a member
   *  token (`@member:…`). */
  parent?: string;
}

/** Scene form: a link to a scene-owned added node. Its CONTENT is scene data, not list data (§ 3.4):
 *  like Unity's `m_AddedGameObjects`, the list holds the reference and the node is an ordinary scene
 *  object. An added PREFAB instance is its own `InstanceRecord`, linked here by its root guid. */
export interface AddedNodeRef {
  guid: string;
}

/** Template form: an added node stored IN the prefab document's reference row, keyed by its template
 *  key (minted by the write, or by admission's seeded key, #1937 C-A). A scene addresses it as
 *  `…/a+<key>`. In prefab edit mode the live node keeps its key on `TemplateAddedKey`, so a save reuses
 *  it rather than re-minting (§ 10.4, review L1). */
export interface TemplateAddedNode {
  key: string;
  name: string;
  traits: RecordTraits;
  children: TemplateAddedNode[];
  /** Present on a template REFERENCE node: the nested prefab it instances … */
  prefab?: string;
  /** … and that nested instance's own list, in template form … */
  members?: Record<RowKey, TemplateTargetRecord>;
  /** … and what of it the parser could not name or interpret, kept verbatim (format rule; rule 9). */
  held?: TemplateHeldData;
}

export type SceneTargetRecord = TargetRecordOf<AddedNodeRef>;
/** Template form carries no identity pins (I8). */
export type TemplateTargetRecord = Omit<TargetRecordOf<TemplateAddedNode>, 'guid' | 'name'>;

/** The override list: THE truth about an instance (rule 2). Unused records stay in it, untouched
 *  (rules 7 and 9); the fold reports them, nothing stores them separately. */
export interface OverrideList {
  rows: Map<RowKey, SceneTargetRecord>;
}
/** A prefab reference row's list (template form). Its root row `"/"` holds the nested root's `name`
 *  and `sortOrder` (§ 10.4: one home each). A scene-form list's `"/"` row never holds them: they are
 *  `Placement`. */
export interface TemplateOverrideList {
  rows: Map<RowKey, TemplateTargetRecord>;
  /** What the parser could not name (its nested prefab missing or damaged) or interpret, kept verbatim so the first
   *  save does not lose it (rule 9; format rule, hub refinement 2026-10-02; hub ruling 2026-10-02, #2006). */
  held?: TemplateHeldData;
}

// ── The stored instance ─────────────────────────────────────────────────────────────────────────────

/**
 * The stored root's DEFAULT OVERRIDES (Unity U10b: always recorded, always written, always read): where
 * it sits, its order and its name. Not ordinary list records (Unity's `m_TransformParent`, the
 * always-written root order and `m_Name`). F7: the root always records its order.
 */
export interface Placement {
  /** Parent entity guid; `''` at the scene's top level. */
  parent: string;
  /** An entry that states none parses as its template root's order, not 0 (§ 10.4, review L4). */
  sortOrder: number;
  /** The root's name (hub ruling, 2026-10-02, rule 1 + U10b). A prefab-root rename does not reach an
   *  existing instance, and a Missing Prefab placeholder takes its name from here. Its ONE home in
   *  memory: the `"/"` row never holds `EntityAttributes.name`. The parser fills it from
   *  `overrides[rootLid].EntityAttributes.name`, else the entry's own `name`, else the template root's
   *  name at load. On disk the writer puts it on the `"/"` row. */
  name: string;
  editorFolder?: string;
  /** Base-scene provenance: the scene FILE that saves this root (`EntityAttributes.sourceScene`). */
  sourceScene?: string;
}

/** A scene-owned added node's content, as the scene file states it (an inline node in `own`/`added`). */
export type SceneOwnedNode = AddedEntity;

/** Legacy channels kept VERBATIM because no reader could convert them yet (format rule, exception 2):
 *  an instance whose document is missing or damaged, since a localId means something only next to its
 *  document. Rule 9 keeps that list untouched; the first save after the document resolves converts it. */
export type LegacyChannels = Pick<
  SceneEntityEntry,
  'overrides' | 'added' | 'removed' | 'removedTraits' | 'moved' | 'nestedOverrides' | 'nestedStructure' | 'members'
>;

/** The marker on a held container that stood for a WHOLE list — a `nestedStructure` slot, or a `members` row's `added`
 *  (scene or template form) — when only its unnameable REMAINDER is held (hub ruling 2026-10-02, #2006,
 *  option C). A held record must mean on reload what it meant in the file; the remainder alone, read as a whole list,
 *  would mean "everything else is gone". So a container carrying `heldRemainder: true` converts ADDITIVELY: each
 *  element becomes its own record, or is held again with the marker. Writers put held data back verbatim, marker
 *  included. On a `members` row it scopes to the row's `added` alone: a written row may also carry v20 statements beside it
 *  (`own`, pins), which read as they always do. v20 is refused by older editors, so none misreads it. */
export const HELD_REMAINDER = 'heldRemainder';

/** What the load could not interpret, or could not place. Written back verbatim; never projected. */
export interface HeldData {
  /** A value in a shape no reader takes (I18 / F-CB1(a)), under its own channel name, e.g.
   *  `{ removed: "x" }`. Format rule, exception 1: written back as it was. */
  unparsed?: Record<string, unknown>;
  /** See `LegacyChannels`. */
  pendingLegacy?: LegacyChannels;
  /** Scene-owned added nodes whose anchor is not projected (prefab missing, or the anchor member gone).
   *  Kept as data, respawned when the anchor returns (B′, #1880 F3a). Rule 7: user-added nodes are
   *  scene content, never overrides — Remove Unused, Detach and unpack never delete them; unpack re-homes
   *  them under the unpacked root (§ 10.4, review L6). */
  heldOwn?: Map<RowKey, SceneOwnedNode[]>;
  /** A v19 file held `embeddedPrefabs` (§ 5.4, owner ruling B). Not read for expansion; a validator
   *  note only; dropped at the next save. */
  ignoredCopies?: true;
}

/** A template-form owner's held data: `HeldData` minus what template form cannot have — no scene-owned nodes (an
 *  own node is scene content) and no embedded copies (a scene-file field). Hub ruling 2026-10-02, #2006. */
export type TemplateHeldData = Pick<HeldData, 'unparsed' | 'pendingLegacy'>;

export interface InstanceRecord {
  /** The stored root's durable guid, minted by the write that placed it (rule 5). */
  rootGuid: string;
  /** The prefab DOCUMENT guid (I22). */
  source: string;
  placement: Placement;
  /** THE truth (rule 2). */
  list: OverrideList;
  held: HeldData;
}

// ── Parse result ────────────────────────────────────────────────────────────────────────────────────

export type ParseWarningCode =
  /** An entry holds a legacy channel AND a row for the same target: the row wins (§ 10.3, review R5). */
  | 'rowWins'
  /** A hand-written `/<row>/<innerRoot>` alias was canonicalised to `/<row>` (§ 2.1). */
  | 'aliasCanonicalised'
  /** `embeddedPrefabs` were present and ignored (§ 5.4). */
  | 'ignoredCopies'
  /** A value no reader takes went to `held.unparsed` (F-CB1(a)). */
  | 'unparsed'
  /** Legacy channels went to `held.pendingLegacy` because the document did not resolve (rule 9). */
  | 'pendingLegacy'
  /** A v20 entry states no `"/"` name: the root shows the template root's (hub ruling 2026-10-02). */
  | 'rootNameMissing';

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  key?: RowKey;
}

/**
 * What `parseInstanceRecord` returns for one stored owner (a scene entry or a scene reference node).
 * The record holds links only; `ownContent` carries each linked scene-owned node's content (by guid) so
 * the first projection can spawn it. After that, the content lives on the live entity, like any plain
 * scene entity's.
 */
export interface ParsedInstance {
  record: InstanceRecord;
  ownContent: Map<string /*guid*/, SceneOwnedNode>;
  warnings: ParseWarning[];
}

// ── The prefab reader (§ 3.1) ───────────────────────────────────────────────────────────────────────

/** A prefab document row, as the runtime reads it. `EntityAttributes.parentId` holds the parent's
 *  localId; there is no `parentLocalId` field on a row. */
export interface PrefabDocRow {
  localId?: number;
  nodeGuid?: string;
  name?: string;
  traits: Record<string, unknown>;
  prefab?: string;
  // ── legacy template-form channels of a reference row (prefab v ≤ 9); converted on parse ──
  overrides?: SceneEntityEntry['overrides'];
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  nestedOverrides?: SceneEntityEntry['nestedOverrides'];
  nestedStructure?: SceneEntityEntry['nestedStructure'];
  members?: SceneEntityEntry['members'];
}

/** A prefab document the reader has ADMITTED: through `admitPrefabDocument` (keys seeded, malformed
 *  owners refused) and `frameRepeatRefusal`. One admission per read (rule 5). */
export interface PrefabDoc {
  id?: string;
  version?: number;
  rootLocalId?: number;
  entities: PrefabDocRow[];
  /** v4 document-level move map (member path → member token). Legacy. */
  moved?: Record<string, string>;
}

export type PrefabRead = { doc: PrefabDoc } | { missing: true } | { damaged: string };
/** `damaged` carries the reason text for the Damaged Prefab label (U9c). */
export type PrefabReader = (guid: string) => PrefabRead;

// ── The fold's output (§ 3.1; built in S2) ──────────────────────────────────────────────────────────

/** Why a record does not apply. Remove Unused and the unused count use `gone` and `unknownField` only (rules 7 and 9,
 *  § 10.4, review R7; `unknownField`: rule 1, hub 2026-10-02, #2007). */
export type UnusedCause =
  /** Its target is gone from a prefab that is loaded and intact. */
  | 'gone'
  /** It waits on a missing or damaged nested prefab. */
  | 'unresolved'
  /** It names a component type not yet registered (I24: not a removal). */
  | 'unregistered'
  /** A scene-owned node held under an anchor that is not projected (`held.heldOwn`). */
  | 'heldNode'
  /** A field a REGISTERED component does not persist: renamed or removed in code, written by a newer engine, or on a
   *  component that became a tag (#1933 L2). Unity's Remove Unused Overrides takes a modification whose property no
   *  longer exists; until removed it is kept and written back verbatim. */
  | 'unknownField';

/** Which part of a record does not apply. */
export type RecordPart =
  | { kind: 'field'; trait: string; field: string }
  | { kind: 'trait'; trait: string } // a whole added component, or a tag
  | { kind: 'traitRemoval'; trait: string }
  | { kind: 'removed' }
  | { kind: 'own'; guid: string }
  | { kind: 'parent' }
  /** A legacy record held verbatim because its target cannot be named (format rule, hub refinement 2026-10-02,
   *  #2006): its path into `held.pendingLegacy`, e.g. `['overrides', '12', 'Transform', 'x']`. */
  | { kind: 'legacy'; path: string[] };

export interface UnusedRecord {
  key: RowKey;
  part: RecordPart;
  cause: UnusedCause;
}

/** One node the projection must produce. Pure data; `realize` (S5) turns it into an entity. */
export interface DesiredNode {
  key: RowKey;
  /** The fully folded component data (template, then each layer inner to outer, then this list). */
  traits: Record<string, Record<string, unknown> | true>;
  /** `null` for the instance root, and only for it. Otherwise the parent's key, or a guid: a scene-owned node's (only
   *  through a legacy `parent` record, § 10.4, review L8), or — for a row whose stated parent names no row — the
   *  instance's own parent (`Placement.parent`; `''` is the scene's top level, and in a nested frame, no parent). */
  parent: { key: RowKey } | { guid: string } | null;
  sortOrder: number;
  /** The template row's minted identity, or a pre-v5 document's in-memory derivation (§ 2.7). */
  nodeGuid?: string;
  /** Set on a template-added node. */
  templateKey?: string;
  localId?: number;
  /** The frame that supplies this node: the document it comes from and that frame's root key. Stamps
   *  `PrefabInstance`. */
  frame: { source: string; rootKey: RowKey };
}

export interface Placeholder {
  source: string;
  reason: 'missing' | 'damaged';
  text?: string;
  /** Where the placeholder hangs, as its row would (`DesiredNode.parent`): what realize (S5) parents it by, and what the
   *  removal cascade follows (#2007 review, item 3). */
  parent?: DesiredNode['parent'];
}

/** The definition of "what this instance is": a pure function of (reader, record). */
export interface FoldedInstance {
  nodes: Map<RowKey, DesiredNode>;
  /** A Missing/Damaged Prefab placeholder per unresolvable frame (the root's `"/"` when the source
   *  itself does not resolve). Records under it are unused with cause `unresolved` (U9, ruling D). */
  placeholders: Map<RowKey, Placeholder>;
  unused: UnusedRecord[];
  /** Where each scene-owned own node hangs. A node whose anchor is not projected is NOT here. */
  anchors: Map<RowKey, AddedNodeRef[]>;
}
