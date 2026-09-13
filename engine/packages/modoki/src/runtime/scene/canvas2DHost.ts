/** Resolve the scene's `Canvas2D` host, and report one that never arrives (#1135).
 *
 *  Every 2D game must find the `Canvas2D` entity it spawns into before it can build anything, and in
 *  the pre-scene boot window there is none — routinely (see `core/ecs/sceneLoaded.ts`). Three games
 *  hand-rolled that wait with three different answers to "is a missing host worth reporting":
 *  Court said nothing ever, space-invader counted 60 frames (a timer: it fires on a slow device whose
 *  scene simply took longer, and stays silent on a fast one whose scene never loads), and wordweave
 *  keyed off its own scene-authored config singleton (right, but only for a game that nominates one).
 *
 *  The discriminator here is the owner's (2026-09-13): **the scene finished loading and still has no
 *  host.** Before `loadedScenePath(world)` is set, a missing host is the boot window and this is
 *  silent; after, it is an authoring defect and this reports it ONCE per world per `report` name —
 *  once per world rather than once per process, because a scene swap is a new world and a second
 *  misauthored scene must say so too (wordweave's #1110 F3). */

import type { Entity, World } from 'koota';
import { Canvas2D } from '../traits/Canvas2D';
import { loadedScenePath } from '../core/ecs/sceneLoaded';
import { journalError } from '../core/gameJournal';

export interface ResolveCanvas2DHostOptions {
  /** The journal/Crashlytics name of the "no host" report, `<gameId>/no-canvas-host` by convention. */
  report: string;
  /** Which host to prefer when the scene authors more than one `Canvas2D`. The first entity it accepts
   *  wins; when none does, the first `Canvas2D` of any kind is returned, so a scene that never authored
   *  the second canvas behaves as if there were only one. Omitted: the first `Canvas2D`. */
  prefer?: (entity: Entity) => boolean;
}

const reported = new WeakMap<World, Set<string>>();

export function resolveCanvas2DHost(world: World, opts: ResolveCanvas2DHostOptions): Entity | undefined {
  let preferred: Entity | undefined;
  let first: Entity | undefined;
  world.query(Canvas2D).forEach((e) => {
    first ??= e;
    if (preferred || !opts.prefer) return;
    if (opts.prefer(e)) preferred = e;
  });
  const host = preferred ?? first;
  if (host) return host;
  const scenePath = loadedScenePath(world);
  if (scenePath === undefined) return undefined;
  let names = reported.get(world);
  if (!names) { names = new Set(); reported.set(world, names); }
  if (!names.has(opts.report)) {
    names.add(opts.report);
    journalError(opts.report, {
      reason: 'the loaded scene authors no Canvas2D entity, so nothing 2D can be built into it',
      scenePath,
    }, world);
  }
  return undefined;
}
