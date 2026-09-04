/** Wires a NATIVE alert to `frameDriver`'s "the frame loop is permanently dead" transition —
 *  Phase 2 of docs/plans/ios-rendering-update-wedge.md. `frameDriver.ts`'s own
 *  `declareUnrecoverable()` comment already flags this: "Phase 2 (out of scope here) wires a
 *  native alert to this transition." On iOS a WebGL context loss makes WebKit permanently stop
 *  painting — DOM paint is dead too, so an in-page message is impossible and only native
 *  UIKit/Android can show anything. See `NativeDialogService` in `../core/appServices.ts`.
 *
 *  Lives in `runtime/rendering/`, not `runtime/core/`, because it needs BOTH `frameDriver` (L2
 *  rendering) and `appServices` (L0 core) — L2 may import L0 but not vice versa, so a module
 *  needing both belongs at the higher layer. See docs/architecture-layers.md.
 *
 *  A game's `dialog` service typically registers well after boot (same reasoning
 *  `globalErrors.ts`'s crashlytics queue-and-flush header gives for `crashlytics`), so a fire
 *  that lands before registration is not dropped — it retries once via `onAppServicesRegistered`.
 *
 *  ⚠️ NO TOP-LEVEL SIDE EFFECTS. This module must not subscribe to anything at import time —
 *  Phase 1 subscribed to `onRendererLost` at module load in a different file and broke three
 *  unrelated test suites whose `activeRenderer` mocks use an explicit export list (the failure is
 *  at import-BINDING time, not at assertion time). Every subscription here happens only inside
 *  `installUnrecoverableFrameLoopAlert()`, when a caller actually asks for it. */

import { onFrameLoopUnrecoverable, type FrameLoopUnrecoverableInfo } from './frameDriver';
import { appServices, onAppServicesRegistered } from '../core/appServices';

/** Copy for the native alert. Strings are AUTHORED BY THE GAME, not the engine — per CLAUDE.md's
 *  "author values in the game, not code" rule, the engine owns only the mechanism. */
export interface UnrecoverableFrameLoopAlertCopy {
  title: string;
  message: string;
  buttonTitle?: string;
}

let installedUninstall: (() => void) | null = null;

/** Subscribe a native alert to `onFrameLoopUnrecoverable`, showing `copy` at most ONCE for the
 *  life of this install — whether the underlying event fires once (documented) or, defensively,
 *  more than once; whether `dialog` is registered already or arrives later via
 *  `onAppServicesRegistered`.
 *
 *  Calling this a SECOND time before the first install is uninstalled REPLACES it: the previous
 *  install is torn down (its `uninstall()` is called for the caller) and a fresh subscription is
 *  made with the new `copy`. This is not a true global singleton (unlike
 *  `installGlobalErrorHandlers`'s `installed`/`installing` latch, which is process-wide and
 *  installed exactly once): a game swap can plausibly uninstall the old game's alert and install
 *  a new one with different copy, and that must work fine. `fired` is per-install and resets on
 *  replace, so a new install always gets its own single alert regardless of whether the old one
 *  already fired.
 *
 *  ⚠️ Both call sites today (`games/wordweave` and `games/court`'s `app-services/src/index.ts`)
 *  discard the returned uninstaller — there is nowhere natural to store it at `register()` time.
 *  Replace-on-reinstall is what makes that safe: a caller with no stored uninstaller can still
 *  call `installUnrecoverableFrameLoopAlert()` again (e.g. on a game swap) and get a live alert
 *  with the new copy, rather than the new call being silently ignored. A double install without
 *  an intervening explicit `uninstall()` is still worth a `console.warn` — it usually means a
 *  caller forgot it already installed, even though the replace makes it harmless here. */
export function installUnrecoverableFrameLoopAlert(
  copy: UnrecoverableFrameLoopAlertCopy,
): () => void {
  if (installedUninstall) {
    console.warn(
      '[unrecoverableFrameLoopAlert] installUnrecoverableFrameLoopAlert() called again before ' +
        'the previous install was uninstalled — replacing it with the new copy.',
    );
    installedUninstall();
  }

  let fired = false;
  let uninstalled = false;
  // `onAppServicesRegistered` has no removal API — its own doc comment says the listeners are
  // process-level and "never removed". So a pending retry cannot be literally unsubscribed;
  // instead `uninstalled` (checked inside the retry callback below) makes it a no-op after
  // `uninstall()`, which gets the same observable effect (no alert after uninstall) without a
  // capability the registry doesn't offer.
  let retryQueued = false;

  function showAlert(info: FrameLoopUnrecoverableInfo): void {
    if (fired || uninstalled) return;
    const dialog = appServices().dialog;
    if (!dialog) {
      // No dialog service yet — a game registers one well after boot. Retry once a service
      // arrives, same reasoning `globalErrors.ts` uses for its `crashlytics` queue-and-flush.
      if (!retryQueued) {
        retryQueued = true;
        onAppServicesRegistered(() => showAlert(info));
      }
      return;
    }
    fired = true;
    dialog.alert(copy).catch((e) => {
      // A failed alert must never become a second fault — swallow and log, matching every other
      // app-service wrapper's try/catch-and-warn convention (e.g. crashlytics.ts in each game).
      console.warn('[unrecoverableFrameLoopAlert] dialog.alert() rejected:', e);
    });
  }

  const unsubscribeUnrecoverable = onFrameLoopUnrecoverable(showAlert);

  const uninstall = () => {
    uninstalled = true;
    unsubscribeUnrecoverable();
    if (installedUninstall === uninstall) installedUninstall = null;
  };
  installedUninstall = uninstall;
  return uninstall;
}
