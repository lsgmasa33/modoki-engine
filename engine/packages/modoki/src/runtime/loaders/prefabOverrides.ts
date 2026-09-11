/** prefabOverrides — the PURE half of prefab-instance composition: override-map merging and the
 *  effective traits of a prefab MEMBER (its root, or any row), with no koota, no trait registry and
 *  no cache import.
 *
 *  It is a module of its own because several readers need one answer to "what would this member of a
 *  spawned instance actually carry?" and cannot share a file:
 *  - the spawner, `loadSceneFile.ts` `instantiatePrefabIntoWorld`, which BUILDS the instance; and
 *  - `sceneValidation.ts`, which runs inside the Node Vite plugin where no trait is registered, and
 *    which `loadSceneFile.ts` itself imports — so it can import neither that file nor anything that
 *    calls `trait({...})` at import time.
 *
 *  Before #1031 the validator and `entryPrefabProvider` each read a prefab ROW's own `traits`. For a
 *  row that is a nested-instance reference (`prefab: <guid>`) that row carries almost nothing: the
 *  entity it produces is the CHILD prefab's root plus the row's overrides. The functions below compose
 *  it with the same helpers and in the same order the spawner does, so the validator, the pool and the
 *  spawned entity describe the same thing.
 *
 *  `loadSceneFile.ts` re-exports the three override helpers, so their existing importers
 *  (`editor/scene/prefab.ts`, `editor/scene/serialize.ts`) are unchanged. */
import { emptyDocMap } from '../core/docKeys';

/** localId → trait name → field → value. */
export type OverrideMap = Record<number, Record<string, Record<string, unknown>>>;

/** Deep-merge two per-localId override maps (localId → trait → field → value).
 *  `b` wins on conflicts. Used to overlay a scene's nested-instance overrides on
 *  top of a prefab row's own overrides. Neither input is mutated. */
export function mergeOverrideMaps(
  a: Record<number, Record<string, Record<string, unknown>>> | undefined,
  b: Record<number, Record<string, Record<string, unknown>>>,
): Record<number, Record<string, Record<string, unknown>>> {
  // ⚠️ The OUTER bag is keyed by localId (a number — safe). The INNER bags are keyed by TRAIT
  // NAME read verbatim out of scene/prefab JSON, so they are `emptyDocMap()` (#986): a trait
  // named `__proto__` would otherwise hit the setter and vanish, and the `out[k][t] ?? {}` read
  // below would hand `Object.prototype`'s own members back as if they were authored overrides.
  // Making the bag null-prototyped fixes BOTH the write and that read, in place.
  const out: Record<number, Record<string, Record<string, unknown>>> = {};
  for (const [lid, traits] of Object.entries(a ?? {})) {
    out[Number(lid)] = emptyDocMap();
    for (const [t, fields] of Object.entries(traits)) out[Number(lid)][t] = { ...fields };
  }
  for (const [lid, traits] of Object.entries(b)) {
    const k = Number(lid);
    out[k] ??= emptyDocMap();
    for (const [t, fields] of Object.entries(traits)) out[k][t] = { ...(out[k][t] ?? {}), ...fields };
  }
  return out;
}

/** Path-keyed nested overrides — lets an OUTER layer (scene or ancestor prefab)
 *  override a member nested at ANY depth, with the outermost layer winning. Each
 *  key is a dot-joined chain of nested-prefab row localIds from the addressing
 *  instance down to the target instance; the value is that target instance's
 *  per-localId override map. `"3"` overrides the instance at row 3; `"3.5"` reaches
 *  the instance at row 5 nested inside it. A single-segment key is the legacy
 *  one-level form, so older scene files remain valid unchanged. */
export type NestedOverridePaths = Record<string, Record<number, Record<string, Record<string, unknown>>>>;

/** Split path-keyed overrides at one expansion step (nested row `rowLocalId`):
 *  `direct` is the override map for that child instance's OWN members (the exact
 *  key `rowLocalId`); `forward` re-keys every deeper path (`rowLocalId.…`) with the
 *  leading segment stripped, to thread into the child's own expansion. */
export function descendNestedOverrides(
  paths: NestedOverridePaths | undefined,
  rowLocalId: number,
): { direct?: Record<number, Record<string, Record<string, unknown>>>; forward?: NestedOverridePaths } {
  if (!paths) return {};
  const prefix = String(rowLocalId);
  let direct: Record<number, Record<string, Record<string, unknown>>> | undefined;
  let forward: NestedOverridePaths | undefined;
  for (const [key, map] of Object.entries(paths)) {
    if (key === prefix) direct = map;
    // `emptyDocMap()` (#986): the key is a dot-joined localId chain taken from the file, so a
    // crafted `"3.__proto__"` would assign through the setter and lose the map silently.
    else if (key.startsWith(prefix + '.')) (forward ??= emptyDocMap())[key.slice(prefix.length + 1)] = map;
  }
  return { direct, forward };
}

/** Merge two path-keyed override maps; `b` (the outer layer) wins per field. Used
 *  to overlay forwarded outer overrides on a prefab row's own deep overrides so the
 *  outermost layer wins at every depth. Neither input is mutated. */
export function mergeNestedOverridePaths(
  a: NestedOverridePaths | undefined,
  b: NestedOverridePaths | undefined,
): NestedOverridePaths | undefined {
  if (!a) return b;
  if (!b) return a;
  // `emptyDocMap()` (#986). Both halves matter here: the writes are document-keyed, and the
  // `out[k] ?` on the next line is a READ — against a plain object it is truthy for `toString`,
  // which would pass `Object.prototype.toString` (a FUNCTION) into mergeOverrideMaps as an
  // override map for it to `Object.entries`-walk.
  const out: NestedOverridePaths = emptyDocMap();
  for (const [k, m] of Object.entries(a)) out[k] = m;
  for (const [k, m] of Object.entries(b)) out[k] = out[k] ? mergeOverrideMaps(out[k], m) : m;
  return out;
}

/** Fold ONE trait's override fields onto its current values — the per-trait rule the spawner
 *  applies (`applyOverridesByLocalToEcs`) and `effectivePrefabMemberTraits` models, kept in one place
 *  so the two cannot disagree about precedence or about which fields count.
 *
 *  An accepted override field wins over the current value; a field `accept` refuses (the spawner's
 *  "genuinely renamed/stale field" case) is dropped and reported in `rejected`. `merged` is a new
 *  plain object; neither input is mutated. */
export function foldTraitOverride(
  current: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
  accept: (field: string) => boolean,
): { merged: Record<string, unknown>; accepted: string[]; rejected: string[] } {
  // `emptyDocMap()` (#986): field names come from a file. `merged` below is an object-literal
  // spread, which DEFINES properties rather than assigning them, so it carries them safely.
  const known: Record<string, unknown> = emptyDocMap();
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!accept(field)) { rejected.push(field); continue; }
    known[field] = value;
    accepted.push(field);
  }
  return { merged: { ...(current ?? {}), ...known }, accepted, rejected };
}

/** What a trait NAME is, as far as the caller knows. `undefined` means "a trait I do not know". */
export type TraitKind = 'component' | 'tag' | undefined;

export interface EffectiveMemberOptions {
  /** Which override fields count — the spawner accepts a field its trait PERSISTS
   *  (`isPersistentTraitField`). INJECTED rather than looked up, because this module must run where
   *  no trait registry exists. Omitted → every field is accepted. */
  acceptField?: (trait: string, field: string) => boolean;
  /** What kind of trait a name is. Needed because an override does more than set fields: the spawner
   *  ADDS a trait an override names but the member lacks — for a KNOWN trait, even when no field of
   *  the override is accepted (an empty or all-renamed override still adds it, at its defaults), a
   *  tag as a tag — and SKIPS a name it does not know. Omitted → every name is a known component. */
  traitKind?: (trait: string) => TraitKind;
  /** Per-localId overrides an OUTER layer applies to this prefab instance's own members. */
  overrides?: OverrideMap;
  /** Path-keyed overrides an outer layer applies to this instance's nested descendants. */
  nestedOverrides?: NestedOverridePaths;
  /** Per-localId component removals an outer layer applies to this instance. */
  removedTraits?: Record<number, string[]>;
}

/** @deprecated-alias kept for the first caller's name; identical to `EffectiveMemberOptions`. */
export type EffectiveRootOptions = EffectiveMemberOptions;

/** Nesting deeper than this is refused. A backstop, not the cycle guard: the spawner's own guard
 *  keys on `prefab.id`, which a hand-written or test prefab may lack. */
const MAX_NEST_DEPTH = 64;

type PrefabRowLike = {
  localId?: unknown; traits?: unknown; prefab?: unknown;
  overrides?: unknown; nestedOverrides?: unknown; removedTraits?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The trait bag an instance of `prefab` would carry on its ROOT entity — or `null` when no root
 *  entity would be produced at all. The root is `rootLocalId ?? 1`, the spawner's rule (NOT "the first
 *  row"). See `effectivePrefabMemberTraits` for how a member is composed. */
export function effectivePrefabRootTraits(
  prefab: unknown,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(prefab)) return null;
  return resolveMember(prefab, (prefab.rootLocalId as number | undefined) ?? 1, getPrefab, opts, new Set<string>(), 0);
}

/** The trait bag the member at `localId` of an instance of `prefab` would carry — composed from the
 *  prefab file(s) exactly the way `instantiatePrefabIntoWorld` builds it — or `null` when no entity
 *  would be produced for that localId.
 *
 *  Mirrors the spawner, step for step:
 *  1. **Which row:** the LAST row carrying `localId` (the spawner's `localToEcs.set` overwrites). No
 *     such row, or localId 0 → `null`.
 *  2. **A nested-instance row** (`prefab: <guid>`) produces the CHILD prefab's ROOT, with the row's
 *     own `overrides` merged under whatever an outer layer addresses at this row (outer wins), the
 *     row's `nestedOverrides` threaded on, and the row's `removedTraits` applied in the child. The
 *     row's own `traits` are NOT part of the result — the spawner reads only `parentId` there. A child
 *     that does not resolve (uncached, a cycle, too deep) → `null`, because the spawner maps no entity
 *     for the row either.
 *  3. **A plain row** starts from its own `traits`, minus any baked-in `PrefabInstance` (the spawner
 *     replaces it).
 *  4. `opts.overrides[localId]` is folded on AFTER the row is resolved — adding a known trait the
 *     member lacks, skipping an unknown one (see `traitKind`) — then `opts.removedTraits[localId]` is
 *     deleted LAST: the spawner's order (overrides, then structure).
 *
 *  ⚠️ Values are returned by REFERENCE where nothing overrode them, as the plain-row read always
 *  did — the result may alias the prefab CACHE, so never mutate it.
 *
 *  **Not modelled:** a structural `removed` of the member itself (the spawner returns a dead id). */
export function effectivePrefabMemberTraits(
  prefab: unknown,
  localId: number,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions = {},
): Record<string, unknown> | null {
  return resolveMember(prefab, localId, getPrefab, opts, new Set<string>(), 0);
}

function resolveMember(
  prefab: unknown,
  localId: number,
  getPrefab: (ref: string) => unknown,
  opts: EffectiveMemberOptions,
  stack: Set<string>,
  depth: number,
  /** The ref this prefab was reached BY (absent at the top level). */
  selfRef?: string,
): Record<string, unknown> | null {
  if (!isRecord(prefab)) return null;
  const entities = prefab.entities;
  if (!Array.isArray(entities) || entities.length === 0) return null;

  // An ANCESTOR stack, like the spawner's — which keys on `prefab.id` alone. This level registers
  // under its `id` AND the ref it was reached by, ONCE, on entry: a real prefab's `id` IS the ref
  // that names it, so registering the ref in the parent before recursing (the first draft) made
  // every nested child see its own id already on the stack and resolve to null. Keying on the ref
  // too keeps a prefab with no `id` from recursing forever.
  const keys = [...new Set([typeof prefab.id === 'string' ? prefab.id : '', selfRef ?? ''])].filter(Boolean);
  if (keys.some((k) => stack.has(k))) return null;
  for (const k of keys) stack.add(k);
  try {
    let row: PrefabRowLike | undefined;
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i] as PrefabRowLike | null;
      if (isRecord(e) && ((e.localId as number | undefined) ?? 0) === localId) { row = e; break; }
    }
    if (!row || !localId) return null;

    let traits: Record<string, unknown>;
    if (typeof row.prefab === 'string' && row.prefab) {
      const ref = row.prefab;
      if (depth >= MAX_NEST_DEPTH) return null;
      let child: unknown;
      try { child = getPrefab(ref); } catch { child = undefined; }
      if (!isRecord(child)) return null;
      const { direct, forward } = descendNestedOverrides(opts.nestedOverrides, localId);
      const rowOverrides = isRecord(row.overrides) ? row.overrides as OverrideMap : undefined;
      const childOverrides = direct ? mergeOverrideMaps(rowOverrides, direct) : rowOverrides;
      const rowNested = isRecord(row.nestedOverrides) ? row.nestedOverrides as NestedOverridePaths : undefined;
      // The child registers itself (under its id and `ref`) on entry — see the stack note above.
      const composed = resolveMember(child, (child.rootLocalId as number | undefined) ?? 1, getPrefab, {
        acceptField: opts.acceptField,
        traitKind: opts.traitKind,
        overrides: childOverrides,
        nestedOverrides: mergeNestedOverridePaths(rowNested, forward),
        removedTraits: isRecord(row.removedTraits) ? row.removedTraits as Record<number, string[]> : undefined,
      }, stack, depth + 1, ref);
      if (!composed) return null;
      traits = composed;
    } else {
      traits = emptyDocMap();
      if (isRecord(row.traits)) {
        for (const [name, data] of Object.entries(row.traits)) {
          if (name !== 'PrefabInstance') traits[name] = data;
        }
      }
    }

    const own = opts.overrides?.[localId];
    if (isRecord(own)) {
      for (const [traitName, fields] of Object.entries(own)) {
        if (!isRecord(fields)) continue;
        const kind: TraitKind = opts.traitKind ? opts.traitKind(traitName) : 'component';
        // The spawner skips a trait name its registry does not know.
        if (kind === undefined) continue;
        // …adds a tag it names (a tag carries no fields to fold)…
        if (kind === 'tag') { traits[traitName] = true; continue; }
        // …and folds a component — ADDING it when the member lacks it, even if no field was accepted,
        // because the spawner then adds it at its defaults.
        const current = traits[traitName];
        const accept = (field: string) => (opts.acceptField ? opts.acceptField(traitName, field) : true);
        traits[traitName] = foldTraitOverride(isRecord(current) ? current : undefined, fields, accept).merged;
      }
    }

    const removed = opts.removedTraits?.[localId];
    if (Array.isArray(removed)) {
      for (const name of removed) if (typeof name === 'string') delete traits[name];
    }
    return traits;
  } finally {
    for (const k of keys) stack.delete(k);
  }
}
