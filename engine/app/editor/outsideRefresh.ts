/** The editor's decisions for applying outside file changes (#1879), kept apart from the DOM and the bridge so a test
 *  drives them with fakes. `agentEditorOps.ts` wires them to the real hold (`agentBridge.ts`), the focus edge and the
 *  shared countdown (`countdownBanner.ts`).
 *
 *  Owner, 2026-09-30: "for claude, claude can reload any time, and we show a toaster for a human with count down". */

import type { OutsideReleaseReport, SceneConflict, SceneConflictAnswer } from '../debug/agentBridge';

/** A scene change over unsaved work (#1879 part 3, owner ruling 2026-09-30: ask "Reload / Keep mine" instead of letting
 *  the disk win; a clean scene reloads as before).
 *  - A human has the editor focused → ask them. An agent's `decision` does not override the human in front of it.
 *  - Nobody focused → an agent's decision (`modoki_refresh`'s `scene`), else it stays pending: a countdown or a refresh
 *    never discards unsaved scene work on its own. */
export function decideSceneConflict(c: { dirty: boolean; focused: boolean; decision?: 'reload' | 'keep' }): SceneConflictAnswer {
  if (!c.dirty) return 'clean';
  if (c.focused) return 'asking';
  if (c.decision === 'reload') return 'reload';
  if (c.decision === 'keep') return 'kept';
  return 'held';
}

/** Everything deferred now — this release's and earlier ones' — with the reason, or nothing. */
function deferredFields(deps: RefreshDeps): { deferred?: string[]; deferredReason?: string } {
  const d = deps.deferred();
  return d.paths.length ? { deferred: d.paths, ...(d.reason ? { deferredReason: d.reason } : {}) } : {};
}

const ASKING = 'A scene with unsaved edits changed on disk; the human is asked "Reload / Keep mine" in the editor. It '
  + 'stays pending until they answer.';

/** The installed resolver (`setSceneConflictResolver`): which scene's unsaved work is at stake, the decision, and the
 *  question put to the human — once per scene while it is open. Unsaved = that scene's OWN edits: the primary's
 *  `sceneDirty` (the world's edit version against its save), a loaded base's dirty flag. Not the scene-guid registry for
 *  the primary: right after an Apply it reads clean while `sceneDirty` does not (#1878 re-verify). "Keep mine" writes
 *  nothing: a scene save sends no if-match, so the next Cmd+S overwrites the file. `ask` is the dialog, closed through
 *  its `signal` once the question goes moot; `answer` hands its choice back to the bridge (`answerSceneConflict`).
 *
 *  An open question is re-checked whenever `watch` calls back, and closed when it went MOOT (#1924):
 *  - the change it asks about is no longer awaiting (`awaiting`) — a load read the file fresh and applied it (#1899), or
 *    a newer change to the scene, clean by then, replaced and applied it (#1906): the dialog closes and nothing is
 *    answered;
 *  - the scene was SAVED since the change it asks about arrived (the primary's save point, `savedAt`, moved while the
 *    scene is still the open primary): the save wrote the editor's version over the outside one, which is gone from
 *    disk, so the change is dropped as Keep mine drops it, and the undo history stays. Put back instead, the next
 *    release reloaded the editor's own bytes and dropped the history (close-out review F2, measured). The save point
 *    is re-read when a newer change replaces the asked-about one — read at the first ask, a save before the newer
 *    change dropped that change, still on disk (re-review 1, measured) — and a switch to another scene or a Save-As
 *    moves it too, without writing this file, so then the change goes back (re-review 2: dropped, its file-change
 *    debt was never raised, and the scene reopened with a stack recorded over the old bytes);
 *  - the scene has no unsaved edits any more without a save (undone back to its save point, or a loaded base, whose
 *    saves this cannot see): the dialog closes and the change goes back to the hold, as Escape puts it, so the next
 *    focus gain or refresh decides it by the clean-scene rule — what a change held over a clean scene gets with no
 *    dialog ever shown.
 *  Left up, the dialog told the human a clean scene had unsaved changes, kept `modal: scene-conflict` in the editor
 *  state, and its Keep mine logged "kept mine" over nothing (measured live). */
export function makeSceneConflictResolver(deps: {
  causes: () => { sceneDirty: boolean; dirtyScenes: string[] };
  ask: (urlPath: string, signal: AbortSignal) => Promise<'reload' | 'keep' | 'later'>;
  answer: (urlPath: string, choice: 'reload' | 'keep' | 'later') => Promise<void>;
  /** The scene changes whose question is open (`awaitingSceneDecisions`). */
  awaiting: () => string[];
  /** Calls `check` whenever an open question may have gone moot; returns the unsubscribe. */
  watch: (check: () => void) => () => void;
  /** The primary scene's save point (`captureWorldDirtyBaseline().savedAt`): it moves on a save, a load or a new scene,
   *  never on an undo back to the saved state. */
  savedAt: () => number;
  /** Is `urlPath` the open primary scene's file? */
  isOpenPrimary: (urlPath: string) => boolean;
}): (c: SceneConflict) => Promise<SceneConflictAnswer> {
  const asking = new Set<string>();
  /** Per open question: the save point when the change it now asks about arrived. */
  const savedAtArrival = new Map<string, number>();
  const isDirty = (baseGuid: string | undefined) => {
    const causes = deps.causes();
    return baseGuid ? causes.dirtyScenes.includes(baseGuid) : causes.sceneDirty;
  };
  return async ({ urlPath, baseGuid, decision, focused }) => {
    const dirty = isDirty(baseGuid);
    // A question already open in front of the human stays theirs while there is unsaved work to decide about: an
    // unfocused release or an agent's answer must not take the change from under the dialog, whose Reload would then do
    // nothing (review F4). Once the scene is CLEAN (saved, or reloaded by a load) the dialog's question is moot, and a
    // newer change reloads as any change to a clean scene does; the stale dialog closes once that change is applied.
    // Parked behind it instead, its Keep mine dropped that change with no unsaved work kept (#1906, measured live).
    if (dirty && asking.has(urlPath)) {
      savedAtArrival.set(urlPath, deps.savedAt()); // the question now asks about THIS change
      return 'asking';
    }
    const answer = decideSceneConflict({ dirty, focused, decision });
    if (answer === 'kept') console.log(`[agentBridge] ${urlPath} changed on disk — kept the unsaved edits (the next save overwrites the file)`);
    if (answer === 'held') console.warn(`[agentBridge] ${urlPath} changed on disk under unsaved edits — pending until someone chooses Reload or Keep mine`);
    if (answer === 'asking' && !asking.has(urlPath)) {
      asking.add(urlPath);
      const moot = new AbortController();
      savedAtArrival.set(urlPath, deps.savedAt());
      let stop: () => void = () => {};
      // Settled HERE, synchronously, not after the dialog's promise: a put-back that waited a microtask could land after
      // a release had taken a newer held change for the scene, and park the older one in the empty hold behind it.
      const check = () => {
        if (moot.signal.aborted) return;
        const applied = !deps.awaiting().includes(urlPath);
        if (!applied && isDirty(baseGuid)) return;
        moot.abort();
        stop();
        asking.delete(urlPath);
        const savedAtThen = savedAtArrival.get(urlPath);
        savedAtArrival.delete(urlPath);
        if (applied) {
          console.log(`[agentBridge] ${urlPath}: the Reload / Keep mine question is moot — the change it asked about was applied; closed it`);
          return;
        }
        if (!baseGuid && deps.savedAt() !== savedAtThen && deps.isOpenPrimary(urlPath)) {
          console.log(`[agentBridge] ${urlPath}: the Reload / Keep mine question is moot — the scene was saved over the outside change; closed it`);
          void deps.answer(urlPath, 'keep');
          return;
        }
        console.log(`[agentBridge] ${urlPath}: the Reload / Keep mine question is moot — the scene has no unsaved edits now; closed it, and the change waits for the next focus gain or refresh`);
        void deps.answer(urlPath, 'later');
      };
      stop = deps.watch(check);
      if (moot.signal.aborted) stop(); // `watch` checked at once, and it was moot already
      void deps.ask(urlPath, moot.signal).then(async (choice) => {
        if (moot.signal.aborted) return; // closed as moot: `check` settled it
        moot.abort();
        stop();
        asking.delete(urlPath);
        savedAtArrival.delete(urlPath);
        console.log(`[agentBridge] ${urlPath} changed on disk under unsaved edits — ${choice === 'later' ? 'asked again at the next refresh' : choice === 'keep' ? 'kept mine' : 'reloading from disk'}`);
        await deps.answer(urlPath, choice);
      }, (e) => { if (moot.signal.aborted) return; moot.abort(); stop(); asking.delete(urlPath); savedAtArrival.delete(urlPath); console.error(`[agentBridge] asking about ${urlPath} failed:`, e); void deps.answer(urlPath, 'later'); });
    }
    return answer;
  };
}

export interface RefreshDeps {
  /** What is held for the next release — not the open questions, which a release does not touch. */
  pending: () => string[];
  /** Scene changes whose Reload / Keep mine question is open in front of the human. */
  awaiting: () => string[];
  /** Changes a release handed on that Play, a preview or a hold deferred, and why: a refresh cannot apply them. */
  deferred: () => { paths: string[]; reason: string | null };
  focused: () => boolean;
  /** The shared countdown with Cancel; resolves how it ended. */
  countdown: (paths: string[]) => Promise<'go' | 'cancel'>;
  release: (opts: { decision?: 'reload' | 'keep' }) => Promise<OutsideReleaseReport>;
}

export interface RefreshReply {
  applied: string[];
  /** The human pressed Cancel on the countdown: nothing was applied, and the changes stay pending. */
  cancelled?: true;
  /** Held by Play, a preview or an operation in progress; applied once that ends — a refresh cannot apply them. */
  deferred?: string[];
  /** Why they wait. */
  deferredReason?: string;
  /** Scene changes over unsaved work: `asking` (a human decides in the dialog), `held` (pass `scene`), `kept`, `reload`. */
  sceneConflicts?: { path: string; status: Exclude<SceneConflictAnswer, 'clean'> }[];
  /** True while a Reload / Keep mine question is open in front of the human. */
  awaitingHuman?: true;
  hint?: string;
}

/** `modoki_refresh`: apply every held outside change now. With a human focused on the editor they first see the
 *  countdown; a Cancel leaves everything pending and says so. With nobody focused it applies at once. */
export async function refreshOutsideChanges(deps: RefreshDeps, scene?: 'reload' | 'keep'): Promise<RefreshReply> {
  const paths = deps.pending();
  if (!paths.length) {
    return {
      applied: [], ...deferredFields(deps),
      ...(deps.awaiting().length ? { awaitingHuman: true as const, hint: ASKING } : {}),
    };
  }
  if (deps.focused() && (await deps.countdown(paths)) === 'cancel') {
    return {
      applied: [], cancelled: true,
      hint: 'The human cancelled the refresh. The editor still shows the OLD contents of pendingOutsideChanges, so a '
        + 'measurement of them is stale; they apply on the next focus gain or modoki_refresh.',
    };
  }
  const r = await deps.release({ decision: scene });
  const conflicts = r.sceneConflicts.filter((c) => c.answer !== 'clean')
    .map((c) => ({ path: c.urlPath, status: c.answer as Exclude<SceneConflictAnswer, 'clean'> }));
  const asking = deps.awaiting().length > 0;
  const held = conflicts.some((c) => c.status === 'held');
  return {
    applied: r.applied,
    ...deferredFields(deps),
    ...(conflicts.length ? { sceneConflicts: conflicts } : {}),
    ...(asking ? { awaitingHuman: true as const } : {}),
    ...(asking || held ? {
      hint: asking
        ? ASKING
        : 'A scene with unsaved edits changed on disk, and nobody has the editor focused to decide. Call modoki_refresh '
          + 'again with scene:"reload" (lose the unsaved edits) or scene:"keep" (keep them; the next save overwrites the file).',
    } : {}),
  };
}
