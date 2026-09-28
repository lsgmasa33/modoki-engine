/** prefabOverrides — the PURE half of prefab-instance composition: override-map merging and the
 *  effective traits of a prefab MEMBER (its root, or any row), with no koota, no trait registry and
 *  no cache import.
 *
 *  It is a module of its own because several readers need one answer to "what would this member of a
 *  spawned instance actually carry?" and cannot share a file:
 *  - the spawner, `loadSceneFile.ts` `instantiatePrefabIntoWorld`, which BUILDS the instance; and
 *  - `sceneValidation.ts`, which runs inside the Node Vite plugin where no trait is registered, and
 *    which `loadSceneFile.ts` itself imports — so it can import neither that file nor anything that
 *    calls `trait({...})` at import time.
 *
 *  Before #1031 the validator and `entryPrefabProvider` each read a prefab ROW's own `traits`. For a
 *  row that is a nested-instance reference (`prefab: <guid>`) that row carries almost nothing: the
 *  entity it produces is the CHILD prefab's root plus the row's overrides. The functions below compose
 *  it with the same helpers and in the same order the spawner does, so the validator, the pool and the
 *  spawned entity describe the same thing.
 *
 *  `loadSceneFile.ts` re-exports the three override helpers, so their existing importers
 *  (`editor/scene/prefab.ts`, `editor/scene/serialize.ts`) are unchanged. */
import { emptyDocMap } from '../core/docKeys';
import { nodeRowKey } from '../core/assetRefRules';
import { docRows } from './memberTranslation';

/** localId → trait name → field → value. */
export type OverrideMap = Record<number, Record<string, Record<string, unknown>>>;

/** Deep-merge two per-localId override maps (localId → trait → field → value).
 *  `b` wins on conflicts. Used to overlay a scene's nested-instance overrides on
 *  top of a prefab row's own overrides. Neither input is mutated. */
export function mergeOverrideMaps(
  a: Record<number, Record<string, Record<string, unknown>>> | undefined,
  b: Record<number, Record<string, Record<string, unknown>>>,
): Record<number, Record<string, Record<string, unknown>>> {
  // ⚠️ The OUTER bag is keyed by localId (a number — safe). The INNER bags are keyed by TRAIT
  // NAME read verbatim out of scene/prefab JSON, so they are `emptyDocMap()` (#986): a trait
  // named `__proto__` would otherwise hit the setter and vanish, and the `out[k][t] ?? {}` read
  // below would hand `Object.prototype`'s own members back as if they were authored overrides.
  // Making the bag null-prototyped fixes BOTH the write and that read, in place.
  const out: Record<number, Record<string, Record<string, unknown>>> = {};
  for (const [lid, traits] of Object.entries(a ?? {})) {
    out[Number(lid)] = emptyDocMap();
    for (const [t, fields] of Object.entries(traits)) out[Number(lid)][t] = { ...fields };
  }
  for (const [lid, traits] of Object.entries(b)) {
    const k = Number(lid);
    out[k] ??= emptyDocMap();
    for (const [t, fields] of Object.entries(traits)) out[k][t] = { ...(out[k][t] ?? {}), ...fields };
  }
  return out;
}

/** Path-keyed nested overrides — lets an OUTER layer (scene or ancestor prefab)
 *  override a member nested at ANY depth, with the outermost layer winning. Each
 *  key is a dot-joined chain of nested-prefab row localIds from the addressing
 *  instance down to the target instance; the value is that target instance's
 *  per-localId override map. `"3"` overrides the instance at row 3; `"3.5"` reaches
 *  the instance at row 5 nested inside it. A single-segment key is the legacy
 *  one-level form, so older scene files remain valid unchanged. */
export type NestedOverridePaths = Record<string, Record<number, Record<string, Record<string, unknown>>>>;

/** Build the key addressing a nested instance from a chain of nested-prefab row localIds,
 *  outermost first — `[3]` → `"3"`, `[3, 5]` → `"3.5"`.
 *
 *  ⚠️ This is the ONLY place the path grammar is written. It used to be a bare `join('.')` at the
 *  one save site with `descendPathKeyed`'s `startsWith` as the only reader, i.e. two independent
 *  implementations of one format; #1358 added a second path-keyed slot beside the overrides, which
 *  would have made a third. A writer and a reader that disagree here mis-address an override or a
 *  structural edit to the wrong depth, which reads as the edit being silently dropped. */
export function nestedPathKey(path: readonly number[]): string {
  return path.join('.');
}

/** Split ANY path-keyed map at one expansion step (nested row `rowLocalId`): `direct` is the value
 *  addressed at that child instance itself (the exact key `rowLocalId`); `forward` re-keys every
 *  deeper path (`rowLocalId.…`) with the leading segment stripped, to thread into the child's own
 *  expansion.
 *
 *  Generic over the payload so the value overrides (`NestedOverridePaths`) and the structural slot
 *  (`NestedStructurePaths`, #1358) descend by exactly the same rule — see `nestedPathKey`. */
export function descendPathKeyed<T>(
  paths: Record<string, T> | undefined,
  rowLocalId: number,
): { direct?: T; forward?: Record<string, T> } {
  if (!paths) return {};
  const prefix = String(rowLocalId);
  let direct: T | undefined;
  let forward: Record<string, T> | undefined;
  for (const [key, map] of Object.entries(paths)) {
    if (key === prefix) direct = map;
    // `emptyDocMap()` (#986): the key is a dot-joined localId chain taken from the file, so a
    // crafted `"3.__proto__"` would assign through the setter and lose the map silently.
    else if (key.startsWith(prefix + '.')) (forward ??= emptyDocMap() as Record<string, T>)[key.slice(prefix.length + 1)] = map;
  }
  return { direct, forward };
}

/** Split path-keyed overrides at one expansion step — `descendPathKeyed` at the override payload. */
export function descendNestedOverrides(
  paths: NestedOverridePaths | undefined,
  rowLocalId: number,
): { direct?: Record<number, Record<string, Record<string, unknown>>>; forward?: NestedOverridePaths } {
  return descendPathKeyed(paths, rowLocalId);
}

/** Merge two path-keyed override maps; `b` (the outer layer) wins per field. Used
 *  to overlay forwarded outer overrides on a prefab row's own deep overrides so the
 *  outermost layer wins at every depth. Neither input is mutated. */
export function mergeNestedOverridePaths(
  a: NestedOverridePaths | undefined,
  b: NestedOverridePaths | undefined,
): NestedOverridePaths | undefined {
  if (!a) return b;
  if (!b) return a;
  // `emptyDocMap()` (#986). Both halves matter here: the writes are document-keyed, and the
  // `out[k] ?` on the next line is a READ — against a plain object it is truthy for `toString`,
  // which would pass `Object.prototype.toString` (a FUNCTION) into mergeOverrideMaps as an
  // override map for it to `Object.entries`-walk.
  const out: NestedOverridePaths = emptyDocMap();
  for (const [k, m] of Object.entries(a)) out[k] = m;
  for (const [k, m] of Object.entries(b)) out[k] = out[k] ? mergeOverrideMaps(out[k], m) : m;
  return out;
}

/** Merge two path-keyed STRUCTURE maps (`NestedStructurePaths`, #1381); `outer` wins per PATH, and
 *  wins WHOLE — never element-wise. A layer that addresses a path owns that instance's interior (all
 *  three lists, see the loader's `structDirect`), so merging two `removed` arrays would make an
 *  un-delete by the outer layer unrepresentable. Used where a prefab ROW's own `nestedStructure`
 *  meets the structure an outer layer forwarded into the same expansion. Neither input is mutated.
 *
 *  Generic over the payload only because `NestedStructurePaths` is declared in loadSceneFile.ts,
 *  which imports this module. */
export function mergeNestedStructurePaths<T>(
  inner: Record<string, T> | undefined,
  outer: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!inner) return outer;
  if (!outer) return inner;
  // `emptyDocMap()` (#986): the keys are path strings read out of a file.
  const out = emptyDocMap() as Record<string, T>;
  for (const [k, v] of Object.entries(inner)) out[k] = v;
  for (const [k, v] of Object.entries(outer)) out[k] = v;
  return out;
}

/** The channel fields of a scene member row (`SceneMemberRow`, scene v16) — the part
 *  {@link foldMemberRowChannels} reads. Generic over the added-node type for the reason
 *  `mergeNestedStructurePaths` is: the concrete types live in loadSceneFile.ts, which imports this. */
export interface MemberRowChannels<A> {
  traits?: Record<string, Record<string, unknown>>;
  removedTraits?: string[];
  removed?: boolean;
  added?: A[];
  /** v17 (#1516): nodes the SCENE added under this member, APPENDED after what the lower layer puts
   *  there — where `added` replaces it. What lets a scene add a node beside a template's without
   *  restating (and so pinning) the template's. */
  own?: A[];
  /** v17 (#1516): per-trait removal statements, merged over `removedTraits` (or, absent that, the lower
   *  layer's list): `true` removes the trait, `false` restores one a lower layer removed. Where
   *  `removedTraits` states the whole list, and so pinned every name the chain removed beside the scene's. */
  traitRemovals?: Record<string, boolean>;
}

/** The node shape {@link applyNodeRows} reads — the part of `AddedEntity` it touches. Generic for the
 *  reason `MemberRowChannels` is. */
export interface KeyedNode<A> {
  key?: string;
  prefab?: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  children: A[];
}

/** Apply NODE ROWS to a frame's template-added nodes (#1516, scene v17) — the field-level twin of what a
 *  member row does for a member. `rows` maps a template key to that node's row; every node carrying a key
 *  in it, at any depth of `children`, gets:
 *  - `removed: true` — dropped, with its subtree;
 *  - `traits` — merged field by field over the node's own bag, the row winning (a trait the node lacks is
 *    ADDED, which is how a scene adds a component to a template node);
 *  - `traitRemovals` — a `true` name is deleted from the bag. `false` has nothing to restore on a plain
 *    node (its bag IS its traits) and is ignored;
 *  - `own` — the scene's own children, appended after the template's.
 *  A REFERENCE node (`prefab`) takes only `removed`: its interior is a frame of its own, and the writer
 *  never states field edits against one (it falls back to restating the member's list).
 *
 *  Returns the new list and the keys that found a node, so a caller can report the rest as orphans — a
 *  row the template no longer backs (#1516 fork 2: the node vanishes, the row is kept and warned, and a
 *  template that brings the node back brings the edit back with it). Inputs are never mutated. */
export function applyNodeRows<A extends KeyedNode<A>>(
  nodes: readonly A[] | undefined,
  rows: ReadonlyMap<string, MemberRowChannels<A>>,
  hit: Set<string> = new Set(),
): { nodes: A[] | undefined; hit: Set<string> } {
  if (!nodes || !rows.size) return { nodes: nodes as A[] | undefined, hit };
  const walk = (list: readonly A[]): A[] => {
    const out: A[] = [];
    for (const node of list) {
      const row = node.key ? rows.get(node.key) : undefined;
      if (row) hit.add(node.key!);
      if (row?.removed === true) continue;
      const children = node.children?.length ? walk(node.children) : node.children;
      if (!row || node.prefab) { out.push(children === node.children ? node : { ...node, children }); continue; }
      const traits: Record<string, Record<string, unknown> | boolean> = emptyDocMap();
      for (const [t, v] of Object.entries(node.traits ?? {})) traits[t] = v;
      if (isRecord(row.traits)) {
        for (const [t, fields] of Object.entries(row.traits)) {
          if (!isRecord(fields)) continue;
          const cur = traits[t];
          traits[t] = { ...(isRecord(cur) ? cur : {}), ...fields };
        }
      }
      if (isRecord(row.traitRemovals)) for (const [t, v] of Object.entries(row.traitRemovals)) if (v === true) delete traits[t];
      const own = Array.isArray(row.own) ? row.own : [];
      out.push({ ...node, traits, children: [...(children ?? []), ...own] });
    }
    return out;
  };
  return { nodes: walk(nodes), hit };
}

/** Merge per-trait removal statements (`traitRemovals`) over a removal list. */
export function mergeTraitRemovals(list: readonly string[] | undefined, statements: Record<string, boolean>): string[] {
  const out = new Set(list ?? []);
  for (const [t, v] of Object.entries(statements)) {
    if (v === true) out.add(t);
    else if (v === false) out.delete(t);
  }
  return [...out];
}

/** The localId-keyed channels of ONE instance frame, as the spawner applies them. */
export interface FrameChannels<A> {
  overrides?: OverrideMap;
  added?: A[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
}

/** Fold a frame's MEMBER ROWS onto its localId-keyed channels (#1468 Phase 4) — the one place a row's
 *  identity is translated back into the document's own address space, so everything downstream (the
 *  override apply, `applyStructureCore`) keeps working on localIds that are right for THIS document.
 *
 *  A localId is only meaningful together with the document it was read from, and a template renumbers
 *  them (#1468 design record, the root cause). A row names its member by the minted `nodeGuid` instead, and this translates it
 *  against `doc` — the frame's CURRENT document — at the moment it is applied. That is the whole fix:
 *  an edit stored against identity lands on the same member however the template was renumbered since.
 *
 *  **Per member, per channel: a field that is PRESENT replaces the lower layer's value for that member;
 *  an absent one leaves it.** `lower` is what the file's legacy channels (and, in a nested frame, the
 *  prefab rows above it) already say. `traits` merges field by field, row winning — the rule
 *  `nestedOverrides` has over a prefab row's own `overrides`. `removed: false` takes a member OUT of the
 *  lower layer's removals, which is how a scene un-deletes a member an outer PREFAB layer deleted;
 *  `removedTraits: []` and `added: []` are the same statement for their channels.
 *
 *  Only this frame's DIRECT rows are read (a key of one component); deeper keys belong to nested frames
 *  and are handed down by `descendMemberRows`. A direct row naming a NESTED ROW of `doc` (an owned
 *  nested instance's root) keeps only `removed` here — deleting the whole instance is this frame's
 *  business — and is returned in `forwardRoot` for the recursion to fold as that frame's `rootRow`,
 *  because its overrides, removed traits and added children must merge UNDER the nested expansion's own
 *  lower layer, which an application after the recursion could not do (it cannot un-spawn an addition).
 *
 *  A row whose component names no row of `doc` is skipped: that is R2's orphan, reported elsewhere.
 *
 *  v17 (#1516) adds two things. A member row's `own` APPENDS the scene's nodes and its `traitRemovals`
 *  edits the removal list per trait, where `added`/`removedTraits` replace. And a direct key `/a+<key>`
 *  is a NODE row, for the template-added node carrying that key — applied last by {@link applyNodeRows}.
 *  Inputs are never mutated — `lower` routinely aliases the prefab cache. */
export function foldMemberRowChannels<A extends { parentLocalId: number }>(
  doc: { entities?: readonly { localId?: number; nodeGuid?: string; prefab?: string }[]; rootLocalId?: number },
  rows: Record<string, MemberRowChannels<A>> | undefined,
  lower: FrameChannels<A>,
  rootRow?: MemberRowChannels<A>,
): FrameChannels<A> & { forwardRoot?: Map<number, MemberRowChannels<A>> } {
  const direct: [string, MemberRowChannels<A>][] = [];
  const nodeRows = new Map<string, MemberRowChannels<A>>();
  for (const [key, row] of Object.entries(rows ?? {})) {
    // One component: `/<nodeGuid>`, or `/a+<key>` for a template-added node (#1516). Neither holds a `/`,
    // so a second one means a deeper frame.
    if (!(key.length > 1 && key[0] === '/' && key.indexOf('/', 1) < 0 && isRecord(row))) continue;
    const nodeKey = nodeRowKey(key.slice(1));
    if (nodeKey) nodeRows.set(nodeKey, row);
    else direct.push([key.slice(1), row]);
  }
  if (!direct.length && !rootRow && !nodeRows.size) return lower;

  const rootLocalId = doc.rootLocalId ?? 1;
  // The frame's CURRENT document answers which row each component names (#1771, `memberTranslation.ts`).
  const byGuid = docRows(doc);

  let overrides = lower.overrides;
  let added = lower.added;
  const removed = new Set(lower.removed ?? []);
  let removedTraits = lower.removedTraits;
  let forwardRoot: Map<number, MemberRowChannels<A>> | undefined;

  const apply = (lid: number, row: MemberRowChannels<A>, nested: boolean): void => {
    if (typeof row.removed === 'boolean') {
      if (row.removed) removed.add(lid);
      else removed.delete(lid);
    }
    if (nested) {
      if (row.traits || row.removedTraits || row.added || row.own || row.traitRemovals) (forwardRoot ??= new Map()).set(lid, row);
      return;
    }
    if (isRecord(row.traits)) overrides = mergeOverrideMaps(overrides, { [lid]: row.traits });
    const statements = isRecord(row.traitRemovals) ? row.traitRemovals as Record<string, boolean> : undefined;
    if (Array.isArray(row.removedTraits) || statements) {
      // `removedTraits` states the whole list (v16); `traitRemovals` then edits it, or the lower layer's.
      const base = Array.isArray(row.removedTraits) ? row.removedTraits : removedTraits?.[lid];
      const list = statements ? mergeTraitRemovals(base, statements) : [...base!];
      const next: Record<number, string[]> = { ...(removedTraits ?? {}) };
      if (list.length) next[lid] = list;
      else delete next[lid];
      removedTraits = next;
    }
    if (Array.isArray(row.added)) {
      added = [...(added ?? []).filter((n) => n.parentLocalId !== lid), ...row.added.map((n) => ({ ...n, parentLocalId: lid }))];
    }
    if (Array.isArray(row.own) && row.own.length) {
      added = [...(added ?? []), ...row.own.map((n) => ({ ...n, parentLocalId: lid }))];
    }
  };

  // The forwarded root row's `removed` is the OUTER frame's to apply — it deletes this whole instance —
  // so only its interior channels land at this frame's root. ⚠️ NOT a falsifiable guard (close-out
  // review): applied here too, the recursion deletes its own root and the outer frame deletes it again,
  // with no observable difference. Kept because it states where each half of the row belongs.
  if (rootRow) apply(rootLocalId, { ...rootRow, removed: undefined }, false);
  for (const [component, row] of direct) {
    const at = byGuid.get(component);
    if (at) apply(at.localId, row, at.nested);
  }
  // Node rows LAST, over whatever the member rows left: a member's `added: []` (v16) or removal takes its
  // template nodes with it. A row naming no node applies nowhere; R2 reports and keeps it
  // (`applyStoredMemberRows`), since only the whole template can say the node is gone — for a stored
  // root by its guid, for a template reference node by the guid its root derives (`keepTemplateNodeOrphans`, #1542).
  if (nodeRows.size) added = applyNodeRows(added as unknown as KeyedNode<never>[] | undefined, nodeRows as never).nodes as unknown as A[] | undefined;
  return {
    overrides, added, removedTraits,
    removed: [...removed].sort((a, b) => a - b),
    ...(forwardRoot ? { forwardRoot } : {}),
  };
}

/** One frame down a member-row map (`/<component>/…` → `/…`): the rows the nested row whose identity
 *  is `component` hands its own expansion. A row key is a chain of minted identities, one per frame, so
 *  descending one frame is dropping the leading component. */
export function descendMemberRowKeys<R>(rows: Record<string, R> | undefined, component: string): Record<string, R> | undefined {
  if (!rows || !component) return undefined;
  const prefix = `/${component}/`;
  let out: Record<string, R> | undefined;
  for (const [key, row] of Object.entries(rows)) {
    if (key.startsWith(prefix)) (out ??= emptyDocMap() as Record<string, R>)[key.slice(prefix.length - 1)] = row;
  }
  return out;
}

/** One structural LAYER over an instance frame (#1533): what one document says about the frame's
 *  structure — a scene entry or reference node (the outermost), or a prefab nested ROW on the way
 *  down. Everything is keyed from the frame it is handed to.
 *
 *  A layer is kept SEPARATE rather than merged into its neighbours, because its channels do not
 *  commute: a row's `added` states a member's whole list, which already holds what the layers below
 *  added through `own`, so merging two layers' rows key by key would spawn those nodes twice. So
 *  layers fold ONE AFTER ANOTHER, inner first ({@link foldStructureLayers}).
 *
 *  Before #1533 there was one row layer (the scene's) and the path-keyed slots of every layer were
 *  merged, outer winning per path. A prefab row's `members` makes a second row layer, and that is what
 *  forces the slots apart too: a slot owns its frame's interior WHOLE and was captured from a live
 *  interior that already showed every layer inside it, so the rows of an inner layer must not fold
 *  again over an outer slot — which a merged slot map cannot tell apart from the row's own slot. */
export interface StructureLayer<D, R> {
  /** Path-keyed whole-frame slots for this frame's nested descendants (`nestedStructure`). */
  slots?: Record<string, D>;
  /** Member rows keyed from this frame (`members`): direct keys fold here, deeper ones descend. */
  rows?: Record<string, R>;
  /** What this layer's row in the frame ABOVE says about this frame's root (`forwardRoot`). */
  rootRow?: R;
}

/** The layers reaching the expansion of nested row `row`, innermost first — the row's own layer (its
 *  `nestedStructure` and `members`, over its own lists), then each of `layers` descended one frame.
 *  `forwardRoots[i]` is what folding `layers[i]` at the current frame forwarded to nested roots.
 *
 *  `direct` is the whole-frame slot the OUTERMOST layer addressing this row states for its expansion,
 *  and `foldFrom` the index (into the returned `layers`) of the first layer whose direct rows still
 *  apply there. A slot owns the three lists, so the layers inside it are replaced — their rows at this
 *  frame were captured into the slot, and folding them again would re-apply it (re-delete what the slot
 *  un-deleted, append a node the slot already holds). What they say about the frames BELOW still
 *  applies — their deeper rows, and a nested root's row, whose interior half is forwarded
 *  ({@link foldStructureLayers}) — because a slot owns one frame, not the frames nested under it. */
export function descendStructureLayers<D, R>(
  layers: readonly StructureLayer<D, R>[],
  row: { localId?: number; nodeGuid?: string; nestedStructure?: Record<string, D>; members?: Record<string, R> },
  forwardRoots: readonly (ReadonlyMap<number, R> | undefined)[] = [],
): { layers: StructureLayer<D, R>[]; direct?: D; foldFrom: number } {
  const lid = row.localId ?? 0;
  const out: StructureLayer<D, R>[] = [{ slots: row.nestedStructure, rows: row.members }];
  let direct: D | undefined;
  let foldFrom = 0;
  layers.forEach((layer, i) => {
    const { direct: d, forward } = descendPathKeyed(layer.slots, lid);
    if (d) { direct = d; foldFrom = i + 1; }
    out.push({ slots: forward, rows: descendMemberRowKeys(layer.rows, row.nodeGuid ?? ''), rootRow: forwardRoots[i]?.get(lid) });
  });
  return { layers: out, direct, foldFrom };
}

/** Fold the direct rows of `layers[foldFrom..]` over a frame's lists, one layer after another
 *  ({@link foldMemberRowChannels} per layer — see {@link StructureLayer} for why not merged). Returns
 *  the folded channels (`lower` itself when no layer changed anything) and, per layer index, what that
 *  layer forwarded to the frame's nested roots. */
export function foldStructureLayers<A extends { parentLocalId: number }>(
  doc: Parameters<typeof foldMemberRowChannels<A>>[0],
  layers: readonly StructureLayer<unknown, MemberRowChannels<A>>[],
  foldFrom: number,
  lower: FrameChannels<A>,
): { channels: FrameChannels<A>; forwardRoots: (Map<number, MemberRowChannels<A>> | undefined)[] } {
  let channels: FrameChannels<A> = lower;
  const forwardRoots: (Map<number, MemberRowChannels<A>> | undefined)[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    // A layer inside the slot still FORWARDS: what its row states about a nested root's interior (`own`,
    // `traitRemovals`…) belongs to the frame below, which the slot does not own. Only its statements about
    // THIS frame are replaced — the nested root's `removed` included, which `forwardRoot` never carries.
    if (i < foldFrom) {
      if (layer.rows) forwardRoots[i] = foldMemberRowChannels(doc, layer.rows, {}).forwardRoot;
      continue;
    }
    if (!layer.rows && !layer.rootRow) continue;
    const r = foldMemberRowChannels(doc, layer.rows, channels, layer.rootRow);
    forwardRoots[i] = r.forwardRoot;
    if (r !== channels) channels = { overrides: r.overrides, added: r.added, removed: r.removed, removedTraits: r.removedTraits };
  }
  return { channels, forwardRoots };
}

/** The lists a whole-frame slot (`nestedStructure[path]`) states — the part the fold reads. */
export interface SlotLists<A> {
  added?: A[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  moved?: Record<number, string>;
}

/** A document ROW, as the path fold reads it: a plain member, or a nested row with its channels. */
export interface FoldRow<A, D, R> {
  localId?: number;
  nodeGuid?: string;
  prefab?: string;
  overrides?: OverrideMap;
  nestedOverrides?: NestedOverridePaths;
  added?: A[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  nestedStructure?: Record<string, D>;
  members?: Record<string, R>;
}

/** A prefab document, as the path fold reads it. */
export interface FoldDoc<A, D, R> {
  entities: readonly FoldRow<A, D, R>[];
  rootLocalId?: number;
}

/** What the layers above a frame FORWARD into its expansion: the pending path-keyed field overrides, the structural
 *  layers reaching it, and what each of them forwarded to its nested roots. Applied at the frame's NESTED rows only:
 *  what the layers say of the frame's own members is the `channels` part {@link foldRowStep} returns beside it. */
export interface ForwardState<D, R> {
  nestedOverrides?: NestedOverridePaths;
  layers: StructureLayer<D, R>[];
  forwardRoots: readonly (ReadonlyMap<number, R> | undefined)[];
}

/** ONE nested row expanded (#1707, I1's expansion side): what the layers above a frame (`state`) and the nested row
 *  `row` itself put on the row's child frame, whose document is `child`. The spawner's order: the row's `overrides` under
 *  the outer layer's forwarded direct ones, the row's lists unless an outer slot owns the frame (then the slot's, an
 *  absent list read as empty, and the slot's `moved`), and then every layer's member rows folded over both, inner first.
 *  `forward` is what the child frame hands ITS nested rows; null without a child document.
 *
 *  The one statement of that step the pure readers share: the editor's effective base (`prefabBase.ts` `foldPath`), the
 *  validator and the UIEntries pool (`effectivePrefabMemberTraits`). The two spawners still state it themselves
 *  (`instantiatePrefabIntoWorld`, the editor's `instantiatePrefab`); a test pins the three against each other. */
export function foldRowStep<A extends { parentLocalId: number }, D extends SlotLists<A>, R extends MemberRowChannels<A>>(
  row: FoldRow<A, D, R>,
  state: ForwardState<D, R>,
  child: FoldDoc<A, D, R> | null,
): { channels: FrameChannels<A>; moved?: Record<number, string>; forward: ForwardState<D, R> | null } {
  const lid = row.localId ?? 0;
  const { direct, forward } = descendNestedOverrides(state.nestedOverrides, lid);
  const overrides = direct ? mergeOverrideMaps(row.overrides, direct) : row.overrides;
  const pending = mergeNestedOverridePaths(row.nestedOverrides, forward);
  const d = descendStructureLayers(state.layers, row, state.forwardRoots);
  // An outer layer addressing this path OWNS the interior — all three lists, absent read as empty (`structDirect`).
  const lower: FrameChannels<A> = d.direct
    ? { overrides, added: d.direct.added ?? [], removed: d.direct.removed ?? [], removedTraits: d.direct.removedTraits ?? {} }
    : { overrides, added: row.added, removed: row.removed, removedTraits: row.removedTraits };
  if (!child) return { channels: lower, ...(d.direct ? { moved: d.direct.moved ?? {} } : {}), forward: null };
  const folded = foldStructureLayers(child, d.layers as StructureLayer<unknown, MemberRowChannels<A>>[], d.foldFrom, lower);
  return {
    channels: folded.channels,
    ...(d.direct ? { moved: d.direct.moved ?? {} } : {}),
    forward: { nestedOverrides: pending, layers: d.layers, forwardRoots: folded.forwardRoots as ForwardState<D, R>['forwardRoots'] },
  };
}

/** {@link foldRowStep} down `path` (nested-row localIds, outermost first), from a first level whose document is
 *  `docs[0]`; `docs[i + 1]` is the document of the frame row `path[i]` expands. `seed` is what a layer above the first
 *  level forwards into it. Returns what the chain puts on the LAST frame: its members' field overrides, its structural
 *  lists (with `moved` when an outer slot owns it), and what it forwards to its own nested rows — null when a level is
 *  missing, and then the overrides and lists are empty. */
export function foldPath<A extends { parentLocalId: number }, D extends SlotLists<A>, R extends MemberRowChannels<A>>(
  docs: readonly (FoldDoc<A, D, R> | null)[],
  path: readonly number[],
  seed?: ForwardState<D, R>,
): { overrides: OverrideMap; structure: SlotLists<A>; forward: ForwardState<D, R> | null } {
  let state: ForwardState<D, R> = seed ?? { layers: [{}], forwardRoots: [] };
  if (!path.length) return { overrides: {}, structure: {}, forward: state };
  for (let i = 0; i < path.length; i++) {
    const row = docs[i]?.entities.find((e) => e.localId === path[i] && e.prefab);
    if (!row) break;
    const step = foldRowStep(row, state, docs[i + 1] ?? null);
    if (i === path.length - 1) {
      const { added, removed, removedTraits } = step.channels;
      return {
        overrides: step.channels.overrides ?? {},
        structure: { added, removed, removedTraits, ...(step.moved ? { moved: step.moved } : {}) },
        forward: step.forward,
      };
    }
    if (!step.forward) break;
    state = step.forward;
  }
  return { overrides: {}, structure: {}, forward: null };
}

/** Fold ONE trait's override fields onto its current values — the per-trait rule the spawner
 *  applies (`applyOverridesByLocalToEcs`) and `effectivePrefabMemberTraits` models, kept in one place
 *  so the two cannot disagree about precedence or about which fields count.
 *
 *  An accepted override field wins over the current value; a field `accept` refuses (the spawner's
 *  "genuinely renamed/stale field" case) is dropped and reported in `rejected`. `merged` is a new
 *  plain object; neither input is mutated. */
export function foldTraitOverride(
  current: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
  accept: (field: string) => boolean,
): { merged: Record<string, unknown>; accepted: string[]; rejected: string[] } {
  // `emptyDocMap()` (#986): field names come from a file. `merged` below is an object-literal
  // spread, which DEFINES properties rather than assigning them, so it carries them safely.
  const known: Record<string, unknown> = emptyDocMap();
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!accept(field)) { rejected.push(field); continue; }
    known[field] = value;
    accepted.push(field);
  }
  return { merged: { ...(current ?? {}), ...known }, accepted, rejected };
}

/** What a trait NAME is, as far as the caller knows. `undefined` means "a trait I do not know". */
export type TraitKind = 'component' | 'tag' | undefined;

export interface EffectiveMemberOptions {
  /** Which override fields count — the spawner accepts a field its trait PERSISTS
   *  (`isPersistentTraitField`). INJECTED rather than looked up, because this module must run where
   *  no trait registry exists. Omitted → every field is accepted. */
  acceptField?: (trait: string, field: string) => boolean;
  /** What kind of trait a name is. Needed because an override does more than set fields: the spawner
   *  ADDS a trait an override names but the member lacks — for a KNOWN trait, even when no field of
   *  the override is accepted (an empty or all-renamed override still adds it, at its defaults), a
   *  tag as a tag — and SKIPS a name it does not know. Omitted → every name is a known component. */
  traitKind?: (trait: string) => TraitKind;
  /** Per-localId overrides an OUTER layer applies to this prefab instance's own members. */
  overrides?: OverrideMap;
  /** Path-keyed overrides an outer layer applies to this instance's nested descendants. */
  nestedOverrides?: NestedOverridePaths;
  /** Per-localId component removals an outer layer applies to this instance. */
  removedTraits?: Record<number, string[]>;
  /** The outer layer's MEMBER ROWS, keyed from this instance's frame (`members`, #1468 / #1533): a direct row folds on
   *  its member here, a deeper one descends into the nested frame it names — as the spawner folds them (#1707). */
  members?: Record<string, unknown>;
  /** The outer layer's whole-frame slots for this instance's nested frames (`nestedStructure`): a slot OWNS its frame's
   *  structural lists, the row's own included (#1707). */
  nestedStructure?: Record<string, unknown>;
}

/** @deprecated-alias kept for the first caller's name; identical to `EffectiveMemberOptions`. */
export type EffectiveRootOptions = EffectiveMemberOptions;

/** Nesting deeper than this is refused. A backstop, not the cycle guard: the spawner's own guard
 *  keys on `prefab.id`, which a hand-written or test prefab may lack. */
const MAX_NEST_DEPTH = 64;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// The fold's types, instantiated for a document read off disk: nothing here knows the concrete node or row types.
type AnyNode = { parentLocalId: number };
type AnySlot = SlotLists<AnyNode>;
type AnyRow = MemberRowChannels<AnyNode>;
type AnyFoldRow = FoldRow<AnyNode, AnySlot, AnyRow>;
type AnyFoldDoc = FoldDoc<AnyNode, AnySlot, AnyRow>;

/** What the layers around a frame put on it: its own members' field overrides and component removals, and what they
 *  forward to its nested rows. */
interface FrameFold {
  overrides?: OverrideMap;
  removedTraits?: Record<number, string[]>;
  forward: ForwardState<AnySlot, AnyRow>;
}

/** A row read off disk, keeping only the channels in the shape the fold reads — a malformed one is dropped, as the
 *  spawner would fail to read it, so a hand-written file resolves to less rather than throwing. */
function foldRowOf(e: Record<string, unknown>): AnyFoldRow {
  const rec = <T>(v: unknown): T | undefined => (isRecord(v) ? v as T : undefined);
  const arr = <T>(v: unknown): T | undefined => (Array.isArray(v) ? v as T : undefined);
  return {
    localId: typeof e.localId === 'number' ? e.localId : undefined,
    nodeGuid: typeof e.nodeGuid === 'string' ? e.nodeGuid : undefined,
    prefab: typeof e.prefab === 'string' ? e.prefab : undefined,
    overrides: rec(e.overrides), nestedOverrides: rec(e.nestedOverrides), removedTraits: rec(e.removedTraits),
    added: arr(e.added), removed: arr(e.removed), nestedStructure: rec(e.nestedStructure), members: rec(e.members),
  };
}

/** The document the fold reads: its well-formed rows, in order. */
function foldDocOf(prefab: Record<string, unknown>): AnyFoldDoc {
  const entities = (prefab.entities as unknown[]).filter(isRecord).map(foldRowOf);
  return { entities, rootLocalId: typeof prefab.rootLocalId === 'number' ? prefab.rootLocalId : undefined };
}

/** The frame an instance of `doc` is, under the outer layer `opts` describes: the layer's direct member rows folded over
 *  its localId channels (a whole-frame slot is for the frames BELOW this one), and the layer forwarded to the nested rows
 *  — the spawner's top call (`instantiatePrefabIntoWorld`) and a reference node's (`spawnNestedInstance`). */
function topFrame(doc: AnyFoldDoc, opts: EffectiveMemberOptions): FrameFold {
  const slots = isRecord(opts.nestedStructure) ? opts.nestedStructure as Record<string, AnySlot> : undefined;
  const rows = isRecord(opts.members) ? opts.members as Record<string, AnyRow> : undefined;
  const layers: StructureLayer<AnySlot, AnyRow>[] = [{ slots, rows }];
  const lower = { overrides: opts.overrides, removedTraits: opts.removedTraits };
  const { channels, forwardRoots } = rows ? foldStructureLayers(doc, layers, 0, lower) : { channels: lower, forwardRoots: [] };
  return { overrides: channels.overrides, removedTraits: channels.removedTraits, forward: { nestedOverrides: opts.nestedOverrides, layers, forwardRoots } };
}

/** The trait bag an instance of `prefab` would carry on its ROOT entity — or `null` when no root
 *  entity would be produced at all. The root is `rootLocalId ?? 1`, the spawner's rule (NOT "the first
 *  row"). See `effectivePrefabMemberTraits` for how a member is composed. */
export function effectivePrefabRootTraits(
  prefab: unknown,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(prefab)) return null;
  return effectivePrefabMemberTraitsAt(prefab, [], (prefab.rootLocalId as number | undefined) ?? 1, getPrefab, opts);
}

/** The trait bag the member at `localId` of an instance of `prefab` would carry — composed from the
 *  prefab file(s) exactly the way `instantiatePrefabIntoWorld` builds it — or `null` when no entity
 *  would be produced for that localId.
 *
 *  Mirrors the spawner, step for step:
 *  1. **Which row:** the LAST row carrying `localId` (the spawner's `localToEcs.set` overwrites). No
 *     such row, or localId 0 → `null`.
 *  2. **A nested-instance row** (`prefab: <guid>`) produces the CHILD prefab's ROOT, composed under
 *     what the row and the layers around it put on the child frame — {@link foldRowStep}, the step the
 *     editor's effective base folds with (#1707): the row's `overrides` under the outer layer's forwarded
 *     ones, the row's `removedTraits` unless an outer whole-frame slot owns the frame, then every layer's
 *     member rows (`members`) over both. The row's own `traits` are NOT part of the result — the spawner
 *     reads only `parentId` there. A child that does not resolve (uncached, a cycle, too deep) → `null`,
 *     because the spawner maps no entity for the row either.
 *  3. **A plain row** starts from its own `traits`, minus any baked-in `PrefabInstance` (the spawner
 *     replaces it).
 *  4. The frame's overrides on `localId` are folded on AFTER the row is resolved — adding a known trait
 *     the member lacks, skipping an unknown one (see `traitKind`) — then its removed traits are deleted
 *     LAST: the spawner's order (overrides, then structure). At the top frame those are `opts.overrides`
 *     and `opts.removedTraits` with the direct rows of `opts.members` folded over them.
 *
 *  ⚠️ Values are returned by REFERENCE where nothing overrode them, as the plain-row read always
 *  did — the result may alias the prefab CACHE, so never mutate it.
 *
 *  **Not modelled:** a structural `removed` of the member itself (the spawner returns a dead id), and a member a
 *  structural `added` list spawns (it has no localId to be asked for). A malformed shape anywhere reads as `null`. */
export function effectivePrefabMemberTraits(
  prefab: unknown,
  localId: number,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions = {},
): Record<string, unknown> | null {
  return effectivePrefabMemberTraitsAt(prefab, [], localId, getPrefab, opts);
}

/** {@link effectivePrefabMemberTraits} for a member of a NESTED frame of the instance: `path` is the nested rows'
 *  localIds from `prefab` down (outermost first), and `localId` is the member's in the last frame's document (#1707).
 *  `[]` is the instance's own frame. Null when a path step is not a nested row, or a document does not resolve. */
export function effectivePrefabMemberTraitsAt(
  prefab: unknown,
  path: readonly number[],
  localId: number,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(prefab) || !Array.isArray(prefab.entities)) return null;
  try {
    const at = asOuterMember(prefab, path, localId, getPrefab);
    return resolveMember(prefab, at.path, at.localId, getPrefab, topFrame(foldDocOf(prefab), opts), opts, new Set<string>(), 0);
  } catch {
    return null; // a shape the fold cannot read; the spawner could not either
  }
}

/** The ROOT of a nested frame is the nested row's own member in the frame ABOVE: what that frame puts on the row (its
 *  overrides and removed traits at the row's localId) lands on the same entity, and composing it from inside the child
 *  frame misses that (#1707 close-out review). So while the member asked for is its frame's root, the last path step
 *  becomes the member — repeatedly, because a frame's root can itself be a nested row (the #1031 shape). The member-row
 *  writer names such an entity by the outermost row alone; a hand-written key can spell it any of the ways. An address
 *  whose documents do not resolve is left as it is: the walk then answers null for it, as before. */
function asOuterMember(
  prefab: Record<string, unknown>, path: readonly number[], localId: number, getPrefab: (ref: string) => unknown,
): { path: number[]; localId: number } {
  if (!path.length) return { path: [], localId };
  const docs: Record<string, unknown>[] = [prefab];
  for (const step of path) {
    const entities = docs[docs.length - 1]!.entities;
    if (!Array.isArray(entities) || docs.length > MAX_NEST_DEPTH) return { path: [...path], localId };
    const row = [...entities].reverse().find((e) => isRecord(e) && ((e.localId as number | undefined) ?? 0) === step) as Record<string, unknown> | undefined;
    if (!row || typeof row.prefab !== 'string' || !row.prefab) return { path: [...path], localId };
    let child: unknown;
    try { child = getPrefab(row.prefab); } catch { child = undefined; }
    if (!isRecord(child)) return { path: [...path], localId };
    docs.push(child);
  }
  const out = [...path];
  let lid = localId;
  while (out.length && lid === ((docs[out.length]!.rootLocalId as number | undefined) ?? 1)) lid = out.pop()!;
  return { path: out, localId: lid };
}

/** The member a member-row KEY names (`/<nodeGuid>/…`, one component per frame — `SceneMemberRow`), as the address
 *  {@link effectivePrefabMemberTraitsAt} takes: the nested rows' localIds down to its frame, and its localId there. Each
 *  component is resolved against its frame's document by `nodeGuid` (`docRows`). Null for a node row (`a+<key>`: an
 *  added node has no localId), or a component that names no row, or a frame whose document does not resolve. */
export function memberAddressOfRowKey(
  prefab: unknown,
  key: string,
  getPrefab: (ref: string) => unknown,
): { path: number[]; localId: number } | null {
  if (!key.startsWith('/') || !isRecord(prefab) || !Array.isArray(prefab.entities)) return null;
  const components = key.slice(1).split('/');
  let doc: Record<string, unknown> = prefab;
  const path: number[] = [];
  for (let i = 0; i < components.length; i++) {
    const component = components[i]!;
    if (!component || nodeRowKey(component)) return null;
    const at = docRows(foldDocOf(doc)).get(component);
    if (!at) return null;
    if (i === components.length - 1) return { path, localId: at.localId };
    if (!at.prefab || path.length >= MAX_NEST_DEPTH) return null;
    let child: unknown;
    try { child = getPrefab(at.prefab); } catch { child = undefined; }
    if (!isRecord(child) || !Array.isArray(child.entities)) return null;
    path.push(at.localId);
    doc = child;
  }
  return null;
}

function resolveMember(
  prefab: Record<string, unknown>,
  path: readonly number[],
  localId: number,
  getPrefab: (ref: string) => unknown,
  frame: FrameFold,
  opts: EffectiveMemberOptions,
  stack: Set<string>,
  depth: number,
  /** The ref this prefab was reached BY (absent at the top level). */
  selfRef?: string,
): Record<string, unknown> | null {
  const entities = prefab.entities;
  if (!Array.isArray(entities) || entities.length === 0) return null;
  // An ANCESTOR stack, like the spawner's — which keys on `prefab.id` alone. This level registers
  // under its `id` AND the ref it was reached by, ONCE, on entry: a real prefab's `id` IS the ref
  // that names it, so registering the ref in the parent before recursing (the first draft) made
  // every nested child see its own id already on the stack and resolve to null. Keying on the ref
  // too keeps a prefab with no `id` from recursing forever.
  const keys = [...new Set([typeof prefab.id === 'string' ? prefab.id : '', selfRef ?? ''])].filter(Boolean);
  if (keys.some((k) => stack.has(k))) return null;
  for (const k of keys) stack.add(k);
  try {
    const rowAt = (lid: number): Record<string, unknown> | undefined => {
      for (let i = entities.length - 1; i >= 0; i--) {
        const e = entities[i] as unknown;
        if (isRecord(e) && ((e.localId as number | undefined) ?? 0) === lid) return e;
      }
      return undefined;
    };
    /** Resolve `lid` at `rest` inside the frame nested row `row` expands, under what this frame puts on it. */
    const into = (row: Record<string, unknown>, rest: readonly number[], lid?: number): Record<string, unknown> | null => {
      const ref = row.prefab as string;
      if (depth >= MAX_NEST_DEPTH) return null;
      let child: unknown;
      try { child = getPrefab(ref); } catch { child = undefined; }
      if (!isRecord(child) || !Array.isArray(child.entities)) return null;
      const step = foldRowStep(foldRowOf(row), frame.forward, foldDocOf(child));
      const childFrame: FrameFold = { overrides: step.channels.overrides, removedTraits: step.channels.removedTraits, forward: step.forward! };
      // The child registers itself (under its id and `ref`) on entry — see the stack note above.
      return resolveMember(child, rest, lid ?? ((child.rootLocalId as number | undefined) ?? 1), getPrefab, childFrame, opts, stack, depth + 1, ref);
    };

    if (path.length) {
      const row = rowAt(path[0]!);
      if (!row || typeof row.prefab !== 'string' || !row.prefab) return null;
      return into(row, path.slice(1), localId);
    }

    const row = rowAt(localId);
    if (!row || !localId) return null;

    let traits: Record<string, unknown>;
    if (typeof row.prefab === 'string' && row.prefab) {
      const composed = into(row, []);
      if (!composed) return null;
      traits = composed;
    } else {
      traits = emptyDocMap();
      if (isRecord(row.traits)) {
        for (const [name, data] of Object.entries(row.traits)) {
          if (name !== 'PrefabInstance') traits[name] = data;
        }
      }
    }

    const own = frame.overrides?.[localId];
    if (isRecord(own)) {
      for (const [traitName, fields] of Object.entries(own)) {
        if (!isRecord(fields)) continue;
        const kind: TraitKind = opts.traitKind ? opts.traitKind(traitName) : 'component';
        // The spawner skips a trait name its registry does not know.
        if (kind === undefined) continue;
        // …adds a tag it names (a tag carries no fields to fold)…
        if (kind === 'tag') { traits[traitName] = true; continue; }
        // …and folds a component — ADDING it when the member lacks it, even if no field was accepted,
        // because the spawner then adds it at its defaults.
        const current = traits[traitName];
        const accept = (field: string) => (opts.acceptField ? opts.acceptField(traitName, field) : true);
        traits[traitName] = foldTraitOverride(isRecord(current) ? current : undefined, fields, accept).merged;
      }
    }

    const removed = frame.removedTraits?.[localId];
    if (Array.isArray(removed)) {
      for (const name of removed) if (typeof name === 'string') delete traits[name];
    }
    return traits;
  } finally {
    for (const k of keys) stack.delete(k);
  }
}
