/** Live-world trait mutation — the write half of the agent surface, shared by the DEVICE and the
 *  editor (#166, docs/mcp-tool-conventions.md §9).
 *
 *  Why this lives here and not in `../editor/agentEditorOps.ts`: setting a trait field is a pure
 *  RUNTIME capability (`writeTraitField`), and the only thing that ever bound it to the editor was
 *  the undo wrapper. Registering it from `agentBridge.ts` means the device gets it, `device_eval`
 *  gets it, and `modoki_eval` gets it — one lever, because both eval APIs are generated from the
 *  op registry. See the plan's §0.
 *
 *  Deliberately NOT undoable. There is no undo stack on a device (the same reason the device eval
 *  API has no `composite()`), and no project on disk to write back to: a device experiment is
 *  inherently temporary and **a relaunch is the undo**. The reply says so rather than staying
 *  silent about it — conventions §8 requires persistence be stated.
 *
 *  Selection reuses `parseWhere`, the SAME predicate `scene-state` filters with, so the thing you
 *  just read is addressable by the expression you just read it with (conventions §9: a rule
 *  implemented twice diverges). */

import {
  getAllEntities,
  getAllTraits,
  readTraitDataFull,
  writeTraitField,
  findEntity,
  findEntityByGuid,
  reparentRefusal,
} from '@modoki/engine/runtime';

type TraitMeta = ReturnType<typeof getAllTraits>[number];
type WherePredicate = (info: { id: number; traits: string[] }) => boolean;

/** Detail rows returned per call. The counts (`matched`/`changed`) are always EXACT — only the
 *  per-entity before/after detail is capped, so a broad `where` can never make the summary lie
 *  (conventions §6: summary-first, and a total that appears only on truncation is not recoverable). */
const DEFAULT_DETAIL_LIMIT = 20;

export interface LiveMutateParams {
  /** Filter: `Trait.field <op> value`, the same grammar `scene-state` takes. Matching MANY
   *  entities is the intended use — this is a filter, not an aim. */
  where?: string;
  /** Aim: one stable guid, or an array of them (the array form is what makes a
   *  read → filter-in-JS → write loop possible inside a single eval body). */
  guid?: string | string[];
  /** Aim: exact entity name. AMBIGUOUS NAMES ARE REFUSED (conventions §3) — never first-matched. */
  name?: string;
  /** Aim: live entity id. Reassigned on every scene reload; prefer `guid`. */
  id?: number;
  /** `{"Trait.field": value}` to write a field, or `{"TraitName": true|false}` to add/remove a
   *  tag trait. Keys reuse `where`'s `Trait.field` addressing — one vocabulary for read and write. */
  set?: Record<string, unknown>;
  /** Report what WOULD change, change nothing. A read-only mode of a write tool. */
  dryRun?: boolean;
  /** Cap on per-entity detail rows (default 20). Counts are unaffected. */
  limit?: number;
}

export interface LiveMutateFailure {
  ok: false;
  error: string;
  /** The real choices, when there is a finite set — feeds the tool's §5 `options`. */
  options?: string[];
  matched?: number;
}

export interface LiveMutateSuccess {
  ok: true;
  matched: number;
  changed: number;
  dryRun?: true;
  saved: false;
  savedNote: string;
  entities: Array<{ id: number; guid: string; name: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  detailTruncated?: true;
  hint?: string;
}

export type LiveMutateResult = LiveMutateSuccess | LiveMutateFailure;

/** A trait's statically-known field names, or null when the schema is a function (AoS traits can't
 *  be validated statically, so we skip the check rather than false-warn — same rule as parseWhere). */
function knownFieldsOf(meta: TraitMeta): Set<string> | null {
  const schema = (meta.trait as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object') return null;
  return new Set([...Object.keys(schema), ...Object.keys(meta.fields)]);
}

/** Refuse a value whose TYPE the trait's schema says is wrong, or null when it is fine.
 *
 *  `writeTraitField` stores the value RAW. Nothing downstream coerces it, and every hierarchy walk
 *  compares with `===` — so `set: {"EntityAttributes.parentId": "2"}` used to be accepted (the
 *  guard coerced it with `Number()` before checking, but the WRITE kept the string) and stored a
 *  string id. The entity then became invisible to `subtreeOf` and `isAncestorOf`, which means
 *  `duplicate-entity` on its parent silently dropped it — a copy missing a child, reported as
 *  success. Same shape for any numeric field: `Transform.x: "5"` is arithmetic waiting to break.
 *
 *  The schema's value IS the default (`trait({parentId: 0, name: ''})`), so its typeof is the
 *  declared type. Only PRIMITIVE defaults are enforced — an object/array/null default says nothing
 *  useful about what the field accepts, and false-refusing a legitimate write is worse than this
 *  check is worth. Provable from the schema alone, so §8 makes it a pre-flight refusal. */
function wrongType(meta: TraitMeta, field: string, value: unknown): string | null {
  const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
  if (!schema || typeof schema !== 'object') return null;
  if (!(field in schema)) return null;
  const expected = typeof schema[field];
  if (expected !== 'number' && expected !== 'boolean' && expected !== 'string') return null;
  const got = typeof value;
  if (got === expected) {
    // A number field that arrives as NaN/Infinity passes `typeof` but poisons every consumer.
    if (expected === 'number' && !Number.isFinite(value as number)) {
      return `expected a finite number, got ${JSON.stringify(value)}.`;
    }
    return null;
  }
  return `expected a ${expected}, got ${value === null ? 'null' : got} (${JSON.stringify(value)}). Values are stored RAW — a "${got}" here would survive into the world and break code that compares or computes with it.`;
}

interface ParsedWrite { trait: string; meta: TraitMeta; field: string | null; value: unknown }

/** Validate every `set` key BEFORE touching the world. An unknown trait, or an unknown field on a
 *  known trait, is provable from the registry alone — so conventions §8 requires the WHOLE call be
 *  refused with nothing applied, rather than the half-applied-then-`ok:false` shape (a caller who
 *  reads a failure verdict reasonably assumes nothing happened). */
function parseWrites(
  set: Record<string, unknown>,
  metaByName: Map<string, TraitMeta>,
): { writes: ParsedWrite[] } | LiveMutateFailure {
  const writes: ParsedWrite[] = [];
  for (const [key, value] of Object.entries(set)) {
    const dot = key.indexOf('.');
    const traitName = dot === -1 ? key : key.slice(0, dot);
    const field = dot === -1 ? null : key.slice(dot + 1);
    const meta = metaByName.get(traitName);
    if (!meta) {
      return {
        ok: false,
        error: `unknown trait "${traitName}" in set key "${key}" — nothing was applied.`,
        options: [...metaByName.keys()].sort(),
      };
    }
    if (field === null) {
      // A bare trait name is only meaningful for a TAG trait (presence IS the value). For a data
      // trait it is almost certainly a forgotten `.field`, and silently guessing one would be a
      // false success on the very call that asked for a change.
      if (meta.category !== 'tag') {
        const fields = knownFieldsOf(meta);
        return {
          ok: false,
          error: `set key "${key}" names a trait but no field. "${traitName}" is not a tag trait, so it needs "${traitName}.<field>" — nothing was applied.`,
          options: fields ? [...fields].sort().map((f) => `${traitName}.${f}`) : undefined,
        };
      }
      if (typeof value !== 'boolean') {
        return {
          ok: false,
          error: `set key "${key}" is a tag trait, so its value must be true (add) or false (remove) — got ${JSON.stringify(value)}. Nothing was applied.`,
        };
      }
    } else {
      const fields = knownFieldsOf(meta);
      if (fields && !fields.has(field)) {
        return {
          ok: false,
          error: `unknown field "${key}" — "${traitName}" has no field "${field}". Nothing was applied.`,
          options: [...fields].sort().map((f) => `${traitName}.${f}`),
        };
      }
      const typeError = wrongType(meta, field, value);
      if (typeError) return { ok: false, error: `${key}: ${typeError} Nothing was applied.` };
    }
    writes.push({ trait: traitName, meta, field, value });
  }
  return { writes };
}

/** Resolve the selector to a set of live entity ids, or a refusal explaining why not. */
function selectTargets(
  p: LiveMutateParams,
  metaByName: Map<string, TraitMeta>,
  parseWhere: (expr: string, m: Map<string, TraitMeta>) => { pred: WherePredicate } | { error: string },
): { ids: number[] } | LiveMutateFailure {
  const selectors = [p.where != null, p.guid != null, p.name != null, p.id != null].filter(Boolean).length;
  if (selectors === 0) {
    return {
      ok: false,
      error: 'no selector — nothing was applied. Name exactly one of: where (filter), guid (one or many), name (exact, ambiguity refused), id.',
      options: ['where', 'guid', 'name', 'id'],
    };
  }
  if (selectors > 1) {
    // Two selectors could only mean "intersect" or "union" and the caller has not said which.
    // Guessing would silently mutate a different set than they asked for.
    return { ok: false, error: 'more than one selector given — nothing was applied. Use exactly one of where / guid / name / id.' };
  }

  if (p.guid != null) {
    const guids = Array.isArray(p.guid) ? p.guid : [p.guid];
    const ids: number[] = [];
    const missing: string[] = [];
    for (const g of guids) {
      const ent = findEntityByGuid(g);
      if (!ent) { missing.push(g); continue; }
      // DEDUPE. `guid: ['G1','G1']` used to report matched:2 for ONE entity — and worse, the second
      // pass re-read `before` AFTER the first write, so `changed` came back 1 against matched 2,
      // which reads as "half my writes were ignored". The counts are documented as exact; that
      // means exact per ENTITY, not per ref. (deleteEntitiesLive already deduped; this did not.)
      const id = ent.id();
      if (!ids.includes(id)) ids.push(id);
    }
    // A stale guid is routine (ids and entities rebuild on every scene reload), so it must never
    // pass silently — an agent that fed 40 guids and mutated 39 has to know which one vanished.
    if (missing.length) {
      return {
        ok: false,
        error: `${missing.length} of ${guids.length} guid(s) matched no entity in the live world — nothing was applied. They may be stale (entities rebuild on scene reload). Missing: ${missing.join(', ')}`,
      };
    }
    return { ids };
  }

  const all = getAllEntities();

  if (p.id != null) {
    const hit = all.find((e) => e.id === p.id);
    if (!hit) return { ok: false, error: `id ${p.id} matched no entity in the live world — nothing was applied. Ids are reassigned on every scene reload; prefer guid.` };
    return { ids: [hit.id] };
  }

  if (p.name != null) {
    const q = p.name.toLowerCase();
    const hits = all.filter((e) => (e.name ?? '').toLowerCase() === q);
    if (hits.length === 0) {
      const near = all.filter((e) => (e.name ?? '').toLowerCase().includes(q)).slice(0, 10).map((e) => e.name ?? `#${e.id}`);
      return {
        ok: false,
        error: `name "${p.name}" matched no entity exactly — nothing was applied.`,
        options: near.length ? near : undefined,
      };
    }
    if (hits.length > 1) {
      // Conventions §3: a name matching several entities is REFUSED everywhere, never
      // first-matched. `where` is the plural selector; `name` is an aim.
      return {
        ok: false,
        error: `name "${p.name}" matched ${hits.length} entities — nothing was applied. Aim with one guid, or select the set deliberately with where/guid[].`,
        options: hits.slice(0, 20).map((e) => `${e.name} (guid via scene-state, id ${e.id})`),
        matched: hits.length,
      };
    }
    return { ids: [hits[0].id] };
  }

  const parsed = parseWhere(p.where as string, metaByName);
  if ('error' in parsed) return { ok: false, error: `${parsed.error} — nothing was applied.` };
  return { ids: all.filter((e) => parsed.pred(e)).map((e) => e.id) };
}

/** Refuse a `parentId` write that would make an entity its own ancestor.
 *
 *  `EntityAttributes.parentId` is an ordinary numeric field, so a plain field write reaches it and
 *  BYPASSES `reparentEntity` — the one place in the engine that rejects a self-parent or a
 *  descendant-as-parent. A single `set: {"EntityAttributes.parentId": <own id>}` produced a cycle
 *  that hung the subtree walk in liveLifecycle.ts (and would break hierarchy/transform propagation
 *  besides). The walk is cycle-SAFE now regardless; this stops the illegal state existing at all,
 *  because a hierarchy nothing can traverse is not a state an experiment should be able to reach. */
function guardParentWrite(ids: number[], writes: ParsedWrite[]): LiveMutateFailure | null {
  const write = writes.find((w) => w.trait === 'EntityAttributes' && w.field === 'parentId');
  if (!write) return null;
  const newParent = Number(write.value);
  if (!Number.isFinite(newParent)) {
    return { ok: false, error: `EntityAttributes.parentId must be a number — got ${JSON.stringify(write.value)}. Nothing was applied.` };
  }
  if (newParent === 0) return null;   // 0 = root, always legal
  if (!findEntity(newParent)) {
    return { ok: false, error: `EntityAttributes.parentId ${newParent} matched no live entity — nothing was applied. Re-parenting to a dead id would orphan the entity.` };
  }
  // The self-parent/cycle rule is SHARED with the editor's reparent (runtime/core/ecs/hierarchy.ts)
  // rather than restated here — this guard originally carried its own walk, which is precisely the
  // second implementation conventions §9 says will diverge (#166 P7).
  for (const id of ids) {
    const refusal = reparentRefusal(id, newParent);
    if (refusal) {
      return {
        ok: false,
        error: refusal === 'self-parent'
          ? `setting EntityAttributes.parentId to ${newParent} would make entity ${id} its own parent — nothing was applied.`
          : `setting EntityAttributes.parentId to ${newParent} would make entity ${id} its own ancestor — nothing was applied. A cycle makes the hierarchy untraversable; re-parent through the editor's reparent op, which validates the move.`,
      };
    }
  }
  return null;
}

/** Read the current values of the fields this call touches, for the before/after readback. A write
 *  must be verifiable (conventions §8), and verifying it in the SAME reply is one lease round trip
 *  instead of two. */
function snapshot(id: number, writes: ParsedWrite[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of writes) {
    const entity = findEntity(id);
    if (w.field === null) {
      out[w.trait] = entity ? entity.has(w.meta.trait) : false;
      continue;
    }
    const data = readTraitDataFull(id, w.meta) as Record<string, unknown> | null;
    out[`${w.trait}.${w.field}`] = data ? data[w.field] : undefined;
  }
  return out;
}

/** Apply `set` to every entity the selector matches, in the LIVE world only.
 *
 *  `guidOf` and `parseWhere` are injected rather than imported: both already exist in
 *  `agentBridge.ts` (guid resolution via the EntityAttributes cache, and the where-parser that
 *  `scene-state` uses), and duplicating either would reintroduce exactly the drift conventions §9
 *  warns about. */
export function applyLiveMutate(
  params: unknown,
  deps: {
    parseWhere: (expr: string, m: Map<string, TraitMeta>) => { pred: WherePredicate } | { error: string };
    guidOf: (id: number) => string;
  },
): LiveMutateResult {
  const p = (params ?? {}) as LiveMutateParams;
  const metaByName = new Map(getAllTraits().map((m) => [m.name, m] as const));

  if (!p.set || typeof p.set !== 'object' || Array.isArray(p.set) || Object.keys(p.set).length === 0) {
    return {
      ok: false,
      error: 'set is required and must be a non-empty object, e.g. {"Renderable3D.isVisible": false} — nothing was applied.',
    };
  }

  const parsedWrites = parseWrites(p.set, metaByName);
  if ('ok' in parsedWrites) return parsedWrites;
  const { writes } = parsedWrites;

  const selected = selectTargets(p, metaByName, deps.parseWhere);
  if ('ok' in selected) return selected;
  const ids = selected.ids;

  const parentRefusal = guardParentWrite(ids, writes);
  if (parentRefusal) return parentRefusal;

  if (ids.length === 0) {
    // Conventions §8: a no-op is a FAILURE when the caller asked for a change. `{ok:true,
    // changed:0}` would read as "applied, nothing needed changing" — the opposite of the truth.
    const selectorText = p.where != null ? `where "${p.where}"` : p.name != null ? `name "${p.name}"` : p.id != null ? `id ${p.id}` : 'the given guid(s)';
    return {
      ok: false,
      error: `${selectorText} matched no entities — nothing was applied. Check the selection first with the same expression: scene-state {where: …}.`,
      matched: 0,
    };
  }

  const limit = typeof p.limit === 'number' && p.limit >= 0 ? p.limit : DEFAULT_DETAIL_LIMIT;
  const detail: LiveMutateSuccess['entities'] = [];
  let changed = 0;

  for (const id of ids) {
    const entity = findEntity(id);
    if (!entity) continue;
    const before = snapshot(id, writes);

    if (!p.dryRun) {
      for (const w of writes) {
        if (w.field === null) {
          // Tag trait: presence IS the value. writeTraitField handles add/remove for category
          // 'tag'; the field argument is unused there but kept for its logging.
          writeTraitField(id, w.meta, w.trait, w.value);
          continue;
        }
        // writeTraitField returns SILENTLY when the entity lacks the trait — a false success on
        // the exact call that asked for a change. Seed the trait first (what the editor's live
        // path does via addTraitToEntitiesWithUndo) so the write lands.
        if (!entity.has(w.meta.trait)) entity.add(w.meta.trait);
        writeTraitField(id, w.meta, w.field, w.value);
      }
    }

    const after = p.dryRun
      ? Object.fromEntries(writes.map((w) => [w.field === null ? w.trait : `${w.trait}.${w.field}`, w.value]))
      : snapshot(id, writes);
    const differs = Object.keys(after).some((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    if (differs) changed++;
    if (detail.length < limit) {
      detail.push({ id, guid: deps.guidOf(id), name: (getAllEntities().find((e) => e.id === id)?.name) ?? `#${id}`, before, after });
    }
  }

  const res: LiveMutateSuccess = {
    ok: true,
    matched: ids.length,
    changed,
    saved: false,
    savedNote: 'live world only — a device has no project on disk, and a relaunch is the undo. There is no undo stack here.',
    entities: detail,
    ...(p.dryRun ? { dryRun: true as const } : {}),
    ...(detail.length < ids.length ? { detailTruncated: true as const } : {}),
  };
  if (changed === 0 && !p.dryRun) {
    // Every matched entity already held the requested values. Not a failure (the world IS in the
    // asked-for state) but an agent reading `changed:0` after a mutate deserves to be told which,
    // rather than concluding its write was ignored.
    res.hint = `matched ${ids.length} entit${ins(ids.length)}, but every one already held these values — nothing needed changing.`;
  }
  return res;
}

function ins(n: number): string {
  return n === 1 ? 'y' : 'ies';
}
