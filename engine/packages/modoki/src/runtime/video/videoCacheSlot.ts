/** A one-slot registry for the LIVE downloaded-video cache, so it can be introspected without
 *  anything importing the module that creates it.
 *
 *  WHY A SLOT AND NOT A DIRECT IMPORT (#288 Phase 6). The singleton is built inside the
 *  `__MODOKI_MODULE_VIDEO__`-gated block in `app/ecs/pipeline.ts`, and the first cut of this had
 *  `agentBridge.ts` import an accessor straight from there. That compiles, and it drags the WHOLE
 *  app pipeline — `registerSystem` calls, resolver installs, the lot — into every module that
 *  imports agentBridge, including the headless test world. Measured: five previously-green
 *  `scene-query` tests started failing on an unrelated commit for exactly that reason.
 *
 *  ⚠️ **The type is deliberately structural, not `import type { VideoCache }`.** A type-only import
 *  is erased, so either would keep the video code out of the bundle — but this module sits in the
 *  runtime barrel, and a named import of the class is the kind of thing a later refactor turns into
 *  a value import without noticing. Describing the two methods the reader actually needs keeps that
 *  door shut.
 *
 *  `null` means two DIFFERENT things and the reader must not conflate them: the video module is
 *  compiled out (a playable-ad build), or the Cache API is unavailable so clips STREAM instead of
 *  caching. Neither is "the cache is empty" — the consumer (`diagnose`'s opt-in `video` filter)
 *  says which, because the two want opposite next moves.
 */

/** The shape `diagnose` reads. Structural on purpose — see the header. */
export interface ActiveVideoCache {
  entries(): Array<{ key: string; bytes: number; pinned?: boolean; lastUsed?: number }>;
  usedBytes(): number;
  budgetBytes(): number;
}

let active: ActiveVideoCache | null = null;

/** Called once by the pipeline's video block, if it builds a cache at all. */
export function setActiveVideoCache(cache: ActiveVideoCache | null): void { active = cache; }

/** The live cache, or null when none is wired. */
export function getActiveVideoCache(): ActiveVideoCache | null { return active; }
