/** A prefab member's HOME — where its identity steps from once it has been moved inside its instance
 *  (#1437). A member's derived guid, and the member path a template token names it by, are walks up its
 *  ROW parents. A member moved to another parent keeps walking from the row parent it left:
 *
 *  - `PrefabInstance.homeParent` — the guid of the entity its identity walk continues from; '' = not moved.
 *  - `PrefabInstance.homeSteps` — step ids that sit BETWEEN that entity and the member's own step, '.'-joined.
 *    Empty while the home is the row parent itself. It fills when a home stops being part of the walk (deleted,
 *    or unpacked): the member then walks from the home's own identity parent, carrying the home's step, so
 *    its path — and so its guid — is exactly what it was. That is also what a reload derives, since the
 *    loader expands a removed row until the member has been derived through it.
 *
 *  Every walk that derives or names a member goes through {@link identityParentId} and {@link homeStepsOf}. */

import type { Entity, World } from 'koota';
import { getCurrentWorld, indexEntityGuid } from './world';
import { getAllTraits, getTraitByName } from './traitRegistry';
import { memberStepId, deriveMemberGuid, remapGuidValues } from '../assetRefRules';
import { templateKeyOf, addedKeyStep } from '../templateIdentity';
import { memberPathKey, type MemberStep } from '../templateRefs';

/** The parent an entity's IDENTITY steps from: its home when it has one that still resolves, else its live parent. */
export function identityParentId(parentId: number, homeParent: string | undefined, idOfGuid: (guid: string) => number | undefined): number {
  return (homeParent && idOfGuid(homeParent)) || parentId;
}

/** The step ids between a member's home and its own step (see the module doc). */
export function homeStepsOf(pi: { homeSteps?: string } | null | undefined): number[] {
  const s = pi?.homeSteps;
  return s ? s.split('.').map(Number) : [];
}

type Pi = { homeParent?: string; homeSteps?: string; localId?: number; parentLocalId?: number };

/** Before the entities in `gone` stop being part of any identity walk — destroyed, or stripped of
 *  `PrefabInstance` — re-point every surviving member whose home is one of them to that home's own identity
 *  parent, carrying the home's steps. Equivalence-preserving, so it needs no undo: a respawned home leaves the
 *  member's path unchanged. */
export function rehomeDependents(gone: ReadonlySet<number>, world: World = getCurrentWorld()): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !gone.size) return;
  const dependents: Entity[] = [];
  for (const e of world.query(piMeta.trait) as Iterable<Entity>) {
    if (!gone.has(e.id()) && (e.get(piMeta.trait) as Pi | undefined)?.homeParent) dependents.push(e);
  }
  if (!dependents.length) return;
  const byGuid = new Map<string, Entity>();
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) {
    byId.set(e.id(), e);
    const guid = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (guid) byGuid.set(guid, e);
  }
  const guidOf = (e: Entity | undefined) => (e?.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  for (const m of dependents) {
    const pi = m.get(piMeta.trait) as Pi;
    let home = pi.homeParent ?? '';
    let steps = homeStepsOf(pi);
    for (let h = byGuid.get(home), n = 0; h && gone.has(h.id()) && n < 10_000; h = byGuid.get(home), n++) {
      const hpi = h.has(piMeta.trait) ? (h.get(piMeta.trait) as Pi & { rootInstanceId?: number } | undefined) : undefined;
      if (!hpi) break; // a home is always a member; a plain one cannot be stepped through
      // Nor any instance ROOT, stored or owned. A root home is the root of the frame the dependent's row lives
      // in (its own frame for a member, its owner's for an owned nested root), and that frame dies with it.
      // `detachOrphanedMembers` handles that member instead — every caller runs the two through `endFrames`
      // (#1453) — promoting an owned nested root and unlinking anything else. Stepping through an OWNED root
      // re-pointed a moved nested root at its grandparent frame, which records no move for it, so it vanished
      // on reload (#1451).
      if (hpi.rootInstanceId === h.id()) break;
      steps = [...homeStepsOf(hpi), memberStepId(hpi), ...steps];
      const liveParent = byId.get((h.get(eaMeta.trait) as { parentId?: number }).parentId ?? 0);
      home = hpi.homeParent || guidOf(liveParent);
    }
    if (home === pi.homeParent && steps.join('.') === (pi.homeSteps ?? '')) continue;
    m.set(piMeta.trait, { ...pi, homeParent: home, homeSteps: steps.join('.') });
  }
}

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
  const byGuid = new Map<string, Entity>();
  for (const e of world.entities as Iterable<Entity>) {
    byId.set(e.id(), e);
    const g = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) byGuid.set(g, e);
  }
  const guidOf = (e: Entity | undefined) => (e?.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  // The root of the instance whose row an owned nested root expanded from: its identity parent's frame. Not its
  // home alone — a nested root carried out inside a moved member has no home, and its owner still dies (#1451).
  const ownerOf = (e: Entity, pi: Pi): number => {
    const live = (e.get(eaMeta.trait) as { parentId?: number } | undefined)?.parentId ?? 0;
    const parent = byId.get(identityParentId(live, pi.homeParent, (g) => byGuid.get(g)?.id()));
    const ppi = parent?.has(piMeta.trait) ? (parent.get(piMeta.trait) as { rootInstanceId?: number } | undefined) : undefined;
    return ppi?.rootInstanceId ?? 0;
  };
  const out: DetachedMember[] = [];
  const strip: Entity[] = [];
  const promote: Entity[] = [];
  for (const e of world.query(piMeta.trait) as Iterable<Entity>) {
    if (gone.has(e.id())) continue;
    const pi = e.get(piMeta.trait) as (Pi & { rootInstanceId?: number }) | undefined;
    if (!pi) continue;
    const root = pi.rootInstanceId ?? 0;
    const ownedRoot = root === e.id() && (pi.parentLocalId || 0) > 0;
    // An owned root also goes when its HOME is still dying after the rehome: the rehome stops only at a home it
    // cannot step past (a root, or a plain entity), and no frame records it there. Detach Prefab no longer leaves such
    // a home (#1453), and a generic trait edit can no longer strip one (#1454); kept for a home already stripped.
    const homeGone = !!pi.homeParent && gone.has(byGuid.get(pi.homeParent)?.id() ?? -1);
    if (ownedRoot ? !(gone.has(ownerOf(e, pi)) || homeGone) : !gone.has(root)) continue;
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
 *  Detach Prefab or an unpack. Call it BEFORE they go (the owner walk reads their links). A member moved away
 *  from one of them keeps its path ({@link rehomeDependents}), and one still linked to a frame that ends is
 *  promoted or unlinked ({@link detachOrphanedMembers}). Every frame-ending path runs both halves through this
 *  one call. Detach and unpack once ran only the first, and a member moved out of the instance vanished on
 *  reload (#1453). Returns what an undo hands to {@link relinkDetachedMembers}. */
export function endFrames(gone: ReadonlySet<number>, world: World = getCurrentWorld()): DetachedMember[] {
  rehomeDependents(gone, world);
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

/** An entity's step below its parent in the derive walk: `'+key'` for a template-keyed node,
 *  `memberStepId` for a prefab member, and `null` for a node no template can name. */
function memberStepOf(e: Entity, piTrait: Parameters<Entity['has']>[0]): MemberStep | null {
  const key = templateKeyOf(e);
  if (key) return addedKeyStep(key);
  if (!e.has(piTrait)) return null;
  return memberStepId(e.get(piTrait) as { localId?: number; parentLocalId?: number });
}

/** Every member a template frame rooted at `rootEcsId` can name: path key → entity. The root is `''`.
 *  It does not descend into another STORED root, a user-added nested instance, which is its own frame;
 *  that root itself is still a target. A step two siblings share names neither of them. */
export function memberPathIndex(
  world: World, rootEcsId: number,
  /** The world's parent → children map, when the caller indexes several frames in one pass. */
  children: Map<number, Entity[]> = childrenByParent(world),
): Map<string, Entity | null> {
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
      const at = [...path, ...homeStepsOf(c.has(piMeta.trait) ? c.get(piMeta.trait) as { homeSteps?: string } : null), step];
      const key = memberPathKey(at);
      out.set(key, out.has(key) ? null : c);
      const pi = c.has(piMeta.trait) ? c.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number } : null;
      const storedRoot = !!pi && pi.rootInstanceId === c.id() && !pi.parentLocalId;
      if (!storedRoot) stack.push([c, at]);
    }
  }
  return out;
}

export function childrenByParent(world: World): Map<number, Entity[]> {
  const attrMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  const children = new Map<number, Entity[]>();
  if (!attrMeta) return children;
  const idOfGuid = new Map<string, number>();
  for (const e of world.entities as Iterable<Entity>) {
    const guid = e.has(attrMeta.trait) ? (e.get(attrMeta.trait) as { guid?: string }).guid : '';
    if (guid) idOfGuid.set(guid, e.id());
  }
  for (const e of world.entities as Iterable<Entity>) {
    if (!e.has(attrMeta.trait)) continue;
    const live = (e.get(attrMeta.trait) as { parentId?: number }).parentId ?? 0;
    const home = piMeta && e.has(piMeta.trait) ? (e.get(piMeta.trait) as { homeParent?: string } | undefined)?.homeParent : '';
    const parent = identityParentId(live, home, (g) => idOfGuid.get(g));
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  return children;
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

/** Make each OWNED nested root in `roots` a STORED root — a standalone instance of its own prefab — and
 *  return the rename its members took (old guid → new), already applied (#1447).
 *
 *  An owned root's members derive their guids from the OUTER instance's anchor, through the row that
 *  expanded them. A stored root is an anchor itself: the save writes its guid and the reload derives its
 *  members from it. So without the rename, every member would reload under a guid no live ref names
 *  (#1349's shape). The root keeps its guid, which becomes stored; each member below it — down to, not
 *  into, another stored root — takes the guid the reload derives, and every ref follows.
 *  Undo: {@link applyGuidRemap} with the map reversed, then put the roots' `PrefabInstance` back. */
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
    if (!e || !pi || pi.rootInstanceId !== id || !pi.parentLocalId) continue;
    e.set(piMeta.trait, { ...pi, parentLocalId: 0, homeParent: '', homeSteps: '' });
    promoted.push(e);
  }
  const guidOf = (e: Entity) => (e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid ?? '' : '');
  const children = childrenByParent(world);
  for (const root of promoted) {
    const anchor = guidOf(root);
    if (!anchor) continue; // unaddressable before, and after: nothing derives from it
    for (const [key, e] of memberPathIndex(world, root.id(), children)) {
      if (!key || !e) continue;
      const pi = e.has(piMeta.trait) ? (e.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number }) : null;
      if (pi && pi.rootInstanceId === e.id() && !pi.parentLocalId) continue; // a stored root keeps its stored guid
      const old = guidOf(e);
      const next = deriveMemberGuid(anchor, key.split('.'));
      if (old && old !== next) remap.set(old, next);
    }
  }
  applyGuidRemap(remap, world);
  return remap;
}
