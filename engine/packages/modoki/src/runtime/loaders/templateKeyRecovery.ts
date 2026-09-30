/** Recovering a template key a live node lost (#1426, widening #1387's editor-only recovery).
 *
 *  A node a prefab template ADDED is stamped with `TemplateAddedKey` when the template spawns it, and
 *  every reader that names it — the loader's derive pass and member-token resolution, the editor's
 *  override comparison and template writes — steps through it as `'+' + key`. The marker is
 *  deliberately unregistered, so every path that rebuilds the entity from another form loses it: a
 *  scene save writes the node's durable guid and no key (so a reload spawns it unkeyed), Play→Stop
 *  reloads such a save, and a registry-built snapshot never sees it.
 *
 *  Every one of those paths keeps the node's GUID, and a keyed node's guid is
 *  `deriveMemberGuid(anchor, [...path, '+' + key])`. So the key is recoverable from the guid: try each
 *  ancestor as the anchor, with each key a known prefab declares, until the derivation reproduces it.
 *  The loader heals every loaded world this way (`deriveInstanceMemberGuids`), and the editor's
 *  template write calls the same function. Runtime never MINTS a key — only the editor does, when
 *  nothing matches — so the result depends only on the world and the prefab documents. */

import type { World } from 'koota';
import { deriveMemberGuid, addedKeyStep, entityStep, memberRowNodes, type MemberStep } from '../core/assetRefRules';
import type { PackedEntity } from '../core/ecs/entityTable';

/** The slice of a prefab document the key walk reads (a `PrefabFile` / loader doc fits structurally). */
type KeyedNode = { key?: string; prefab?: string; children?: KeyedNode[]; added?: KeyedNode[]; nestedStructure?: StructurePaths; members?: MemberRows };
type StructurePaths = Record<string, { added?: KeyedNode[] } | undefined>;
type MemberRows = Record<string, { added?: unknown; own?: unknown } | null | undefined>;
export type TemplateKeyDoc = { entities: Array<{ localId?: number; prefab?: string; added?: KeyedNode[]; nestedStructure?: StructurePaths; members?: MemberRows }> };

/** Every template key a prefab document declares — its rows' `added`, their `nestedStructure[*].added`
 *  and `members` rows' nodes (prefab v6, #1533), and a reference node's own `added`/`nestedStructure`/`members`
 *  (a template reference node carries rows too since #1538), recursively. Memoised per document object. */
const keysByDoc = new WeakMap<object, string[]>();
export function templateKeysOf(doc: TemplateKeyDoc): string[] {
  const memo = keysByDoc.get(doc);
  if (memo) return memo;
  const keys: string[] = [];
  eachKeyedNode(doc, (n) => { keys.push(n.key!); });
  keysByDoc.set(doc, keys);
  return keys;
}

/** Every node of `doc` carrying a template key, in DOCUMENT order — the one walk {@link templateKeysOf},
 *  {@link declaredTemplateKeys} and {@link nestedDeclaredKeys} share. */
function eachKeyedNode(doc: TemplateKeyDoc, visit: (n: KeyedNode) => void): void {
  const nodes = (list: KeyedNode[] | undefined): void => {
    for (const n of list ?? []) {
      if (n.key) visit(n);
      nodes(n.children);
      nodes(n.added);
      structure(n.nestedStructure);
      rows(n.members);
    }
  };
  const rows = (members: MemberRows | undefined): void => {
    for (const row of Object.values(members ?? {})) nodes(memberRowNodes(row) as KeyedNode[]);
  };
  const structure = (paths: StructurePaths | undefined): void => {
    for (const delta of Object.values(paths ?? {})) nodes(delta?.added);
  };
  for (const pe of doc.entities ?? []) {
    nodes(pe.added);
    structure(pe.nestedStructure);
    rows(pe.members);
  }
}

/** `steps` — a member path inside the frame of `doc`, ending in a template key — respelled as #1809 derives it: the
 *  steps up to the last one that ENTERS a frame (a nested row, or a keyed reference node), then the key. A path written
 *  before #1809 spells the steps to the node's anchor and any keyed parent (`2.3.+K` for today's `+K`); a flat one comes
 *  back unchanged. Walks the documents (`readPrefab`), so it answers where no live world exists yet: the prefab-edit
 *  world's token mapping (`editGuidAt`), which runs before anything is spawned. Anything else comes back as it is. */
export function flatKeyedSteps(steps: readonly MemberStep[], doc: TemplateKeyDoc | null | undefined, readPrefab: (guid: string) => TemplateKeyDoc | null | undefined): MemberStep[] {
  const last = steps[steps.length - 1];
  if (typeof last !== 'string' || !last.startsWith('+') || !doc) return [...steps];
  let cur: TemplateKeyDoc | null | undefined = doc;
  let keep = 0;
  for (let i = 0; i < steps.length - 1 && cur; i++) {
    const s = steps[i];
    let enters: string | undefined;
    if (typeof s === 'number') enters = cur.entities.find((e) => e.localId === s)?.prefab;
    else if (s.startsWith('+')) eachKeyedNode(cur, (n) => { if (!enters && n.key === s.slice(1) && n.prefab) enters = n.prefab; });
    if (enters) { cur = readPrefab(enters); keep = i + 1; }
  }
  return [...steps.slice(0, keep), last];
}

/** The keys the prefabs `doc` NESTS declare — every document reachable through its rows' and its reference nodes'
 *  `prefab`, recursively — and not `doc`'s own. What a prefab-edit copy keeps (`copySnapshot`): a key a deeper
 *  template declares names that template's node, which the copy still is; any other key is the edited document's, or
 *  one no document declares yet (an earlier copy's this session, a Detach's stale marker), and mints (#1809). */
export function nestedDeclaredKeys(doc: TemplateKeyDoc, readPrefab: (guid: string) => TemplateKeyDoc | null | undefined): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const sourcesOf = (d: TemplateKeyDoc): string[] => {
    const found: string[] = [];
    for (const e of d.entities ?? []) if (e.prefab) found.push(e.prefab);
    eachKeyedNode(d, (n) => { if (n.prefab) found.push(n.prefab); });
    return found;
  };
  const stack = sourcesOf(doc);
  while (stack.length) {
    const g = stack.pop()!;
    if (seen.has(g)) continue;
    seen.add(g);
    const d = readPrefab(g);
    if (!d) continue;
    eachKeyedNode(d, (n) => { out.add(n.key!); });
    stack.push(...sourcesOf(d));
  }
  return out;
}

/** The keys `doc` declares NOW — {@link templateKeysOf} without its memo, for a document a writer is still changing. */
export function declaredTemplateKeys(doc: TemplateKeyDoc): Set<string> {
  const out = new Set<string>();
  eachKeyedNode(doc, (n) => { out.add(n.key!); });
  return out;
}

/** Every template key `doc` declares twice within ONE frame, with that frame — what `validatePrefabData` reports (#1809,
 *  owner ruling (A)). A keyed node's guid is its frame's path plus its key, so two nodes of one frame sharing a key
 *  share a guid (I7). Keys are kept unique at the sources (a prefab-edit copy mints every key no nested prefab declares;
 *  a promotion does not carry a key its target declares or already wrote), and no ordinary edit on an older build made a
 *  same-frame repeat either (a copy of a keyed node or of a member above it took no key; a nested row's duplicate is a
 *  new frame). So such a repeat comes from a hand edit or a merge, and is REPORTED, never rewritten: a load-time re-key
 *  was built and dropped, since it renamed keys the scenes' statements name (#1872's pinned lists and node rows). A
 *  repeat across two frames collides on no guid and is not reported.
 *
 *  The frame of a node, as a label: a row's own `added` and each `nestedStructure` path of it; a member row's nodes by
 *  the row key's frame chain (every component but the member's own); a keyed REFERENCE node's `added`, slots and rows
 *  in its own frame; `children` in their parent's. Two lists the label cannot tell apart as one frame (a row's own
 *  `added` beside its member rows) are two labels, so the check under-reports there rather than invent a repeat. */
export function sameFrameRepeatedKeys(doc: TemplateKeyDoc): Array<{ frame: string; key: string }> {
  const seen = new Map<string, Set<string>>();
  const out: Array<{ frame: string; key: string }> = [];
  const note = (frame: string, key: string): void => {
    let keys = seen.get(frame);
    if (!keys) seen.set(frame, (keys = new Set()));
    if (!keys.has(key)) { keys.add(key); return; }
    if (!out.some((o) => o.frame === frame && o.key === key)) out.push({ frame, key });
  };
  // Defensive at every level: the validator's contract is warn-but-load, never throw, on any shape (a hand edit).
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const nodes = (list: unknown, frame: string): void => {
    if (!Array.isArray(list)) return;
    for (const n of list as KeyedNode[]) {
      if (!isObj(n)) continue;
      if (typeof n.key === 'string' && n.key) note(frame, n.key);
      nodes(n.children, frame);
      const own = n.prefab && n.key ? `${frame} / node ${n.key}` : frame;
      nodes(n.added, own);
      structure(n.nestedStructure, own);
      rows(n.members, own);
    }
  };
  const rows = (members: unknown, frame: string): void => {
    if (!isObj(members)) return;
    for (const [k, row] of Object.entries(members)) {
      const chain = k.split('/').filter(Boolean).slice(0, -1);
      nodes(memberRowNodes(row), chain.length ? `${frame} / ${chain.join('/')}` : frame);
    }
  };
  const structure = (paths: unknown, frame: string): void => {
    if (!isObj(paths)) return;
    for (const [path, delta] of Object.entries(paths)) nodes(isObj(delta) ? delta.added : undefined, `${frame} / slot ${path}`);
  };
  for (const pe of Array.isArray(doc?.entities) ? doc.entities : []) {
    if (!isObj(pe)) continue;
    const frame = `row localId=${String(pe.localId)}`;
    nodes(pe.added, frame);
    structure(pe.nestedStructure, frame);
    rows(pe.members, frame);
  }
  return out;
}

/** The template keys of every prefab document expanded into a world — the candidates its heal tries.
 *  Keyed per world like the loader's other per-world state, so a swapped-out world takes its set with it. */
const keysByWorld = new WeakMap<World, Set<string>>();
export function noteTemplateDoc(world: World, doc: TemplateKeyDoc): void {
  const keys = templateKeysOf(doc);
  if (!keys.length) return;
  let set = keysByWorld.get(world);
  if (!set) { set = new Set(); keysByWorld.set(world, set); }
  for (const k of keys) set.add(k);
}
export function templateKeysIn(world: World): ReadonlySet<string> {
  return keysByWorld.get(world) ?? EMPTY;
}

/** Per world: packed entity (generation included, #868) → the `guid|keyCount|ancestorChain` a heal already tried and could not
 *  recover. The derive pass runs on EVERY runtime prefab spawn (a pool row, a timeline clip), so
 *  without this each spawn re-walked every unrecoverable node in the world (#1426 close-out review:
 *  2000 entities, 5 keys, 51 ms per spawn). A new guid, a new key or a reparent invalidates it. */
const missesByWorld = new WeakMap<World, Map<PackedEntity, string>>();
export function healMissesIn(world: World): Map<PackedEntity, string> {
  let m = missesByWorld.get(world);
  if (!m) { m = new Map(); missesByWorld.set(world, m); }
  return m;
}
const EMPTY: ReadonlySet<string> = new Set();

/** What the recovery walk reads of one entity. `guid` is its DURABLE guid ('' when none). */
export interface KeyRecoveryNode {
  guid: string;
  parentId: number;
  /** Its template key if it still carries the marker, else ''. */
  key: string;
  pi: { localId?: number; parentLocalId?: number } | null;
  /** The steps between its identity parent and its own step: the template rows between that are gone —
   *  deleted or unpacked (#1437). `parentId` is its IDENTITY parent: its template parent, for a member moved
   *  inside its instance (`core/ecs/identityParents.ts`) — the chain its guid was derived along. */
  extra?: MemberStep[];
}

/** The template key the node `ecsId` was spawned with, recovered from its guid. `''` when nothing
 *  matches: the node was not spawned from a template key (a user-added node has a random guid, a
 *  duplicate a fresh one, a moved node a different path — none of them derive from a key).
 *
 *  A plain ancestor that lost its own marker recovers first; the memo keeps the whole walk linear in
 *  depth (a recursion at every ancestor was 2^depth: measured 1 s per node at depth 14 — #1352 review).
 *
 *  `isTop` bounds the climb: the walk tries an ancestor for which it returns true as the anchor, then
 *  stops. The loader passes "a top-level stored instance root" — a keyed node's original anchor is
 *  always at or below it — so a node never walks to the scene root trying keys at every level.
 *
 *  `startOf`: where the node's path continues from IF it is keyed — `IdentityParents.derivesFromAsKeyed`, its frame
 *  root with no steps (#1809: a keyed node derives from its frame root, not its anchor). Omitted, the walk starts at
 *  `self.parentId`, the rule before #1809. The ancestor walk from there is the derive pass's, so the parent-key
 *  recursion below is reached only when the start is a keyed node's live parent (the legacy rule of the v18 upgrade):
 *  nothing keyed sits above a frame root. */
export function recoverTemplateKey(
  ecsId: number,
  nodeOf: (id: number) => KeyRecoveryNode | undefined,
  keys: ReadonlySet<string>,
  memo: Map<number, string> = new Map(),
  isTop?: (id: number) => boolean,
  startOf?: (id: number) => { parentId: number; extra: MemberStep[] },
): string {
  const done = memo.get(ecsId);
  if (done !== undefined) return done;
  memo.set(ecsId, ''); // a parent cycle resolves to nothing instead of recursing
  if (!keys.size) return '';
  const self = nodeOf(ecsId);
  if (!self?.guid) return '';
  const start = startOf?.(ecsId);
  const steps: MemberStep[] = [...(start?.extra ?? [])];
  let cur = start ? start.parentId : self.parentId;
  const seen = new Set<number>([ecsId]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = nodeOf(cur);
    if (!node) break;
    if (node.guid) {
      for (const k of keys) {
        if (deriveMemberGuid(node.guid, [...steps, addedKeyStep(k)]) === self.guid) { memo.set(ecsId, k); return k; }
      }
    }
    if (isTop?.(cur)) break;
    // This ancestor is on the path, not the anchor: prepend its step, as the derive pass does. A
    // prefab member steps by its localId. A keyed REFERENCE root that lost its marker (#1438) never
    // reaches this line in the loader: it is a stored root, so `isTop` already tried it as the anchor.
    const step = node.key || node.pi ? entityStep(node.pi, node.key)
      : (() => { const k = recoverTemplateKey(cur, nodeOf, keys, memo, isTop, startOf); return k ? addedKeyStep(k) : 0; })();
    steps.unshift(...(node.extra ?? []), step);
    cur = node.parentId;
  }
  return '';
}
