/** The write-side token scope: the template tokenizer and its node-exit markers, the base token resolver, and the
 *  scopes a template write runs in (the kept-state bake, the statement being rewritten).
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { keptStateOf, restoreKeptState, type KeptState } from '../../runtime/core/ecs/keptOrphanRows';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents, templateFrameClimber } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsToWrite } from '../../runtime/core/ecs/memberRows';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity, subtreeIds, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { durableGuid, mapStringValues, memberPathSteps, entityStep, isStoredRoot, isFrameStep, FRAME_STEP } from '../../runtime/core/assetRefRules';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import type { AddedEntity, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { templateReferenceNode } from './prefabBase';
import { isMemberToken, parseMemberToken, memberToken, memberPathLookup, type MemberStep } from '../../runtime/core/templateRefs';
import { getCachedPrefabSync, recoverTemplateKey } from './prefabCache';

/** Which entities of `tree` become ROWS of the prefab, and what localId each one gets.
 *
 *  ⚠️ This is THE numbering for a prefab's localId address space, and it exists as one function
 *  because it used to exist as two (#1278). `serializePrefab` decides the rows; Create Prefab
 *  then stamps `PrefabInstance.localId` onto the live tree, and that stamp MUST agree — it is
 *  the same address space a scene's `overrides`/`removed` are keyed in (docs/prefabs.md
 *  § "localId stability"). Tagging used to re-derive it by counting the live tree, which
 *  disagreed for every member ordered after a nested instance, and the next save then wrote
 *  overrides under an id denoting a different member. **Anything that needs to know a member's
 *  localId calls this; nothing re-derives it.**
 *
 *  Membership is genuinely not inferable from the hierarchy, which is why re-deriving it kept
 *  going wrong: a nested instance's own members, the added subtrees it folded in, and every OWNED
 *  nested instance inside it at any depth (the row partition, `captureNestedChannels`'
 *  `ownedMemberEcsIds`) are dropped. The last were once NOT, and each got a second reference row
 *  at the prefab root (#1382). "Every descendant of a nested root" is the wrong rule in both
 *  directions — `memberEcsIds` is a world-wide query on `rootInstanceId`, so a member reparented
 *  out of the subtree is dropped too, and a user-added instance inside is captured as an `added`
 *  reference node rather than skipped as a member.
 *
 *  Returns null when a nested ref would make the prefab transitively contain itself. */
/** A prefab row's member rows with member refs rewritten as tokens (#1352), each in the frame its row applies in: a
 *  member or node row the frame its key names a member of (the key less its last component), and a nested ROOT's row
 *  (whose key IS a frame's key: what it states lands at that root) that frame. `rowRoot` is the row's live
 *  instance root, whose key space the rows are written in. */
export function tokenizeRowMembers(
  members: Record<string, SceneMemberRow>,
  frames: ReadonlyMap<string, { root: number }>,
  rowRoot: number,
  frameOf: (pathKey: string) => number,
  tokens: ReturnType<typeof templateTokenizer>,
): Record<string, SceneMemberRow> {
  const keyOf = memberRowKeysIn(rowRoot);
  const pathByKey = new Map<string, string>();
  for (const [path, { root }] of frames) { const k = keyOf.get(root); if (k) pathByKey.set(k, path); }
  const out: Record<string, SceneMemberRow> = {};
  for (const [key, row] of Object.entries(members)) {
    const path = pathByKey.get(key) ?? pathByKey.get(key.slice(0, key.lastIndexOf('/')));
    const frame = path ? frameOf(path) : rowRoot;
    const r: SceneMemberRow = { ...row };
    if (r.traits) r.traits = tokens.value(r.traits, frame) as SceneMemberRow['traits'];
    if (r.added) r.added = tokens.added(r.added, frame);
    if (r.own) r.own = tokens.added(r.own, frame);
    out[key] = r;
  }
  return out;
}

/** Serialize selected entity + descendants as a prefab.
 *  Pass `existingId` when re-saving an existing prefab to preserve its UUID.
 *
 *  Nested prefab instances inside the subtree (a self-rooted PrefabInstance below
 *  the selection root) are written as *reference rows* — one row carrying the
 *  child `prefab` GUID + captured overrides/structure — and their members are
 *  excluded from the flat output. The selection root itself is never collapsed
 *  this way (so "save instance as prefab" still flattens the instance). */
/** Rewrites refs held in a TEMPLATE being written from the live tree under `rootEcsId` (#1352).
 *
 *  A payload is in the frame of the instance it is applied to: the written root for a flat row's bag,
 *  a nested row's live root for its `overrides`/`added`, and the owned instance a `nestedOverrides` /
 *  `nestedStructure` path addresses. A string value equal to the guid of an entity the payload's frame
 *  can name becomes a member token. If only an ENCLOSING frame can name it, the token climbs `^` once
 *  per level, and it always takes the NEAREST such frame. That makes the spelling canonical, which the
 *  #1381 no-op comparison needs: MID's own save and OUTER's save of the same MID interior must write
 *  the same token, or OUTER pins an interior it never changed. A ref out of the written tree is left
 *  as it is.
 *
 *  Steps: the written root's frame names each row by its NEW localId (`ecsToLocal`). Any other frame
 *  is a live instance whose members step as the derive pass walks them (`memberPathIndex`). A
 *  reference node's payload is left whole, since it is applied in its own frame: its own writer
 *  tokenizes it there (`finishTemplateReferenceNode`, #1538).
 *
 *  `ownFrame`: `rootEcsId` is a template REFERENCE node's live root rather than the written root. Its
 *  frame is then indexed as every other instance frame is (`memberPathIndex`, what the loader resolves
 *  a token against). A ref no frame inside the node can name climbs OUT of its root the way the loader
 *  climbs (`templateFrameClimber`, #1541): to the instance holding the node, then the frames around it,
 *  still to the nearest that names it. Under `serializePrefab` it stays below the root being written:
 *  that root's frame is named by the new localIds, which do not exist yet while rows are planned, so a
 *  guid the climb could not name there is left as an exit marker for `serializePrefab` to finish
 *  (`nodeExits`). In the prefab-edit world the climb ends at the row entry for the same reason. */
export function templateTokenizer(rootEcsId: number, all: EntityInfo[], ecsToLocal: Map<number, number>, rowParent: Map<number, number> = new Map(), ownFrame = false) {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const piOf = (id: number) => (piMeta ? readTraitData(id, piMeta) as { localId?: number; parentLocalId?: number; rootInstanceId?: number } | null : null);
  // A written ROW hangs where it lives; a nested instance's member by its IDENTITY — from its template parent
  // when it was moved (#1437) — since that is where the written prefab's expansion derives it.
  const identity = worldIdentityParents(getCurrentWorld());
  const children = new Map<number, EntityInfo[]>();
  for (const e of all) {
    const parent = ecsToLocal.has(e.id) ? (rowParent.get(e.id) ?? e.parentId) : identity.parentOf(e.id);
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  const pathInRoot = new Map<string, MemberStep[]>();
  const pathById = new Map<number, MemberStep[]>([[rootEcsId, []]]);
  const rootGuid = all.find((e) => e.id === rootEcsId)?.guid;
  if (rootGuid) pathInRoot.set(rootGuid, []);
  const stack: [number, MemberStep[]][] = ownFrame ? [] : [[rootEcsId, []]];
  const seen = new Set<number>([rootEcsId]);
  while (stack.length) {
    const [id, path] = stack.pop()!;
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const key = templateKeyOf(findEntity(c.id));
      const pi = piOf(c.id);
      const step: MemberStep | null = ecsToLocal.has(c.id) ? ecsToLocal.get(c.id)!
        : (key || pi) ? entityStep(pi, key) : null;
      if (step === null) continue;
      // A written row under a written NESTED root steps across that frame, as the reloaded expansion derives it (#1484).
      const crosses = id !== rootEcsId && ecsToLocal.has(id) && piOf(id)?.rootInstanceId === id;
      // A template-keyed node continues from its FRAME ROOT's path, not its parent's (#1809, `derivesFrom`).
      const from = identity.derivesFrom(c.id);
      const at = ecsToLocal.has(c.id) ? [...path, ...(crosses ? [FRAME_STEP] : []), step]
        : [...(from.parentId === id ? path : pathById.get(from.parentId) ?? path), ...from.extra, step];
      if (c.guid) pathInRoot.set(c.guid, at);
      pathById.set(c.id, at);
      if (!isStoredRoot(pi, c.id) || ecsToLocal.has(c.id)) stack.push([c.id, at]);
    }
  }
  const frames = new Map<number, Map<string, MemberStep[]>>(ownFrame ? [] : [[rootEcsId, pathInRoot]]);
  const pathsIn = (frame: number): Map<string, MemberStep[]> => {
    let out = frames.get(frame);
    if (out) return out;
    out = new Map();
    if (eaMeta) {
      for (const [key, target] of memberPathIndex(getCurrentWorld(), frame)) {
        const guid = target ? (target.get(eaMeta.trait) as { guid?: string }).guid : '';
        if (guid) out.set(guid, memberPathSteps(key));
      }
    }
    frames.set(frame, out);
    return out;
  };
  /** The frame one level out: a written row's frame is the root's, and an owned nested instance's
   *  frame is the one its row sits in. */
  const enclosing = (frame: number): number => {
    if (frame === rootEcsId) return 0;
    if (ecsToLocal.has(frame)) return rootEcsId;
    const parent = eaMeta ? ((readTraitData(frame, eaMeta)?.parentId as number) || 0) : 0;
    return (parent && piOf(parent)?.rootInstanceId) || rootEcsId;
  };
  /** token → the guid it was written for, so `undeclaredKeys` can put one back. */
  const origin = new Map<string, string>();
  /** The tokens that climbed out of a reference node's root: their keys are the enclosing file's to declare, which
   *  only the outer write can see (`nodeExits.origins`), so the node's own `undeclaredKeys` leaves them alone. */
  const exited = new Set<string>();
  let climb: ReturnType<typeof templateFrameClimber> | undefined;
  let liveGuids: Set<string> | undefined;
  const parentById = new Map(all.map((e) => [e.id, e.parentId]));
  /** Is `frame` strictly below the root `serializePrefab` is writing (`nodeExits.root`)? */
  const belowWrittenRoot = (frame: number): boolean => {
    const seen = new Set<number>();
    for (let p = parentById.get(frame) ?? 0; p && !seen.has(p); p = parentById.get(p) ?? 0) {
      if (p === nodeExits?.root) return true;
      seen.add(p);
    }
    return false;
  };
  const value = (v: unknown, frame: number): unknown => mapStringValues(v, (str) => {
    if (!str) return str;
    let up = 0;
    for (let f = frame; f; f = enclosing(f), up++) {
      const p = pathsIn(f).get(str);
      if (p) { const t = memberToken(up, p); origin.set(t, str); return t; }
    }
    if (!ownFrame) return str;
    // Out of the node's root, as the loader resolves a `^` left over at the node's top call (#1541). Inside a
    // `serializePrefab` the climb stays inside the tree being written, below its root: the root's own frame is named by
    // the NEW localIds (`nameAtRoot`, once they exist), and a frame outside the tree is not the file's to name. So
    // the climb stops at the root, at the edge of the tree, or where no frame is left (a prefab-edit row entry, whose
    // next frame is the edited prefab's root) — and a live guid it stops on becomes an exit marker.
    climb ??= templateFrameClimber(getCurrentWorld());
    for (let f = climb(rootEcsId, 1); f && (!nodeExits || belowWrittenRoot(f)); f = climb(f, 1), up++) {
      const p = pathsIn(f).get(str);
      if (!p) continue;
      const t = memberToken(up, p);
      origin.set(t, str);
      exited.add(t);
      nodeExits?.origins.set(t, str);
      return t;
    }
    if (nodeExits && (liveGuids ??= new Set(all.map((e) => e.guid).filter((g): g is string => !!g))).has(str)) {
      const marker = `${NODE_EXIT_PREFIX}${nodeExits.markers.size}`;
      nodeExits.markers.set(marker, { up, guid: str });
      return marker;
    }
    return str;
  });
  /** The token the written root's frame names `guid` by, `up` climbs out — an exit marker's finish. */
  const nameAtRoot = (guid: string, up: number): string | undefined => {
    const p = pathInRoot.get(guid);
    if (!p) return undefined;
    const t = memberToken(up, p);
    origin.set(t, guid);
    return t;
  };
  /** Adopt the origins of tokens a reference node's writer climbed out with, so `undeclaredKeys` can put them back. */
  const adoptOrigins = (from: ReadonlyMap<string, string>): void => { for (const [t, g] of from) if (!origin.has(t)) origin.set(t, g); };
  /** `v` with every token that steps through a key no file declares turned back into its guid. The key
   *  was minted for a live node the write then left out, because the file's pre-key version of that
   *  interior still counts as unchanged (`sameStructure`). A token for it would name nothing on
   *  reload, where the guid still resolved (#1352 review) — when the reloaded node spawns with that guid.
   *  One that does not: a legacy key-less node an OLD file's slot re-stated under a key, whose edit-world
   *  copy derived its guid through that key. The slot drops, the reload spawns the node's own legacy guid,
   *  and the guid written here names nothing either (#1538 close-out; docs/prefab-structural-overrides.md). */
  const undeclaredKeys = (v: unknown, declared: ReadonlySet<string>): unknown => mapStringValues(v, (str) => {
    const t = isMemberToken(str) && !exited.has(str) ? parseMemberToken(str) : null;
    if (!t || !t.path.some((step) => typeof step === 'string' && !isFrameStep(step) && !declared.has(step.slice(1)))) return str;
    return origin.get(str) ?? str;
  });
  const added = (nodes: AddedEntity[] | undefined, frame: number): AddedEntity[] | undefined => nodes?.map((n) => (n.prefab ? n : {
    ...n, traits: value(n.traits, frame) as AddedEntity['traits'], children: added(n.children, frame) ?? [],
  }));
  /** The live owned instance a `nestedOverrides`/`nestedStructure` path addresses below `rowRoot`
   *  (each step a row localId), or 0.
   *
   *  ⚠️ "Which instance owns this nested root" is asked of its OWNER (`identityParents.ts`), never its
   *  live parent. An owned nested root moved BESIDE its frame — under a member of another nested
   *  instance inside the same outermost instance — stays owned (`planMoveUnlinks` neither strips nor
   *  promotes it), so reading the live parent made this return 0 and the caller tokenize the path in the
   *  wrong frame. Found by #1468 Phase 2B's close-out sweep: three other sites already answer this
   *  question this way (the identity tree, `planMoveUnlinks`, `memberRowKeysIn`) and this was the fourth.
   *
   *  ⚠️ **No test, and saying so rather than implying one.** The observable is a member token
   *  resolved in the wrong frame inside a prefab-within-prefab-within-prefab, which no fixture in
   *  this repo builds. What makes it safe without one is that the owner falls back to the live
   *  parent's frame for a root that never moved, so every case that works today is byte-identical and
   *  only a MOVED root behaves differently. */
  const frameAt = (rowRoot: number, pathKey: string): number => {
    let cur = rowRoot;
    for (const step of memberPathSteps(pathKey)) {
      let next = 0;
      for (const e of all) {
        const pi = piOf(e.id);
        if (!pi || pi.rootInstanceId !== e.id || pi.parentLocalId !== step) continue;
        if (identity.ownerOf(e.id) === cur) { next = e.id; break; }
      }
      if (!next) return 0;
      cur = next;
    }
    return cur;
  };
  /** A live entity's path in the written prefab's frame, or undefined when it is not one it can name. */
  const pathOf = (id: number): MemberStep[] | undefined => pathById.get(id);
  return { value, added, frameAt, undeclaredKeys, pathOf, nameAtRoot, adoptOrigins, root: rootEcsId };
}

/** Exit markers stand in, inside a template reference node's payload, for a ref only the edited prefab's written ROOT
 *  can name (#1541). The prefab-edit world spawns each row as a scene entry, so the node's writer, which runs while
 *  `serializePrefab` is still planning its rows, cannot name that root's rows yet: it writes a marker, and
 *  `serializePrefab` replaces it with the token (`nameAtRoot`) once it has the rows' new localIds. Set only while
 *  `serializePrefab` plans its rows; a marker it cannot name is written back as the guid it stood for, so none
 *  reaches a file. Not a member token (`isMemberToken` is false), so no token pass reads one. */
const NODE_EXIT_PREFIX = '@member-exit:';

export type NodeExits = { root: number; markers: Map<string, { up: number; guid: string }>; origins: Map<string, string> };

let nodeExits: NodeExits | null = null;

/** Run `fn` with `exits` as the running template write's node exits, restored however `fn` leaves — the shape of
 *  {@link withKeptStateBake}, and the only way `nodeExits` is set. */
export function withNodeExits<T>(exits: NodeExits, fn: () => T): T {
  const outer = nodeExits;
  nodeExits = exits;
  try { return fn(); } finally { nodeExits = outer; }
}

/** Resolves the member tokens in a prefab BASE value against the live instance rooted at
 *  `rootInstanceId`, so it can be compared with the live value, which holds guids (#1352). A `^`
 *  climbs as the loader climbs (`templateFrameClimber`): to the instance whose row expanded this one —
 *  its owner, for a moved nested root (#1437) — and out of a template reference node's root to the
 *  instance holding it (#1541). A token that names nothing stays as it is. */
export function baseTokenResolver(rootInstanceId: number): (value: unknown) => unknown {
  const world = getCurrentWorld();
  const eaMeta = getTraitByName('EntityAttributes');
  const indexes = new Map<number, ReturnType<typeof memberPathIndex>>();
  let climb: ReturnType<typeof templateFrameClimber> | undefined;
  const resolve = (token: string): string => {
    const t = parseMemberToken(token);
    const frame = !t ? 0 : t.up ? (climb ??= templateFrameClimber(world))(rootInstanceId, t.up) : rootInstanceId;
    if (!t || !frame || !eaMeta) return token;
    let index = indexes.get(frame);
    if (!index) { index = memberPathIndex(world, frame); indexes.set(frame, index); }
    const within = index;
    const target = memberPathLookup((k) => within.get(k), t.path);
    const guid = target ? ((target.get(eaMeta.trait) as { guid?: string }).guid ?? '') : '';
    return guid || token;
  };
  return (value) => mapStringValues(value, (v) => (isMemberToken(v) ? resolve(v) : v));
}

/** Does the running template write BAKE the kept R2 state of the scene roots it swallows (#1790, owner ruling D)? A scope,
 *  not a parameter: the row writer is reached at every depth of the capture (a row, a template reference node inside any
 *  nested frame), and only for the one write that asked. Set only through {@link withKeptStateBake}. */
export let bakingKeptState = false;

/** Run `fn` with the bake scope `on` (or off), restored however `fn` leaves — a throw included, or every later template
 *  write would bake scene rows. The two writers that swallow a SCENE root: Create Prefab (`serializePrefab`'s
 *  `bakeKeptState`) and Apply's promotion of a scene-added reference node (`insertAddedSubtree`, #1802). */
export function withKeptStateBake<T>(on: boolean, fn: () => T): T {
  const prev = bakingKeptState;
  bakingKeptState = on;
  try { return fn(); } finally { bakingKeptState = prev; }
}

/** For the guard that a throw inside the scope leaves it unset. */
export const bakingKeptStateForTest = () => bakingKeptState;

/** The prefab the running `serializePrefab` REWRITES (its `existingId`), for a template reference node's writer to find
 *  the statement it is rewriting (#1804) — a scope, for the same reason as {@link bakingKeptState}. */
let rewritingPrefab: string | undefined;

/** Run `fn` as the write that rewrites `existingId`, restored however `fn` leaves — the shape of
 *  {@link withKeptStateBake}, and the only way `rewritingPrefab` is set. */
export function withRewritingPrefab<T>(existingId: string | undefined, fn: () => T): T {
  const prev = rewritingPrefab;
  rewritingPrefab = existingId;
  try { return fn(); } finally { rewritingPrefab = prev; }
}

/** The TEMPLATE statement that spawned the reference node rooted at `ecsId`: the node a prefab layer enclosing it states
 *  (`templateReferenceNode` — a node inside another instance's frame), else the node with its key in the prefab being
 *  rewritten (a prefab-edit world, where the row stating it is a top-level entry no prefab layer encloses). Keys are minted
 *  guids, so a key names one node in a document. Null for a node no template states yet. */
export function templateStatementOf(ecsId: number): AddedEntity | null {
  const enclosed = templateReferenceNode(ecsId, 0);
  if (enclosed) return enclosed;
  const doc = rewritingPrefab ? getCachedPrefabSync(rewritingPrefab) : null;
  const key = doc ? templateKeyOf(findEntity(ecsId)) || recoverTemplateKey(ecsId) : '';
  if (!doc || !key) return null;
  let hit: AddedEntity | null = null;
  const walk = (nodes: readonly AddedEntity[] | undefined): void => {
    for (const n of nodes ?? []) {
      if (hit) return;
      if (n.prefab && n.key === key) { hit = n; return; }
      walk(n.children);
      walk(n.added);
      for (const st of Object.values(n.nestedStructure ?? {})) walk(st.added);
      for (const r of Object.values(n.members ?? {})) { walk(r.added); walk(r.own); }
    }
  };
  for (const e of doc.entities) {
    walk(e.added);
    for (const st of Object.values(e.nestedStructure ?? {})) walk(st.added);
    for (const r of Object.values(e.members ?? {})) { walk(r.added); walk(r.own); }
  }
  return hit;
}

/** After the tag: what R2 kept for every root the new instance swallowed, left as the SCENE half of the bake. Its edits
 *  went into the template (`bakeKeptState`), so a root that became a MEMBER of the new instance keeps only each orphan
 *  row's identity, its pinned `guid` and `name`, moved to the new root under that root's member path (the scene writer
 *  reads kept rows only for a stored root) — a scene statement of the edit as well would pin the old value over any
 *  later template change. Its legacy channels are dropped: the template carries them, and a `moved` there is a scene
 *  guid no template form holds. A root the new instance's member rows do not name is left as it is (the rule and its two
 *  cases are at the test below); so is the selection root, whose own frame is not written as a row (`planPrefabRows`).
 *  Apply's promotion runs it too (#1802), over the instance its reference nodes were promoted into: after the refresh they
 *  are members of it, and the same rule leaves every root that is not — a stored one — alone.
 *  Returns the undo, which restores every entry it changed. */
export function settleSwallowedKeptState(rootId: number): () => void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return () => {};
  const guidOf = (id: number) => durableGuid((readTraitData(id, eaMeta) as { guid?: string } | null)?.guid);
  const rootGuid = guidOf(rootId);
  if (!rootGuid) return () => {};
  // In MEMBER-ROW form (`/<nodeGuid>/…`), the keys the scene writer and the loader address rows by — the one predicate
  // `captureInstanceMembers` writes through, not `memberPathIndex`, whose keys step by localId.
  const keyOf = new Map<number, string>(memberRowsToWrite(rootId));
  const before = new Map<string, KeptState | undefined>();
  const moved: Record<string, object> = {};
  for (const id of subtreeIds(getAllEntities(), rootId)) {
    if (id === rootId) continue;
    const guid = guidOf(id);
    const kept = guid ? keptStateOf(guid) : undefined;
    if (!kept) continue;
    // ONE rule leaves a root alone: the new instance's member rows do not name it. That is a root still stored (a scene-
    // added reference node, which the scene save writes whole over the template's node, so stripping it lost this very
    // instance's edit: close-out review F3), and EVERY root when the tag linked nothing — it refuses a tree that no longer
    // matches the file written, and a settle then stripped an unlinked instance for a template nothing points at (F6).
    const prefix = keyOf.get(id);
    if (prefix === undefined) continue;
    before.set(guid, kept);
    const identity: Record<string, object> = {};
    for (const [k, row] of Object.entries(kept.rows ?? {})) {
      const { guid: g, name } = row as { guid?: string; name?: string };
      if (durableGuid(g)) identity[k] = { guid: g, ...(name ? { name } : {}) };
    }
    restoreKeptState(guid, {});
    for (const [k, row] of Object.entries(identity)) moved[`${prefix}${k}`] = row;
  }
  if (Object.keys(moved).length) {
    const own = keptStateOf(rootGuid);
    before.set(rootGuid, own);
    restoreKeptState(rootGuid, { ...own, rows: { ...own?.rows, ...moved } });
  }
  return () => { for (const [g, st] of before) restoreKeptState(g, st ?? {}); };
}
