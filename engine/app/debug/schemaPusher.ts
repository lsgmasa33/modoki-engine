/** Watches the trait registry and pushes the scene-validation schema once it settles.
 *
 *  #459: trait registration is racy — engine traits and the open project's game
 *  traits register independently, so the registry can be non-empty well before it
 *  is COMPLETE. The old logic asked "is it non-empty" and stopped on the first
 *  success, so whatever partial subset existed at that instant was sent once and
 *  never corrected (measured: `games/sling` served 8 of its own traits while 94
 *  entities in the loaded scene carried the missing `Transform`). This version
 *  keeps polling while the trait set is still CHANGING and sends every time it
 *  changes — the receiver just replaces its cached schema, so the last push wins.
 *
 *  Extracted out of `agentBridge.ts` (a ~2000-line file with no tests) so the
 *  polling/settle logic can be unit-tested headlessly with a fake timer — no
 *  renderer, no wall clock, per the repo's determinism rules. */

import { buildSceneSchema } from '@modoki/engine/runtime';

type Schema = ReturnType<typeof buildSceneSchema>;

/** Stable signature of a schema's trait SET. Trait names only (not field
 *  contents) — the bug is a MISSING trait, not a changed field, so a renamed
 *  field on an already-known trait must not reset the settle window. */
function traitSignature(schema: Schema): string {
  const names = Object.keys(schema.traits).sort();
  return `${names.length}:${names.join(',')}`;
}

export interface SchemaPusherOptions {
  /** Builds the schema to consider pushing. Defaults to the live `buildSceneSchema`. */
  buildSchema?: () => Schema;
  /** Timer used to schedule the next poll. Defaults to `setTimeout`; tests inject
   *  a fake so the settle window doesn't need real time. */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  /** Ms between polls. */
  intervalMs?: number;
  /** Hard cap on ticks — bounds the loop if the registry stays empty forever. */
  maxTicks?: number;
  /** Consecutive unchanged ticks (after at least one push) before the loop stops
   *  polling on its own. */
  settleTicks?: number;
}

export interface SchemaPusher {
  /** (Re-)arms the watch. Safe to call repeatedly — an HMR update or a scene
   *  change may bring the registry back into flux, so each call resets the tick
   *  and settle counters and resumes polling. The last-SENT signature is NOT
   *  reset by a restart: a restart that finds the same (already-sent) trait set
   *  must not re-send it — only a genuinely different set triggers a push. This
   *  is what lets a `vite:afterUpdate`/`scene-changed` re-arm be "cheap" (a no-op
   *  send) when the edit didn't touch the trait set. */
  start: () => void;
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
    settleTicks = 5,
  } = options;

  let tries = 0;
  let lastSentSignature: string | undefined;
  let unchangedStreak = 0;
  /** Bumped by every `start()`. A tick chain captures the value it was armed with and
   *  stops when it no longer matches, so a re-arm REPLACES the running chain instead of
   *  racing a second one alongside it. Without this, `vite:afterUpdate` firing during a
   *  settle window leaves two chains polling, and they accumulate with each update. */
  let generation = 0;

  const pushOnce = (): boolean => {
    try {
      const schema = buildSchema();
      if (Object.keys(schema.traits).length === 0) return false; // not ready yet — never send empty
      const signature = traitSignature(schema);
      if (signature === lastSentSignature) {
        unchangedStreak += 1;
        return false; // no-op: same trait set as last sent — don't send twice in a row
      }
      lastSentSignature = signature;
      unchangedStreak = 0;
      send(schema);
      return true;
    } catch {
      return false; // a throwing builder must not kill the loop — just skip this tick
    }
  };

  const runTick = (mine: number) => {
    if (mine !== generation) return; // superseded by a newer start()
    pushOnce();
    // Settle on `lastSentSignature`, NOT on "did THIS run send" — a re-arm that finds the
    // registry unchanged has nothing to send, and gating on a per-run flag would leave it
    // polling the full tick budget every time. Undefined means nothing has EVER been sent
    // (an empty registry), which must keep retrying until the budget runs out.
    const settled = lastSentSignature !== undefined && unchangedStreak >= settleTicks;
    if (settled || tries++ > maxTicks) return;
    scheduleTimer(() => runTick(mine), intervalMs);
  };

  return {
    start: () => {
      tries = 0;
      unchangedStreak = 0;
      generation += 1;
      runTick(generation);
    },
    pushOnce,
  };
}
