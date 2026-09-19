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
import { deriveMemberGuid, memberStepId, addedKeyStep } from '../core/assetRefRules';
import type { PackedEntity } from '../core/ecs/entityTable';

/** The slice of a prefab document the key walk reads (a `PrefabFile` / loader doc fits structurally). */
type KeyedNode = { key?: string; children?: KeyedNode[]; added?: KeyedNode[]; nestedStructure?: StructurePaths };
type StructurePaths = Record<string, { added?: KeyedNode[] } | undefined>;
export type TemplateKeyDoc = { entities: Array<{ added?: KeyedNode[]; nestedStructure?: StructurePaths }> };

/** Every template key a prefab document declares — its rows' `added`, their `nestedStructure[*].added`,
 *  and a reference node's own `added`/`nestedStructure`, recursively. Memoised per document object. */
const keysByDoc = new WeakMap<object, string[]>();
export function templateKeysOf(doc: TemplateKeyDoc): string[] {
  const memo = keysByDoc.get(doc);
  if (memo) return memo;
  const keys: string[] = [];
  const nodes = (list: KeyedNode[] | undefined): void => {
    for (const n of list ?? []) {
      if (n.key) keys.push(n.key);
      nodes(n.children);
      nodes(n.added);
      structure(n.nestedStructure);
    }
  };
  const structure = (paths: StructurePaths | undefined): void => {
    for (const delta of Object.values(paths ?? {})) nodes(delta?.added);
  };
  for (const pe of doc.entities ?? []) { nodes(pe.added); structure(pe.nestedStructure); }
  keysByDoc.set(doc, keys);
  return keys;
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
 *  always at or below it — so a node never walks to the scene root trying keys at every level. */
export function recoverTemplateKey(
  ecsId: number,
  nodeOf: (id: number) => KeyRecoveryNode | undefined,
  keys: ReadonlySet<string>,
  memo: Map<number, string> = new Map(),
  isTop?: (id: number) => boolean,
): string {
  const done = memo.get(ecsId);
  if (done !== undefined) return done;
  memo.set(ecsId, ''); // a parent cycle resolves to nothing instead of recursing
  if (!keys.size) return '';
  const self = nodeOf(ecsId);
  if (!self?.guid) return '';
  const steps: (number | string)[] = [];
  let cur = self.parentId;
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
    const step = node.key ? addedKeyStep(node.key)
      : node.pi ? memberStepId(node.pi)
      : (() => { const k = recoverTemplateKey(cur, nodeOf, keys, memo, isTop); return k ? addedKeyStep(k) : 0; })();
    steps.unshift(step);
    cur = node.parentId;
  }
  return '';
}
