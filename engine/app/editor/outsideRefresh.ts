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
 *  nothing: a scene save sends no if-match, so the next Cmd+S overwrites the file. `ask` is the dialog; `answer` hands
 *  its choice back to the bridge (`answerSceneConflict`). */
export function makeSceneConflictResolver(deps: {
  causes: () => { sceneDirty: boolean; dirtyScenes: string[] };
  ask: (urlPath: string) => Promise<'reload' | 'keep' | 'later'>;
  answer: (urlPath: string, choice: 'reload' | 'keep' | 'later') => Promise<void>;
}): (c: SceneConflict) => Promise<SceneConflictAnswer> {
  const asking = new Set<string>();
  return async ({ urlPath, baseGuid, decision, focused }) => {
    // A question already open in front of the human stays theirs: an unfocused release or an agent's answer must not
    // take the change from under the dialog, whose Reload would then do nothing (review F4).
    if (asking.has(urlPath)) return 'asking';
    const causes = deps.causes();
    const dirty = baseGuid ? causes.dirtyScenes.includes(baseGuid) : causes.sceneDirty;
    const answer = decideSceneConflict({ dirty, focused, decision });
    if (answer === 'kept') console.log(`[agentBridge] ${urlPath} changed on disk — kept the unsaved edits (the next save overwrites the file)`);
    if (answer === 'held') console.warn(`[agentBridge] ${urlPath} changed on disk under unsaved edits — pending until someone chooses Reload or Keep mine`);
    if (answer === 'asking' && !asking.has(urlPath)) {
      asking.add(urlPath);
      void deps.ask(urlPath).then(async (choice) => {
        asking.delete(urlPath);
        console.log(`[agentBridge] ${urlPath} changed on disk under unsaved edits — ${choice === 'later' ? 'asked again at the next refresh' : choice === 'keep' ? 'kept mine' : 'reloading from disk'}`);
        await deps.answer(urlPath, choice);
      }, (e) => { asking.delete(urlPath); console.error(`[agentBridge] asking about ${urlPath} failed:`, e); void deps.answer(urlPath, 'later'); });
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
