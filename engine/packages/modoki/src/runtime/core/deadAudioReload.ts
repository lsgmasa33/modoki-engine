/**
 * Reload the page when its audio is DEAD (#1455) — the decision, with every dependency injected.
 * The wiring (real clock, real storage, real reload) is `engine/app/useDeadAudioReload.ts`; the
 * detection is `audioService`'s clock check (`onAudioDead`).
 *
 * **Why a reload.** Measured on the iPhone Air, 2026-09-23: after Apple Music took the audio
 * session while the game was away, the context came back reporting `running` with a frozen clock.
 * Nothing inside the page revived it — not a resume, not a fresh `AudioContext`, not either of
 * those inside a real user gesture. `location.reload()` did, at once. So recovery is a reload, and
 * the owner chose to do it automatically for projects that opt in (2026-09-23).
 *
 * Three rules:
 *  - **Never through a reload blocker** (an ad on screen, a purchase or sign-in in flight — the
 *    same registry `useResumeReload` honours). While blocked it waits and re-asks, up to
 *    `maxWaitMs`, then gives up: the audio stays dead, which is the pre-existing behaviour.
 *  - **At most one dead-audio reload per `minIntervalMs`**, remembered ACROSS the reload by the
 *    caller's storage. If another app still holds the session, a reload may not help, and without
 *    this the game would reload in a loop.
 *  - **Flush before reloading.** The game's persisted state is what makes the reload survivable.
 */

export interface DeadAudioReloadDeps {
  /** Wall clock, ms. */
  now(): number;
  /** Active reload blockers — `getActiveReloadBlockers`. Empty = safe to reload. */
  blockedBy(): string[];
  /** Persist pending writes before the page goes. */
  flush(): Promise<unknown> | void;
  /** Perform the reload. */
  reload(): Promise<unknown> | void;
  /** When the last dead-audio reload happened, or null. Must survive the reload itself. */
  lastReloadAt(): number | null;
  /** Remember that a dead-audio reload is happening now. */
  markReloaded(at: number): void;
  /** Wait between blocked re-asks. */
  wait(ms: number): Promise<void>;
  /** Re-check right before reloading: while this waited out a blocker the audio may have come back
   *  on its own (a lock/wake, WebKit's auto-resume), and a reload then costs the player for nothing. */
  stillDead(): Promise<boolean>;
  minIntervalMs: number;
  /** How often to re-ask while blocked. Default 2 s. */
  retryMs?: number;
  /** Give up after this long blocked. Default 60 s. */
  maxWaitMs?: number;
}

export type DeadAudioReloadOutcome =
  | 'reloading'
  /** A dead-audio reload already happened within `minIntervalMs` — do not loop. */
  | 'rate-limited'
  /** A blocker never cleared within `maxWaitMs`. */
  | 'blocked'
  /** The audio came back by itself before the reload — nothing to do. */
  | 'recovered'
  /** A previous call is still deciding or reloading. */
  | 'busy';

export interface DeadAudioReloadHandler {
  onDead(): Promise<DeadAudioReloadOutcome>;
}

export function createDeadAudioReloadHandler(deps: DeadAudioReloadDeps): DeadAudioReloadHandler {
  const retryMs = deps.retryMs ?? 2_000;
  const maxWaitMs = deps.maxWaitMs ?? 60_000;
  let busy = false;
  return {
    async onDead() {
      if (busy) return 'busy';
      busy = true;
      try {
        const last = deps.lastReloadAt();
        if (last !== null && deps.now() - last < deps.minIntervalMs) return 'rate-limited';
        let waited = 0;
        while (deps.blockedBy().length > 0) {
          if (waited >= maxWaitMs) return 'blocked';
          await deps.wait(retryMs);
          waited += retryMs;
        }
        if (!(await deps.stillDead())) return 'recovered';
        deps.markReloaded(deps.now());
        await deps.flush();
        await deps.reload();
        return 'reloading';
      } finally {
        busy = false;
      }
    },
  };
}
