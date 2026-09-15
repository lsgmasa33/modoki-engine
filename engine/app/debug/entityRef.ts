/** The ONE live resolver for an agent-supplied entity address — `{guid}` | `{name}` | `{id}` (#1223).
 *
 *  Every op that aims at a live entity resolves through here: the editor ops (`requireLiveId`,
 *  `apply-scene-ops`), the device lifecycle and `set-traits` ops, aimed input
 *  (`resolve-entity-point`), `scene-query`'s `exclude`, and `capture_gesture`'s sample probe. There
 *  were eight copies before, with four precedence orders, three ways of reading an empty string, and
 *  a refusal code in only some of them. So the same `{guid:'', id:7}` meant "id 7" on one tool and
 *  "no such guid" on the next, and a guid given beside a stale id silently won on some tools and lost
 *  on the scene-file path.
 *
 *  The rules (docs/mcp-tool-conventions.md §3):
 *  - **An empty string, `null` or `undefined` is ABSENT.** `id` counts as given when it is a number.
 *  - **More than one address is refused (`AMBIGUOUS`)** rather than resolved by precedence (D1). A
 *    caller who sent two does not know which one a tool would use, and a stale id beside a guid names
 *    a different entity.
 *  - **A name matching several entities is refused (`AMBIGUOUS`)**, listing their guids as `options`.
 *    Exact and case-sensitive.
 *  - **`{id}` addresses only a registered entity with NO guid (D2)**: an id is reassigned on every
 *    reload, so an entity that has a guid is refused (`REFUSED_BY_OP`) with that guid as the one option.
 *    Since #1248 a registered entity lacks a guid only when its EntityAttributes was removed after spawn
 *    (or removed and re-added). koota's own world entity (id 0) is not registered, so it is NOT_FOUND.
 *  - **A miss is `NOT_FOUND`, plus `stale` when a runtime guid can be told apart (D4)**: `'despawned'`
 *    or `'world-swapped'` (`classifyRuntimeGuidMiss`). The recovery is the same as for any miss — re-read
 *    the guid — so it is a field, not a new code.
 *
 *  Pure over the current world: no DOM, no editor store, so the device bridge imports it as-is. */

import { findEntityById, findEntityByGuid, guidOfEntityId, getAllEntities, getTraitByName, readTraitData, classifyRuntimeGuidMiss, type RuntimeGuidStale } from '@modoki/engine/runtime';
import type { ErrorCode } from '../../tools/shared/mcpResult';

export interface EntityAddress { guid?: string | null; name?: string | null; id?: number | null }

export type EntityAddressKey = 'guid' | 'name' | 'id';

export type EntityAddressResolution =
  | { ok: true; id: number; guid: string | null; name: string }
  | { ok: false; code?: ErrorCode; error: string; options?: string[]; stale?: RuntimeGuidStale };

/** The address keys actually GIVEN, in `accept` order (an empty string counts as absent). */
export function givenAddressKeys(addr: EntityAddress | undefined, accept: readonly EntityAddressKey[] = ['guid', 'name', 'id']): EntityAddressKey[] {
  if (!addr) return [];
  return accept.filter((k) => (k === 'id' ? typeof addr.id === 'number' : typeof addr[k] === 'string' && addr[k] !== ''));
}

const phrase = (keys: readonly EntityAddressKey[]) => keys.map((k) => `{${k}}`).join(' | ');

/** One entity's guid and name, read directly — the whole-world `getAllEntities` projection is for the name scan only. */
function attrsOf(id: number): { guid: string | null; name: string } {
  const meta = getTraitByName('EntityAttributes');
  const d = meta ? readTraitData(id, meta) : null;
  return { guid: (d?.guid as string) || null, name: (d?.name as string) ?? '' };
}

/** Resolve `addr` to exactly one live entity, or say why not.
 *
 *  `accept` narrows the keys an op takes (the editor structural ops have no name resolver, and a tool
 *  that advertises only `{guid|id}` must not quietly honour a name). `label` prefixes every message,
 *  so the refusal names the op or the parameter it came from. */
export function resolveEntityAddress(
  addr: EntityAddress | undefined,
  opts: { label: string; accept?: readonly EntityAddressKey[] },
): EntityAddressResolution {
  const accept = opts.accept ?? ['guid', 'name', 'id'];
  const label = opts.label;
  const given = givenAddressKeys(addr, accept);
  if (given.length === 0) return { ok: false, error: `${label}: no entity address — pass one of ${phrase(accept)}` };
  if (given.length > 1) {
    return {
      ok: false, code: 'AMBIGUOUS',
      error: `${label}: ${phrase(given)} given together — pass exactly one. Two addresses can name two different entities (a stale id beside a guid), and choosing one for you would act on the wrong one.`,
    };
  }
  const a = addr as EntityAddress;

  if (given[0] === 'guid') {
    const guid = a.guid as string;
    const e = findEntityByGuid(guid);
    if (e) {
      const at = attrsOf(e.id());
      return { ok: true, id: e.id(), guid: at.guid || guid, name: at.name };
    }
    const stale = classifyRuntimeGuidMiss(guid) ?? undefined;
    const why = stale === 'despawned'
      ? ' — a runtime guid whose entity was deleted'
      : stale === 'world-swapped'
        ? ' — a runtime guid from an earlier world: a scene load, Stop or reload replaced it'
        : '';
    return {
      ok: false, code: 'NOT_FOUND',
      error: `${label}: no LIVE entity with guid ${JSON.stringify(guid)}${why}. Re-read it with get_scene_state.`,
      ...(stale ? { stale } : {}),
    };
  }

  if (given[0] === 'name') {
    const name = a.name as string;
    const hits = getAllEntities().filter((x) => x.name === name);
    if (hits.length === 0) return { ok: false, code: 'NOT_FOUND', error: `${label}: no LIVE entity named ${JSON.stringify(name)}` };
    if (hits.length > 1) {
      // Guids only (#1207): a match with no guid is not listed. The guids are in the MESSAGE as well as
      // `options`, because a batch (`apply-scene-ops`) reports each op's refusal as a string and only the
      // first failure's options survive to the reply. When NONE has a guid (EntityAttributes removed and
      // re-added after spawn), `{id}` is the one address they have, and this resolver accepts it for them.
      const guids = hits.map((x) => x.guid).filter((g): g is string => !!g);
      const way = guids.length ? `(${guids.join(', ')}) — a name matching several is refused, never first-matched; address by guid` : '— none has a guid, so address one by id';
      return {
        ok: false, code: 'AMBIGUOUS',
        error: `${label}: ${hits.length} LIVE entities are named ${JSON.stringify(name)} ${way}.`,
        options: guids,
      };
    }
    return { ok: true, id: hits[0].id, guid: hits[0].guid || null, name: hits[0].name };
  }

  const id = a.id as number;
  // REGISTERED entities only (`findEntityById`, the world's index), never `findEntity`'s fallback scan
  // of koota's raw list: that list also holds koota's own world entity at id 0, which has no
  // EntityAttributes and so no guid, and the id rule below would accept it as "the guid-less entity" —
  // `set-traits {id:0}` wrote to it and reported success (#1223 close-out review).
  const e = findEntityById(id);
  if (!e) return { ok: false, code: 'NOT_FOUND', error: `${label}: id ${id} matched no live entity — ids are reassigned on every scene reload. Re-read it with get_scene_state and address it by guid.` };
  const { guid, name } = attrsOf(id);
  if (guid) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `${label}: entity ${id} has guid ${guid} — address it by guid. {id} is accepted only for an entity with no guid, because an id is reassigned on every reload and a held one names a different entity.`,
      options: [guid],
    };
  }
  return { ok: true, id, guid: null, name };
}

// ── Replies: the other direction, id → address (#1223 P2) ──
//
// A reply names every entity it reports by guid (docs/mcp-tool-conventions.md §3). An OBJECT that
// carries an entity keeps its `id` and gains `guid` beside it (`null` for a guid-less entity), so an
// in-process reader joining on the id keeps working. A LIST cannot hold a sibling per element, so an
// id list becomes a guid list plus `<field>NoGuidIds` for the entities that have none — present only
// when non-empty, because since #1248 only an entity whose EntityAttributes was removed lands there.

/** An entity named for a reply: its id, its guid (`null` when it has none) and its name. */
export function addressOf(id: number): { id: number; guid: string | null; name: string } {
  return { id, guid: guidOfEntityId(id), name: attrsOf(id).name };
}

/** `ids` split into the guids of the entities that have one and the ids of those that do not, in order. */
export function guidListOf(ids: readonly number[], guidOf: (id: number) => string | null = guidOfEntityId): { guids: string[]; noGuidIds: number[] } {
  const guids: string[] = [];
  const noGuidIds: number[] = [];
  for (const id of ids) {
    const g = guidOf(id);
    if (g) guids.push(g); else noGuidIds.push(id);
  }
  return { guids, noGuidIds };
}

/** Every entity under any of `roots` — the roots themselves and duplicates excluded, parents before
 *  children. CYCLE-SAFE: `EntityAttributes.parentId` is a plain field a `set-traits` write can reach
 *  (see `subtreeOf` in liveLifecycle.ts, which walks through this). */
export function descendantsOf(roots: readonly number[]): number[] {
  const children = new Map<number, number[]>();
  for (const e of getAllEntities()) {
    const list = children.get(e.parentId);
    if (list) list.push(e.id); else children.set(e.parentId, [e.id]);
  }
  const seen = new Set(roots);
  const out: number[] = [];
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** How many cascaded descendants a delete reply names before it only counts them. */
export const ALSO_DELETED_CAP = 100;

/** What a delete took WITH the entities it was asked for (#1216 C-6), as reply fields: `alsoDeleted`
 *  (guids) + `alsoDeletedNoGuidIds`, and `alsoDeletedTotal` when more than the cap were taken. Absent
 *  when the delete cascaded to nothing. Both delete-entities ops answered only the entities they were
 *  named, so a parent's delete removed its whole subtree without a word. Capped because the list is
 *  unbounded (a scene root's subtree is the scene) and an over-budget reply is elided whole — which
 *  would hide `deleted` too. Call it BEFORE deleting: afterwards the descendants have no guid to read. */
export function alsoDeletedFields(descendants: readonly number[], guidOf?: (id: number) => string | null) {
  if (!descendants.length) return {};
  return {
    ...guidListFields('alsoDeleted', descendants.slice(0, ALSO_DELETED_CAP), guidOf),
    ...(descendants.length > ALSO_DELETED_CAP ? { alsoDeletedTotal: descendants.length } : {}),
  };
}

/** An id list as reply fields: `{ [key]: guids }`, plus `{ [key + 'NoGuidIds']: ids }` when any entity has no guid. */
export function guidListFields<K extends string>(
  key: K, ids: readonly number[], guidOf?: (id: number) => string | null,
): Record<K, string[]> & Partial<Record<`${K}NoGuidIds`, number[]>> {
  const { guids, noGuidIds } = guidListOf(ids, guidOf);
  return { [key]: guids, ...(noGuidIds.length ? { [`${key}NoGuidIds`]: noGuidIds } : {}) } as Record<K, string[]> & Partial<Record<`${K}NoGuidIds`, number[]>>;
}
