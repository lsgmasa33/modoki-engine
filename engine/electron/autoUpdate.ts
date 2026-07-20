// Desktop editor self-update (electron-updater over the generic feed declared in
// electron-builder.yml `publish` — a PUBLIC GCS path, not GitHub Releases, since
// the repo is private and a distributed app can't authenticate to a private GitHub
// feed). The release workflow signs + notarizes + uploads latest-mac.yml + the
// zip/blockmap to that bucket on a v* tag; this checks the feed on launch,
// downloads a newer signed build in the background, and offers a restart-to-install.
// Squirrel.Mac requires a code signature, so this is a no-op in dev / `--dir` /
// MODOKI_PROD runs (app.isPackaged === false there).

import { app, dialog, BrowserWindow } from 'electron';
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

/** True while an update install is in progress (after "Restart Now"). main's
 *  before-quit checks this so it doesn't preempt Squirrel's quit-and-install. */
export function isUpdateInstalling(): boolean {
  return installing;
}

function wire(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    const msg = (err && (err as Error).message) || String(err);
    console.warn('[auto-update] error:', msg);
    if (interactiveCheck) {
      interactiveCheck = false;
      dialog.showMessageBox({
        type: 'error', title: 'Update Check Failed', message: 'Could not check for updates.', detail: msg,
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[auto-update] update available:', info.version, '(downloading…)');
    // Downloading happens automatically (autoDownload). The interactive
    // acknowledgement comes on `update-downloaded`, so drop the interactive flag
    // here — we don't want a second "up to date" dialog to fire.
    interactiveCheck = false;
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] up to date');
    if (interactiveCheck) {
      interactiveCheck = false;
      dialog.showMessageBox({
        type: 'info', title: 'No Updates', message: 'Modoki Editor is up to date.',
        detail: `You're on version ${app.getVersion()}.`,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[auto-update] downloaded:', info.version);
    const opts = {
      type: 'info' as const,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `Modoki Editor ${info.version} has been downloaded.`,
      detail: 'Restart to install the update. It will also install automatically the next time you quit.',
    };
    const win = BrowserWindow.getAllWindows()[0];
    const after = (r: Electron.MessageBoxReturnValue) => {
      if (r.response === 0) {
        installing = true; // before-quit must defer to Squirrel from here
        autoUpdater.quitAndInstall();
      }
    };
    (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(after);
  });
}

/** Pure parse of `codesign -dvv` output: true ⇒ the binary is AD-HOC signed (a
 *  locally-built / unsigned app), false ⇒ anything else (a Developer-ID build).
 *  Exported so the classification is unit-tested without spawning codesign. */
export function isAdhocSignature(codesignOutput: string): boolean {
  return /Signature=adhoc/.test(codesignOutput);
}

/** A locally-built / unsigned mac app is ad-hoc signed. Squirrel.Mac REJECTS a
 *  Developer-ID-signed update for it ("code failed to satisfy specified code
 *  requirement(s)"), so the launch check can only ever end in a dead-end
 *  "downloaded — restart to install" prompt that then fails to install. Detect the
 *  ad-hoc signature and skip auto-update entirely for such builds. codesign prints
 *  the signature info to stderr, so redirect it into the captured output. Any
 *  failure (codesign missing, unexpected output) returns false → a real signed
 *  production build still updates normally. Skipped under the test harness (VITEST):
 *  the probe would run codesign on the ad-hoc-signed node binary — isAdhocSignature
 *  is unit-tested directly instead. */
function isUnsignedMacBuild(): boolean {
  if (process.platform !== 'darwin' || process.env.VITEST) return false;
  try {
    return isAdhocSignature(execSync(`codesign -dvv "${process.execPath}" 2>&1`, { encoding: 'utf8' }));
  } catch {
    return false; // can't tell → don't block production updates
  }
}

/** Silent check on launch — packaged + signed only. Errors are logged, never shown. */
export function setupAutoUpdate(): void {
  if (!app.isPackaged) return; // dev / MODOKI_PROD: no feed, no signature
  // Unsigned `--dir` builds (the packaged smoke test) are app.isPackaged===true but
  // can't actually self-install; skip so the smoke run doesn't kick off a pointless
  // background download against the live GitHub feed.
  if (process.env.MODOKI_NO_AUTOUPDATE === '1') return;
  // Locally-built unsigned DMGs (developer review builds) likewise can't apply a
  // signed update — skip so they don't nag with an un-installable "update ready".
  if (isUnsignedMacBuild()) {
    // Belt-and-suspenders: a PRIOR (signed-check) session may have staged a newer
    // build in Squirrel's pending cache. autoInstallOnAppQuit defaults to true, so on
    // quit Squirrel would try to apply that staged update — silently REVERTING this
    // unsigned build to the older signed one. Disable it so an unsigned build stays put.
    autoUpdater.autoInstallOnAppQuit = false;
    console.log('[auto-update] skipped — this is an unsigned (ad-hoc) build; it cannot self-install a signed update (install-on-quit disabled).');
    return;
  }
  wire();
  autoUpdater.checkForUpdates().catch((e) => console.warn('[auto-update] launch check failed:', e?.message || e));
}

/** "Check for Updates…" menu action — shows up-to-date / error feedback. */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info', title: 'Updates Unavailable',
      message: 'Auto-update is only available in the packaged app.',
      detail: 'This is a development build.',
    });
    return;
  }
  wire();
  interactiveCheck = true;
  autoUpdater.checkForUpdates().catch((e) => {
    interactiveCheck = false;
    console.warn('[auto-update] interactive check failed:', e?.message || e);
  });
}
