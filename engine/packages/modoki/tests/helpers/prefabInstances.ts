/**
 * ⚠️ **What a placed prefab instance ACTUALLY carries — for a guard that would otherwise read the
 * prefab's own root (#1060).**
 *
 * A prefab placed inside another document — a `level-page` row placing `level-tile`, a scene row
 * placing a character — is a ROW that names the child prefab and carries `overrides` /
 * `nestedOverrides` / `removedTraits`. The runtime spawns the child's members with those folded on
 * (`effectivePrefabMemberTraits`, #1031), so ONE instance can be a different size from the prefab it
 * came from. A guard that measures the child prefab's root file is blind to it: resize one level tile
 * in the Prefab editor and every root-reading size check still passes while that tile is 33 pt wide.
 *
 * This enumerates every instance in a document, member by member, composed by the ENGINE'S OWN
 * function — never by a copy of the fold, which would be a second statement of the spawner's
 * precedence and would drift from it. Deciding which DIFFERENCES matter is the consumer's job (the
 * tap-target gate compares what it would CONCLUDE about the placed member against its prefab's own
 * copy), so nothing here judges one.
 *
 * ⚠️ **Not modelled, inherited from `effectivePrefabMemberTraits`: a row's structural `added` /
 * `removed` members** (the spawner applies both into the child). A guard that depends on a member
 * EXISTING must refuse those itself.
 *
 * Lives in the PACKAGE for the reason `tapTargetFloor.ts` does — a published demo can name only
 * `@modoki/engine`. Exported as `@modoki/engine/testing/prefabInstances`.
 */

// ⚠️ Relative and narrow, like `tapTargetFloor.ts`: `prefabOverrides` imports nothing but `docKeys`,
// which is what lets this run in a plain Node test with no trait registry.
import {
  descendNestedOverrides, effectivePrefabMemberTraits, mergeNestedOverridePaths, mergeOverrideMaps,
  type EffectiveMemberOptions, type NestedOverridePaths, type OverrideMap,
} from '../../src/runtime/loaders/prefabOverrides';

/** Resolve a `prefab:` ref (the child prefab's `id`) to its parsed document, or `undefined`. */
export type PrefabLookup = (ref: string) => unknown;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Index parsed documents by their `id` — the ref a `prefab:` row names. A document without a string
 *  `id` (most scenes) is simply not addressable, which is also true at runtime. */
export function prefabLookup(docs: Iterable<unknown>): PrefabLookup {
  const byId = new Map<string, unknown>();
  for (const d of docs) if (isRecord(d) && typeof d.id === 'string' && d.id) byId.set(d.id, d);
  return (ref) => byId.get(ref);
}

/** Where a member sits in its instance's `members`: the entry with this `path` and `localId`. */
export interface MemberAddress { path: readonly number[]; localId: number }

export interface InstanceMember {
  /** The member's `localId` inside the prefab that authors it. */
  localId: number;
  /** Nested-instance row `localId`s from the placed child down to the prefab holding this member —
   *  `[]` for a member of the child itself, `[4]` for a member of the instance at the child's row 4. */
  path: readonly number[];
  /**
   * The ADDRESS of this member's parent within the same instance, or `undefined` when the parent is
   * outside it — the placed root (whose parent is the placing row's own `parentId`, in the placing
   * document) or a member authored with no parent (the spawner puts it at the world root).
   *
   * ⚠️ A member parented to a NESTED child's root is addressed at the placing ROW one level up
   * (`path` minus its last segment, `localId` = that segment), because that root is listed there and
   * NOT at its own depth — see `collect`. Resolving it as `(path, rootLocalId)` finds nothing, and a
   * consumer walking ancestors silently gets an empty chain (#1060 close-out review).
   */
  parent: MemberAddress | undefined;
  /** The traits the runtime spawns for this member IN THIS INSTANCE. `null` → no entity is produced. */
  effective: Rec | null;
  /** The same member composed WITHOUT this placement's overrides — what the document ONE LEVEL IN
   *  measures: the child prefab file for a top-level member, the placing prefab (with its own row's
   *  overrides) for a nested one. Comparing it with `effective` is how a guard knows the instance
   *  diverged. */
  standalone: Rec | null;
}

export interface PrefabInstance {
  /** The row that places the instance, in the document passed in. */
  row: Rec;
  /** The child prefab's id. */
  ref: string;
  /** The runtime NAME — the root's effective `EntityAttributes.name` (a pooled `Day3`, a `Tile12`),
   *  falling back to the row's own. */
  name: string;
  /** `members[0]`. Its `parent` is always `undefined`: the placing row's `parentId` says where it goes. */
  root: InstanceMember;
  /** Every member, root first. A child that does not resolve yields NO instance, never a guess. */
  members: InstanceMember[];
}

/** The options a placement row applies to the child it names. */
function rowOptions(row: Rec): EffectiveMemberOptions {
  return {
    overrides: isRecord(row.overrides) ? row.overrides as OverrideMap : undefined,
    nestedOverrides: isRecord(row.nestedOverrides) ? row.nestedOverrides as NestedOverridePaths : undefined,
    removedTraits: isRecord(row.removedTraits) ? row.removedTraits as Record<number, string[]> : undefined,
  };
}

/** The options the spawner threads into the instance at `row` (localId `lid`) when an OUTER layer
 *  applies `outer` — `resolveMember` step 2, line for line: the row's overrides with the outer layer's
 *  direct map merged over them, the outer deep paths forwarded under the row's own, and the ROW's
 *  removals (outer removals are not forwarded). */
function threadInto(row: Rec, lid: number, outer: EffectiveMemberOptions): EffectiveMemberOptions {
  const own = rowOptions(row);
  const { direct, forward } = descendNestedOverrides(outer.nestedOverrides, lid);
  return {
    overrides: direct ? mergeOverrideMaps(own.overrides, direct) : own.overrides,
    nestedOverrides: mergeNestedOverridePaths(own.nestedOverrides, forward),
    removedTraits: own.removedTraits,
  };
}

const MAX_DEPTH = 64;

function collect(
  prefab: unknown, opts: EffectiveMemberOptions, base: EffectiveMemberOptions, getPrefab: PrefabLookup,
  path: readonly number[], stack: Set<string>, out: InstanceMember[],
): void {
  if (!isRecord(prefab) || !Array.isArray(prefab.entities) || path.length > MAX_DEPTH) return;
  const id = typeof prefab.id === 'string' ? prefab.id : '';
  if (id && stack.has(id)) return;
  if (id) stack.add(id);
  try {
    const rootId = typeof prefab.rootLocalId === 'number' ? prefab.rootLocalId : 1;
    // The LAST row carrying a localId is the one the spawner keeps (`localToEcs.set` overwrites).
    const rows = new Map<number, Rec>();
    for (const e of prefab.entities) if (isRecord(e) && typeof e.localId === 'number' && e.localId) rows.set(e.localId, e);
    const ids = [...rows.keys()].sort((a, b) => (a === rootId ? -1 : b === rootId ? 1 : a - b));
    const nested = path.length > 0;
    for (const lid of ids) {
      const row = rows.get(lid)!;
      // A NESTED child's root is not listed at its own depth: it is the member one level up (the row
      // that placed it), where the outer fold on that row's localId applies AFTER the child resolves.
      if (!(nested && lid === rootId)) {
        const attrs = isRecord(row.traits) && isRecord(row.traits.EntityAttributes) ? row.traits.EntityAttributes : {};
        const p = attrs.parentId;
        let parent: MemberAddress | undefined;
        if (lid !== rootId && typeof p === 'number' && p) {
          parent = nested && p === rootId
            ? { path: path.slice(0, -1), localId: path[path.length - 1] }
            : { path, localId: p };
        }
        out.push({
          localId: lid,
          path,
          parent,
          effective: effectivePrefabMemberTraits(prefab, lid, getPrefab, opts),
          standalone: effectivePrefabMemberTraits(prefab, lid, getPrefab, base),
        });
      }
      // A member that is itself an instance: its OTHER members are reached with the options the
      // spawner threads into that child.
      if (typeof row.prefab === 'string' && row.prefab) {
        let child: unknown;
        try { child = getPrefab(row.prefab); } catch { child = undefined; }
        collect(child, threadInto(row, lid, opts), threadInto(row, lid, base), getPrefab, [...path, lid], stack, out);
      }
    }
  } finally {
    if (id) stack.delete(id);
  }
}

/**
 * Every prefab instance placed by `doc`'s rows (any row with a string `prefab`), each composed member
 * by member. Works for a scene and for a prefab alike — both spell an instance row the same way.
 */
export function prefabInstances(doc: unknown, getPrefab: PrefabLookup): PrefabInstance[] {
  if (!isRecord(doc) || !Array.isArray(doc.entities)) return [];
  const out: PrefabInstance[] = [];
  for (const row of doc.entities) {
    if (!isRecord(row) || typeof row.prefab !== 'string' || !row.prefab) continue;
    let child: unknown;
    try { child = getPrefab(row.prefab); } catch { child = undefined; }
    const members: InstanceMember[] = [];
    // The placed child is composed with the row's options; its `standalone` twin with none, which is
    // exactly the child prefab file read on its own.
    collect(child, rowOptions(row), {}, getPrefab, [], new Set(), members);
    const root = members[0];
    if (!root) continue;
    const attrs = isRecord(row.traits) && isRecord(row.traits.EntityAttributes) ? row.traits.EntityAttributes : {};
    const effName = isRecord(root.effective?.EntityAttributes) ? root.effective.EntityAttributes.name : undefined;
    const name = typeof effName === 'string' && effName ? effName
      : typeof attrs.name === 'string' && attrs.name ? attrs.name
        : typeof row.name === 'string' ? row.name : '(unnamed instance)';
    out.push({ row, ref: row.prefab, name, root, members });
  }
  return out;
}
