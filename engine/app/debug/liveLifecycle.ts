/** Live-world entity lifecycle — create / duplicate / delete, shared by the DEVICE and the editor
 *  (#166 P2, docs/mcp-tool-conventions.md §9).
 *
 *  These are the undo-free RUNTIME twins of the editor ops in `../editor/agentEditorOps.ts`. The
 *  editor registers its own richer, undoable versions at editor startup, and `registerAgentOp` is a
 *  Map keyed by name — so the editor's replace these wherever an editor is running, and the device
 *  gets these. That layering is deliberate: one op name, the best implementation each surface can
 *  honestly provide.
 *
 *  Why it unlocks anything: the experiment #154 wanted and could not run is *spawn N more of this
 *  and watch the frame*. That needs duplicate, and duplicate needs the trait-spec builders — which
 *  is why `entityCreateSpecs` moved from `editor/` into `runtime/` in this change.
 *
 *  No undo stack, no disk. A relaunch is the undo, and every reply says so. */

import {
  getAllEntities,
  getAllTraits,
  readTraitDataFull,
  findEntity,
  guidOfEntityId,
  spawnEntity,
  deleteEntity,
  getCurrentWorld,
  newGuid,
  durableGuid,
  buildEntityCreateSpecs,
  resolveCreateEntitySpec,
  isResourceEntity,
  parentRefusal,
  type CreateEntitySpec,
} from '@modoki/engine/runtime';
import { resolveEntityAddress, guidListFields, descendantsOf, alsoDeletedFields } from './entityRef';
import type { ErrorCode } from '../../tools/shared/mcpResult';

const LIVE_ONLY = 'live world only — no project on disk here, and a relaunch is the undo. There is no undo stack.';

export interface LifecycleFailure { ok: false; error: string; code?: ErrorCode; options?: string[]; stale?: string }

/** A shared-resolver refusal (`entityRef.ts`, #1223) as this op's failure: its code, options and
 *  `stale` travel with the message, and `tail` says what was NOT done. */
function addressFailure(r: { code?: ErrorCode; error: string; options?: string[]; stale?: string }, tail: string): LifecycleFailure {
  return { ok: false, error: `${r.error} — ${tail}`, ...(r.code ? { code: r.code } : {}), ...(r.options ? { options: r.options } : {}), ...(r.stale ? { stale: r.stale } : {}) };
}

function attrMeta() {
  return getAllTraits().find((m) => m.name === 'EntityAttributes');
}

/** An entity's guid, or `null` when it has none (#1199). NEVER `String(id)` — see `guidOfEntityId`
 *  (runtime `core/ecs/entityUtils.ts`), which this names for the ops that already import it from here. */
export function liveGuidOf(id: number): string | null {
  return guidOfEntityId(id);
}

/** Give a freshly-spawned entity a stable guid. The editor mints one via its undo-aware
 *  `ensureGuid`; here we write the field directly, because the reply MUST hand back a guid — an
 *  agent told only a numeric id has been handed an address that expires on the next scene reload. */
function mintGuid(id: number): string | null {
  const meta = attrMeta();
  const entity = findEntity(id);
  if (!meta || !entity) return null;   // not String(id) — see liveGuidOf (#1199)
  // Durable only (#1210): `spawnEntity` already gave the entity a RUNTIME guid, which dies with the
  // world — a Play→Stop revert rebuilds it and the reply's guid would name nothing. The reply exists
  // to hand back an address that survives that, so mint over a runtime guid like an empty one.
  const existing = durableGuid((readTraitDataFull(id, meta) as Record<string, unknown> | null)?.guid as string | undefined);
  if (existing) return existing;
  const guid = newGuid();
  if (!entity.has(meta.trait)) entity.add(meta.trait);
  const current = entity.get(meta.trait) as Record<string, unknown>;
  entity.set(meta.trait, { ...current, guid });
  return guid;
}

/** Spawn one entity from `TraitSpec[]`, the same specs the editor builds. */
function spawnFromSpecs(specs: Array<{ name: string; data?: Record<string, unknown> }>): number | null {
  const all = getAllTraits();
  const inits: unknown[] = [];
  for (const spec of specs) {
    const meta = all.find((t) => t.name === spec.name);
    if (!meta) return null;
    inits.push(spec.data !== undefined ? meta.trait(spec.data) : meta.trait());
  }
  const entity = spawnEntity(getCurrentWorld(), ...(inits as Parameters<typeof spawnEntity>[1][]));
  return entity.id();
}

export function createEntityLive(params: unknown): unknown {
  const p = (params ?? {}) as { spec?: CreateEntitySpec; parentGuid?: string; parentId?: number };
  if (!p.spec) return { ok: false, error: 'create-entity requires { spec } — nothing was created.' };

  // The ONE vocabulary check both create-entity ops share (#1070): the per-kind defaults, then the
  // kind, mesh, shape, light and preset — returned as DATA so this op answers in its own
  // `{ok:false, error, options}` shape. `{kind:'primitive', mesh:'pyramid'}` once returned a clean
  // success for an invisible entity; the light/preset checks then THREW out of the spec builders,
  // which the device relay flattened into a bare error string with no options.
  const resolved = resolveCreateEntitySpec(p.spec);
  if (!resolved.ok) return { ok: false, error: resolved.error, options: resolved.options };

  // `parentId: 0` alone is the root; anything else resolves through the shared resolver, which refuses
  // a stale parent (an ORPHAN reported as success, conventions §3), a guid beside an id (D1), and an id
  // for a parent that has a guid (D2).
  let parentId = 0;
  if (p.parentGuid || (p.parentId != null && p.parentId !== 0)) {
    const r = resolveEntityAddress({ guid: p.parentGuid, id: p.parentId }, { label: 'create-entity parent', accept: ['guid', 'id'] });
    if (!r.ok) return addressFailure(r, 'nothing was created.');
    parentId = r.id;
  }
  if (parentRefusal(parentId)) {
    return { ok: false, error: `parent ${parentId} is a resource (Time, Input, a config singleton) and holds no children — a child under the Transient Time/Input singleton is dropped from every save. Nothing was created; parent it elsewhere, or omit the parent for the scene root (#1248).` };
  }

  const { name, specs } = buildEntityCreateSpecs(resolved.spec, parentId);
  const id = spawnFromSpecs(specs);
  if (id == null) return { ok: false, error: `nothing was created for spec ${JSON.stringify(resolved.spec)} — a referenced trait is not registered in this build.` };
  return { ok: true, id, guid: mintGuid(id), name, saved: false, savedNote: LIVE_ONLY };
}

/** Every descendant of `rootId`, parents before children (so a copy's parent always exists).
 *
 *  CYCLE-SAFE, and that is not paranoia: `parentId` is an ordinary numeric field on
 *  EntityAttributes, and the `set-traits` op in the sibling file can write it directly — which
 *  BYPASSES `reparentEntity`, the one place that rejects a self-parent or a descendant-as-parent.
 *  A single `set: {"EntityAttributes.parentId": <own id>}` used to make this function loop forever
 *  (`out` grew exactly as fast as `i`), hanging the device app until it was killed. The `seen` set
 *  makes the walk terminate on any graph; `guardParentWrite` in liveMutate.ts stops the illegal
 *  state being created in the first place. Both, because either alone leaves a hole. */
function subtreeOf(rootId: number): number[] {
  return [rootId, ...descendantsOf([rootId])];
}

/** Copy an entity AND its descendants. A shallow copy would be a false success for any parent —
 *  "duplicate this" that silently drops the children is the shape conventions §0 ranks worst. */
export function duplicateEntityLive(params: unknown): unknown {
  const p = (params ?? {}) as { id?: number; guid?: string; count?: number };
  const r = resolveEntityAddress(p, { label: 'duplicate-entity', accept: ['guid', 'id'] });
  if (!r.ok) return addressFailure(r, 'nothing was duplicated.');
  const rootId = r.id;
  // Refuse a malformed count rather than quietly substituting 1: `count: "5"` used to return
  // {ok:true, created:1} — the caller asked for five and nothing in the reply said the field was
  // ignored. Every other malformed input in these two files is refused loudly; this was the one
  // place that guessed.
  if (isResourceEntity(rootId)) {
    // Same refusal as the editor's duplicate-entity and the Hierarchy's disabled Duplicate (#1248). A copy
    // is a second world singleton, and for Input its per-frame maps would be SHARED by reference.
    return { ok: false, error: `duplicate-entity: entity ${rootId} is a resource (Time, Input, a config singleton) — a world holds one, so nothing was duplicated.` };
  }
  const count = p.count === undefined ? 1 : p.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) {
    return { ok: false, error: `count must be an integer between 1 and 1000 — got ${JSON.stringify(p.count)}. Nothing was duplicated.` };
  }

  const all = getAllTraits();
  const ids = subtreeOf(rootId);
  // Snapshot BEFORE spawning anything: the copies are themselves entities, and reading the source
  // as we go would start duplicating our own output.
  const snapshot = ids.map((id) => {
    const entity = findEntity(id);
    const traits: Array<{ name: string; data?: Record<string, unknown> }> = [];
    for (const meta of all) {
      if (!entity?.has(meta.trait)) continue;
      const data = readTraitDataFull(id, meta) as Record<string, unknown> | null;
      traits.push({ name: meta.name, ...(data ? { data: { ...data } } : {}) });
    }
    const parent = getAllEntities().find((e) => e.id === id)?.parentId ?? 0;
    return { id, parentId: parent, traits };
  });

  const roots: Array<{ id: number; guid: string | null }> = [];
  // Everything this call spawns, so a mid-flight failure can be ROLLED BACK. Without it, a spawn
  // that failed on the child of a 2-entity subtree left the parent's copy live in the world while
  // the reply said "nothing was kept" — a half-applied mutation behind a failure verdict, which is
  // the shape conventions §8 forbids, and the reply even named it.
  const spawned: number[] = [];
  const rollback = (why: string) => {
    for (const id of spawned.reverse()) deleteEntity(id);
    return { ok: false as const, error: `duplicate-entity: ${why} Nothing was kept — ${spawned.length} partial copy entit${spawned.length === 1 ? 'y was' : 'ies were'} rolled back.` };
  };

  for (let n = 0; n < count; n++) {
    const idMap = new Map<number, number>();
    for (const src of snapshot) {
      const specs = src.traits.map((t) => {
        if (t.name !== 'EntityAttributes' || !t.data) return t;
        // A copy must NOT inherit the original's guid — two entities answering to one address is
        // the addressing failure every Percept tool would then inherit. Re-parent within the copy.
        const mappedParent = idMap.get(src.parentId);
        return {
          name: t.name,
          data: {
            ...t.data,
            guid: newGuid(),
            ...(mappedParent !== undefined ? { parentId: mappedParent } : {}),
          },
        };
      });
      // A trait factory can THROW on data it dislikes, not just return null — and an uncaught throw
      // here would escape mid-loop, leaking every copy made so far with no reply at all.
      let newId: number | null;
      try {
        newId = spawnFromSpecs(specs);
      } catch (e) {
        return rollback(`spawning a copy threw: ${(e as Error).message}.`);
      }
      if (newId == null) return rollback('a trait on the source entity is not registered in this build, so the copy would be incomplete.');
      spawned.push(newId);
      idMap.set(src.id, newId);
    }
    const newRoot = idMap.get(rootId)!;
    roots.push({ id: newRoot, guid: liveGuidOf(newRoot) });
  }

  return {
    ok: true,
    created: roots.length,
    entitiesPerCopy: snapshot.length,
    roots,
    saved: false,
    savedNote: LIVE_ONLY,
    ...(snapshot.length > 1 ? { note: `each copy includes the ${snapshot.length - 1} descendant(s) of the source` } : {}),
  };
}

export function deleteEntitiesLive(params: unknown): unknown {
  const p = (params ?? {}) as { ids?: number[]; id?: number; guids?: string[]; guid?: string };
  const refs: Array<{ id?: number; guid?: string }> = [
    ...(p.guids ?? []).map((guid) => ({ guid })),
    ...(p.guid != null ? [{ guid: p.guid }] : []),
    ...(p.ids ?? []).map((id) => ({ id })),
    ...(p.id != null ? [{ id: p.id }] : []),
  ];
  if (!refs.length) return { ok: false, error: 'delete-entities requires { guids } / { guid } (preferred) or { ids } / { id } — nothing was deleted.' };

  const targets: number[] = [];
  const missing: Array<{ id?: number; guid?: string }> = [];
  let stale: string | undefined;
  for (const ref of refs) {
    const r = resolveEntityAddress(ref, { label: 'delete-entities', accept: ['guid', 'id'] });
    if (r.ok) { if (!targets.includes(r.id)) targets.push(r.id); continue; }
    // A wrong ADDRESS (an id for an entity that has a guid, #1223 D2) refuses the call on its own terms.
    if (r.code !== 'NOT_FOUND') return addressFailure(r, 'NOTHING was deleted.');
    stale ??= r.stale;
    missing.push(ref);
  }
  // Refuse the WHOLE call on any unresolvable ref rather than deleting the rest: a partial delete
  // reported alongside a miss leaves the caller unable to tell which entities are now gone.
  if (missing.length) {
    return {
      ok: false, code: 'NOT_FOUND',
      error: `${missing.length} of ${refs.length} ref(s) matched no live entity — NOTHING was deleted. Missing: ${missing.map((m) => m.guid ?? `#${m.id}`).join(', ')}`,
      ...(stale ? { stale } : {}),
    };
  }

  // Read every guid BEFORE deleting anything. deleteEntity CASCADES to the subtree, so deleting a
  // parent destroys a child that is also in `targets` — and reading that child's guid afterwards
  // finds no entity, reporting `null` for an entity that had a real guid. Same
  // snapshot-before-mutating discipline duplicateEntityLive uses one function up.
  // Named by guid, the same shape as the editor op (#1223 P2): `deleted` lists the guids and
  // `deletedNoGuidIds` the ids of any target that has none. It was a COUNT beside a `guids` array
  // holding a bare `null` per guid-less target, which said one was deleted and not which.
  const deleted = guidListFields('deleted', targets);
  // …and the descendants the cascade takes with them, which the reply never mentioned (#1216 C-6).
  const also = alsoDeletedFields(descendantsOf(targets));
  for (const id of targets) deleteEntity(id);   // a second delete of a cascaded child is a safe no-op
  return { ok: true, ...deleted, ...also, saved: false, savedNote: LIVE_ONLY };
}
