/** Shared by both MCP servers (#1559 C-13): the editor's `flatEntityAlias` tools and
 *  `device_duplicate_entity`. Dependency-free. */

/** Fold a nested `entity` ref into the flat `{guid, id}` a tool's handler already passes on.
 *
 *  Refuses BOTH-at-once rather than picking: a caller who sent two addresses does not know which
 *  one this tool uses, and choosing for them is exactly the silent-wrong-target class §0 ranks
 *  first. Returns the flat pair, or a message for the caller to refuse with.
 *
 *  ⚠️ `flatEntityAlias` (modoki-mcp `shapes.ts`) and the device twin's alias are `.strict()` and carries no `name` ON PURPOSE — both halves matter.
 *  Without `name` but not strict, zod STRIPS the key (a nested `z.object` is not strict just
 *  because its parent is), so `entity:{name:'Crate'}` would arrive here as `{}`, fold to the empty
 *  flat ref, and surface as "entity ref matched no live entity — it may be stale": a §0 rank-4
 *  unclear failure pointing at the wrong cause. That is the §1 silent-key-strip bug one level down,
 *  and it is why `mutateOpSchema`'s entity ref is strict too. */
export function foldEntityRef(
  flat: { guid?: string; id?: number },
  entity: { guid?: string; id?: number } | undefined,
): { guid?: string; id?: number } | { conflict: string } {
  if (!entity || Object.keys(entity).length === 0) return flat;
  // `!== undefined`, not truthiness: `id: 0` is the ROOT entity, and a truthiness test would read
  // it as "no address given" and silently fall through to the other branch.
  // An empty string is ABSENT, as in the live resolver (`app/debug/entityRef.ts`, #1223).
  const flatKeys = Object.entries(flat).filter(([, v]) => v !== undefined && v !== '').map(([k]) => k);
  if (flatKeys.length) {
    return { conflict: `both \`entity\` and the flat ${flatKeys.join('/')} were given — they are two ways to say the same thing, and sending both leaves it ambiguous which target you meant. Pass exactly one.` };
  }
  return entity;
}
