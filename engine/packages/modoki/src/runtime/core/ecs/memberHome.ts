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
import { getCurrentWorld } from './world';
import { getTraitByName } from './traitRegistry';
import { memberStepId } from '../assetRefRules';

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
      // Nor a STORED root: the derive pass anchors there and takes no step through it. A member whose home
      // chain dies at one lost its instance with it — `detachOrphanedMembers` handles that member.
      if (hpi.rootInstanceId === h.id() && !hpi.parentLocalId) break;
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
export type DetachedMember = { guid: string; rootGuid: string; data: Record<string, unknown> };

/** Before the entities in `gone` are destroyed, detach every surviving member whose instance goes with them
 *  (#1437): a member MOVED out of its instance's subtree is not under the root being deleted, so it would
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
  const out: DetachedMember[] = [];
  const strip: Entity[] = [];
  const promote: Entity[] = [];
  for (const e of world.query(piMeta.trait) as Iterable<Entity>) {
    if (gone.has(e.id())) continue;
    const pi = e.get(piMeta.trait) as (Pi & { rootInstanceId?: number }) | undefined;
    if (!pi) continue;
    const root = pi.rootInstanceId ?? 0;
    const ownedRoot = root === e.id() && (pi.parentLocalId || 0) > 0;
    const home = pi.homeParent ? byGuid.get(pi.homeParent) : undefined;
    if (ownedRoot ? !(home && gone.has(home.id())) : !gone.has(root)) continue;
    out.push({ guid: guidOf(e), rootGuid: ownedRoot ? '' : guidOf(byId.get(root)), data: { ...pi } });
    (ownedRoot ? promote : strip).push(e);
  }
  for (const e of strip) e.remove(piMeta.trait);
  for (const e of promote) e.set(piMeta.trait, { ...(e.get(piMeta.trait) as Pi), parentLocalId: 0, homeParent: '', homeSteps: '' });
  return out;
}

/** Undo {@link detachOrphanedMembers} once the deleted entities are back. */
export function relinkDetachedMembers(detached: readonly DetachedMember[], world: World = getCurrentWorld()): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !detached.length) return;
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
