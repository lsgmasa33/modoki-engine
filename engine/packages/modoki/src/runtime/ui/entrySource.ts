/** entrySource — the registry a game fills a scroll view's entries through.
 *
 *  The engine decides WHICH pooled instance shows entry (x, y); the game answers WHAT entry
 *  (x, y) says. That inversion is the whole contract, and it is why a game registers a resolver
 *  by name instead of writing to named entities: with a pool, there are no stable named
 *  entities to write to.
 */
import { resolveMemberPathIn } from '../core/ecs/memberPath';

/** Where an entry sits in the data. Both forms are given because a 2-D consumer wants x/y and a
 *  1-D consumer wants index, and making either do the arithmetic the engine already did is
 *  gratuitous. */
export interface EntryCoord { x: number; y: number; index: number }

/** What one entry says.
 *
 *  `members` is keyed by member PATH within the entry prefab instance (`''` = the entry root),
 *  then by TRAIT name, then by field. Trait-keyed with no shorthand is deliberate: a flat field
 *  map would have to GUESS a trait, so a resolver returning a `UIToggle.value` would silently
 *  write nothing — the "an unwired field is a lie with a tooltip" failure. */
export interface EntryContent {
  /** Entry kind (a name from `UIEntries.prefabs`). Omitted → the first declared kind. */
  kind?: string;
  members: Record<string, Record<string, Record<string, unknown>>>;
}

export type EntryResolver = (at: EntryCoord) => EntryContent | null;

const sources = new Map<string, EntryResolver>();

export function registerEntrySource(name: string, resolver: EntryResolver): void {
  if (!name) { console.error('[entrySource] refusing to register a source with no name'); return; }
  if (sources.has(name)) console.warn(`[entrySource] '${name}' re-registered — the later one wins`);
  sources.set(name, resolver);
}
export function unregisterEntrySource(name: string): void { sources.delete(name); }
export function getEntrySource(name: string): EntryResolver | undefined { return sources.get(name); }
export function getEntrySourceNames(): string[] { return [...sources.keys()]; }
/** Test/teardown only — a game's registrations are re-made on load. */
export function clearEntrySources(): void { sources.clear(); }

/** One resolved trait write. */
export interface EntryWrite { entityId: number; trait: string; fields: Record<string, unknown>; path: string }

/** A path that named nothing, or named several things. */
export interface EntryWriteProblem { path: string; reason: 'not-found' | 'ambiguous'; at?: string }

export interface EntryWritePlan { writes: EntryWrite[]; problems: EntryWriteProblem[] }

/** Turn one entry's content into concrete trait writes.
 *
 *  Pure over a prebuilt child index, so the rules that matter — full paths, exactly one match,
 *  a problem REPORTED rather than swallowed — are testable with no world and no DOM.
 *
 *  ⚠️ A path that names several members is a PROBLEM, not a fan-out. Court once had a
 *  `patchUIInInstance` that deliberately wrote every match and returned a count (deleted in
 *  #316 when its only caller, the level selector's 25 authored tiles, moved to a pooled scroll
 *  view); this deliberately does not inherit that shape. The example the rule came from:
 *  `level-tile.prefab.json` USED to carry three entities named `Num`, one per state face, so a
 *  leaf-name match would write all three and look like it worked. ⚠️ #344 collapsed that prefab
 *  to one face (four entities, one `Num`) — the rule stands, the example is history.
 */
export function planEntryWrites(
  index: Map<number, { id: number; name: string }[]>,
  rootId: number,
  content: EntryContent,
): EntryWritePlan {
  const writes: EntryWrite[] = [];
  const problems: EntryWriteProblem[] = [];
  for (const [path, byTrait] of Object.entries(content.members ?? {})) {
    const hit = resolveMemberPathIn(index, rootId, path);
    if (!hit.id) {
      problems.push({ path, reason: hit.failure ?? 'not-found', at: hit.at });
      continue;
    }
    for (const [traitName, fields] of Object.entries(byTrait ?? {})) {
      if (!fields || typeof fields !== 'object') continue;
      writes.push({ entityId: hit.id, trait: traitName, fields, path });
    }
  }
  return { writes, problems };
}
