/**
 * The scene acquire's preload for a lazily-cached asset def (#1097, #1162).
 *
 * The def caches (`animationClipCache`, `spriteAnimCache`, `rig2dCache`, `animSetCache`,
 * `particleCache`) share one shape: a getter that returns null on a miss and STARTS a fetch,
 * recorded in a per-path `loading` map, with the per-frame consumer retrying next frame. Their
 * consumers skip an entity while its def is null, so a def still in flight when a world goes live
 * leaves that entity at its authored state — unposed, invisible, or not emitting — for as many
 * frames as one fetch takes. Awaiting this in `SceneManager`'s acquire, before the swap, is what
 * makes the first projected frame already use the def.
 *
 * Rides the getter's OWN in-flight promise, so there is one fetch path and a preload racing a
 * per-frame request never fetches twice. Never throws: every cache's in-flight promise swallows its
 * own failure. Resolves null for an unknown/failed ref, and also when the load was refused by an
 * invalidation mid-flight — deliberately no retry: the lazy getter is still read every frame, so a
 * refused preload degrades to the pre-preload behaviour instead of blocking the scene.
 *
 * `peek` must be the getter's `{ load: false }` form. Re-calling the loading getter after an
 * invalidation emptied the cache would start a second fetch the preload never waits for.
 */
export async function awaitLazyLoad<T>(
  get: () => T | null,
  inFlight: () => Promise<unknown> | undefined,
  peek: () => T | null,
): Promise<T | null> {
  const hit = get();
  if (hit) return hit;
  const pending = inFlight();
  if (!pending) return null;
  await pending;
  return peek();
}
