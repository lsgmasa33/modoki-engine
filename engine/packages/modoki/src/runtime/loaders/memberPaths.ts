/** The member paths a scene or prefab document derives, predicted from the DOCUMENT rather than a live
 *  world — the file-level mirror of `deriveInstanceMemberGuids` (loadSceneFile.ts). Moved here from
 *  engine/plugins/asset-fs-ops.ts so the editor can run the same walk on a live scene's serialized form
 *  (#1437: an applied move changes member paths, and every stored ref to a moved member follows). */

import { durableGuid, deriveMemberGuid, addedKeyStep, mapStringValues, parseSteps, memberPathSteps, type MemberStep } from '../core/assetRefRules';
import { isMemberToken, parseMemberToken, memberToken, memberPathKey, MEMBER_TOKEN_PREFIX } from '../core/templateRefs';
import { descendPathKeyed, mergeNestedStructurePaths } from './prefabOverrides';

/** Reads a prefab document by its asset guid; `null`/`undefined` when it cannot. */
export type PrefabReader = (prefabGuid: string) => unknown;

/** Bounds on `derivedMemberPaths`, which mirrors the loader exactly — including the shapes the loader
 *  itself recurses on forever (a prefab whose file adds a reference that leads back to it). Predicting
 *  WHICH shapes those are took two wrong structural rules (#1324 review), so the walk does not try: it
 *  stops on size. A walk past either bound describes an entity tree no scene could load, and maps
 *  nothing (a ref into it is left as it was). Plain added levels are finite JSON and do not count
 *  toward the depth; no committed prefab nests an instance past 1 level. */
export const MAX_INSTANCE_DEPTH = 64;
const MAX_MEMBER_PATHS = 100_000;
class MemberWalkTooLarge extends Error {}

/** The fields of a scene row or an `added[]` node that decide which members derive under it. */
export type AddedNode = { guid?: unknown; key?: unknown; prefab?: unknown; added?: unknown; children?: unknown; nestedStructure?: unknown; members?: unknown };
type PrefabRow = { localId?: number; nodeGuid?: string; prefab?: string; added?: unknown; nestedStructure?: unknown; traits?: { EntityAttributes?: { parentId?: number } } };
/** Scene member rows (v16), relative to one frame: `/<nodeGuid>[/…]` → a row whose `added` (#1468
 *  Phase 4) holds nodes added under that member. Only `added` matters to this walk. */
type MemberRows = Record<string, { added?: unknown } | null>;
const rowsOf = (v: unknown): MemberRows | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as MemberRows : undefined);
/** A frame's DIRECT rows' added nodes, by the nodeGuid they hang under, and the rows one frame down
 *  (`/<g>/…` → `/…`) for the nested row whose identity is `g` — the loader's `foldMemberRowChannels`
 *  and `descendMemberRows`, as far as this walk needs them. */
const directRowAdded = (rows: MemberRows | undefined, nodeGuid: string): unknown[] => {
  const r = rows?.[`/${nodeGuid}`];
  return nodeGuid && Array.isArray(r?.added) ? r.added : [];
};
const descendRows = (rows: MemberRows | undefined, nodeGuid: string | undefined): MemberRows | undefined => {
  if (!rows || !nodeGuid) return undefined;
  const prefix = `/${nodeGuid}/`;
  let out: MemberRows | undefined;
  for (const [k, v] of Object.entries(rows)) if (k.startsWith(prefix)) (out ??= {})[k.slice(prefix.length - 1)] = v;
  return out;
};
/** A path-keyed structural slot (`nestedStructure`): '<localId>[.<localId>…]' → that expansion's delta. */
type NestedSlots = Record<string, { added?: unknown }>;
const slotsOf = (v: unknown): NestedSlots | undefined => (v && typeof v === 'object' ? v as NestedSlots : undefined);
type PrefabDoc = { rootLocalId?: number; entities?: PrefabRow[] };

/** Which anchor a derived path hangs off. `self`: the walked node's own guid. `parent`: the guid the
 *  walked node's PARENT derives from — where the loader puts a prefab row whose parent is zero or
 *  unknown, and a guid-less instance root (#1339). `skip`: a path owned by a different walk (a
 *  nested anchor's members, seen from its outer instance), or one no reload can address. */
type AnchorTag = 'self' | 'parent' | 'skip';
/** `path` is the steps below the last anchor; `done` the finished segments before it — one per
 *  guid-less stored root on the way down, each of which derives its own guid and anchors the next
 *  segment (#1349). */
type Base = { tag: AnchorTag; done: Step[][]; path: Step[]; id: string };
/** A numeric localId step, or a template-keyed added node's `'+key'` (`addedKeyStep`, #1387).
 *  Aliased rather than re-declared: the type is `MemberStep` and lives in `assetRefRules` (#1468). */
type Step = MemberStep;

/** Every `path` (`deriveInstanceMemberGuids`'s step chain, dot-joined; `|` between segments, see
 *  {@link deriveMemberChain}) a member can derive at below
 *  `node` — a scene instance root or an `added[]` node that carries its own guid — grouped by the
 *  anchor it derives from. Mirrors the loader's parenting, not the prefab's intent:
 *  - a prefab row steps by its `localId` (a nested row too: its root's `parentLocalId` is that
 *    row's localId), a user-added nested instance's root by its prefab's root localId
 *    (`parentLocalId` stays 0), and a plain added node by 0 (it has no `PrefabInstance`) — except a
 *    node a prefab TEMPLATE keyed (`key`, no guid), which derives itself and steps by `'+key'`, as a
 *    keyed reference node's root does (#1387);
 *  - a row whose `parentId` is 0, missing, or names no spawned row is parented by
 *    `instantiatePrefabIntoWorld` to the CALLER's parent: the scene parent for a top-level instance
 *    (→ `parent`), the anchor member for a user-added nested instance, and nothing for a nested
 *    prefab ROW, which is expanded under 0 and so is unaddressable;
 *  - an `added` node whose anchor is unknown re-anchors to the root, as `applyStructureCore` does;
 *  - `guidLess`: the node itself carries no guid, so its root derives too (`[rootLocalId]`, `parent`);
 *  - a guid-less instance ROOT the save stores (that `guidLess` root, or a guid-less user-added
 *    nested instance) derives its own guid and then ANCHORS its members, so their paths start a new
 *    segment after it, as the loader does (#1349).
 *  A descendant that stores its own guid is its own anchor: its members are `skip` here and are
 *  enumerated by its own walk, but its orphan rows hang off THIS walk's anchors.
 *
 *  Over-generating is harmless — the caller maps a derived guid only where the document holds it —
 *  so removed members need no special case. */
export function derivedMemberPathsByAnchor(
  node: AddedNode, readPrefab: PrefabReader, opts: { guidLess?: boolean; orphans?: 'parent' | 'skip' } = {},
): { self: string[]; parent: string[] } {
  const r = memberPathRecords(node, readPrefab, opts);
  return { self: [...r.self.keys()], parent: [...r.parent.keys()] };
}

/** {@link derivedMemberPathsByAnchor}, with each path's IDENTITY: which row or node it is, independent of
 *  where in the tree it hangs — the chain of `localId`s, one per instance frame (`/`-joined; an `added`
 *  node is `a` + its key under the entity it hangs from). Two walks of one node under different prefab
 *  documents pair up by identity, which is how a member whose row was re-parented is followed from its
 *  old path to its new one (#1437). Each map is path → identity; a path two identities share (a keyless
 *  added level) keeps the first. */
export function memberPathRecords(
  node: AddedNode, readPrefab: PrefabReader, opts: { guidLess?: boolean; orphans?: 'parent' | 'skip' } = {},
): { self: Map<string, string>; parent: Map<string, string> } {
  const out = { self: new Map<string, string>(), parent: new Map<string, string>() };
  let size = 0;
  const emit = (b: Base): void => {
    if (b.tag === 'skip' || !b.path.length) return;
    const set = out[b.tag];
    const key = [...b.done, b.path].map(memberPathKey).join('|');
    if (set.has(key)) return;
    set.set(key, b.id);
    if (++size > MAX_MEMBER_PATHS) throw new MemberWalkTooLarge();
  };
  const under = (b: Base, id: string, ...steps: Step[]): Base => ({ tag: b.tag, done: b.done, path: [...b.path, ...steps], id });
  /** The base a derived stored root at `b` gives its members: its own guid is the next anchor. */
  const anchoredAt = (b: Base): Base => ({ tag: b.tag, done: [...b.done, b.path], path: [], id: b.id });
  const SKIP: Base = { tag: 'skip', done: [], path: [], id: '' };
  const docOf = (guid: unknown): PrefabDoc | null => {
    if (typeof guid !== 'string' || !guid) return null;
    const d = readPrefab(guid);
    return d && typeof d === 'object' && Array.isArray((d as PrefabDoc).entities) ? d as PrefabDoc : null;
  };

  /** Members of `doc` below its root (the root sits at `root`), plus `added` applied to that
   *  instance; a row with no spawned parent hangs at `orphan`. `stack` is the loader's nested-ROW
   *  guard (`instantiatePrefabIntoWorld`'s `_stack`), which a reference node restarts
   *  (`spawnNestedInstance` passes none). `frame` is the root's identity. `nested` is the path-keyed
   *  structure an outer layer addressed INTO this expansion, split at each nested row exactly as the loader
   *  splits it (`descendPathKeyed`, the row's own slots under what was forwarded) — a template-keyed node a
   *  row writes into a deeper expansion lives only there (#1430). */
  const expand = (doc: PrefabDoc, root: Base, orphan: Base, added: unknown, stack: string[], depth: number, frame: string, nested?: NestedSlots, memberRows?: MemberRows): void => {
    if (depth > MAX_INSTANCE_DEPTH) throw new MemberWalkTooLarge();
    const rootLocalId = doc.rootLocalId ?? 1;
    // The rows the loader actually spawns and maps: a nested row only when its prefab resolves.
    const rows = new Map<number, PrefabRow>();
    for (const r of doc.entities ?? []) {
      if (!r || typeof r.localId !== 'number' || !r.localId) continue;
      if (r.prefab && (!docOf(r.prefab) || stack.includes(r.prefab))) continue;
      rows.set(r.localId, r);
    }
    const parentOf = (r: PrefabRow): number => r.traits?.EntityAttributes?.parentId ?? 0;
    const idOf = (localId: number): string => (localId === rootLocalId || !rows.has(localId) ? frame : `${frame}/${localId}`);
    // Where `localId` sits; `null` for a parent cycle, which the loader leaves detached. A localId
    // that is not a row is the root — the re-anchoring an `added` node gets.
    const baseOf = (localId: number): Base | null => {
      if (localId === rootLocalId || !rows.has(localId)) return root;
      const chain: number[] = [];
      const seen = new Set<number>();
      let cur = localId;
      for (;;) {
        if (seen.has(cur)) return null;
        seen.add(cur);
        chain.unshift(cur);
        const p = parentOf(rows.get(cur)!);
        if (p === rootLocalId) return under(root, idOf(localId), ...chain);
        if (!p || !rows.has(p)) return under(orphan, idOf(localId), ...chain);
        cur = p;
      }
    };
    for (const [localId, row] of rows) {
      const here = baseOf(localId);
      if (!here) continue;
      if (localId !== rootLocalId) emit(here);
      if (row.prefab) {
        const { direct, forward } = descendPathKeyed(nested, localId);
        // The loader REPLACES the row's `added` with an outer layer's direct list. Both are walked:
        // over-generating is harmless, and a node the scene saved in scene form (its derived guid,
        // no key) is still named by the template path that derives it (#1430).
        // …and so does a member ROW for this nested root (Phase 4, #1468), whose added nodes hang at the
        // child's ROOT (no `parentLocalId`, which the child's walk reads as its root).
        const fromRow = directRowAdded(memberRows, row.nodeGuid ?? '').map((n) => (n && typeof n === 'object' ? { ...n as object, parentLocalId: undefined } : n));
        const rowAdded = [...(Array.isArray(row.added) ? row.added : []), ...(Array.isArray(direct?.added) ? direct.added : []), ...fromRow];
        // A nested row expands under parent 0, so ITS orphans are unaddressable.
        expand(docOf(row.prefab)!, here, SKIP, rowAdded, [...stack, row.prefab], depth + 1, here.id,
          mergeNestedStructurePaths(slotsOf(row.nestedStructure), forward), descendRows(memberRows, row.nodeGuid));
      }
    }
    // A member row's added nodes (Phase 4, #1468) hang under the member the row names — the same
    // anchoring `parentLocalId` gives a legacy node, reached by identity instead.
    const fromRows: unknown[] = [];
    for (const [localId, row] of rows) {
      // A nested root's row was walked by its expansion above — the route the loader takes. Walking it
      // here as well would name the same paths again (`emit` dedups them), so this is one route, not a
      // correctness guard: mutation confirms dropping it changes no output.
      if (row.prefab && localId !== rootLocalId) continue;
      for (const n of directRowAdded(memberRows, row.nodeGuid ?? '')) if (n && typeof n === 'object') fromRows.push({ ...n as object, parentLocalId: localId });
    }
    const allAdded = [...(Array.isArray(added) ? added : []), ...fromRows];
    if (allAdded.length) {
      for (const n of allAdded as (AddedNode & { parentLocalId?: number })[]) {
        if (!n || typeof n !== 'object') continue;
        const at = n.parentLocalId ?? rootLocalId;
        const b = baseOf(at);
        if (b) addedNode(n, b, depth, idOf(at));
      }
    }
  };

  /** One `added[]` node hanging at `base`, below the entity whose identity is `owner`. */
  const addedNode = (n: AddedNode, base: Base, depth: number, owner: string): void => {
    const ownGuid = durableGuid(typeof n.guid === 'string' ? n.guid : '');
    // A template-keyed node (no guid) derives itself, stepping by its key (#1387).
    const key = !ownGuid && typeof n.key === 'string' && n.key ? addedKeyStep(n.key) : '';
    const id = `${owner}/a${key || (n.prefab ? 'r' : '0')}`;
    if (n.prefab) {
      const child = docOf(n.prefab);
      if (!child) return;
      // With its own guid it is its own anchor: its root and members belong to its own walk. Its
      // orphan rows do not — `spawnNestedInstance` parents them to `base`, which is ours.
      const here = ownGuid ? SKIP : under(base, id, key || (child.rootLocalId ?? 1));
      emit(here);
      // A FRESH row chain, as `spawnNestedInstance` gives it (#1324 review). Guid-less, the root
      // still anchors its members on the guid it derives (#1349).
      expand(child, ownGuid ? SKIP : anchoredAt(here), base, n.added, [n.prefab as string], depth + 1, id, slotsOf(n.nestedStructure), rowsOf(n.members));
      return;
    }
    // A plain node with its own guid anchors everything below it (its own walk).
    if (ownGuid) return;
    const here = under(base, id, key || 0);
    if (key) emit(here);
    if (Array.isArray(n.children)) for (const c of n.children as AddedNode[]) if (c && typeof c === 'object') addedNode(c, here, depth, id);
  };

  try {
    if (node.prefab) {
      const doc = docOf(node.prefab);
      if (doc) {
        const orphan: Base = { tag: opts.orphans ?? 'skip', done: [], path: [], id: '' };
        const root: Base = opts.guidLess ? under(orphan, '', doc.rootLocalId ?? 1) : { tag: 'self', done: [], path: [], id: '' };
        emit(root);
        expand(doc, opts.guidLess ? anchoredAt(root) : root, orphan, node.added, [node.prefab as string], 0, '', slotsOf(node.nestedStructure), rowsOf(node.members));
      }
    } else if (Array.isArray(node.children)) {
      // A plain added node anchors any guid-less nested instance added beneath it.
      for (const c of node.children as AddedNode[]) if (c && typeof c === 'object') addedNode(c, { tag: 'self', done: [], path: [], id: '' }, 0, '');
    }
  } catch (e) {
    if (e instanceof MemberWalkTooLarge) return { self: new Map(), parent: new Map() };
    throw e;
  }
  return out;
}

/** The guid a member at `key` (a {@link derivedMemberPathsByAnchor} path) derives from `anchor`:
 *  one `deriveMemberGuid` per `|`-separated segment, each result anchoring the next. */
export function deriveMemberChain(anchor: string, key: string): string {
  // `parseSteps`, not `memberPathSteps`: an empty SEGMENT has always seeded `deriveMemberGuid` with
  // `'0'` rather than with nothing, and that output is persisted and frozen (#1468 Phase 1).
  return key.split('|').reduce((a, seg) => deriveMemberGuid(a, parseSteps(seg)), anchor);
}

/** The member paths that derive from `node`'s own guid — {@link derivedMemberPathsByAnchor}'s `self`. */
export function derivedMemberPaths(node: AddedNode, readPrefab: PrefabReader): string[] {
  return derivedMemberPathsByAnchor(node, readPrefab).self;
}

/** A top-level scene entry's field shape, as far as its parent chain is concerned. */
type SceneEntry = AddedNode & { id?: unknown; traits?: { EntityAttributes?: { guid?: unknown; parentId?: unknown } } };

/** The guid a top-level scene entry's PARENT position derives from, and the steps from just below
 *  that anchor down to the parent — `null` when no reload can be relied on to address it. Mirrors
 *  `resolveParentRef` (a guid names an entry, a positive number an entry id, anything else the
 *  root). Only a parent with a durable guid is followed:
 *  - a guid-less INSTANCE parent can only be named by its numeric entry id. Since #1353 the loader
 *    parents the child to the re-instantiated root, and that root derives a guid from ITS scene
 *    parent (`deriveInstanceMemberGuids`), so a chain below a durable parent could be followed.
 *    Not following it is a conservative choice for legacy, never-re-saved files, not a necessity;
 *  - a guid-less PLAIN parent gets a guid seeded from the scene PATH (`deriveAuthoredEntityGuids`),
 *    which a copy at another path does not share.
 *  Either way nothing below it can be predicted, so its refs are left as they were. */
export function sceneAnchorOf(entry: SceneEntry, entries: SceneEntry[]): string | null {
  const ownGuid = (e: SceneEntry): string => durableGuid(String((e.prefab ? e.guid : e.traits?.EntityAttributes?.guid) ?? ''));
  const raw = entry.traits?.EntityAttributes?.parentId;
  const parent = typeof raw === 'string'
    ? (raw ? entries.find((x) => ownGuid(x) === raw) : undefined)
    : typeof raw === 'number' && raw > 0 ? entries.find((x) => x.id === raw) : undefined;
  return parent ? ownGuid(parent) || null : null;
}


/** A place in a scene document whose derived members {@link memberPathRecords} enumerates: `node` walked
 *  with `opts`, its `self` paths deriving from `self` and its `parent` paths from `parent` (either
 *  `null` when nothing a reload does can be predicted there — see {@link sceneAnchorOf}). */
export type SceneMemberAnchor = {
  node: AddedNode;
  opts: { guidLess?: boolean; orphans?: 'parent' | 'skip' };
  self: string | null;
  parent: string | null;
};

/** Every {@link SceneMemberAnchor} of a scene document: each nested anchor it defines (an `added[]` node,
 *  a `nestedStructure` slot's added node or a legacy `children` row with its own guid), and each
 *  top-level instance or plain-with-children entry — which, for a row the loader parents to the SCENE
 *  parent or a guid-less (pre-#1248) root, also derives from that parent's anchor (#1339). The one
 *  enumeration `remintSceneEntityGuids` and {@link memberGuidRemap} both walk. */
export function sceneMemberAnchors(scene: Record<string, unknown>): SceneMemberAnchor[] {
  type Row = AddedNode & { traits?: { EntityAttributes?: { guid?: unknown } } };
  const out: SceneMemberAnchor[] = [];
  const visit = (rows: unknown, topLevel: boolean): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Row[]) {
      if (!row || typeof row !== 'object') continue;
      const anchor = durableGuid(typeof row.guid === 'string' ? row.guid : '');
      if (anchor && !topLevel) out.push({ node: row, opts: {}, self: anchor, parent: null });
      visit(row.children, false);
      visit(row.added, false);
      // A member row's added nodes (Phase 4, #1468) define anchors exactly as `added` does.
      for (const r of Object.values(rowsOf(row.members) ?? {})) visit(r?.added, false);
      const slot = (row as { nestedStructure?: unknown }).nestedStructure;
      if (slot && typeof slot === 'object') {
        for (const delta of Object.values(slot as Record<string, { added?: unknown } | null>)) visit(delta?.added, false);
      }
    }
  };
  visit(scene.entities, true);
  const entries = (Array.isArray(scene.entities) ? scene.entities : []).filter((e): e is Row => !!e && typeof e === 'object');
  for (const entry of entries) {
    if (!entry.prefab && !Array.isArray(entry.children)) continue;
    const ownGuid = durableGuid(typeof entry.guid === 'string' ? entry.guid : '');
    out.push({
      node: entry,
      opts: { guidLess: !!entry.prefab && !ownGuid, orphans: 'parent' },
      self: ownGuid || null,
      parent: sceneAnchorOf(entry as SceneEntry, entries as SceneEntry[]),
    });
  }
  return out;
}

/** Old derived guid → new, for every member of `scene` whose PATH differs between the prefab documents
 *  `readOld` and `readNew` return (#1437: applying a move re-parents a prefab row, and a row's path is
 *  what its members' guids derive from). Members pair by identity ({@link memberPathRecords}), so one
 *  that moved from a row-parented position to an orphaned one, or back, is followed across anchors. A
 *  member with no predictable anchor on either side is left out: a ref to it is left as it was. */
export function memberGuidRemap(scene: Record<string, unknown>, readOld: PrefabReader, readNew: PrefabReader): Map<string, string> {
  const remap = new Map<string, string>();
  for (const a of sceneMemberAnchors(scene)) {
    const at = (r: { self: Map<string, string>; parent: Map<string, string> }): Map<string, string> => {
      const byId = new Map<string, string>();
      for (const [tag, anchor] of [['self', a.self], ['parent', a.parent]] as const) {
        if (!anchor) continue;
        for (const [path, id] of r[tag]) if (!byId.has(id)) byId.set(id, deriveMemberChain(anchor, path));
      }
      return byId;
    };
    const before = at(memberPathRecords(a.node, readOld, a.opts));
    const after = at(memberPathRecords(a.node, readNew, a.opts));
    for (const [id, was] of before) {
      const now = after.get(id);
      if (now && now !== was && !remap.has(was)) remap.set(was, now);
    }
  }
  return remap;
}

/** `doc` — a prefab document stored under `docGuid` — with every MEMBER TOKEN re-pointed from the member
 *  path `readOld`'s documents give it to the one `readNew`'s give it (#1437: a template names its members
 *  by path, and applying a move re-parents a row). `null` when nothing changed. `readOld`/`readNew` are
 *  asked for `docGuid` too, so a caller rewriting the changed prefab itself answers with its two versions.
 *
 *  A token is read in the frame its value is applied in (templateRefs.ts § Frame): a row's own traits, and
 *  the document's own `moved` targets, in the document's; a nested row's `overrides` and `added` in that row's instance; a `nestedOverrides` or
 *  `nestedStructure` entry in the instance its key addresses. It climbs `^` frames, names a path below
 *  that one, is followed by identity, and is written back relative to the same frame. A value inside a
 *  user-added REFERENCE node is left as it is — its frame is not a row chain — and so is a token that
 *  resolves to nothing, as the loader leaves it. */
export function rewritePrefabMemberTokens(
  doc: Record<string, unknown>, docGuid: string, readOld: PrefabReader, readNew: PrefabReader,
): Record<string, unknown> | null {
  const index = (read: PrefabReader): { idOf: Map<string, string>; pathOf: Map<string, string> } => {
    const r = memberPathRecords({ prefab: docGuid }, read);
    const idOf = new Map<string, string>();
    const pathOf = new Map<string, string>([['', '']]);
    for (const [path, id] of r.self) {
      if (path.includes('|')) continue; // past a guid-less stored root: another anchor, not a token path
      idOf.set(path, id);
      if (!pathOf.has(id)) pathOf.set(id, path);
    }
    idOf.set('', '');
    return { idOf, pathOf };
  };
  const before = index(readOld);
  const after = index(readNew);
  const join = (a: string, b: string): string => (a && b ? `${a}.${b}` : a || b);
  let changed = false;
  /** `value` with its tokens re-pointed, read in the frame whose identities are `frames` (outermost first). */
  const rewrite = (value: unknown, frames: string[]): unknown => mapStringValues(value, (s) => {
    const t = isMemberToken(s) ? parseMemberToken(s) : null;
    if (!t || t.up >= frames.length) return s;
    const frame = frames[frames.length - 1 - t.up]!;
    const oldBase = before.pathOf.get(frame);
    const newBase = after.pathOf.get(frame);
    if (oldBase === undefined || newBase === undefined) return s;
    const id = before.idOf.get(join(oldBase, memberPathKey(t.path)));
    const target = id === undefined ? undefined : after.pathOf.get(id);
    if (target === undefined) return s;
    if (newBase && target !== newBase && !target.startsWith(newBase + '.')) return s;
    const rel = newBase ? target.slice(newBase.length + 1) : target;
    const next = memberToken(t.up, memberPathSteps(rel));
    if (next !== s) changed = true;
    return next;
  });
  type Row = Record<string, unknown> & { localId?: number; prefab?: string; traits?: unknown };
  const rows = Array.isArray(doc.entities) ? (doc.entities as Row[]) : [];
  /** An `added` subtree applied in `frames`: plain nodes' traits, recursively; a reference node is skipped. */
  const addedIn = (nodes: unknown, frames: string[]): unknown => (!Array.isArray(nodes) ? nodes : nodes.map((n) => {
    if (!n || typeof n !== 'object' || (n as { prefab?: unknown }).prefab) return n;
    const node = n as Record<string, unknown>;
    const out = { ...node };
    if (node.traits !== undefined) out.traits = rewrite(node.traits, frames);
    if (node.children !== undefined) out.children = addedIn(node.children, frames);
    return out;
  }));
  /** A path-keyed slot of a nested row at `row`: each key's frames run through the chain it names. */
  const slot = (paths: unknown, row: string, each: (v: unknown, frames: string[]) => unknown): unknown => {
    if (!paths || typeof paths !== 'object') return paths;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(paths as Record<string, unknown>)) {
      const frames = ['', row];
      for (const lid of key.split('.')) frames.push(`${frames[frames.length - 1]}/${lid}`);
      Object.defineProperty(out, key, { value: each(v, frames), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const entities = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const next: Row = { ...row };
    if (row.traits !== undefined) next.traits = rewrite(row.traits, ['']);
    if (row.prefab && typeof row.localId === 'number') {
      const frames = ['', `/${row.localId}`];
      if (row.overrides !== undefined) next.overrides = rewrite(row.overrides, frames);
      if (row.added !== undefined) next.added = addedIn(row.added, frames);
      if (row.nestedOverrides !== undefined) next.nestedOverrides = slot(row.nestedOverrides, frames[1]!, (v, f) => rewrite(v, f));
      if (row.nestedStructure !== undefined) {
        next.nestedStructure = slot(row.nestedStructure, frames[1]!, (v, f) => (v && typeof v === 'object'
          ? { ...(v as Record<string, unknown>), added: addedIn((v as { added?: unknown }).added, f) }
          : v));
      }
    }
    return next;
  });
  // The prefab's own moves name their members AND their targets by path in its own frame (#1437 P3-b).
  let moved: Record<string, unknown> | undefined;
  if (doc.moved && typeof doc.moved === 'object') {
    moved = {};
    for (const [key, value] of Object.entries(doc.moved as Record<string, unknown>)) {
      const token = memberToken(0, memberPathSteps(key));
      const next = rewrite(token, ['']) as string;
      const nextKey = next.slice(MEMBER_TOKEN_PREFIX.length);
      if (nextKey !== key) changed = true;
      Object.defineProperty(moved, nextKey, { value: rewrite(value, ['']), enumerable: true, writable: true, configurable: true });
    }
  }
  return changed ? { ...doc, entities, ...(moved !== undefined ? { moved } : {}) } : null;
}
