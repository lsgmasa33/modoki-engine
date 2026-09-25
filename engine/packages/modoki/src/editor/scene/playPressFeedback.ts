/** What the HUMAN is told when a Play or Stop press does not do what it looks like it did (#1577).
 *
 *  `enterPlay` / `stopPlay` return an outcome (#1574), and the agent `play`/`stop` ops build their
 *  reply from it. The toolbar and the `mod+p` chord used to `void` it, so the same refusal that tells
 *  an agent "retry once the load lands" left the human with a ▶ that appeared to do nothing — the
 *  only trace a `console.warn`. These presses read the outcome and raise a warn toast, and the toast
 *  text is the outcome's own `message`/`reason`, so both surfaces print one string.
 *
 *  The decision (which outcome speaks, with what text) is the pure `playFeedback`/`stopFeedback`,
 *  where a unit test reaches it; the `.tsx` call sites are one line each. */

import { enterPlay, stopPlay, type PlayOutcome, type StopOutcome } from './playMode';
import { useEditorStore } from '../store/editorStore';

export interface PressFeedback { text: string; kind: 'warn' }

const warn = (text: string): PressFeedback => ({ text, kind: 'warn' });

/** Toast for a Play press, or null when the press did what it looked like. Exhaustive on purpose: a
 *  new `PlayOutcome` kind fails the typecheck here until someone decides whether the human hears it. */
export function playFeedback(o: PlayOutcome): PressFeedback | null {
  switch (o.kind) {
    case 'started':
    case 'resumed':
    case 'already-playing':
      return null;
    // A double-press on ▶ — the first press is starting Play, which is what the human asked for.
    case 'refused': return o.reason === 'already-starting' ? null : warn(o.message);
    // A Stop pressed during startup that reverted is the Stop the human asked for; one that did not
    // leaves the Play world live, which looks exactly like a Stop that worked.
    case 'stopped-during-startup': return o.reverted ? null : warn(o.message);
    default: { const never: never = o; return never; }
  }
}

/** Toast for a Stop press, or null when it did what it looked like. Exhaustive, as `playFeedback`. */
export function stopFeedback(o: StopOutcome): PressFeedback | null {
  switch (o.kind) {
    case 'stopped': return o.reverted ? null : warn(`Stopped without reverting — ${o.reason}.`);
    case 'preview-exited': return o.reverted === false ? warn(`Preview exited without reverting — ${o.reason}.`) : null;
    // Queued behind a Play still starting up: its answer arrives on that Play's outcome, which the
    // Play press reports (`stopped-during-startup`).
    case 'queued':
    case 'already-stopped':
      return null;
    default: { const never: never = o; return never; }
  }
}

function show(f: PressFeedback | null): void {
  if (f) useEditorStore.getState().showToast(f.text, f.kind);
}

/** A thrown Play/Stop used to be an unhandled rejection under `void` — logged, but not to the human. */
function thrown(what: string, err: unknown): PressFeedback {
  console.error(`[Editor] ${what} threw:`, err);
  const why = err instanceof Error ? err.message : String(err);
  return warn(what === 'Stop'
    ? `Stop could not restore the authored world (${why}) — the live world may still be the Play world. Reload the scene before saving or pressing Play.`
    : `Play failed to start (${why}).`);
}

/** The toolbar ▶, the `mod+p` chord and the take recorder's ⏺. Resolves with the outcome for a
 *  caller that has its own follow-up (the recorder), or null when Play threw — both already told. */
export async function pressPlay(): Promise<PlayOutcome | null> {
  let o: PlayOutcome;
  try { o = await enterPlay(); } catch (err) { show(thrown('Play', err)); return null; }
  show(playFeedback(o));
  return o;
}

/** The toolbar ⏹, and the take recorder's second ⏺ press. Never rejects. */
export async function pressStop(): Promise<void> {
  let o: StopOutcome;
  try { o = await stopPlay(); } catch (err) { show(thrown('Stop', err)); return; }
  show(stopFeedback(o));
}
