/** Transient — marker trait for entities that must live in the world (render, participate
 *  in physics) but NEVER be written to the scene file. The editor's serializer
 *  (`serialize.ts` — Cmd+S AND the Play snapshot) skips a Transient entity AND its whole
 *  subtree (walked by parentId), so only the ROOT of a generated subtree needs the tag.
 *
 *  Two canonical uses:
 *   - Content DERIVED from an authored source that is the single source of truth — a
 *     procedurally-generated arena from a painted `.level.json`, a debug-viz overlay, a
 *     spawned particle burst — anything a system regenerates from data on load, so baking
 *     it into the scene would bloat the file and create a second, drifting copy of the truth.
 *   - Anything SPAWNED while the run-mode was not `stopped` (a scrub/preview/play spawn, e.g.
 *     a Timeline control track instantiating a prefab), so a preview/scrub mutation can't leak
 *     into a saved scene — the guarantee is structural, not vigilance (preview-mode refactor).
 *
 *  Carries no data; purely a "do not serialize" flag. Deliberately UNREGISTERED (not in
 *  `registerTraits`) — a pure runtime marker checked by trait identity (`entity.has(Transient)`),
 *  never via the name-based trait registry. (Distinct from Persistent, which does the opposite —
 *  it SURVIVES scene swaps and IS serialized; an entity should not carry both.) */

import { trait } from 'koota';

export const Transient = trait({});
