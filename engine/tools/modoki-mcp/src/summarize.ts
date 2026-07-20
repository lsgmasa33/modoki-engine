/** Summary-first shaping for the two flat "list everything" tools.
 *
 *  `list_assets` returned all 320 manifest entries (~16.7k tokens) and `list_traits` all 60 trait
 *  schemas (~10.7k) on every call. Neither is ever the question. An agent resolving a GUID wants
 *  one folder; an agent about to `setTrait` wants ONE trait's fields. So bare calls answer
 *  "what exists, and how much of it" and a filter buys the detail.
 *
 *  This lives outside `index.ts` on purpose: `index.ts` calls `main()` at module load and cannot
 *  be imported by a test, so anything with logic in it ships unguarded. See
 *  `docs/mcp-response-budget.md` Phase 5, and the Phase-1 review that learned this the hard way. */

export interface AssetEntry { guid: string; path: string; name: string; type: string }
export interface TraitSchema { category?: string; fields?: Record<string, unknown> }

export interface AssetQuery { type?: string; folder?: string; name?: string; all?: boolean; limit?: number }

/** Bare → per-type counts. Any of type/folder/name/limit (or `all`) → matching entries.
 *
 *  `limit` counts as targeting. Asking for "the first 5 assets" and receiving a histogram
 *  instead would be a parameter silently ignored — the same failure this whole effort exists
 *  to eliminate. An explicit param must always change the answer. */
export function summarizeAssets(assets: AssetEntry[], q: AssetQuery = {}) {
  const targeted = !!(q.type || q.folder || q.name || q.limit != null);
  if (!targeted && !q.all) {
    const byType: Record<string, number> = {};
    for (const a of assets) byType[a.type] = (byType[a.type] ?? 0) + 1;
    return {
      total: assets.length,
      byType,
      hint: 'Counts only. Narrow with type=<type>, folder=<path prefix>, or name=<substring>; or all=true for every entry.',
    };
  }
  const needle = q.name?.toLowerCase();
  let filtered = assets.filter((a) =>
    (!q.type || a.type === q.type) &&
    (!q.folder || a.path.startsWith(q.folder)) &&
    (!needle || a.name.toLowerCase().includes(needle) || a.path.toLowerCase().includes(needle)));

  const totalCount = filtered.length;
  let truncated = false;
  if (q.limit != null && filtered.length > q.limit) { filtered = filtered.slice(0, q.limit); truncated = true; }
  return {
    count: filtered.length,
    assets: filtered,
    ...(truncated ? { truncated, totalCount } : {}),
    // A zero-result filter is the silent-empty trap: say so, and say how to recover.
    ...(filtered.length === 0 ? { hint: 'No match. Call bare for per-type counts, or widen the filter.' } : {}),
  };
}

export interface TraitQuery { name?: string; all?: boolean }
export type TraitResult =
  | { error: string }
  | { schemaAvailable?: boolean; traits: Record<string, TraitSchema> }
  | { schemaAvailable?: boolean; traitCount: number; byCategory: Record<string, string[]>; hint: string };

/** Bare → names grouped by category. `name=` → that one trait's full schema (with a
 *  did-you-mean on a miss, because a silent empty here reads as "the trait doesn't exist"). */
export function summarizeTraits(
  traits: Record<string, TraitSchema>,
  schemaAvailable: boolean | undefined,
  q: TraitQuery = {},
): TraitResult {
  if (q.name) {
    const hit = traits[q.name];
    if (!hit) {
      // "unknown trait" is a LIE when the registry is simply EMPTY — the renderer pushes it,
      // so a cold start or a reloading window means we know NOTHING, not that the trait
      // doesn't exist. The did-you-mean was filtered from the same empty map, so it went
      // silent too, and `list_traits {name:'Transform'}` told the agent Transform is not a
      // registered trait. It then abandoned a perfectly good setTrait. (C7)
      if (schemaAvailable === false || Object.keys(traits).length === 0) {
        return { error: `the trait registry is EMPTY — no editor renderer has pushed it yet (cold start, or the window is reloading). This says NOTHING about whether "${q.name}" exists. Wait for the editor window to finish loading, then retry.` };
      }
      const near = Object.keys(traits).filter((t) => t.toLowerCase().includes(q.name!.toLowerCase())).slice(0, 8);
      return { error: `unknown trait "${q.name}"${near.length ? ` — did you mean: ${near.join(', ')}?` : ''}` };
    }
    return { schemaAvailable, traits: { [q.name]: hit } };
  }
  if (q.all) return { schemaAvailable, traits };

  const byCategory: Record<string, string[]> = {};
  for (const [name, s] of Object.entries(traits)) (byCategory[s.category ?? 'other'] ??= []).push(name);
  return {
    schemaAvailable,
    traitCount: Object.keys(traits).length,
    byCategory,
    hint: 'Names only. Pass name=<Trait> for its field schema (do this before a setTrait), or all=true for every schema.',
  };
}
