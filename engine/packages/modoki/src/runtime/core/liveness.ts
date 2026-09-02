/** Shared machinery for "am I still the live session?" checks after an `await`.
 *
 *  The engine has settled on ONE pattern with FIVE sanctioned tokens for this question
 *  (docs/async-lifetime.md is the convention doc — read it before adding a sixth). This file
 *  covers exactly TWO of the five, because those two are literally the same machinery: capture a
 *  counter before the `await`, compare it after.
 *
 *  - **Supersession epoch** (`createSupersessionToken`) — a monotonic counter that bumps every
 *    time a new attempt begins. Only the NEWEST attempt's check stays true; every earlier one
 *    goes false the instant a later `begin()` happens. Use this when a new call should always win
 *    over an older in-flight one (e.g. the user re-triggers a load before the first finished).
 *  - **Teardown generation** (`createTeardownToken`) — a counter that bumps on invalidation, not
 *    on start. Every outstanding capture survives until something explicitly invalidates it, and
 *    a capture taken AFTER an `invalidateAll()` is unaffected by that past invalidation (see
 *    `SceneManager.loadScene`'s `enteredGeneration` comment — a fresh load after a completed
 *    teardown must not read as cancelled). It also supports a PER-KEY generation: invalidating one
 *    key must not stale captures against a different key (see `runtime/loaders/
 *    animationClipCache.ts`'s `keyEpoch` doc comment for the original statement of that
 *    requirement — the editor's file watcher invalidates one asset and must not cancel an
 *    unrelated in-flight load).
 *
 *  The other three sanctioned tokens are deliberately hand-rolled and NOT covered here: owner-set
 *  membership (a `Set` of live ids), identity-against-a-captured-reference (`capturedX === x`),
 *  and a plain `disposed`/`alive` boolean. Forcing those through a counter would be a worse fit,
 *  not a cleanup.
 *
 *  This is L0 (`runtime/core/`) — no imports, ships in every build, and depends on nothing else
 *  in the engine.
 *
 *  **Composed, not substituted.** `.current` / `.generation` expose the raw counter as a
 *  first-class part of the API, not an escape hatch — a call site with its own control flow (an
 *  `AbortController`, an in-flight counter, a post-swap latch) takes ONLY its counter from here
 *  and keeps the rest itself. `SceneManager` is exactly this shape: it keeps its own
 *  `AbortController`, in-flight counter and post-swap latch, and sources just the generation
 *  counter from a `TeardownToken`.
 *
 *  Call sites should read as a question: `const stillLive = token.capture(path); … if
 *  (!stillLive()) return;` */

/** Returned by a capture. Call it after each `await`; false means bail. */
export type LivenessCheck = () => boolean;

export interface SupersessionToken {
  /** Start a new attempt. Every earlier capture's check goes false. */
  begin(): LivenessCheck;
  /** The raw counter, for a site that must interleave it with its own control flow. */
  readonly current: number;
}

export interface TeardownToken<K = string> {
  /** Snapshot liveness. With a key, the check ALSO goes false when that key alone is invalidated. */
  capture(key?: K): LivenessCheck;
  /** Everything outstanding goes stale. */
  invalidateAll(): void;
  /** Only captures taken for this key go stale. */
  invalidateKey(key: K): void;
  /** The raw counter, for composition. */
  readonly generation: number;
}

export function createSupersessionToken(): SupersessionToken {
  let counter = 0;
  return {
    begin() {
      counter += 1;
      const capturedAt = counter;
      return () => capturedAt === counter;
    },
    get current() {
      return counter;
    },
  };
}

export function createTeardownToken<K = string>(): TeardownToken<K> {
  let generation = 0;
  const keyGenerations = new Map<K, number>();

  return {
    capture(key?: K) {
      const capturedGeneration = generation;
      const capturedKeyGeneration = key === undefined ? 0 : (keyGenerations.get(key) ?? 0);
      return () => {
        if (generation !== capturedGeneration) return false;
        if (key !== undefined && (keyGenerations.get(key) ?? 0) !== capturedKeyGeneration) return false;
        return true;
      };
    },
    invalidateAll() {
      generation += 1;
      keyGenerations.clear();
    },
    invalidateKey(key: K) {
      keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1);
    },
    get generation() {
      return generation;
    },
  };
}
