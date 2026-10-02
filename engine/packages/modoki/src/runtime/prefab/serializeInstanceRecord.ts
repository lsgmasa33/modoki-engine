/**
 * The WRITER of the prefab instance model (#2001 S3, #2008): an `InstanceRecord` → the scene v20 entry, and a template
 * list → what a prefab v10 reference row states (`members`, plus held values).
 *
 * Rule 4 (docs/prefabs.md § High-level rules): **Save writes the list. It does not diff the live tree.** So this reads
 * the record and nothing else: no live entity, no template, no mark, no frame record (design § 3.4). Three inputs come
 * from outside the record, and each is data, not a comparison:
 * - `identity`: the guid (and, for a readable file, the name) of each PRESENT keyed member. Identity, not an override:
 *   it is the one thing the save writes that no gesture wrote (design § 2.7).
 * - `sceneOwned(guid)`: the CONTENT of a scene-owned added node, serialized like any plain entity. The list holds only
 *   its link, as Unity's `m_AddedGameObjects` does (design § 3.4).
 * - `held` (on the record): what the load could not interpret, written back verbatim.
 *
 * Format rule (docs/prefabs.md): only the new form is written. The two exceptions are verbatim pass-through of values
 * no reader could interpret yet (`held.unparsed`, `held.pendingLegacy`), in both forms: a scene owner's, and a template
 * owner's (a reference row's list, a template reference node; hub ruling 2026-10-02). No legacy content is ever produced.
 *
 * Byte stability (rule 4: load → save is verbatim from v20 on): rows are written sorted by key, as today's row writer
 * sorts them (`moveChannelsOntoRows`); each row's fields in one fixed order; traits and fields in the record's own order.
 *
 * Dead code at S3: nothing calls it until the save flips (S6).
 */
import type { AddedEntity, SceneEntityEntry, SceneMemberRow } from '../loaders/loadSceneFile';
import {
  ROOT_ROW_KEY,
  type InstanceRecord,
  type RecordTraits,
  type RowKey,
  type SceneOwnedNode,
  type SceneTargetRecord,
  type TemplateAddedNode,
  type TemplateHeldData,
  type TemplateOverrideList,
  type TemplateTargetRecord,
} from './instanceRecord';

/** A scene v20 instance entry as the writer states it. The entry's file `id` is the scene writer's to assign. */
export type InstanceEntryJson = Omit<SceneEntityEntry, 'id'>;

/** A template-form row as a prefab v10 reference row's `members` states it. */
export interface TemplateRowJson {
  parent?: string;
  traits?: RecordTraits;
  traitRemovals?: Record<string, boolean>;
  removed?: boolean;
  own?: TemplateNodeJson[];
}

/** A template-added node on disk: `AddedEntity`'s template shape (`guid: ''`, `parentLocalId: 0`, the identity in `key`,
 *  as `toTemplateNodes` writes it today), plus a reference node's own template-form list. */
export interface TemplateNodeJson extends Omit<AddedEntity, 'members' | 'traits' | 'children'> {
  key: string;
  traits: RecordTraits;
  children: TemplateNodeJson[];
  members?: Record<RowKey, TemplateRowJson>;
}

/** The present members' identity, from the projection (design § 2.7). `name` only makes the file readable: its one
 *  reader is an orphaned row's log line (`SceneMemberRow.name`). */
export type MemberIdentity = ReadonlyMap<RowKey, { guid: string; name?: string }>;

export interface SerializeContext {
  identity: MemberIdentity;
  /** The content of the scene-owned added node with this guid, in its inline `AddedEntity` form, or `undefined` when no
   *  live node has it. A node the projection could not place is in `held.heldOwn` instead. An added PREFAB instance is
   *  a reference node with its own record (review "held up": at any depth). Its inline form is the caller's adapter
   *  (S6): `prefab` plus that record's list, NOT a whole `serializeInstanceRecord` entry, whose placement `parentId`
   *  would restate the anchor this row already names. */
  sceneOwned: (guid: string) => SceneOwnedNode | undefined;
}

/** A value the writer did not write, because the written form states something else at its place. */
export interface SupersededValue {
  path: string[];
  value: unknown;
}

export interface SerializedInstance {
  entry: InstanceEntryJson;
  /** Each value the written form superseded, for the caller to report (never silently: rule 1's exception): a held
   *  value whose place the written form states, or a name the `"/"` row held beside `placement.name`. */
  superseded: SupersededValue[];
  /** Each `own` link with no content anywhere (neither live nor held). The node is already gone, so only the link is
   *  not written; the caller reports it, as § 10.2's drift check does: WARN, never write, and never refuse the save. */
  danglingOwn: { key: RowKey; guid: string }[];
}

interface Report {
  superseded: SupersededValue[];
  danglingOwn: { key: RowKey; guid: string }[];
}

/**
 * The scene v20 entry for a stored instance root (design § 2.2, § 3.4).
 *
 * - **Placement** (parent, sortOrder, editorFolder, sourceScene) goes on the entry's own `traits.EntityAttributes`,
 *   where a plain entity keeps it. `sortOrder` is ALWAYS written: F7, the root always records its order (Unity's
 *   `m_RootOrder`). `editorFolder` and `sourceScene` only when non-empty (`''` is absent). `sourceScene` holds only what
 *   the file stated, never the load-time stamp that marks a base scene's entities (design § 10.4b).
 * - **The root's name** is a default override (hub ruling 2026-10-02, rule 1 + U10b): ALWAYS written, on the `"/"`
 *   row's `traits.EntityAttributes.name`. Its in-memory home is `placement.name` alone (`Placement`), so it wins over
 *   anything the `"/"` row holds. The entry-level `name` repeats it for a readable file; nothing reads it.
 * - **Rows** come from the list, plus a pin row for every present member (`identity`). The root is not a member: its
 *   identity is `entry.guid` (`rootGuid`), never a `"/"` pin.
 */
export function serializeInstanceRecord(rec: InstanceRecord, ctx: SerializeContext): SerializedInstance {
  const ea: Record<string, unknown> = {};
  if (rec.placement.parent) ea.parentId = rec.placement.parent;
  ea.sortOrder = rec.placement.sortOrder;
  if (rec.placement.editorFolder) ea.editorFolder = rec.placement.editorFolder;
  if (rec.placement.sourceScene) ea.sourceScene = rec.placement.sourceScene;

  const report: Report = { superseded: [], danglingOwn: [] };
  const members: Record<RowKey, SceneMemberRow> = {};
  for (const key of sceneRowKeys(rec, ctx.identity)) {
    const row = sceneRow(rec, ctx, key, report);
    if (row) members[key] = row;
  }

  const entry: InstanceEntryJson = {
    name: rec.placement.name,
    traits: { EntityAttributes: ea },
    prefab: rec.source,
    guid: rec.rootGuid,
    members,
  };
  putHeld(entry as Record<string, unknown>, rec.held, [], report.superseded);
  // Rows in key order, as today's row writer writes them (`moveChannelsOntoRows`), held rows included.
  if (isPlainObject(entry.members)) entry.members = sortedByKey(entry.members) as Record<RowKey, SceneMemberRow>;
  return { entry, ...report };
}

/**
 * What a prefab v10 reference row states about its nested instance: its list in TEMPLATE form as `members` (design
 * § 2.2), plus what the parse could not name or interpret (`list.held`), written back verbatim. The caller (S6's
 * document writer) puts `fields` on the row beside the row's own identity and traits; a held value whose channel the
 * row's own fields also state is the caller's to report.
 *
 * - No identity pins (I8): a template that carried member guids would hand every instance the same ones.
 * - The `"/"` row holds the nested root's `name` and `sortOrder` as records (§ 10.4: one home each).
 * - Added nodes are stored in the row itself, keyed by their template key; a template reference node's own list, and
 *   its own held values, are written the same way, recursively.
 */
export function serializeTemplateOwner(list: TemplateOverrideList): { fields: Record<string, unknown>; superseded: SupersededValue[] } {
  const superseded: SupersededValue[] = [];
  const fields: Record<string, unknown> = { members: templateMembers(list.rows, ['members'], superseded) };
  if (list.held) putHeld(fields, list.held, [], superseded);
  // A held row can add a key: rows in key order, as the scene form writes them.
  if (isPlainObject(fields.members)) fields.members = sortedByKey(fields.members);
  return { fields, superseded };
}

/**
 * A prefab document's own held values (`parseTemplateLists(doc).docHeld`): v4 document-level `moved` entries that name
 * no nested member, which belong to no row's list. S6's document writer spreads the result onto the document, verbatim
 * (design § 10.4b).
 */
export function serializeTemplateDocHeld(docHeld: { moved?: Record<string, string>; unparsed?: { moved: unknown } } | undefined): { moved?: Record<string, string> } {
  // A `moved` that is not a record at all is held whole (`unparsed`), and written back byte-for-byte as the file had it
  // — the document type describes a well-formed file, which this one was not.
  if (docHeld?.unparsed) return { moved: docHeld.unparsed.moved as Record<string, string> };
  return docHeld?.moved && Object.keys(docHeld.moved).length ? { moved: { ...docHeld.moved } } : {};
}

// ── Scene form ──────────────────────────────────────────────────────────────────────────────────────────

/** Every key the entry writes: the root row (its name is always written), each list row, each present member's pin
 *  row, and each anchor holding a node the projection could not place. The caller sorts the written rows. */
function sceneRowKeys(rec: InstanceRecord, identity: MemberIdentity): RowKey[] {
  const keys = new Set<RowKey>([ROOT_ROW_KEY, ...rec.list.rows.keys(), ...identity.keys()]);
  for (const key of rec.held.heldOwn?.keys() ?? []) keys.add(key);
  return [...keys];
}

function sceneRow(rec: InstanceRecord, ctx: SerializeContext, key: RowKey, report: Report): SceneMemberRow | undefined {
  const r = rec.list.rows.get(key);
  const id = key === ROOT_ROW_KEY ? undefined : ctx.identity.get(key);
  const row: SceneMemberRow = {};
  // Pins (rule 5): every parsed pin is kept verbatim, including a gone member's (§ 10.4, review L2); the projection's
  // identity fills only a pin the list does not hold.
  const guid = r?.guid ?? id?.guid;
  if (guid !== undefined) row.guid = guid;
  const name = r?.name ?? id?.name;
  if (name !== undefined) row.name = name;
  if (r?.parent !== undefined) row.parent = r.parent;

  let traits = r?.traits ? cloneTraits(r.traits) : undefined;
  if (key === ROOT_ROW_KEY) {
    // The root's name: the default override, always stated, first in its trait (`Placement.name`, its one home).
    const { name: shadowed, ...rest } = (traits?.EntityAttributes === true ? {} : traits?.EntityAttributes) ?? {};
    if (shadowed !== undefined) {
      report.superseded.push({ path: ['members', ROOT_ROW_KEY, 'traits', 'EntityAttributes', 'name'], value: shadowed });
    }
    traits = { ...traits, EntityAttributes: { name: rec.placement.name, ...rest } };
  }
  if (traits) row.traits = traits as SceneMemberRow['traits'];
  if (r?.traitRemovals) row.traitRemovals = { ...r.traitRemovals };
  if (r?.removed !== undefined) row.removed = r.removed;
  const own = ownNodes(rec, ctx, key, r, report);
  if (own) row.own = own;
  return Object.keys(row).length ? row : undefined;
}

/** A row's scene-owned nodes, in authored order: each link's content, live or held; then any node held under this
 *  anchor that no link names. Anchored by the row, so `parentLocalId` is 0 (`ownForm`, today's row writer). A link
 *  with no content anywhere is reported and not written (`SerializedInstance.danglingOwn`). */
function ownNodes(
  rec: InstanceRecord, ctx: SerializeContext, key: RowKey, r: SceneTargetRecord | undefined, report: Report,
): AddedEntity[] | undefined {
  const held = rec.held.heldOwn?.get(key) ?? [];
  if (!r?.own && !held.length) return undefined;
  const out: AddedEntity[] = [];
  const written = new Set<string>();
  for (const { guid } of r?.own ?? []) {
    const node = ctx.sceneOwned(guid) ?? held.find((n) => n.guid === guid);
    if (!node) {
      report.danglingOwn.push({ key, guid });
      continue;
    }
    out.push({ ...structuredClone(node), parentLocalId: 0 });
    written.add(guid);
  }
  for (const node of held) if (!written.has(node.guid)) out.push({ ...structuredClone(node), parentLocalId: 0 });
  return out;
}

// ── Template form ───────────────────────────────────────────────────────────────────────────────────────

/** A template list's rows as `members`: sorted by key, empty rows not written. */
function templateMembers(rows: ReadonlyMap<RowKey, TemplateTargetRecord>, at: string[], superseded: SupersededValue[]): Record<RowKey, TemplateRowJson> {
  const out: Record<RowKey, TemplateRowJson> = {};
  for (const key of [...rows.keys()].sort()) {
    const row = templateRow(rows.get(key)!, [...at, key], superseded);
    if (row) out[key] = row;
  }
  return out;
}

function templateRow(r: TemplateTargetRecord, at: string[], superseded: SupersededValue[]): TemplateRowJson | undefined {
  const row: TemplateRowJson = {};
  if (r.parent !== undefined) row.parent = r.parent;
  if (r.traits) row.traits = cloneTraits(r.traits);
  if (r.traitRemovals) row.traitRemovals = { ...r.traitRemovals };
  if (r.removed !== undefined) row.removed = r.removed;
  if (r.own) row.own = r.own.map((n, i) => templateNode(n, [...at, 'own', String(i)], superseded));
  return Object.keys(row).length ? row : undefined;
}

function templateNode(n: TemplateAddedNode, at: string[], superseded: SupersededValue[]): TemplateNodeJson {
  const node: TemplateNodeJson = {
    parentLocalId: 0,
    guid: '',
    key: n.key,
    name: n.name,
    traits: cloneTraits(n.traits),
    children: n.children.map((c, i) => templateNode(c, [...at, 'children', String(i)], superseded)),
  };
  if (n.prefab !== undefined) node.prefab = n.prefab;
  if (n.members) node.members = templateMembers(new Map(Object.entries(n.members)), [...at, 'members'], superseded);
  // A template reference node is an owner too: what its parse could not name or interpret goes back on the node.
  if (n.held) putHeld(node as unknown as Record<string, unknown>, n.held, at, superseded);
  if (isPlainObject(node.members)) node.members = sortedByKey(node.members) as Record<RowKey, TemplateRowJson>;
  return node;
}

// ── Shared ──────────────────────────────────────────────────────────────────────────────────────────────

/** A copy the caller may mutate without reaching into the record. Trait and field order are the record's own. */
function cloneTraits(traits: RecordTraits): RecordTraits {
  return structuredClone(traits);
}

/** An owner's held values back into what the writer states for it: `pendingLegacy` first, then `unparsed`. Each goes
 *  where the written form states nothing (today's `restoreMalformed` rule, owner ruling F-CB1(a)); where it does state
 *  something, a later record superseded the value, and the caller reports it. */
function putHeld(target: Record<string, unknown>, held: TemplateHeldData, at: string[], superseded: SupersededValue[]): void {
  if (held.pendingLegacy) putBack(target, held.pendingLegacy, at, superseded);
  if (held.unparsed) putBack(target, held.unparsed, at, superseded);
}

/** Put each `held` value into `target` where `target` states nothing at its place, recursing into plain objects both
 *  sides hold. Where `target` states something else, the target wins and the held value is reported. `target` is
 *  mutated. */
function putBack(
  target: Record<string, unknown>, held: object, at: string[], superseded: SupersededValue[],
): void {
  for (const [k, v] of Object.entries(held)) {
    if (v === undefined) continue;
    const path = [...at, k];
    if (!Object.prototype.hasOwnProperty.call(target, k)) {
      target[k] = structuredClone(v);
    } else if (isPlainObject(target[k]) && isPlainObject(v)) {
      putBack(target[k] as Record<string, unknown>, v, path, superseded);
    } else {
      superseded.push({ path, value: structuredClone(v) });
    }
  }
}

function sortedByKey(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
