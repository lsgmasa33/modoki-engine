/** One save at a time, whoever asked for it (#2069).
 *
 *  A save is a scene write followed by a file-direct flush of the parked `baseScene` edits (`pendingBaseScene.ts`), and
 *  two of them overlapping is what let a park outlive the file it edited: a Save As replacing X while an earlier save's
 *  flush was still writing X's park landed that park on the replacement, for the next save to overwrite with the
 *  stale base (rows 7–8). `runSaveAll` already coalesced a human's own presses, but the agent `save-all` op called
 *  `saveAll` directly and Create Scene writes a scene of its own, so neither waited for the other.
 *
 *  QUEUED rather than coalesced: an agent's `save_all({path})` answered with a human Cmd+S's result would report a
 *  Save As that never ran. Each caller waits for the save ahead of it, then runs its own. A failure does not jam the
 *  queue — the next save runs either way, and the failure reaches only the caller that ran it.
 *
 *  ⚠️ **A human save can hold the queue indefinitely** — its Save As panel or an Overwrite confirm waits on a person. A
 *  caller that cannot wait that long (an agent, whose relay gives up after 60 s) passes `maxWaitMs`: if its turn has
 *  not come by then it is rejected with {@link SaveQueueBusyError} and its body NEVER runs. Without that, the caller
 *  was told it timed out and the save then ran anyway, minutes later, against whatever scene was open by then (#2069
 *  close-out review) — cancel the operation, not just its answer.
 *
 *  ⚠️ Never call this from INSIDE a queued save: it would wait for itself. The entry points are the outermost
 *  gestures (`runSaveAll`, the `save-all` op, Create Scene), and nothing below them re-enters one. */
import { withTimeout, TimeoutError } from '../../runtime/core/abandonment';

let tail: Promise<unknown> = Promise.resolve();

/** The save ahead did not finish within the caller's `maxWaitMs`; this one was not run. */
export class SaveQueueBusyError extends Error {
  constructor(waitedMs: number) {
    super(`another save is still in progress after ${waitedMs} ms (a Save dialog or an Overwrite question may be waiting on a human) — this save was NOT run`);
    this.name = 'SaveQueueBusyError';
  }
}

export function runSerialisedSave<T>(run: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  // Our TURN: the save ahead has settled, either way. Only the turn is timed — never the body: a save that has started
  // runs to its end, since its writes cannot be recalled.
  const turn = tail.then(() => undefined, () => undefined);
  let gaveUp = false;
  let started = false;
  const next = turn.then(() => {
    if (gaveUp) throw new SaveQueueBusyError(opts.maxWaitMs ?? 0);
    started = true;
    return run();
  });
  tail = next.then(() => undefined, () => undefined);
  const { maxWaitMs } = opts;
  if (maxWaitMs === undefined) return next;
  return withTimeout(turn, maxWaitMs, 'the save ahead in the queue', {
    discard: 'a turn reached late owns nothing — it sees gaveUp and runs no body',
  }).then(() => next, (e: unknown) => {
    // `started`: the turn landed in the same tick as the deadline and the body is already running — answer with it.
    if (!(e instanceof TimeoutError) || started) return next;
    gaveUp = true;
    throw new SaveQueueBusyError(maxWaitMs);
  });
}
