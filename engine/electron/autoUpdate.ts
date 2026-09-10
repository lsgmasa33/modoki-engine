// Desktop editor self-update (electron-updater over the generic feed declared in
// electron-builder.yml `publish` — the PUBLIC modoki-engine repo's GitHub Releases).
// The release workflow signs + notarizes + uploads latest-mac.yml + the zip/blockmap
// on a v* tag; this checks the feed on launch, ASKS before downloading, and offers a
// restart-to-install once the download lands. Squirrel.Mac requires a code signature,
// so this is a no-op in dev / `--dir` / MODOKI_PROD runs (app.isPackaged === false).
//
// ⚠️ #1032 — CONSENT + FEEDBACK ARE THE POINT, not a nicety. This module used to set
// `autoDownload = true` and answer `update-available` with a bare console.log: the one
// outcome "Check for Updates…" exists to report — an update EXISTS — was the only one
// with no UI. Clicking the menu item silently began a ~294 MB fetch and showed nothing
// for minutes, so it read as a dead menu item; the owner quit mid-download and Squirrel
// discarded a 94%-complete partial (observed on disk as pending/temp-*.zip). Every
// terminal state now has a dialog, and nothing downloads until the user says yes.

import { app, BrowserWindow, autoUpdater as nativeAutoUpdater } from 'electron';
import { showMessageBox, resolveDialogParent } from './mainDialog';
import { execSync } from 'node:child_process';
// electron-updater ships CJS with a default export carrying the singleton.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

let wired = false;
// When the user explicitly invokes "Check for Updates…" we surface the
// "you're up to date" / error result; the silent launch check stays quiet.
let interactiveCheck = false;
// True once the user chose "Restart Now": quitAndInstall() triggers app.quit(),
// which fires `before-quit`. main's before-quit MUST let Squirrel drive that quit
// (NOT call its own app.exit(0), which would hard-exit before the install
// handshake completes — leaving the update uninstalled until the next quit).
let installing = false;
// A download is in flight (between downloadUpdate() and update-downloaded/error).
// Guards a SECOND check from kicking off a duplicate few-hundred-MB fetch, and lets
// a failure be reported even though the interactive flag was consumed by the prompt.
let downloading = false;
// Set once update-downloaded has fired. A later check re-offers the restart rather
// than re-downloading a build already staged on disk.
let downloadedVersion: string | null = null;
// An update prompt is on screen and unanswered. `downloading` cannot stand in for this:
// it is set INSIDE the dialog's .then, so between two checks a second `update-available`
// would stack a second identical dialog and (on two accepts) call downloadUpdate twice.
// electron-updater happens to dedupe the second call by returning the in-flight promise,
// but that is its invariant, not ours — the duplicate DIALOG is ours either way.
let promptOpen = false;

/** True while an update install is in progress (after "Restart Now"). main's
 *  before-quit checks this so it doesn't preempt Squirrel's quit-and-install. */
export function isUpdateInstalling(): boolean {
  return installing;
}

/** Dock (macOS) / taskbar (Windows) progress bar — the OS-native idiom for a long
 *  background transfer, so the download is visible without owning a window. `-1`
 *  removes the bar. Applied to every window: the dock icon reflects whichever one
 *  set it, and clearing only the first would strand the bar on a second window. */
function setProgress(fraction: number): void {
  for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(fraction);
}

/** Every box this module shows — prompts AND notifications alike. The splash rule that used to
 *  live here now lives in `mainDialog.ts` alongside its `anyWindow` twin, because #1044 found
 *  three sites in THIS FILE bypassing the local helper and going unconditionally parentless.
 *  Keeping the name as a thin alias is deliberate: it is what the call sites below read as. */
const show = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
  showMessageBox(opts, null, 'visibleNonSplash');

/** "An update exists — want it?" Shared by the launch check and the menu check: the
 *  owner's ruling (2026-09-10) is that a few-hundred-MB download never starts without
 *  consent, so BOTH paths ask rather than only the interactive one. */
function promptDownload(version: string): void {
  if (promptOpen) return;
  promptOpen = true;
  void show({
    type: 'info',
    buttons: ['Download & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Available',
    message: `Modoki Editor ${version} is available.`,
    detail: `You're on ${app.getVersion()}. The download is a few hundred MB and runs in the background — `
      + `the app icon shows its progress, and you'll be asked to restart once it's ready.`,
  }).then((r) => {
    promptOpen = false;
    if (r.response !== 0) return;
    downloading = true;
    squirrelReady = false; // a fresh transfer: whatever Squirrel had is not THIS build (#1033)
    forgetPendingReady(); // …and the previous transfer's parked listener must not speak for it
    setProgress(0); // show the bar immediately — the first progress event can be seconds away
    autoUpdater.downloadUpdate().catch((e) => {
      // A rejection here usually ALSO fires the `error` event (which reports it); clearing
      // state is idempotent, and this covers a rejection that arrives without one.
      downloading = false;
      setProgress(-1);
      console.warn('[auto-update] download failed:', e?.message || e);
    });
  }).catch((e) => { promptOpen = false; console.warn('[auto-update] prompt failed:', e?.message || e); });
}

/** macOS ONLY: has Squirrel actually pulled and validated the zip? (#1033)
 *
 *  ⚠️ **`update-downloaded` does NOT mean the bytes are on disk.** `MacUpdater` calls
 *  `dispatchUpdateDownloaded(event)` — the event we listen for — from inside
 *  `server.listen(0, "127.0.0.1", …)`, at the moment its local proxy STARTS LISTENING, and only
 *  THEN asks Squirrel to pull the ~294 MB zip through that proxy. The real completion signal is
 *  Electron's own `autoUpdater`, which is what `MacUpdater` itself keys `squirrelDownloadedUpdate`
 *  on (`this.nativeUpdater = require("electron").autoUpdater`). We listen to the same public
 *  emitter rather than reaching into the library's private field.
 *
 *  Why this matters: `MacUpdater.quitAndInstall()` with `squirrelDownloadedUpdate === false` and
 *  `autoInstallOnAppQuit === true` takes an else-branch that registers a listener and **returns
 *  having done nothing observable**. So a user who clicked "Restart Now" in the seconds before
 *  Squirrel finished got no quit and no message — the app then quit on its own once Squirrel
 *  caught up, which from the outside is the editor closing itself. */
let squirrelReady = false;

/** Windows' `NsisUpdater` has no proxy-server dance — its `update-downloaded` means the file IS
 *  downloaded — so the gate is darwin-only and everywhere else runs `cb` straight away. */
let pendingReady: (() => void) | null = null;

/** Drop a parked readiness listener. Called when a transfer is superseded or fails.
 *
 *  ⚠️ Without this the `.once` is removed by nothing, and two things go wrong. The listeners
 *  accumulate on a shared emitter (default `maxListeners` 10); worse, a parked one holds ITS
 *  download's version in a closure, so when Squirrel finishes the SUPERSEDED v1 it would set
 *  `squirrelReady = true` and prompt with v1's version — after which v2's early proxy event finds
 *  readiness already true and prompts on it, restoring #1033. (`MacUpdater` gets this wrong the
 *  same way: it sets `squirrelDownloadedUpdate` with `on` and never resets it.) */
function forgetPendingReady(): void {
  if (!pendingReady) return;
  nativeAutoUpdater.removeListener('update-downloaded', pendingReady);
  pendingReady = null;
}

/** Can Squirrel install RIGHT NOW? Windows/linux: always (their `update-downloaded` means the
 *  bytes are there). darwin: only once the native emitter has confirmed it. */
function installableNow(): boolean { return process.platform !== 'darwin' || squirrelReady; }

function whenInstallable(cb: () => void): void {
  if (installableNow()) { cb(); return; }
  // ⚠️ No timeout that prompts anyway: that would re-arm the exact defect this fixes. A download
  // that never completes is NOT silent — electron-updater rejects it through `nativeUpdater.once
  // ("error", reject)`, which surfaces on our own `error` handler as "Update Download Failed".
  forgetPendingReady(); // one parked listener at a time, always for the CURRENT transfer
  const fire = () => { pendingReady = null; squirrelReady = true; cb(); };
  pendingReady = fire;
  nativeAutoUpdater.once('update-downloaded', fire);
}

/** How long "Restart Now" may go unanswered before we say something. Mechanism (a liveness
 *  bound), not a tunable knob — same rule as `FATAL_DIALOG_TIMEOUT_MS`. */
const INSTALL_QUIT_GRACE_MS = 8_000;
/** The armed watchdog, so a second accepted prompt cannot stack a second one. */
let quitWatchdog: ReturnType<typeof setTimeout> | null = null;

/** "It's downloaded — restart?" Reached from update-downloaded, and again from a
 *  later interactive check so the staged build isn't re-downloaded. */
function promptRestart(version: string): void {
  if (promptOpen) return;
  promptOpen = true;
  void show({
    type: 'info',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Ready',
    message: `Modoki Editor ${version} has been downloaded.`,
    detail: 'Restart to install the update. It will also install automatically the next time you quit.',
  }).then((r) => {
    promptOpen = false;
    if (r.response !== 0) { setProgress(-1); return; } // "Later" — drop the indeterminate bar
    installing = true; // before-quit must defer to Squirrel from here
    autoUpdater.quitAndInstall();
    // Defence in depth (#1033). `whenInstallable` should mean the quit is immediate, but a click
    // that produces neither a quit nor a message is the exact shape #1032 existed to remove, and
    // this is the one path where we cannot see inside Squirrel. If we are still here, say so
    // rather than leaving the user looking at an editor that ignored them.
    if (quitWatchdog) clearTimeout(quitWatchdog);
    quitWatchdog = setTimeout(() => {
      quitWatchdog = null;
      if (!installing) return; // an `error` released it and already reported
      // ⚠️ Only with a window. `mainDialog` falls back to a PARENTLESS box when there is none,
      // and by now the windows may be going away for the quit this is reporting on — a parentless
      // box is app-modal and would block the very quit-and-install it is apologising for
      // (mainDialog.ts's header; fatalDialog.ts's "never open a parentless modal on a path that
      // must terminate"). With no window there is nobody looking anyway.
      // ⚠️ Ask the SAME question `show()` will ask, rather than re-implementing it. A hand-rolled
      // `getAllWindows().some(...)` had already drifted: it omitted the splash filter, so with only
      // a splash up it answered "there is a window" while `show()`'s `visibleNonSplash` policy
      // found none and went parentless anyway — the exact outcome this guard exists to prevent.
      if (resolveDialogParent('visibleNonSplash') == null) return;
      if (promptOpen) return; // do not stack a box on an open prompt
      promptOpen = true;
      void show({
        type: 'info', title: 'Finishing Update',
        message: 'The update is still being prepared.',
        detail: 'Modoki Editor will restart on its own as soon as it is ready.',
      }).finally(() => { promptOpen = false; });
    }, INSTALL_QUIT_GRACE_MS);
  }).catch((e) => { promptOpen = false; console.warn('[auto-update] prompt failed:', e?.message || e); });
}

function wire(): void {
  if (wired) return;
  wired = true;

  // ⚠️ Consent-gated (#1032): the user is asked on `update-available` and the download
  // starts only from promptDownload(). Flipping this back to true silently re-creates
  // the unannounced few-hundred-MB fetch.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    const msg = (err && (err as Error).message) || String(err);
    console.warn('[auto-update] error:', msg);
    const wasDownloading = downloading;
    // ⚠️ An error AFTER "Restart Now" means the install did not happen — so `installing`
    // must be released. main's before-quit RETURNS EARLY while it is set (main.ts), which
    // skips the whole awaited teardown including releaseDeviceResourcesOnExit(); a device
    // claim is machine-wide, so a stuck flag would lock a phone out of every other clone
    // on every later quit, hours after the failed update.
    const wasInstalling = installing;
    // ⚠️ Only drop the parked readiness listener when a TRANSFER failed — not on any `error`.
    // electron-updater emits `error` for a failed FEED CHECK too ("Cannot check for updates"), and
    // in the #1033 window `downloading` is already false because the early proxy event cleared it.
    // So an unconditional forget here killed a listener whose transfer was alive and well: Squirrel
    // would finish minutes later and "Restart Now" would never be offered again for the life of
    // the process. Found in review, as a regression introduced by the previous review's fix.
    if (wasInstalling || wasDownloading) forgetPendingReady();
    installing = false;
    downloading = false;
    setProgress(-1);
    // A failed DOWNLOAD or INSTALL is always reported, interactive or not: the user
    // explicitly asked for it, so silence here is the same defect this module was fixing.
    if (interactiveCheck || wasDownloading || wasInstalling) {
      interactiveCheck = false;
      const what = wasInstalling ? 'install' : wasDownloading ? 'download' : 'check';
      show({
        type: 'error',
        title: what === 'install' ? 'Update Install Failed'
          : what === 'download' ? 'Update Download Failed' : 'Update Check Failed',
        message: what === 'install' ? 'Could not install the update.'
          : what === 'download' ? 'Could not download the update.' : 'Could not check for updates.',
        detail: msg,
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[auto-update] update available:', info.version);
    // The prompt below IS the interactive answer, so consume the flag either way —
    // otherwise a later `update-not-available` would fire a stale "up to date" box.
    const wasInteractive = interactiveCheck;
    interactiveCheck = false;
    // ⚠️ THIS is the one place the staged/in-flight cases are decided, and it is reachable
    // from both entry points — checkForUpdatesInteractive deliberately keeps no second copy.
    // The ordering matters: `installing` outranks a staged build, which outranks a download.
    if (installing) {
      // Quitting into Squirrel. Not silent for a user who clicked, but nothing to offer.
      if (wasInteractive) {
        void show({
          type: 'info', title: 'Installing Update',
          message: 'The update is being installed.',
          detail: 'Modoki Editor will restart on its own.',
        });
      }
      return;
    }
    if (downloadedVersion === info.version) {
      // ⚠️ GATED, exactly like the `update-downloaded` path (#1033 review). This is reachable
      // DURING the minutes Squirrel spends pulling the zip: `downloadedVersion` is set by the early
      // proxy event, so a "Check for Updates…" in that window used to re-offer "Restart Now" here
      // ungated — the very no-op #1033 fixes, plus a stuck `installing` that makes main's
      // before-quit skip `releaseDeviceResourcesOnExit()` on every later quit.
      //
      // ⚠⚠ ...but gating ALONE made this the one branch of this handler that answers a user's
      // menu click with SILENCE (found in review). Every other branch speaks — `installing` says
      // "Installing Update", `downloading` says "Update Downloading" — and this state is exactly
      // the one where `downloading` was already cleared by the `update-downloaded` handler, so the
      // branch that would have spoken is unreachable. A dead menu item during the longest wait in
      // the whole flow is #1032's original defect, reintroduced by #1033's fix.
      if (!installableNow() && wasInteractive) {
        void show({
          type: 'info', title: 'Update Downloading',
          message: `Modoki Editor ${info.version} is still being prepared.`,
          detail: "The app icon shows its progress. You'll be asked to restart once it's ready.",
        });
      }
      whenInstallable(() => promptRestart(info.version));
      return;
    }
    if (downloading) {
      // A second check landing mid-download must not start a duplicate fetch — but if
      // the USER asked, the click still has to produce an answer.
      if (wasInteractive) {
        void show({
          type: 'info', title: 'Update Downloading',
          message: `Modoki Editor ${info.version} is already downloading.`,
          detail: "The app icon shows its progress. You'll be asked to restart once it's ready.",
        });
      }
      return;
    }
    // A staged build that the feed has since SUPERSEDED falls through to here and is
    // offered as a fresh download — the reason this guard compares versions rather than
    // short-circuiting on "something is staged".
    promptDownload(info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] up to date');
    if (interactiveCheck) {
      interactiveCheck = false;
      show({
        type: 'info', title: 'No Updates', message: 'Modoki Editor is up to date.',
        detail: `You're on version ${app.getVersion()}.`,
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    // Electron wants 0–1 and treats >1 as indeterminate; electron-updater reports 0–100.
    const pct = typeof p?.percent === 'number' ? p.percent : 0;
    setProgress(Math.max(0, Math.min(1, pct / 100)));
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[auto-update] downloaded:', info.version);
    downloading = false;
    downloadedVersion = info.version;
    // NOT cleared: on macOS `update-downloaded` fires when electron-updater's local proxy
    // starts listening, BEFORE Squirrel pulls the zip through it — so the machine is still
    // transferring. Switch to indeterminate rather than claiming completion; "Later" clears it.
    setProgress(2);
    // ⚠️ …and for the same reason the PROMPT waits too (#1033). Offering "Restart Now" here
    // offered a button that could do nothing: #1032 fixed the progress bar for this and left the
    // prompt armed on the early event two lines below it.
    whenInstallable(() => promptRestart(info.version));
  });
}

/** Pure parse of `codesign -dvv` output: true ⇒ the binary is AD-HOC signed (a
 *  locally-built / unsigned app), false ⇒ anything else (a Developer-ID build).
 *  Exported so the classification is unit-tested without spawning codesign. */
export function isAdhocSignature(codesignOutput: string): boolean {
  return /Signature=adhoc/.test(codesignOutput);
}

// The signature cannot change while the app runs, and the reason probe is now hit on
// every menu click rather than once at launch — memoize the codesign spawn.
let adhocCache: boolean | undefined;

/** A locally-built / unsigned mac app is ad-hoc signed. Squirrel.Mac REJECTS a
 *  Developer-ID-signed update for it ("code failed to satisfy specified code
 *  requirement(s)"), so a check can only ever end in a dead-end "downloaded — restart
 *  to install" prompt that then fails to install. Detect the ad-hoc signature and skip
 *  auto-update entirely for such builds. codesign prints the signature info to stderr,
 *  so redirect it into the captured output. Any failure (codesign missing, unexpected
 *  output) returns false → a real signed production build still updates normally.
 *  Skipped under the test harness (VITEST): the probe would run codesign on the
 *  ad-hoc-signed node binary — isAdhocSignature is unit-tested directly instead. */
function isUnsignedMacBuild(): boolean {
  if (process.platform !== 'darwin' || process.env.VITEST) return false;
  if (adhocCache !== undefined) return adhocCache;
  try {
    adhocCache = isAdhocSignature(execSync(`codesign -dvv "${process.execPath}" 2>&1`, { encoding: 'utf8' }));
  } catch {
    adhocCache = false; // can't tell → don't block production updates
  }
  return adhocCache;
}

/** Why this build cannot self-update, as a user-facing sentence — or null when it can.
 *  ONE eligibility rule for both entry points, because they disagreed (#1032): the
 *  launch check skipped unsigned/ad-hoc builds, while the menu check happily ran on one
 *  and would download a few hundred MB that Squirrel then refuses to install. */
function updateBlockedReason(): string | null {
  // dev / MODOKI_PROD: no feed, no signature.
  if (!app.isPackaged) return 'This is a development build.';
  // Unsigned `--dir` builds (the packaged smoke test) are app.isPackaged===true but
  // can't actually self-install; skip so the smoke run doesn't fetch from the live feed.
  if (process.env.MODOKI_NO_AUTOUPDATE === '1') return 'Auto-update is disabled for this build (MODOKI_NO_AUTOUPDATE=1).';
  if (isUnsignedMacBuild()) {
    return 'This is an unsigned (ad-hoc) local build. Squirrel.Mac rejects a Developer-ID-signed '
      + 'update for such a build, so a download could never be installed — install a signed release instead.';
  }
  return null;
}

/** Silent check on launch — packaged + signed only. Errors are logged, never shown;
 *  an update that EXISTS still prompts (that is the whole point of the check). */
export function setupAutoUpdate(): void {
  const blocked = updateBlockedReason();
  if (blocked) {
    // Belt-and-suspenders: a PRIOR (eligible) session may have staged a newer build in
    // Squirrel's pending cache. autoInstallOnAppQuit defaults to true, so on quit Squirrel
    // would try to apply that staged update — silently REVERTING this build to another one.
    // Disable it so an ineligible build stays put.
    autoUpdater.autoInstallOnAppQuit = false;
    console.log(`[auto-update] skipped — ${blocked}`);
    return;
  }
  wire();
  autoUpdater.checkForUpdates().catch((e) => console.warn('[auto-update] launch check failed:', e?.message || e));
}

/** "Check for Updates…" menu action — EVERY outcome shows feedback (#1032). */
export function checkForUpdatesInteractive(): void {
  const blocked = updateBlockedReason();
  if (blocked) {
    void show({
      type: 'info', title: 'Updates Unavailable',
      message: 'This build cannot check for or install updates.',
      detail: blocked,
    });
    return;
  }
  // ⚠️ ALWAYS re-read the feed, even with a build already staged. Short-circuiting on
  // `downloadedVersion` here looked like a saving and was a bug: once 0.7.0 was staged and
  // the user picked "Later", every later check re-offered 0.7.0 for the life of the
  // process — 0.8.0 could ship and the menu would never see it. The staged/in-flight cases
  // are answered by the `update-available` handler instead, which knows the feed's version.
  // That also leaves ONE copy of those guards rather than two that can drift apart.
  wire();
  interactiveCheck = true;
  autoUpdater.checkForUpdates().catch((e) => {
    interactiveCheck = false;
    console.warn('[auto-update] interactive check failed:', e?.message || e);
  });
}
