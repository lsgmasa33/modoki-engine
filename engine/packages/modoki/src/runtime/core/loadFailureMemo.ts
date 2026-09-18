/** What a lazy asset loader remembers about a load that FAILED (#1371, #1374).
 *
 *  Every def cache used to answer one question — "did this path fail?" — with one answer: yes,
 *  forever. That is right for a failure the same bytes will reproduce (a 404, a corrupt file, a
 *  format refusal) and wrong for one they will not (the phone dropped off the network for a
 *  second): one flaky fetch disabled the asset until the app restarted, and the only trace was a
 *  `console.warn` nobody on a device reads. Scene2D's material-sprite textures had the opposite
 *  bug — no memory at all, so a 404 refetched on every dirty frame. Both are the same missing
 *  distinction, so it lives here, once.
 *
 *  - **permanent** — the file is not there (404/410, the dev server's SPA fallback), or it came
 *    back and is unusable (a parse error, a format refusal). Remembered until the cache's own
 *    `invalidate*`/`set*`/`clear*` hook calls {@link LoadFailureMemo.forget}, exactly as before.
 *  - **transient** — the request never completed ({@link AssetNetworkError}) or the server could
 *    not serve a file that may exist (any other non-ok status). Retried with exponential backoff,
 *    {@link RETRY_BASE_MS} doubling up to {@link RETRY_CAP_MS} (owner ruling 2026-09-18: back off,
 *    never give up, cap at 10 min). No attempt budget on purpose: callers ask every frame, so a
 *    budget counted in attempts is spent in a few frames (#541's measured lesson) and a session
 *    that loses the network for a minute would keep the dead asset anyway.
 *  - **unknown** — anything unclassifiable goes where the memo's `unknownIs` says. The JSON def
 *    caches say `permanent` (their unknowns are parse/normalise throws, which bytes reproduce);
 *    Scene2D says `transient`, because Pixi's texture loader reports a 404 and a dropped
 *    connection as the same opaque error, and backing off bounds a 404 while sticking would
 *    reintroduce #1371 for textures.
 *
 *  A failure is announced ONCE per streak on the console, and once per streak PER WORLD in the
 *  journal (`@asset-load-failed`, level `warn`) — so a game's own journal can tell "nothing drew"
 *  from "drew" in the scene that is actually running. The silent retries after it stay silent
 *  until the key is forgotten or loads.
 *
 *  Time is `rawNow()` (the sanctioned wall-clock seam): a retry delay is about the network, not
 *  simulation time, so it must keep running while the sim is paused. */

import { rawNow } from './clock';
import { emit } from './journal';
import { peekCurrentWorld } from './ecs/worldRegistry';
import type { World } from 'koota';
import { AssetNetworkError, MissingAssetError, statusIsAbsent } from './assetLoadErrors';

/** First retry delay after a transient failure. Doubles per consecutive failure. */
export const RETRY_BASE_MS = 1000;
/** Ceiling on the retry delay — owner ruling 2026-09-18. */
export const RETRY_CAP_MS = 10 * 60 * 1000;

export { AssetNetworkError };

/** `fetch(...).catch(rethrowAsNetworkError)` — attached directly to the fetch promise, so it sees
 *  ONLY the fetch's own rejection, never an error from the parse step after it. The body read is
 *  marked inside `parseAssetJson`. */
export function rethrowAsNetworkError(e: unknown): never {
  throw new AssetNetworkError(e);
}

export type LoadFailureClass = 'permanent' | 'transient' | 'unknown';

export function classifyLoadFailure(e: unknown): LoadFailureClass {
  if (e instanceof AssetNetworkError) return 'transient';
  if (e instanceof MissingAssetError) return e.absent ? 'permanent' : 'transient';
  // three's `FileLoader` (under GLTFLoader, HDRLoader, UltraHDRLoader, …) rejects a non-ok response
  // with its own `HttpError`, carrying the Response. It is not exported, so match its shape. A bare
  // `TypeError` from the same loader stays unknown: FileLoader routes a dropped connection AND a
  // parse error through one `onError`, so nothing distinguishes them (#1397).
  const status = (e as { response?: { status?: unknown } } | null)?.response?.status;
  if (e instanceof Error && typeof status === 'number') return statusIsAbsent(status) ? 'permanent' : 'transient';
  return 'unknown';
}

/** The delay before retry number `failures` (1 = after the first failure). */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export interface LoadFailureMemo {
  /** True when the key must NOT be fetched now: a permanent failure, or a transient one whose
   *  backoff has not expired. Also re-announces a remembered failure into the journal of a world
   *  that has not heard it yet (see `journal` below) — the one side effect, and why it is here:
   *  this is the question every consumer asks every frame in the world it is drawing. */
  blocked(key: string): boolean;
  /** Record a caught load failure: classify it, remember it, and announce it if it starts a
   *  streak. `live: false` (the load was superseded by an invalidation mid-flight) logs and
   *  remembers nothing — the key's current state belongs to the newer load. */
  record(key: string, error: unknown, live?: boolean): void;
  /** A consumer in the current world asked about `key` WITHOUT going through {@link blocked} — a
   *  cache whose own sentinel answers first (`meshTemplateCache`'s `MESH_FAILED`). Re-announces a
   *  remembered failure into this world's journal, exactly as `blocked` does. */
  seen(key: string): void;
  /** Remember a permanent failure the caller has already logged itself (a format refusal). Still
   *  journalled — `reason` is the event's `error`. */
  markPermanent(key: string, reason: string): void;
  /** When a transient key becomes fetchable again (`rawNow()` ms), or undefined if it is not
   *  backing off. For a caller that must schedule its own wake — Scene2D's idle gate. */
  retryAt(key: string): number | undefined;
  /** The key loaded, or its cache entry was invalidated/reseeded: drop what was remembered. */
  forget(key: string): void;
  clear(): void;
  /** How many `onRetryDue` timers are armed — a test seam. */
  readonly pendingWakes: number;
}

interface Entry {
  permanent: boolean; failures: number; retryAt: number;
  /** What the journal event carries, kept so it can be re-announced into a later world. */
  error: string;
  /** The world whose journal last heard about this failure (`null`: none existed yet). Weak, so a
   *  remembered failure never pins a destroyed world and its journal. */
  announcedIn: WeakRef<World> | null;
}

export function createLoadFailureMemo(opts: {
  /** Log/journal prefix, e.g. `rig2dCache`. */
  label: string;
  unknownIs: 'permanent' | 'transient';
  /** Called once when a transient key's backoff expires (#1397). For a cache whose askers do not
   *  come back on their own — a render-on-demand view, a slot built once, an idle Scene2D — so
   *  without it a retry that is due waits for an unrelated edit. A per-frame asker does not need
   *  it. One timer per backing-off key, cancelled by `forget`/`clear` and replaced by the next
   *  `record`, so it fires at most once per retry step. */
  onRetryDue?: (key: string) => void;
}): LoadFailureMemo {
  const entries = new Map<string, Entry>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelTimer = (key: string): void => {
    const t = timers.get(key);
    if (t !== undefined) { clearTimeout(t); timers.delete(key); }
  };
  const armTimer = (key: string, at: number): void => {
    const onRetryDue = opts.onRetryDue;
    if (!onRetryDue) return;
    cancelTimer(key);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      onRetryDue(key);
    }, Math.max(0, at - rawNow())));
  };

  /** Journal half of an announcement. ⚠️ Per WORLD, not once: `SceneManager` acquires the next
   *  scene's assets BEFORE it makes that world current, so a failure during a load lands in the
   *  OUTGOING world's journal, which the swap discards — and at first boot there may be no world at
   *  all. So `blocked()` (every consumer's per-frame question) re-announces into whichever world is
   *  current now, once per world. Found by #1371's review: the willow's rig is preloaded at scene
   *  acquire, the most common failure moment, and its event was invisible to the new scene. */
  const journal = (key: string, e: Entry): void => {
    const world = peekCurrentWorld();
    e.announcedIn = world ? new WeakRef(world) : null;
    if (!world) return;
    try {
      emit('@asset-load-failed', { cache: opts.label, key, transient: !e.permanent, error: e.error }, world, 'warn');
    } catch { /* journal unavailable — the console line still carries it */ }
  };
  const reannounce = (key: string, e: Entry): void => {
    const world = peekCurrentWorld();
    if ((e.announcedIn?.deref() ?? null) !== (world ?? null)) journal(key, e);
  };
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  return {
    blocked(key) {
      const e = entries.get(key);
      if (!e) return false;
      reannounce(key, e);
      return e.permanent || rawNow() < e.retryAt;
    },
    seen(key) {
      const e = entries.get(key);
      if (e) reannounce(key, e);
    },
    record(key, error, live = true) {
      if (!live) { console.warn(`[${opts.label}] superseded load of ${key} failed:`, error); return; }
      const cls = classifyLoadFailure(error);
      const permanent = cls === 'permanent' || (cls === 'unknown' && opts.unknownIs === 'permanent');
      const prev = entries.get(key);
      const failures = (prev?.failures ?? 0) + 1;
      const delay = permanent ? Infinity : retryDelayMs(failures);
      const e: Entry = {
        permanent, failures, retryAt: rawNow() + delay, error: describe(error),
        announcedIn: prev?.announcedIn ?? null,
      };
      entries.set(key, e);
      if (permanent) cancelTimer(key); else armTimer(key, e.retryAt);
      // A new streak — or a transient streak that just turned permanent — is announced; a repeat is not.
      if (prev && prev.permanent === permanent) return;
      console.warn(
        `[${opts.label}] failed to load ${key}` + (permanent ? ':' : ` — retrying in ${Math.round(delay / 1000)}s, backing off to ${RETRY_CAP_MS / 60000} min:`),
        error,
      );
      journal(key, e);
    },
    markPermanent(key, reason) {
      const prev = entries.get(key);
      const e: Entry = { permanent: true, failures: (prev?.failures ?? 0) + 1, retryAt: Infinity, error: reason, announcedIn: null };
      entries.set(key, e);
      cancelTimer(key);
      journal(key, e); // the caller already logged its own console.error
    },
    retryAt(key) {
      const e = entries.get(key);
      return e && !e.permanent ? e.retryAt : undefined;
    },
    forget(key) { entries.delete(key); cancelTimer(key); },
    clear() {
      entries.clear();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    get pendingWakes() { return timers.size; },
  };
}
