/** useResumeReload — reloads the app on resume after a long time in the background (#574).
 *
 *  Its own module, not an effect inside `App.tsx`, for the same reason `useAudioResumeRearm` is:
 *  `App` is not exported and drags in routing plus the lazy editor chunk, so anything inline
 *  there cannot be pinned by a test. The DECISION itself lives one level further out again, in
 *  `runtime/core/resumeReload.ts`, with every dependency injected — this file is only the wiring
 *  that supplies the real clock, the real store and the real reload.
 *
 *  The threshold is authored data, not a code constant: `runtime.reloadAfterBackgroundMinutes` in
 *  the project's `project.config.json`, reachable from the editor's Project Settings dialog. It
 *  defaults to 0 (off) and each project opts in — because the reload only preserves what that
 *  game persists, and most games persist nothing mid-level. `games/court` and `games/wordweave`
 *  each hand-rolled a session serializer; `games/sling`, `chess`, `space-invader` and
 *  `alien-animal` would lose the whole session.
 */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { PlayerPrefs, createResumeReloadHandler, getActiveReloadBlockers, markResumeReload, shutdownRealmThenReload } from '@modoki/engine/runtime';
import projectConfig from 'virtual:modoki-project-config';

/** In a DEBUG build the threshold is capped here, because the shipping value is unusable to test
 *  against: waiting ten real minutes per iteration means the trigger gets exercised once and
 *  assumed correct thereafter (owner, 2026-09-02).
 *
 *  A cap rather than an override, so a project that deliberately authors something SHORTER than
 *  this keeps its own value — the goal is "never wait long in debug", not "always wait exactly
 *  this". `debugBuild` survives `stripPrivateBuildFields`, so it is readable client-side. */
const DEBUG_MAX_THRESHOLD_MS = 60_000;

/** Minutes → ms, defaulting to 0 (disabled) for any project that has not authored the field or
 *  has authored something non-numeric. A malformed value must not silently become "reload
 *  constantly": anything that is not a finite positive number is off.
 *
 *  Pure and exported so the debug cap and the malformed-input handling can be pinned without a
 *  virtual-module mock — `virtual:modoki-project-config` is resolved by a Vite plugin, so a test
 *  that wanted to vary it would be asserting against its own stub. */
export function resolveThresholdMs(config: {
  runtime?: { reloadAfterBackgroundMinutes?: unknown };
  build?: { debugBuild?: boolean };
}): number {
  const minutes = config.runtime?.reloadAfterBackgroundMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 0;
  const ms = minutes * 60_000;
  // Applied AFTER the disabled check, so a debug build never turns an opted-OUT project on.
  return config.build?.debugBuild ? Math.min(ms, DEBUG_MAX_THRESHOLD_MS) : ms;
}

function thresholdMs(): number {
  return resolveThresholdMs(projectConfig);
}

export function useResumeReload() {
  useEffect(() => {
    // Read once per mount: a project cannot change its own config at runtime, and this lets the
    // whole effect become a no-op for the projects that have not opted in — no listeners, no
    // background bookkeeping, nothing to reason about.
    const armedMs = thresholdMs();
    if (armedMs <= 0) return;

    // Say so when the debug cap is actually BITING. Without this the cap is invisible: a project
    // that authors 10 minutes and ships `debugBuild: true` (Court does) runs at 1 minute, and
    // anyone measuring the behaviour — or wondering why editing the authored value changed
    // nothing — has no signal at all. One line, once per boot, only when the two disagree.
    const authoredMs = (projectConfig.runtime?.reloadAfterBackgroundMinutes ?? 0) * 60_000;
    if (armedMs !== authoredMs) {
      console.info(`[resume-reload] armed at ${armedMs / 60_000} min — capped by build.debugBuild; `
        + `the authored (shipping) value is ${authoredMs / 60_000} min`);
    }

    const handler = createResumeReloadHandler({
      // ⚠️ WALL clock, deliberately. `performance.now()` is monotonic-since-load and is not
      // guaranteed to advance while an iOS app is suspended, which is precisely the interval
      // being measured. A user clock change causes at worst one spurious reload.
      now: () => Date.now(),
      thresholdMs,
      blockedBy: getActiveReloadBlockers,
      flush: () => PlayerPrefs.flush(),
      pendingKeys: () => PlayerPrefs.pendingKeys(),
      // Dispatch the realm-shutdown tasks (native ad SDK teardown, #587) before tearing the realm
      // down — same treatment as `engine.reload`, so a resume-triggered reload doesn't race it.
      // Returns the promise (not `void`-ed) so `createResumeReloadHandler` can `await` it and its
      // `catch` can still see a throw from either the teardown chain or `reload()` itself.
      reload: () => shutdownRealmThenReload(() => window.location.reload()),
      markResumed: markResumeReload,
    });

    /** ⚠️ The EDITOR must never reload itself on a timer.
     *
     *  `App.tsx` is shared between the game and the editor, and hooks run before its editor-route
     *  early return — so without this the editor would reload after a background, **discarding
     *  unsaved scene edits** (the #18 hazard; `CLAUDE.md` § Hot reload says a game-code reload
     *  already does this and must be announced to the human first). Worse here, because nothing
     *  announces it and the human is by definition away from the screen.
     *
     *  Gated on the ROUTE rather than the `__MODOKI_EDITOR__` bundle flag on purpose: that flag
     *  is true for the whole dev bundle, so keying off it would also disable the trigger on the
     *  GAME route under `npm run dev` — i.e. exactly where the 1-minute debug cap exists to make
     *  it testable. `startsWith` because the route may carry a suffix. */
    const isEditorRoute = () => window.location.hash.startsWith('#/editor');

    const resume = () => {
      if (isEditorRoute()) return;
      // The `.catch` is not decorative. An unhandled rejection here would be reported to
      // Crashlytics by `globalErrors.ts` — and worse, a throw from `reload()` itself lands AFTER
      // the handler has latched `reloading = true`, which wedges the trigger off for the rest of
      // the realm. Swallowing it keeps the failure to one declined reload. Same treatment as the
      // `addListener` rejection below.
      handler.onResume().catch((e: unknown) => {
        console.warn('[modoki] reload-on-resume check failed — skipping this resume', e);
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') handler.onBackground();
      else resume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    let appListener: { remove: () => void } | undefined;
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) resume();
        else handler.onBackground();
      }).then((h) => { if (cancelled) h.remove(); else appListener = h; })
        // A rejected registration must not become an unhandledrejection — globalErrors.ts reports
        // those to Crashlytics, so an absent/stripped plugin would file one per launch. Same
        // treatment as `useAudioResumeRearm`'s listener. Warned rather than swallowed because a
        // failure here silently disables the whole feature on native, and `visibilitychange`
        // alone is a weaker signal there.
        .catch((e: unknown) => {
          console.warn('[modoki] appStateChange listener failed to register — reload-on-resume '
            + 'will rely on visibilitychange only', e);
        });
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      appListener?.remove();
    };
  }, []);
}
