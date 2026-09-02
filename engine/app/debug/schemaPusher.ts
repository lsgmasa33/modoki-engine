/** Watches the trait registry and pushes the scene-validation schema while the
 *  trait registry is still filling in during editor boot.
 *
 *  #459: game traits and engine traits register SEQUENTIALLY, not racily. Editor
 *  boot (`engine/app/editor/setup.ts`) step 3 runs every game's `registerSystems()`
 *  (where GAME traits register) then awaits `editorPanels()` — an async dynamic
 *  import a game can hook to load its own editor panel modules — before step 4
 *  calls `registerAll()`, which registers the ~80 ENGINE traits. So the registry
 *  is deterministically ordered; the danger is the AWAITED GAP between the two
 *  steps. `games/sling` is the only game with an `editorPanels` hook
 *  (`Promise.all([import('./editor/LevelEditor'), import('./editor/WaveEditor')])`),
 *  so opening it can leave the registry holding only sling's 8 game traits for
 *  however long that cold dynamic import takes — which is exactly why sling
 *  served 8 traits while `games/3d-test`, which has no such hook, always served
 *  the complete 83.
 *
 *  A settle-and-stop heuristic is the wrong shape for this: any fixed "unchanged
 *  for N ticks" window is a bet against how long a cold dynamic import takes, and
 *  a bet that loses serves an incomplete schema for the rest of the session (the
 *  #459 report). So there is no settle window — this polls for the FULL tick
 *  budget every time it is armed, sending on every trait-set change, and only
 *  gives up early if the budget is exhausted. The one exception is the
 *  never-published edge: if NOTHING has ever been sent when the normal budget
 *  runs out (a cold clone where registration itself is unusually slow), it
 *  extends to `hardMaxTicks` rather than leaving `list_traits` reporting
 *  `schemaAvailable:false` for the rest of the session.
 *
 *  Extracted out of `agentBridge.ts` (a ~2000-line file with no tests) so the
 *  polling logic can be unit-tested headlessly with a fake timer — no renderer,
 *  no wall clock, per the repo's determinism rules. */

import { buildSceneSchema } from '@modoki/engine/runtime';
import { createSupersessionToken } from '@modoki/engine/runtime/core/liveness';

type Schema = ReturnType<typeof buildSceneSchema>;

/** Stable signature of a schema's trait SET. Trait names only (not field
 *  contents) — the bug is a MISSING trait, not a changed field, so a renamed
 *  field on an already-known trait must not trigger a resend. */
function traitSignature(schema: Schema): string {
  const names = Object.keys(schema.traits).sort();
  return `${names.length}:${names.join(',')}`;
}

export interface SchemaPusherOptions {
  /** Builds the schema to consider pushing. Defaults to the live `buildSceneSchema`. */
  buildSchema?: () => Schema;
  /** Timer used to schedule the next poll. Defaults to `setTimeout`; tests inject
   *  a fake so the poll window doesn't need real time. */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  /** Ms between polls. */
  intervalMs?: number;
  /** Tick budget once something has been sent at least once. ~8s at the default
   *  200ms interval — the boot window a cold dynamic import needs to clear. */
  maxTicks?: number;
  /** Extended tick budget used ONLY while nothing has EVER been sent (the
   *  never-published edge — a cold clone where registration itself is unusually
   *  slow). Once anything is sent, `maxTicks` governs from then on. */
  hardMaxTicks?: number;
}

export interface StartOptions {
  /** Clears the last-sent signature so the next successful build re-sends even if
   *  the trait set is unchanged. For the Vite reconnect path: the dev server's
   *  cache is genuinely empty after a restart, so a re-arm that finds an
   *  unchanged registry must still re-send — a signature-gated re-arm would send
   *  nothing and the server would never get a schema. */
  force?: boolean;
}

export interface SchemaPusher {
  /** (Re-)arms the watch. Safe to call repeatedly — an HMR update may bring the
   *  registry back into flux, so each call resets the tick counter and resumes
   *  polling. The last-SENT signature is NOT reset by a plain restart: a restart
   *  that finds the same (already-sent) trait set must not re-send it — only a
   *  genuinely different set, or `{force:true}`, triggers a push. */
  start: (options?: StartOptions) => void;
  /** Runs one poll immediately, applying the same send-on-change gating as the
   *  scheduled ticks. Exposed for tests. */
  pushOnce: () => boolean;
}

/** Build a pusher that calls `send` with the schema whenever the trait set the
 *  registry reports has changed since the last successful send. Never sends an
 *  empty registry (not ready yet). */
export function makeSchemaPusher(
  send: (schema: Schema) => void,
  options: SchemaPusherOptions = {},
): SchemaPusher {
  const {
    buildSchema = buildSceneSchema,
    scheduleTimer = setTimeout,
    intervalMs = 200,
    maxTicks = 40,
    hardMaxTicks = 150,
  } = options;

  let tries = 0;
  let budget = maxTicks;
  let lastSentSignature: string | undefined;
  /** Begun by every `start()`. A tick chain is threaded the liveness check it was armed
   *  with, and stops once that check goes false, so a re-arm REPLACES the running chain
   *  instead of racing a second one alongside it. Without this, `vite:afterUpdate` firing
   *  while a chain is still polling leaves two chains running, and they accumulate with
   *  each update. */
  const pushEpoch = createSupersessionToken();

  const pushOnce = (): boolean => {
    try {
      const schema = buildSchema();
      if (Object.keys(schema.traits).length === 0) return false; // not ready yet — never send empty
      const signature = traitSignature(schema);
      if (signature === lastSentSignature) return false; // no-op: same trait set as last sent
      lastSentSignature = signature;
      send(schema);
      return true;
    } catch {
      return false; // a throwing builder must not kill the loop — just skip this tick
    }
  };

  const runTick = (stillLive: () => boolean) => {
    if (!stillLive()) return; // superseded by a newer start()
    pushOnce();
    if (tries >= budget) {
      // The never-published edge: nothing has EVER been sent and the normal budget just ran
      // out. Extend once to hardMaxTicks rather than leaving list_traits reporting
      // schemaAvailable:false for the rest of the session. Once anything has been sent, this
      // extension never applies again.
      if (lastSentSignature === undefined && budget < hardMaxTicks) budget = hardMaxTicks;
      else return;
    }
    tries += 1;
    scheduleTimer(() => runTick(stillLive), intervalMs);
  };

  return {
    start: (startOptions) => {
      if (startOptions?.force) lastSentSignature = undefined;
      tries = 0;
      budget = maxTicks;
      runTick(pushEpoch.begin());
    },
    pushOnce,
  };
}
