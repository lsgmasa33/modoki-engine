/** "Authoring has settled": the editor is back in `stopped` AND no world-replacing load is still on
 *  its way in (#1164).
 *
 *  Why a run-mode edge alone is not enough. The two paths that end a run hand the world back by
 *  RELOADING it, and both flip the mode before their load lands:
 *   - `stopPlay` calls `setPlayState('stopped')` BEFORE its snapshot `loadScene`;
 *   - `serialize.loadScene` (opening a scene) calls `setPlayState('stopped')` before its load too.
 *  Anything that reacts to "we are stopped" by loading the scene (the deferred hot-reload replay in
 *  `agentBridge.ts`) would then start its load in the middle of theirs. SceneManager supersedes the
 *  older load, so either the replay is aborted by the restore and lost again (the defect itself,
 *  one step later), or it aborts the restore or the scene open.
 *
 *  So each such path holds a replacement token for its whole length, and the settle signal fires
 *  only when the count is back to zero while `canEdit()` holds, whichever of the two edges comes
 *  last. `endTimelinePreviewSession` holds one as well, even though its caller flips the mode after
 *  it returns: a panel calls it WITHOUT awaiting and flips the mode on the next line
 *  (`TimelineEditor.tsx`), and the token is what keeps that flip from counting as settled.
 *
 *  ⚠️ A path that holds a token must take it SYNCHRONOUSLY, before its first await and before any
 *  mode change, or the window this exists to close is still open. */

import { canEdit, onRunModeChange } from '../../runtime/core/playState';
import { notifyListeners } from '../../runtime/core/notifyListeners';

let _replacing = 0;
const _listeners = new Set<() => void>();
let _unsubscribeRunMode: (() => void) | null = null;

function maybeSettle(): void {
  if (_replacing === 0 && canEdit()) notifyListeners(_listeners, 'authoringSettle', []);
}

/** Take a token for a load that replaces the world (restore, scene open). Returns its release,
 *  which is idempotent, so a `finally` and an early-exit path cannot release it twice. */
export function beginWorldReplacement(): () => void {
  _replacing += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _replacing -= 1;
    maybeSettle();
  };
}

/** Is a world-replacing load holding a token right now? */
export function isWorldReplacementInFlight(): boolean {
  return _replacing > 0;
}

/** Subscribe to "authoring has settled". Fires on every stopped-with-no-replacement edge, including
 *  repeated ones, so a listener must be cheap when it has nothing to do. The run-mode subscription
 *  is taken lazily, so importing this module subscribes to nothing. */
export function onAuthoringSettled(fn: () => void): () => void {
  _listeners.add(fn);
  if (!_unsubscribeRunMode) _unsubscribeRunMode = onRunModeChange(maybeSettle);
  return () => {
    _listeners.delete(fn);
    if (_listeners.size === 0 && _unsubscribeRunMode) { _unsubscribeRunMode(); _unsubscribeRunMode = null; }
  };
}
