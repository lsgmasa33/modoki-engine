import { deriveGuid, durableGuid } from '../core/assetRefRules';

/** The subset of `SceneEntityEntry` (loadSceneFile.ts) this module reads. Declared
 *  structurally rather than imported so the module stays a pure leaf — `loadSceneFile`
 *  imports a VALUE from here, and a type-only back-import would still put the two files
 *  in each other's graph for anything that does not erase types. */
export interface AuthoredGuidEntry {
  id: number;
  name?: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  /** A prefab-instance root's scene-authored guid, stored at entry level rather than
   *  inside EntityAttributes. Present ⇒ the entry already has an identity. */
  guid?: string;
}

/** Longest ancestor chain walked when building a parent path. A scene hierarchy is
 *  nowhere near this deep; the cap exists so a `parentId` cycle in a hand-edited or
 *  corrupt file terminates instead of hanging the load. */
const MAX_PARENT_DEPTH = 64;

/** Derive a STABLE guid for every scene entry that has no durable one.
 *
 *  ## Why this exists (#1268)
 *
 *  Since #1248 every spawned entity gets `EntityAttributes`, and `spawnEntity` mints a
 *  RUNTIME guid for it (`world.ts`, #1210) — an address valid only until reload, which
 *  `durableGuid()` deliberately reads as "no guid". A scene entry written before #1248
 *  carries no `EntityAttributes` at all, so on the FIRST SAVE the serializer's guid
 *  pre-pass mints a random `crypto.randomUUID()` for it. Every clone mints a different
 *  one, so two clones saving the same untouched scene produce conflicting diffs — and
 *  because `compareSiblings` tiebreaks on `guid.localeCompare` (`entityOrder.ts`), the
 *  random guid also MOVES the entity in the file. Deriving the guid instead makes every
 *  clone write the same bytes.
 *
 *  ## The seed (owner, 2026-09-16)
 *
 *  `scene path | parent path / entity name`, disambiguated by an ordinal when two entries
 *  in one file would otherwise seed identically. The scene half is whatever path the loader
 *  was called with — `SceneData` has no `id` field and this loader never reads the file's
 *  top-level `id`, so the path is the only scene identity that reaches *this* function.
 *
 *  ⚠️ **"Project-relative" is what the caller normally passes, NOT something enforced here**,
 *  and the difference is a real one: `App.tsx`'s OTA sub-game boot prefixes `assetBaseUrl`
 *  onto the path before `loadScene`, so the same unmigrated scene seeds differently as a baked
 *  shell game and as an OTA sub-game. Latent today — the runtime never saves a scene, and the
 *  committed corpus is fully migrated — but it means the seed's stability rests on the callers
 *  agreeing on a spelling. #1293 carries that, together with the alternative the owner may
 *  prefer: `SceneManager` already computes a `primaryGuid` from the file's own `id`, which is
 *  immune to path spelling and to a rename.
 *
 *  ⚠️ **A derived guid is meant to be STORED on the next save, not re-derived forever.**
 *  Every input to the seed is authored data a human edits, so re-deriving on each load
 *  would make the identity move under a rename or a reparent. The engine already ships
 *  one derive-and-don't-store address space, for prefab instance members
 *  (`deriveInstanceMemberGuids`), and #1272/#1278/#1284 are the bugs that came out of it:
 *  a reload re-derived the members and everything holding a reference missed. So this runs
 *  ONCE per entity, for a file written before the rule existed; afterwards the entry has a
 *  real guid on disk and never reaches this code again. #1293 tracks the remaining seam
 *  (duplicate/rename of the FILE).
 *
 *  ## Scope
 *
 *  Only entries with no durable guid from any source are derived — an entry carrying
 *  `EntityAttributes.guid` or a top-level `entry.guid` (a prefab-instance root) is left
 *  exactly as authored. Prefab MEMBERS are not in `data.entities` at all; they keep their
 *  own anchor-based derivation, which runs after this and can now anchor on an entry this
 *  function just gave an identity to.
 *
 *  @param entities  The scene file's entries, in file order.
 *  @param scenePath Project-relative path of the scene being loaded. When absent, NOTHING
 *    is derived and the caller falls back to the runtime guid — the carried-snapshot load
 *    (`SceneManager`'s respawn after a world swap) synthesises its `SceneData` from live
 *    entities drawn from several different scenes, so it has no single scene identity, and
 *    its entities already carry durable guids from their originating files. Re-keying one
 *    there would defeat `filterPersistentDuplicates`, which matches a carried entity to the
 *    incoming scene's row BY GUID.
 *  @param reserved Guids that are already spoken for but are NOT in `entities` — in practice the
 *    durable guids of entities already ALIVE in the target world. ⚠️ Load-bearing, not belt-and-
 *    braces: `SceneManager` runs `filterPersistentDuplicates` and `filterDuplicateChainGuids`
 *    BEFORE handing the data over, and both *remove rows*. A row dropped because a carried
 *    `Persistent` entity already covers it takes its guid out of `entities` with it — while that
 *    entity is very much alive — so without this a guid-less twin in the same file derives exactly
 *    the carried entity's guid, and the result depends on the approach path (cold open vs. a swap
 *    that carried it) rather than on the file's bytes.
 *  @returns `entry.id → derived guid`, containing only the entries that needed one.
 */
export function deriveAuthoredEntityGuids(
  entities: AuthoredGuidEntry[],
  scenePath: string | undefined,
  reserved?: Iterable<string>,
): Map<number, string> {
  const derived = new Map<number, string>();
  if (!scenePath) return derived;

  const guidOf = (e: AuthoredGuidEntry): string => {
    const ea = e.traits?.EntityAttributes;
    const own = ea && ea !== true ? (ea as Record<string, unknown>).guid : undefined;
    return durableGuid(typeof own === 'string' ? own : '') || durableGuid(e.guid);
  };

  // Ancestors are addressed by GUID on disk (`EntityAttributes.parentId`, v12+), so the
  // path can only be walked through entries that HAVE one. An entry whose parent is itself
  // guid-less is unreachable this way and is treated as a root — acceptable because the
  // ordinal below still keeps it unique within the file, and because the real population
  // (#1268: 34 entries, all roots) has no parent at all.
  const byGuid = new Map<string, AuthoredGuidEntry>();
  for (const e of entities) {
    const g = guidOf(e);
    if (g) byGuid.set(g, e);
  }

  // ⚠️ `MAX_PARENT_DEPTH` is the ONLY thing standing between a `parentId` cycle and a hung load, so
  // it is load-bearing rather than defensive. A visited-set was here too and was removed: with the
  // cap already guaranteeing termination it changed nothing a caller can observe, and two guards for
  // one property means neither can be mutation-tested — deleting either left the suite green.
  const parentPathOf = (entry: AuthoredGuidEntry): string => {
    const parts: string[] = [];
    let cur = entry;
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
      const ea = cur.traits?.EntityAttributes;
      const pid = ea && ea !== true ? (ea as Record<string, unknown>).parentId : undefined;
      if (typeof pid !== 'string' || !pid) break;
      const parent = byGuid.get(pid);
      if (!parent) break; // dangling ref
      parts.unshift(parent.name ?? '');
      cur = parent;
    }
    return parts.join('/');
  };

  // Two entries can legitimately share a name under a shared parent, and a guid MUST be
  // unique within one scene file (`sceneGuidUniqueness.test.ts`) — an ordinal on the
  // second and later occurrence is what keeps that true. Counted per CALL, never per
  // world: a base-scene chain runs one call per file into ONE world, and per-world state
  // here would let one file's names perturb another's seeds (the shape of A9 defect 1).
  // Everything already claimed in this file: the guids entries came in with, PLUS each one derived
  // below as it is handed out. A guid must be unique WITHIN a scene file
  // (`sceneGuidUniqueness.test.ts`), and both halves of that matter —
  //  - against EXISTING guids, because a file can hold the migrated `Time (resource)` row and a
  //    guid-less copy of it at once (a merge that kept both sides, a partial revert, the old shape
  //    pasted into a migrated file), and the copy would otherwise derive exactly the stored guid;
  //  - against other DERIVED guids, because two entries can legitimately share a name under a
  //    shared parent and would otherwise seed identically.
  // Neither is caught downstream: `filterDuplicateChainGuids` compares ON-DISK guids, before any of
  // this runs, and the corpus guard only sees the result after someone saves.
  //
  // ⚠️ ONE mechanism on purpose. A per-seed ordinal counter used to sit alongside this set, and once
  // the set existed the counter changed nothing observable — deleting it left every test green,
  // because advancing on collision already separates duplicates. Two guards for one property means
  // neither can be mutation-tested; see the note on `parentPathOf` for the same lesson.
  const taken = new Set<string>(byGuid.keys());
  for (const g of reserved ?? []) if (g) taken.add(g);

  for (const entry of entities) {
    if (guidOf(entry)) continue;
    const base = `scene:${scenePath}|path:${parentPathOf(entry)}/${entry.name ?? ''}`;
    let guid = deriveGuid(base);
    // Each bump re-seeds, so every attempt is a different hash. Bounded rather than `while`: a hang
    // in the loader would be a far worse failure than the astronomically unlikely exhaustion this
    // guards, and because every attempt is deterministic, a clone that did exhaust would exhaust
    // identically everywhere — still the same bytes in every clone, which is the actual requirement.
    for (let n = 1; taken.has(guid) && n <= entities.length + 1; n++) {
      guid = deriveGuid(`${base}|dup:${n}`);
    }
    taken.add(guid);
    derived.set(entry.id, guid);
  }
  return derived;
}
