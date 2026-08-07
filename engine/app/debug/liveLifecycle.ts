/** Live-world entity lifecycle — create / duplicate / delete, shared by the DEVICE and the editor
 *  (#166 P2, docs/plans/device-authoring-parity-plan.md).
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
  findEntityByGuid,
  spawnEntity,
  deleteEntity,
  getCurrentWorld,
  newGuid,
  buildEntityCreateSpecs,
  PRIMITIVE_NAMES,
  PRIMITIVE_SPRITE_NAMES,
  type CreateEntitySpec,
} from '@modoki/engine/runtime';

const LIVE_ONLY = 'live world only — no project on disk here, and a relaunch is the undo. There is no undo stack.';

export interface LifecycleFailure { ok: false; error: string; options?: string[] }

/** Resolve `{guid}` (preferred) or `{id}` to a LIVE entity id.
 *
 *  A guid resolves to the RIGHT entity or fails; a recycled numeric id can silently name a
 *  DIFFERENT entity after a hot-reload, which on a DELETE is data loss reported as success. Same
 *  reasoning as the editor op's C7 fix. */
function resolveLiveId(ref: { id?: number; guid?: string }): number | null {
  if (ref.guid != null) {
    const ent = findEntityByGuid(ref.guid);
    return ent ? ent.id() : null;
  }
  if (ref.id != null) return findEntity(ref.id) ? ref.id : null;
  return null;
}

function attrMeta() {
  return getAllTraits().find((m) => m.name === 'EntityAttributes');
}

function guidOf(id: number): string {
  const meta = attrMeta();
  const d = meta ? (readTraitDataFull(id, meta) as Record<string, unknown> | null) : null;
  return ((d?.guid as string) || '') || String(id);
}

/** Give a freshly-spawned entity a stable guid. The editor mints one via its undo-aware
 *  `ensureGuid`; here we write the field directly, because the reply MUST hand back a guid — an
 *  agent told only a numeric id has been handed an address that expires on the next scene reload. */
function mintGuid(id: number): string {
  const meta = attrMeta();
  const entity = findEntity(id);
  if (!meta || !entity) return String(id);
  const existing = (readTraitDataFull(id, meta) as Record<string, unknown> | null)?.guid as string | undefined;
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

  // Same vocabulary check the editor op makes: `{kind:'primitive', mesh:'pyramid'}` used to return a
  // clean success and produce an entity whose renderer resolves to nothing — invisible, no error.
  const spec = p.spec as { kind?: string; mesh?: string; shape?: string };
  if (spec.kind === 'primitive' && !spec.mesh) spec.mesh = 'sphere';
  if (spec.kind === '2d' && !spec.shape) spec.shape = 'square';
  if (spec.kind === 'primitive' && spec.mesh && !PRIMITIVE_NAMES.includes(spec.mesh)) {
    return { ok: false, error: `unknown primitive mesh "${spec.mesh}" — nothing was created.`, options: [...PRIMITIVE_NAMES] };
  }
  if (spec.kind === '2d' && spec.shape && !(PRIMITIVE_SPRITE_NAMES as readonly string[]).includes(spec.shape)) {
    return { ok: false, error: `unknown 2D shape "${spec.shape}" — nothing was created.`, options: [...PRIMITIVE_SPRITE_NAMES] };
  }

  let parentId = 0;
  if (p.parentGuid != null) {
    const pid = resolveLiveId({ guid: p.parentGuid });
    if (pid == null) return { ok: false, error: `parentGuid "${p.parentGuid}" matched no live entity — nothing was created.` };
    parentId = pid;
  } else if (p.parentId != null && p.parentId !== 0) {
    // A stale numeric parent id would produce an ORPHAN reported as success (conventions §3).
    if (!findEntity(p.parentId)) return { ok: false, error: `parentId ${p.parentId} matched no live entity — nothing was created. Ids are reassigned on scene reload; prefer parentGuid.` };
    parentId = p.parentId;
  }

  const { name, specs } = buildEntityCreateSpecs(p.spec, parentId);
  const id = spawnFromSpecs(specs);
  if (id == null) return { ok: false, error: `nothing was created for spec ${JSON.stringify(p.spec)} — a referenced trait is not registered in this build.` };
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
  const all = getAllEntities();
  const out = [rootId];
  const seen = new Set([rootId]);
  for (let i = 0; i < out.length; i++) {
    for (const e of all) {
      if (e.parentId !== out[i] || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e.id);
    }
  }
  return out;
}

/** Copy an entity AND its descendants. A shallow copy would be a false success for any parent —
 *  "duplicate this" that silently drops the children is the shape conventions §0 ranks worst. */
export function duplicateEntityLive(params: unknown): unknown {
  const p = (params ?? {}) as { id?: number; guid?: string; count?: number };
  const rootId = resolveLiveId(p);
  if (rootId == null) {
    return { ok: false, error: `duplicate-entity: ${p.guid != null ? `guid "${p.guid}"` : `id ${p.id}`} matched no live entity — nothing was duplicated.` };
  }
  // Refuse a malformed count rather than quietly substituting 1: `count: "5"` used to return
  // {ok:true, created:1} — the caller asked for five and nothing in the reply said the field was
  // ignored. Every other malformed input in these two files is refused loudly; this was the one
  // place that guessed.
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

  const roots: Array<{ id: number; guid: string }> = [];
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
    roots.push({ id: newRoot, guid: guidOf(newRoot) });
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
  for (const r of refs) {
    const id = resolveLiveId(r);
    if (id == null) missing.push(r);
    else if (!targets.includes(id)) targets.push(id);
  }
  // Refuse the WHOLE call on any unresolvable ref rather than deleting the rest: a partial delete
  // reported alongside a miss leaves the caller unable to tell which entities are now gone.
  if (missing.length) {
    return {
      ok: false,
      error: `${missing.length} of ${refs.length} ref(s) matched no live entity — NOTHING was deleted. Missing: ${missing.map((m) => m.guid ?? `#${m.id}`).join(', ')}`,
    };
  }

  // Read every guid BEFORE deleting anything. deleteEntity CASCADES to the subtree, so deleting a
  // parent destroys a child that is also in `targets` — and reading that child's guid afterwards
  // falls through to String(id), reporting a live entity id disguised as a guid. Same
  // snapshot-before-mutating discipline duplicateEntityLive uses one function up.
  const deleted = targets.map(guidOf);
  for (const id of targets) deleteEntity(id);   // a second delete of a cascaded child is a safe no-op
  return { ok: true, deleted: deleted.length, guids: deleted, saved: false, savedNote: LIVE_ONLY };
}
