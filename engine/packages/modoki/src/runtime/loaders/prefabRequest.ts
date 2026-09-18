/**
 * `requestPrefab` — the ONE re-acquire latch for a runtime prefab spawner (#1376).
 *
 * A game that spawns a prefab at runtime reads it from the engine's prefab cache, and that cache can
 * be empty for reasons the game does not control: an editor Apply-to-Prefab or a re-import evicted
 * it, or the scene load's fetch failed. So a spawner has to ask for it back — and asking back is
 * three separate pieces of state that seven hand-written copies got wrong in three different ways
 * before this existed (#1359, #1373, #1375; the census is #1376):
 *
 * 1. **In-flight dedup** — at most one fetch per (owner, prefab), released on EVERY settle, success
 *    or not. Without it a per-frame caller fetches every frame (#1373).
 * 2. **A bounded attempt budget** — the give-up latch, for a prefab that is not coming: a DELETED
 *    file, a bad one, or a cached document the caller's `isHit` rejects. `acquirePrefab` RESOLVES
 *    either way with nothing usable (it never rejects — see docs/prefabs.md § "A prefab EDIT
 *    replaces the runtime cache entry"). The budget is refunded on a hit, so a LATER eviction gets a
 *    fresh run. ⚠️ **An OUTAGE is not an attempt** (#1397). The budget used to exist because the
 *    fetch seam could not tell a deleted prefab from a transient failure, so a flat 3 fetches — about
 *    1.5 s of dropped connection — gave a prefab up for the session in a built game. `fetchPrefab`
 *    now classifies its failures (`prefabFetchRetryAt`): while one is backing off this does not
 *    fetch, and an attempt that ends in a transient failure (or asks during its backoff) is refunded. Latching on the first settle
 *    made one 5xx permanent, and never latching refetched a deleted prefab forever; both shipped
 *    (#1359), and this keeps both closed.
 * 3. **A reset scope** — the budget is held per WORLD, so a Play/Stop (which swaps the world) is a
 *    fresh chance. The in-flight hold is deliberately NOT per world: the cache it fills is global,
 *    and releasing it on a swap let the old fetch's settle free the new fetch's hold.
 *
 * ⚠️ Conflating any two of those three produces a shipped bug — #1359 managed two of them in one Set.
 *
 * The give-up is REPORTED, once, as `prefab/unavailable` (level warn). The miss itself is not: a
 * healthy cold cache looks exactly like a deleted prefab one frame before it fills, so only "the
 * budget is spent and it still is not here" carries information. This is also the only place a
 * failed preload can be seen at all, since `acquirePrefab` never rejects (#1375).
 *
 * ⚠️ "Reset per world" is an EDITOR safety net. A built game loads one world and never swaps it, so
 * there the budget is session-permanent. Accepted: this is a RECOVERY path — the scene load acquires
 * every prefab its resources name, so reaching a miss here already means that failed.
 *
 * Bulk preloads that AWAIT a set of prefabs (a scene load, a game's bootstrap `Promise.all`) are not
 * latches and stay on `acquirePrefab` directly; `engine/tests/architecture/prefabRequestSites.test.ts`
 * holds the list of the ones in games and demos.
 */
import type { World } from 'koota';
import { acquirePrefab, getCachedPrefab, prefabFetchRetryAt, type SceneId } from './meshTemplateCache';
import { peekCurrentWorld } from '../core/ecs/worldRegistry';
import { journalWarn } from '../core/gameJournal';

/** The shape `requestPrefab` inspects. A prefab document carries more; callers cast to their own. */
export interface PrefabDocLike { entities?: unknown[] }

export interface RequestPrefabOptions {
  /** The world whose budget this request spends, and where a give-up is journaled. Defaults to the
   *  current world. */
  world?: World;
  /** Whether a cached document is USABLE. Defaults to "has at least one entity" — an entity-less
   *  document spawns nothing, so it is a miss. A caller whose miss test is stricter (a layout that
   *  must parse) MUST pass it here: the hit test and the re-arm test have to be the same predicate,
   *  or a cached-but-unusable document releases the latch and refetches forever (#1359). */
  isHit?: (doc: PrefabDocLike) => boolean;
}

/** How many fetches one (owner, prefab) may cost a world before it is given up on. Mechanism, not a
 *  feel knob — nothing about it is visible on screen — so it stays a code constant. */
export const MAX_PREFAB_FETCH_ATTEMPTS = 3;

const hasEntities = (doc: PrefabDocLike): boolean => !!doc.entities?.length;

/** IN-FLIGHT DEDUP ONLY. Keyed by owner+ref, and never cleared by a world swap. */
const inFlight = new Set<string>();
/** THE GIVE-UP LATCH: fetches spent per owner+ref, per world. A WeakMap, so a disposed world takes
 *  its budgets with it and no caller has to reset anything. */
const budgets = new WeakMap<World, Map<string, number>>();
/** Budgets for a request made before any world exists (a bootstrap path). */
const noWorld = new Map<string, number>();

function budgetFor(world: World | null): Map<string, number> {
  if (!world) return noWorld;
  let m = budgets.get(world);
  if (!m) { m = new Map(); budgets.set(world, m); }
  return m;
}

function usable(ref: string, isHit: (doc: PrefabDocLike) => boolean): PrefabDocLike | null {
  const doc = getCachedPrefab(ref) as PrefabDocLike | null | undefined;
  return doc && isHit(doc) ? doc : null;
}

/**
 * The cached document for `ref` when it is usable, else null — and, on a miss, a guarded fetch so a
 * later call can succeed. Call it every time the prefab is needed (every frame is fine); it starts
 * at most one fetch per (owner, ref) at a time and at most `MAX_PREFAB_FETCH_ATTEMPTS` per world.
 *
 * The miss is still a miss for THIS call — the fetch is async — so the caller must handle null
 * (skip, fall back, or record a refusal) rather than assume the next line has the prefab.
 *
 * `owner` is the caller's own scene-id sentinel, as for `acquirePrefab`; the fetched prefab is held
 * under it until `releaseAllForScene(owner)`.
 */
export function requestPrefab(owner: SceneId, ref: string, opts: RequestPrefabOptions = {}): PrefabDocLike | null {
  if (!ref) return null;
  const isHit = opts.isHit ?? hasEntities;
  const world = opts.world ?? peekCurrentWorld();
  const key = `${owner}|${ref}`;
  const budget = budgetFor(world);

  const doc = usable(ref, isHit);
  if (doc) {
    // Hand the budget back, so a LATER eviction (an editor Apply, a re-import) starts a fresh run
    // instead of inheriting the count from before it healed.
    budget.delete(key);
    return doc;
  }
  if (inFlight.has(key)) return null;
  const tried = budget.get(key) ?? 0;
  if (tried >= MAX_PREFAB_FETCH_ATTEMPTS) return null; // given up for this world

  inFlight.add(key);
  budget.set(key, tried + 1);
  void acquirePrefab(owner, ref).finally(() => {
    inFlight.delete(key); // the in-flight hold ALWAYS ends; only the budget latches
    // A TRANSIENT failure hands its attempt back (#1397): the budget is for prefabs that are not
    // coming, not for a network that is down. This also covers an ask made WHILE it backs off —
    // `fetchPrefab` refuses to fetch then, so the attempt is spent and handed straight back.
    if (prefabFetchRetryAt(ref) !== undefined) { budget.set(key, Math.max(0, (budget.get(key) ?? 1) - 1)); return; }
    // ⚠️ The cache term is not redundant with the budget one: when the LAST allowed attempt is the
    // one that succeeds, the budget is exactly spent, and without it this would report a prefab
    // that just loaded as unavailable.
    // A throwing `isHit` reads as unusable: the lookup path already threw it at the caller, and a
    // throw here would only add an unhandled rejection on top.
    let ok: PrefabDocLike | null;
    try { ok = usable(ref, isHit); } catch { ok = null; }
    if (ok || (budget.get(key) ?? 0) < MAX_PREFAB_FETCH_ATTEMPTS) return;
    // The budget is per world but the hold is not, so the last attempt CAN settle after a swap —
    // report only into the world that spent it, while that world is still the live one.
    // ⚠️ "Current" is a stand-in for "alive", and it is stricter: a request made inside a
    // `stepSimulation` of a side world, whose last attempt settles after that step, is not reported.
    // No shipped caller does that; the cost would be a missing diagnostic, never a wrong state.
    if (world && world !== peekCurrentWorld()) return;
    journalWarn('prefab/unavailable', { prefab: ref, owner, attempts: MAX_PREFAB_FETCH_ATTEMPTS }, world ?? undefined);
  });
  return null;
}

/** Test-only: forget every hold and every world-less budget. Per-world budgets go with their world. */
export function __resetPrefabRequests(): void {
  inFlight.clear();
  noWorld.clear();
}
