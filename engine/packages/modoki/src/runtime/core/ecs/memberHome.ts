/** What happens to a prefab instance's members when part of it goes — deleted, or stripped of
 *  `PrefabInstance` by a Detach Prefab or an unpack — and the walks that NAME a member by its path.
 *
 *  A member's derived guid, and the member path a template token names it by, are walks up its TEMPLATE
 *  parents, which `identityParents.ts` reads from the document the frame was expanded from (#1468 Phase 6).
 *  A member moved inside its instance (#1437) keeps walking from the row parent it left, and one whose row
 *  parent is gone keeps that row's step — both without anything recorded on the member. This module used
 *  to maintain that record (`PrefabInstance.homeParent` + `homeSteps`) and re-point it whenever a home
 *  died; the document makes both unnecessary. */

import type { Entity, World } from 'koota';
import { getCurrentWorld, indexEntityGuid } from './world';
import { getAllTraits, getTraitByName } from './traitRegistry';
import { deriveMemberGuid, remapGuidValues, durableGuid, memberPathSteps, entityStep, isStoredRoot, isOwnedRoot, type MemberStep, type MemberPi } from '../assetRefRules';
import { templateKeyOf } from '../templateIdentity';
import { memberRowsToWrite } from './memberRows';
import { memberPathKey } from '../templateRefs';
import { worldIdentityParents, type IdentityParents, type TemplateDocReader } from './identityParents';

type Pi = { localId?: number; parentLocalId?: number; ownerGuid?: string };

/** A member that outlives its instance: `data` is its `PrefabInstance` as it was, `guid` its own and
 *  `rootGuid` the root it belonged to, for an undo to relink it. */
export type DetachedMember = {
  guid: string; rootGuid: string; data: Record<string, unknown>;
  /** A promoted owned root's member rename ({@link promoteOwnedRoots}), `[old, new]` — reversed by the undo. */
  renamed?: [string, string][];
};

/** Before the entities in `gone` are destroyed (or stripped, #1453), detach every surviving member whose
 *  instance goes with them (#1437): a member MOVED out of its instance's subtree is not under the root being deleted, so it would
 *  otherwise stay linked to a dead root and vanish on the next reload. It stays where it was put, as a plain
 *  entity with its guid — what is on screen is what is saved. An OWNED nested root whose outer instance goes
 *  becomes a stored root instead, so its own members keep their instance. Returns what an undo needs. */
export function detachOrphanedMembers(gone: ReadonlySet<number>, world: World = getCurrentWorld()): DetachedMember[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !gone.size) return [];
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const guidOf = (e: Entity | undefined) => (e?.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  // The root of the instance whose row an owned nested root expanded from — its owner link when it was moved,
  // else its live parent's frame (`identityParents.ts`). A nested root carried out inside a moved member was
  // never moved itself, and its owner still dies (#1451): its live parent is that member, still in the frame.
  const parents = worldIdentityParents(world);
  const out: DetachedMember[] = [];
  const strip: Entity[] = [];
  const promote: Entity[] = [];
  for (const e of world.query(piMeta.trait) as Iterable<Entity>) {
    if (gone.has(e.id())) continue;
    const pi = e.get(piMeta.trait) as (Pi & { rootInstanceId?: number }) | undefined;
    if (!pi) continue;
    const root = pi.rootInstanceId ?? 0;
    const ownedRoot = isOwnedRoot(pi, e.id());
    // (An owned root also went when its HOME was still dying after the rehome — a home the rehome could not step
    // past. There is no home any more: its template parent is read from the document, which steps past a gone row.)
    if (ownedRoot ? !gone.has(parents.ownerOf(e.id())) : !gone.has(root)) continue;
    out.push({ guid: guidOf(e), rootGuid: ownedRoot ? '' : guidOf(byId.get(root)), data: { ...pi } });
    (ownedRoot ? promote : strip).push(e);
  }
  for (const e of strip) e.remove(piMeta.trait);
  // Promoted with its members renamed to the guids a reload derives under it (#1447). The whole rename rides on
  // the first promoted entry: one map, reversed as one by the undo.
  const renamed = [...promoteOwnedRoots(promote.map((e) => e.id()), world)];
  const first = out.find((d) => !d.rootGuid);
  if (first && renamed.length) first.renamed = renamed;
  return out;
}

/** The entities in `gone` stop being part of any instance: deleted, or stripped of `PrefabInstance` by a
 *  Detach Prefab or an unpack. Call it BEFORE they go (the owner walk reads their links). A member still
 *  linked to a frame that ends is promoted or unlinked ({@link detachOrphanedMembers}). A member moved away
 *  from one of them needs nothing: its path steps past a gone template row by the document
 *  (`identityParents.ts`), which is what a `rehomeDependents` half used to record on it (#1468 Phase 6).
 *  Every frame-ending path runs through this one call — Detach and unpack once skipped it, and a member moved
 *  out of the instance vanished on reload (#1453). Returns what an undo hands to {@link relinkDetachedMembers}. */
export function endFrames(gone: ReadonlySet<number>, world: World = getCurrentWorld()): DetachedMember[] {
  return detachOrphanedMembers(gone, world);
}

/** Undo {@link detachOrphanedMembers} once the deleted entities are back. */
export function relinkDetachedMembers(detached: readonly DetachedMember[], world: World = getCurrentWorld()): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !detached.length) return;
  // Undo a promotion's member rename first, so every guid below names what it did before the delete — one entry
  // at a time, last first, so a guid two promotions renamed in turn (a → b → c) walks all the way back.
  for (const d of [...detached].reverse()) {
    if (d.renamed?.length) applyGuidRemap(new Map(d.renamed.map(([a, b]) => [b, a] as [string, string])), world);
  }
  const byGuid = new Map<string, Entity>();
  for (const e of world.entities as Iterable<Entity>) {
    const g = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) byGuid.set(g, e);
  }
  for (const d of detached) {
    const e = byGuid.get(d.guid);
    if (!e) continue;
    const root = d.rootGuid ? byGuid.get(d.rootGuid)?.id() : e.id();
    if (!root) continue;
    if (e.has(piMeta.trait)) e.set(piMeta.trait, { ...d.data, rootInstanceId: root });
    else e.add(piMeta.trait({ ...d.data, rootInstanceId: root } as never));
  }
}

/** Each prefab member among `ids` and the guid of the instance root it belongs to — taken before a delete, so
 *  an undo that respawns them in any order can point each member back at its (respawned) root afterwards. A
 *  member respawned BEFORE its root would otherwise keep the dead root's id (#1437: a member moved out of its
 *  root's subtree is its own delete target, so the two are separate snapshots). */
export function captureRootLinks(ids: Iterable<number>, world: World = getCurrentWorld()): { guid: string; rootGuid: string }[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return [];
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const guidOf = (e: Entity | undefined) => (e?.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  const out: { guid: string; rootGuid: string }[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    const pi = e?.has(piMeta.trait) ? (e.get(piMeta.trait) as { rootInstanceId?: number } | undefined) : undefined;
    if (!pi?.rootInstanceId || pi.rootInstanceId === id) continue;
    const guid = guidOf(e);
    const rootGuid = guidOf(byId.get(pi.rootInstanceId));
    if (guid && rootGuid) out.push({ guid, rootGuid });
  }
  return out;
}

/** Undo half of {@link captureRootLinks}. */
export function restoreRootLinks(links: readonly { guid: string; rootGuid: string }[], world: World = getCurrentWorld()): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !links.length) return;
  const byGuid = new Map<string, Entity>();
  for (const e of world.entities as Iterable<Entity>) {
    const g = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) byGuid.set(g, e);
  }
  for (const { guid, rootGuid } of links) {
    const e = byGuid.get(guid);
    const root = byGuid.get(rootGuid);
    if (!e?.has(piMeta.trait) || !root) continue;
    const pi = e.get(piMeta.trait) as Record<string, unknown>;
    if (pi.rootInstanceId !== root.id()) e.set(piMeta.trait, { ...pi, rootInstanceId: root.id() });
  }
}

/** An entity's step below its parent in the derive walk: `entityStep`, and `null` for a node no
 *  template can name (no key and no `PrefabInstance`). */
function memberStepOf(e: Entity, piTrait: Parameters<Entity['has']>[0]): MemberStep | null {
  const key = templateKeyOf(e);
  if (!key && !e.has(piTrait)) return null;
  return entityStep(e.has(piTrait) ? (e.get(piTrait) as MemberPi) : null, key);
}

/** Every member a template frame rooted at `rootEcsId` can name: path key → entity. The root is `''`.
 *  It does not descend into another STORED root, a user-added nested instance, which is its own frame;
 *  that root itself is still a target. A step two siblings share names neither of them. */
export function memberPathIndex(
  world: World, rootEcsId: number,
  /** The world's identity tree, when the caller indexes several frames in one pass. */
  tree: IdentityTree = identityTree(world),
): Map<string, Entity | null> {
  const { children, parents } = tree;
  const piMeta = getTraitByName('PrefabInstance');
  const out = new Map<string, Entity | null>();
  // Found by the world walk rather than the entity index: the editor reaches this from Apply, whose
  // tests stub the world module by an explicit export list.
  let root: Entity | undefined;
  for (const e of world.entities as Iterable<Entity>) if (e.id() === rootEcsId) { root = e; break; }
  if (!piMeta || !root) return out;
  out.set('', root);
  const stack: [Entity, MemberStep[]][] = [[root, []]];
  const seen = new Set<number>([rootEcsId]);
  while (stack.length) {
    const [e, path] = stack.pop()!;
    for (const c of children.get(e.id()) ?? []) {
      if (seen.has(c.id())) continue;
      seen.add(c.id());
      const step = memberStepOf(c, piMeta.trait);
      if (step === null) continue;
      const at = [...path, ...parents.of(c.id()).extra, step];
      const key = memberPathKey(at);
      out.set(key, out.has(key) ? null : c);
      const pi = c.has(piMeta.trait) ? c.get(piMeta.trait) as MemberPi : null;
      if (!isStoredRoot(pi, c.id())) stack.push([c, at]);
    }
  }
  return out;
}

/** A world's IDENTITY tree: each entity under its identity parent (`identityParents.ts`), with the
 *  resolver it was built from — whose `extra` steps a path walk needs beside the parent. */
export interface IdentityTree { children: Map<number, Entity[]>; parents: IdentityParents }

export function identityTree(world: World, fallback?: TemplateDocReader): IdentityTree {
  const attrMeta = getTraitByName('EntityAttributes');
  const parents = worldIdentityParents(world, fallback);
  const children = new Map<number, Entity[]>();
  if (!attrMeta) return { children, parents };
  for (const e of world.entities as Iterable<Entity>) {
    if (!e.has(attrMeta.trait)) continue;
    const parent = parents.parentOf(e.id());
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  return { children, parents };
}

/** Re-point every ref a live trait holds from a key of `remap` to its value — every field of every trait
 *  except an entity's own `EntityAttributes.guid`, which is the caller's to set. */
export function remapWorldGuidRefs(remap: ReadonlyMap<string, string>, world: World = getCurrentWorld()): void {
  if (!remap.size) return;
  const traits = getAllTraits();
  for (const e of world.entities as Iterable<Entity>) {
    for (const meta of traits) {
      if (!e.has(meta.trait)) continue;
      const data = e.get(meta.trait) as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') continue;
      const next = remapGuidValues(data, remap) as Record<string, unknown>;
      if (next === data) continue;
      if (meta.name === 'EntityAttributes') next.guid = data.guid;
      e.set(meta.trait, next);
    }
  }
}

/** Rename entities and every ref to them: each entity whose guid is a key of `remap` takes its value, then
 *  every ref in the world follows. Its own inverse, so an undo passes the map reversed. */
export function applyGuidRemap(remap: ReadonlyMap<string, string>, world: World = getCurrentWorld()): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta || !remap.size) return;
  const renamed: Entity[] = [];
  for (const e of world.entities as Iterable<Entity>) {
    if (!e.has(eaMeta.trait)) continue;
    const ea = e.get(eaMeta.trait) as { guid?: string };
    const next = ea.guid ? remap.get(ea.guid) : undefined;
    if (next === undefined) continue;
    e.set(eaMeta.trait, { ...ea, guid: next });
    renamed.push(e);
  }
  remapWorldGuidRefs(remap, world);
  for (const e of renamed) indexEntityGuid(e, world);
}

/** Give every member of the instance rooted at `rootEcsId` the guid a RELOAD will derive for it, and
 *  return the rename it took (old guid → new), already applied (#1461).
 *
 *  Create Prefab tags a LIVE tree as an instance: the entities keep the random guids they had as plain
 *  entities, while the prefab file just written says `guid: ''` on every row — so the reload derives each
 *  member's guid from the anchor and its path, and the two disagree until the first save+reload. Anything
 *  written in that window naming a member BY GUID (`moved`'s value, a ref into a member, an override
 *  value) names a guid that will never exist again, and the load-time derive pass cannot repair it after
 *  the fact: it fills EMPTY guids only. So the window is closed where it opens.
 *
 *  ⚠️ The rename is NOT a new identity change — the reload performs it today, silently and with no ref
 *  repair at all. Doing it here makes it eager and repaired.
 *
 *  The root keeps its guid: it is the anchor, and both Create Prefab callers resolve the tagged subtree by
 *  it across a world rebuild. A STORED root below (a user-added nested instance) keeps its own for the same
 *  reason, exactly as {@link promoteOwnedRoots} skips one — this is that function run the other way.
 *  Undo: {@link applyGuidRemap} with the map reversed, and BEFORE the prior links go back, because
 *  `detachPrefabInstance`'s snapshot addresses every member by the guid it had when it was taken.
 *
 *  ⚠️ **A member the save will write a ROW for is SKIPPED** (scene v16, #1468). The window above is
 *  "the reload will derive a different guid"; a stored row means the reload PINS the guid the member
 *  already has, so there is no window and renaming would move identity for nothing — the same
 *  reasoning, and the same skip, as {@link promoteOwnedRoots}'s.
 *
 *  ⚠️ **This is why the stamp still EXISTS.** #1468 Phase 2B set out to DELETE it, and could not: a
 *  row exists only where the TEMPLATE minted a `nodeGuid`, so a member of a PRE-v5 template gets none
 *  and the window is still open for exactly those members. Retiring it needs every template it can
 *  meet at v5 — which is also why Phase 4 could not delete the localId key space: the repo's corpus
 *  is v5, but every prefab the released editor wrote is not (plan § 4 Phase 4's ruling), so neither
 *  retires while such a prefab can be opened. Found by a TEST, not by reading: deleting the stamp
 *  reddened `createPrefabMemberIdentity.test.ts`'s nested-instance case, whose child template is a
 *  hand-written pre-v5 document. */
export function stampDerivedMemberGuids(rootEcsId: number, world: World = getCurrentWorld()): Map<string, string> {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const remap = new Map<string, string>();
  if (!piMeta || !eaMeta) return remap;
  const guidOf = (e: Entity) => (e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  const index = memberPathIndex(world, rootEcsId, identityTree(world));
  const root = index.get('');
  // ⚠️ DURABLE only. A runtime guid (#1210) dies with its world, so deriving members from one would
  // bake identities the next reload cannot reproduce — the very defect this closes, one level up.
  // Both Create Prefab callers mint a durable guid (`entityRef` → `ensureGuid`) before tagging, so in
  // production this is a floor, not a live branch.
  const anchor = root ? durableGuid(guidOf(root)) : '';
  if (!anchor) return remap; // unaddressable before, and after: nothing derives from it
  // The members the next save will STATE a guid for, so no reload has to derive one (v16).
  // ⚠️ `memberRowsToWrite`, not `memberRowKeysIn`: a KEYED member with no durable guid gets no row,
  // and skipping it here on the premise that a row covers it reopens #1461's window for it.
  const keyed = memberRowsToWrite(rootEcsId, world);
  for (const [key, e] of index) {
    if (!key || !e) continue; // the root itself, and a step two siblings share
    if (isStoredRoot(e.has(piMeta.trait) ? (e.get(piMeta.trait) as MemberPi) : null, e.id())) continue; // a stored root keeps its stored guid
    if (keyed.has(e.id())) continue; // a stored row states its guid — see the docblock
    const old = guidOf(e);
    // A member with NO guid is left alone: nothing can reference it, and the load-time pass fills it.
    const next = deriveMemberGuid(anchor, memberPathSteps(key));
    if (old && old !== next) remap.set(old, next);
  }
  applyGuidRemap(remap, world);
  return remap;
}

/** Make each OWNED nested root in `roots` a STORED root — a standalone instance of its own prefab — and
 *  return the rename its members took (old guid → new), already applied (#1447).
 *
 *  An owned root's members derive their guids from the OUTER instance's anchor, through the row that
 *  expanded them. A stored root is an anchor itself: the save writes its guid and the reload derives its
 *  members from it. So without the rename, every member would reload under a guid no live ref names
 *  (#1349's shape). The root keeps its guid, which becomes stored; each member below it — down to, not
 *  into, another stored root — takes the guid the reload derives, and every ref follows.
 *  Undo: {@link applyGuidRemap} with the map reversed, then put the roots' `PrefabInstance` back.
 *
 *  ⚠️ **A member the save will write a ROW for is NOT renamed (scene v16, § 3.3 R7).** The rename's
 *  entire premise is *"the reload will DERIVE this member's guid, so the live one must match what it
 *  derives"*. Once a row states the guid, the reload reads it and the premise is gone — renaming
 *  anyway moves a guid for no reader and drags every external reference along with it.
 *
 *  ⚠️ This is the **deliberate divergence from a QA-measured contract** § 3.3 R7 flags:
 *  `qa/knowledge.md`'s promotion row records that promotion today re-derives its members' guids. That stops
 *  being true where the template mints identity, and stays true where it does not — a pre-v5
 *  template has no rows, so the reload really does derive and the rename is still what keeps the
 *  live world honest.
 *
 *  ⚠️ It is sound only because a promoted root has somewhere to WRITE those rows wherever it lands:
 *  its own scene entry if it ends up top-level, and `AddedEntity.members` if it stays inside another
 *  instance as a reference node. The reference-node slot was added in the same change for this
 *  reason — without it this skip silently loses the identity it is trying to keep. */
export function promoteOwnedRoots(roots: Iterable<number>, world: World = getCurrentWorld()): Map<string, string> {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const remap = new Map<string, string>();
  if (!piMeta || !eaMeta) return remap;
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const promoted: Entity[] = [];
  for (const id of roots) {
    const e = byId.get(id);
    const pi = e?.has(piMeta.trait) ? (e.get(piMeta.trait) as Pi & { rootInstanceId?: number }) : undefined;
    if (!e || !pi || !isOwnedRoot(pi, id)) continue;   // `!pi` restores TS's proof for the spread below
    e.set(piMeta.trait, { ...pi, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '' });
    promoted.push(e);
  }
  const guidOf = (e: Entity) => (e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  const tree = identityTree(world);
  for (const root of promoted) {
    const anchor = guidOf(root);
    if (!anchor) continue; // unaddressable before, and after: nothing derives from it
    // The members the next save will STATE a guid for, so no reload has to derive one (R7).
    // `memberRowsToWrite`, not `memberRowKeysIn` — see the same note in `stampDerivedMemberGuids`.
    const keyed = memberRowsToWrite(root.id(), world);
    for (const [key, e] of memberPathIndex(world, root.id(), tree)) {
      if (!key || !e) continue;
      if (isStoredRoot(e.has(piMeta.trait) ? (e.get(piMeta.trait) as MemberPi) : null, e.id())) continue; // a stored root keeps its stored guid
      if (keyed.has(e.id())) continue; // a stored row states its guid — see the docblock
      const old = guidOf(e);
      const next = deriveMemberGuid(anchor, memberPathSteps(key));
      if (old && old !== next) remap.set(old, next);
    }
  }
  applyGuidRemap(remap, world);
  return remap;
}
