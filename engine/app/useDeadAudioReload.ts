/** useDeadAudioReload — reloads the page when the engine declares its audio DEAD (#1455).
 *
 *  The decision is `runtime/core/deadAudioReload.ts` (tested there, every dependency injected);
 *  detection is `audioService`'s clock check (`onAudioDead`). This file supplies the real clock,
 *  the real blockers, the real prefs flush, the real reload, and the rate-limit memory that must
 *  survive the reload itself (sessionStorage — it dies with the app process, as it should).
 *
 *  Opt-in per project: `runtime.reloadOnDeadAudio` in `project.config.json` (Project Settings →
 *  "Reload when audio dies"), because a reload only preserves what the GAME persists — the same
 *  reasoning as `useResumeReload`'s threshold. */

import { useEffect } from 'react';
import {
  PlayerPrefs, createDeadAudioReloadHandler, getActiveReloadBlockers, isAudioStillDead, onAudioDead,
  shutdownRealmThenReload,
} from '@modoki/engine/runtime';
import projectConfig from 'virtual:modoki-project-config';

/** At most one dead-audio reload per this long. If another app still holds the audio session, a
 *  reload may not help — without a floor the game would reload in a loop. Mechanism, not feel. */
const MIN_INTERVAL_MS = 10 * 60_000;
const STORAGE_KEY = 'modoki.deadAudioReloadAt';

/** Pure and exported so the opt-in rule is testable without the virtual module: only a literal
 *  `true` turns it on — a malformed value must never mean "reload". */
export function resolveReloadOnDeadAudio(config: { runtime?: { reloadOnDeadAudio?: unknown } }): boolean {
  return config.runtime?.reloadOnDeadAudio === true;
}

function lastReloadAt(): number | null {
  try {
    const v = Number(sessionStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function markReloaded(at: number): void {
  try { sessionStorage.setItem(STORAGE_KEY, String(at)); } catch { /* the reload still happens */ }
}

export function useDeadAudioReload() {
  useEffect(() => {
    if (!resolveReloadOnDeadAudio(projectConfig)) return;
    const handler = createDeadAudioReloadHandler({
      // Wall clock: the rate-limit spans a reload, so it cannot be a monotonic-since-load clock.
      now: () => Date.now(),
      blockedBy: getActiveReloadBlockers,
      flush: () => PlayerPrefs.flush(),
      reload: () => shutdownRealmThenReload(() => window.location.reload()),
      lastReloadAt,
      markReloaded,
      wait: (ms) => new Promise((r) => { setTimeout(r, ms); }),
      stillDead: () => isAudioStillDead(),
      minIntervalMs: MIN_INTERVAL_MS,
    });
    // ⚠️ Never the editor: `App.tsx` is shared, and a reload there discards unsaved scene edits.
    const isEditorRoute = () => window.location.hash.startsWith('#/editor');
    return onAudioDead((after) => {
      if (isEditorRoute()) return;
      handler.onDead().then(
        (outcome) => console.warn(`[dead-audio] audio is dead after ${after === 'ad' ? 'an ad' : 'a foreground'} — ${outcome}`),
        (e: unknown) => console.warn('[dead-audio] reload failed:', e),
      );
    });
  }, []);
}
