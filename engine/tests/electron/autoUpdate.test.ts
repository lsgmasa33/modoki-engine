/** autoUpdate — self-update wiring. Verifies the "Restart Now" install path sets
 *  the installing flag (so main's before-quit defers to Squirrel — E1), the
 *  dev/no-autoupdate no-ops, wire() listener idempotency, and #1032's consent +
 *  feedback contract: nothing downloads unasked, and no outcome of a check is
 *  silent. `electron` + `electron-updater` are mocked so this runs headless. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ──────────────────────────────────────────────
const showMessageBox = vi.fn();
// Mutable so a test can run as a dev build, and so the progress bar has a window to
// land on (the default [] models the launch check, which fires before any window).
let isPackaged = true;
type FakeWin = { setProgressBar: ReturnType<typeof vi.fn>; isVisible: () => boolean; isDestroyed: () => boolean };
let windows: FakeWin[] = [];
// ⚠️ `isDestroyed` is not decoration: mainDialog filters on it BEFORE `isVisible`, because
// `isVisible()` throws on a destroyed window (#1044). A fake without it models a window that
// cannot exist.
const mkWin = (): FakeWin => ({ setProgressBar: vi.fn(), isVisible: () => true, isDestroyed: () => false });
/** Electron's OWN autoUpdater — the Squirrel wrapper, NOT electron-updater. `MacUpdater` does
 *  `this.nativeUpdater = require("electron").autoUpdater` and keys `squirrelDownloadedUpdate` on
 *  its `update-downloaded`; #1033's gate listens to the same public emitter. */
let nativeUpdater: EventEmitter;
vi.mock('electron', () => ({
  app: { get isPackaged() { return isPackaged; }, getVersion: () => '1.2.3' },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...a) },
  BrowserWindow: { getAllWindows: () => windows },
  get autoUpdater() { return nativeUpdater; },
}));
// The splash is a REAL window at launch, and a dialog must never be parented to it.
let splashWin: FakeWin | null = null;
vi.mock('../../electron/splash', () => ({ isSplashWindow: (w: unknown) => w != null && w === splashWin }));

class FakeUpdater extends EventEmitter {
  autoDownload = true; // electron-updater's own default — wire() must turn it OFF
  // ⚠️ UNSET, not false. Seeded `false` this test could not fail: the "an ineligible
  // launch disables install-on-quit" assertion demanded exactly the fixture's own value,
  // so deleting `autoInstallOnAppQuit = false` from the source left the suite green
  // (caught in review). Undefined means BOTH the true and the false assertion prove a write.
  autoInstallOnAppQuit: boolean | undefined = undefined;
  checkForUpdates = vi.fn(() => Promise.resolve(null));
  downloadUpdate = vi.fn(() => Promise.resolve([]));
  quitAndInstall = vi.fn();
}
let fakeUpdater: FakeUpdater;
vi.mock('electron-updater', () => ({ default: { get autoUpdater() { return fakeUpdater; } } }));

/** ⚠️ **Pinned, never inherited from the host.** #1033's readiness gate is darwin-only (Windows'
 *  `NsisUpdater` has no proxy-server dance), so a suite that read the real `process.platform` would
 *  exercise the gate on a Mac and skip it entirely on the ubuntu and windows legs of CI — three
 *  machines disagreeing about which branch is under test, and the macOS one is the only one where
 *  a regression could fail. Every test states the platform it means. */
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
const REAL_PLATFORM = process.platform;
afterEach(() => setPlatform(REAL_PLATFORM));

/** Squirrel has the bytes — what `update-downloaded` does NOT mean on macOS (#1033). */
const squirrelFinishes = () => nativeUpdater.emit('update-downloaded');

async function freshModule({ platform = 'darwin' as NodeJS.Platform } = {}) {
  vi.resetModules();
  fakeUpdater = new FakeUpdater();
  nativeUpdater = new EventEmitter();
  showMessageBox.mockReset();
  isPackaged = true;
  windows = [];
  splashWin = null;
  setPlatform(platform);
  delete process.env.MODOKI_NO_AUTOUPDATE;
  return import('../../electron/autoUpdate');
}

/** Let a dialog's .then() chain settle (the prompts act on the user's answer). */
const settle = () => new Promise((r) => setImmediate(r));
/** The options object of the Nth showMessageBox call — arg 0 free-floating, arg 1 when
 *  parented to a window (`show()` passes the window first). */
const boxAt = (i: number) => {
  const args = showMessageBox.mock.calls[i] as unknown[];
  return (args.length > 1 ? args[1] : args[0]) as Electron.MessageBoxOptions;
};
const lastBox = () => boxAt(showMessageBox.mock.calls.length - 1);
/** The window a box was parented to, or null when it was shown free-floating. */
const lastBoxParent = () => {
  const args = showMessageBox.mock.calls[showMessageBox.mock.calls.length - 1] as unknown[];
  return args.length > 1 ? args[0] : null;
};

describe('autoUpdate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('setupAutoUpdate wires once and triggers a launch check', async () => {
    const m = await freshModule();
    m.setupAutoUpdate();
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    expect(m.isUpdateInstalling()).toBe(false);
  });

  it('isAdhocSignature classifies codesign output (ad-hoc build → skip; Developer ID → update)', async () => {
    const m = await freshModule();
    // A locally-built unsigned DMG: `codesign -dvv` reports Signature=adhoc.
    expect(m.isAdhocSignature('Executable=/Applications/Modoki Editor.app\nSignature=adhoc\n')).toBe(true);
    // A real signed release: a Developer ID authority, no adhoc marker.
    expect(m.isAdhocSignature('Authority=Developer ID Application: Modoki (ABCDE12345)\nTeamIdentifier=ABCDE12345\n')).toBe(false);
    expect(m.isAdhocSignature('')).toBe(false);
  });

  it('"Restart Now" sets installing=true before quitAndInstall (E1 — before-quit must defer)', async () => {
    const m = await freshModule();
    showMessageBox.mockResolvedValue({ response: 0 }); // "Restart Now"
    m.setupAutoUpdate();
    fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
    await settle();
    // ⚠⚠ NO prompt yet on macOS (#1033): the event above fires when electron-updater's local
    // proxy starts listening, BEFORE Squirrel pulls the zip through it. Offering "Restart Now"
    // here offered a button that could do nothing. Delete the gate in the source and THIS
    // assertion is what goes red.
    expect(showMessageBox).not.toHaveBeenCalled();
    squirrelFinishes();
    await settle();

    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(m.isUpdateInstalling()).toBe(true);
  });

  it('"Later" does NOT install and leaves installing=false', async () => {
    const m = await freshModule();
    showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
    m.setupAutoUpdate();
    fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
    // Without this the prompt never appears and the assertion below passes VACUOUSLY — nothing
    // was declined because nothing was offered.
    squirrelFinishes();
    await settle();

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(m.isUpdateInstalling()).toBe(false);
  });

  it('wire() is idempotent — update-downloaded has exactly one listener after repeated setup', async () => {
    const m = await freshModule();
    m.setupAutoUpdate();
    m.checkForUpdatesInteractive();
    m.checkForUpdatesInteractive();
    expect(fakeUpdater.listenerCount('update-downloaded')).toBe(1);
    expect(fakeUpdater.listenerCount('error')).toBe(1);
  });

  it('MODOKI_NO_AUTOUPDATE=1 skips the launch check', async () => {
    const m = await freshModule();
    process.env.MODOKI_NO_AUTOUPDATE = '1';
    m.setupAutoUpdate();
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  // ── #1032: consent before the download ──────────────────────────────────────
  describe('#1032 — an available update asks first', () => {
    it('turns electron-updater\'s autoDownload OFF (the unannounced fetch is the defect)', async () => {
      const m = await freshModule();
      m.setupAutoUpdate();
      expect(fakeUpdater.autoDownload).toBe(false);
    });

    it('update-available prompts with the version and downloads NOTHING until accepted', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(lastBox().title).toBe('Update Available');
      expect(lastBox().message).toContain('2.0.0');
      expect(lastBox().buttons?.[0]).toMatch(/download/i);
      expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('"Download & Install" starts the download exactly once', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 0 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(fakeUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('the LAUNCH check prompts too — an unattended background fetch is what #1032 removed', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate(); // no checkForUpdatesInteractive() anywhere
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(lastBox().title).toBe('Update Available');
    });
  });

  // ── #1032: the download is visible ──────────────────────────────────────────
  describe('#1032 — download feedback', () => {
    it('drives the dock/taskbar progress bar from 0 through percent to cleared', async () => {
      const m = await freshModule();
      const win = mkWin();
      windows = [win];
      showMessageBox.mockResolvedValueOnce({ response: 0 })   // "Download & Install"
        .mockResolvedValue({ response: 1 });                  // then "Later" on the restart box
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      // The bar appears on accept, not on the first progress event (seconds later).
      expect(win.setProgressBar).toHaveBeenCalledWith(0);

      // electron-updater reports 0–100; Electron wants 0–1.
      fakeUpdater.emit('download-progress', { percent: 42.5 });
      expect(win.setProgressBar).toHaveBeenLastCalledWith(0.425);

      // ⚠️ NOT cleared here: on macOS `update-downloaded` fires when the local proxy starts
      // listening, before Squirrel pulls the zip through it — the machine is still busy.
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      expect(win.setProgressBar).toHaveBeenLastCalledWith(2); // indeterminate
      squirrelFinishes();                                      // …and only NOW is there a prompt
      await settle();                                          // the user picks "Later"
      expect(win.setProgressBar).toHaveBeenLastCalledWith(-1); // now the bar goes away
    });

    it('a FAILED download is reported even though the prompt consumed the interactive flag', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 0 });
      m.setupAutoUpdate(); // launch check — never interactive
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      showMessageBox.mockClear();

      fakeUpdater.emit('error', new Error('ECONNRESET'));
      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(lastBox().title).toBe('Update Download Failed');
      expect(lastBox().detail).toContain('ECONNRESET');
    });

    it('a launch-check error with no download in flight stays SILENT (the check is unattended)', async () => {
      const m = await freshModule();
      m.setupAutoUpdate();
      fakeUpdater.emit('error', new Error('feed unreachable'));
      expect(showMessageBox).not.toHaveBeenCalled();
    });
  });

  // ── #1032: a second check never re-fetches ──────────────────────────────────
  describe('#1032 — a repeat check answers from state', () => {
    // ⚠️ These drive the guards inside the `update-available` HANDLER, which is the only
    // copy. An earlier revision short-circuited in checkForUpdatesInteractive as well, and
    // tests that stopped at that copy left the handler's guards green-when-deleted.
    it('mid-download: says so instead of starting a duplicate few-hundred-MB fetch', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 0 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      showMessageBox.mockClear();

      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-available', { version: '2.0.0' }); // the feed answers again
      await settle();
      expect(fakeUpdater.downloadUpdate).toHaveBeenCalledTimes(1); // NOT twice
      expect(lastBox().title).toBe('Update Downloading');
    });

    it('already downloaded: re-offers the restart instead of downloading again', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      squirrelFinishes();
      await settle();
      showMessageBox.mockClear();

      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
      expect(lastBox().title).toBe('Update Ready');
    });

    /** ⚠️ The hole the case above used to ratify (#1033 review). `downloadedVersion` is set by
     *  the EARLY proxy event, so a "Check for Updates…" during the minutes Squirrel spends
     *  pulling the zip reached `promptRestart` through this path with no gate at all — offering
     *  a "Restart Now" that does nothing, and leaving `installing` stuck true, which makes main's
     *  before-quit skip `releaseDeviceResourcesOnExit()` on every later quit. */
    it('a re-offer DURING the transfer is gated too, not just the update-downloaded path', async () => {
      const m = await freshModule({ platform: 'darwin' });
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' }); // proxy listening, Squirrel busy
      await settle();
      expect(showMessageBox).not.toHaveBeenCalled();

      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      // ⚠️ NOT "no dialog at all" — an earlier version of this test asserted exactly that and was
      // ratifying a regression. The user CLICKED a menu item; every other branch of this handler
      // answers, and `downloading` was already cleared by the early proxy event so the branch that
      // would have spoken is unreachable. Silence here is #1032's dead menu item, during the
      // longest wait in the whole flow. What must not appear is a RESTART offer.
      expect(lastBox().title, 'the click must be answered').toBe('Update Downloading');
      expect(
        showMessageBox.mock.calls.map(() => lastBox().title),
        'no Restart Now while Squirrel is still pulling',
      ).not.toContain('Update Ready');

      squirrelFinishes();
      await settle();
      expect(lastBox().title).toBe('Update Ready');
    });

    it('a staged build the feed has SUPERSEDED is offered as a fresh download, not re-offered', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later" throughout
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      await settle();
      showMessageBox.mockClear();

      // 3.0.0 shipped while 2.0.0 sat staged. Short-circuiting on "something is staged"
      // would re-offer 2.0.0 forever and the user could never reach 3.0.0.
      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-available', { version: '3.0.0' });
      await settle();
      expect(lastBox().title).toBe('Update Available');
      expect(lastBox().message).toContain('3.0.0');
    });

    it('two update-available events before an answer stack ONE dialog, not two', async () => {
      const m = await freshModule();
      let answer!: (v: { response: number }) => void;
      showMessageBox.mockReturnValue(new Promise((r) => { answer = r; }));
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      expect(showMessageBox).toHaveBeenCalledTimes(1);

      answer({ response: 0 });
      await settle();
      expect(fakeUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ── #1032: a failed install must not wedge the app's teardown ───────────────
  describe('#1032 — a failed install releases the installing flag', () => {
    it('an error after "Restart Now" clears installing and reports the failure', async () => {
      const m = await freshModule();
      showMessageBox.mockResolvedValue({ response: 0 }); // "Restart Now"
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      squirrelFinishes();
      await settle();
      expect(m.isUpdateInstalling()).toBe(true);
      showMessageBox.mockClear();

      // Squirrel refuses the staged build (signature mismatch, disk full, proxy read error).
      fakeUpdater.emit('error', new Error('code failed to satisfy specified code requirement(s)'));

      // ⚠️ main's before-quit RETURNS EARLY while this is set, skipping the whole awaited
      // teardown — including the machine-wide device-claim release. A stuck flag would lock
      // a phone out of every other clone on every later quit.
      expect(m.isUpdateInstalling()).toBe(false);
      expect(lastBox().title).toBe('Update Install Failed');
    });
  });

  // ── #1032: never parent a dialog to the splash ──────────────────────────────
  describe('#1032 — dialog parenting', () => {
    it('does NOT parent to the splash (it is destroyed the moment the renderer mounts)', async () => {
      const m = await freshModule();
      const splash = mkWin();
      splashWin = splash;
      windows = [splash]; // exactly the launch-time state: splash first, editor still hidden
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(lastBox().title).toBe('Update Available');
      expect(lastBoxParent()).toBeNull(); // free-floating, so closeSplash() can't take it down
    });

    it('parents to a real VISIBLE editor window when there is one', async () => {
      const m = await freshModule();
      const splash = mkWin();
      const editor = mkWin();
      splashWin = splash;
      windows = [splash, editor];
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(lastBoxParent()).toBe(editor);
    });

    it('does NOT parent to a HIDDEN editor window (createWindow makes it hidden until reveal)', async () => {
      const m = await freshModule();
      const hidden: FakeWin = { setProgressBar: vi.fn(), isVisible: () => false, isDestroyed: () => false };
      windows = [hidden];
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(lastBoxParent()).toBeNull();
    });
  });

  /** ── #1044: the three sites that BYPASSED show() ────────────────────────────
   *
   *  ⚠️ These are the regression tests for #1044 itself, and the suite had none. The three
   *  boxes below were `dialog.showMessageBox({…})` — unconditionally parentless, taking the
   *  app-modal path with a perfectly good editor window open. Every existing assertion on them
   *  reads `lastBox().title`, and `boxAt` is deliberately parent-agnostic, so they passed either
   *  way; worse, they all run under `freshModule()`, which sets `windows = []`, so they were
   *  parentless BY FIXTURE and could not have observed parenting even if they had asked.
   *
   *  Review demonstrated the cost: the real defect was reinstated at the error handler through an
   *  aliased import and all 1072 electron tests stayed green. A source guard alone was the only
   *  thing standing here. These three put a window in the fixture and assert the PARENT. */
  describe('#1044 — the boxes that used to go parentless now parent to a real window', () => {
    it('the "up to date" box parents to the editor window', async () => {
      const m = await freshModule();
      const editor = mkWin();
      windows = [editor];
      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-not-available', {});
      await settle();
      expect(lastBox().title).toBe('No Updates');
      expect(lastBoxParent()).toBe(editor);
    });

    it('the download-failure box parents to the editor window', async () => {
      const m = await freshModule();
      const editor = mkWin();
      windows = [editor];
      showMessageBox.mockResolvedValue({ response: 0 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      fakeUpdater.emit('error', new Error('feed exploded'));
      await settle();
      expect(lastBox().title).toBe('Update Download Failed');
      expect(lastBoxParent()).toBe(editor);
    });

    it('the "Updates Unavailable" box parents to the editor window', async () => {
      const m = await freshModule();
      const editor = mkWin();
      windows = [editor];
      isPackaged = false;
      m.checkForUpdatesInteractive();
      await settle();
      expect(lastBox().title).toBe('Updates Unavailable');
      expect(lastBoxParent()).toBe(editor);
    });
  });

  /** ── #1033: "Restart Now" could be a no-op ─────────────────────────────────
   *
   *  `MacUpdater` calls `dispatchUpdateDownloaded` from inside `server.listen(…)` — when its local
   *  proxy starts LISTENING — and only then asks Squirrel to pull the ~294 MB zip through it. Its
   *  `quitAndInstall()` with `squirrelDownloadedUpdate === false` and `autoInstallOnAppQuit === true`
   *  registers a listener and returns having done nothing observable. So a user clicking "Restart
   *  Now" in the seconds before Squirrel caught up got no quit and no message; the app then quit on
   *  its own, which from the outside is the editor closing itself. */
  describe('#1033 — the restart prompt waits for Squirrel, not for the proxy', () => {
    it('macOS: no prompt on the early event, and one as soon as Squirrel finishes', async () => {
      const m = await freshModule({ platform: 'darwin' });
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      await settle();
      expect(showMessageBox).not.toHaveBeenCalled();

      squirrelFinishes();
      await settle();
      expect(lastBox().title).toBe('Update Ready');
    });

    /** ⚠️ Windows' `NsisUpdater` has no proxy-server dance — its `update-downloaded` means the
     *  file IS downloaded, and there is no native emitter to wait for. Gating it there would hang
     *  the prompt forever, which is a WORSE bug than the one being fixed. */
    it('win32: prompts immediately — there is no proxy dance to wait out', async () => {
      const m = await freshModule({ platform: 'win32' });
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      await settle();
      expect(lastBox().title).toBe('Update Ready');
    });

    it('a SECOND download re-arms the gate — Squirrel having finished 1.0 says nothing about 2.0', async () => {
      const m = await freshModule({ platform: 'darwin' });
      // ⚠️ "Later", NOT "Restart Now": accepting sets `installing`, and the `update-available`
      // handler then takes its installing branch and never reaches promptDownload — so the second
      // download would never start and this test would prove nothing about re-arming.
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      squirrelFinishes();
      await settle();
      expect(lastBox().title).toBe('Update Ready');

      // A newer build appears and the user accepts the DOWNLOAD: readiness must not still be true.
      showMessageBox.mockResolvedValue({ response: 0 });
      fakeUpdater.emit('update-available', { version: '3.0.0' });
      await settle();
      expect(fakeUpdater.downloadUpdate).toHaveBeenCalled(); // the second transfer really started

      showMessageBox.mockClear();
      fakeUpdater.emit('update-downloaded', { version: '3.0.0' });
      await settle();
      expect(showMessageBox).not.toHaveBeenCalled();

      squirrelFinishes();                                    // …and it unblocks on the real signal
      await settle();
      expect(lastBox().title).toBe('Update Ready');
    });

    /** The mirror of the case above: a SILENT launch check in the same state must stay silent.
     *  #1032's rule is that a user's click is always answered, not that every event speaks. */
    it('a non-interactive re-offer during the transfer stays quiet', async () => {
      const m = await freshModule({ platform: 'darwin' });
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
      await settle();
      showMessageBox.mockClear();

      fakeUpdater.emit('update-available', { version: '2.0.0' }); // no checkForUpdatesInteractive()
      await settle();
      expect(showMessageBox).not.toHaveBeenCalled();
    });

    /** ⚠️ A failed CHECK is not a failed TRANSFER. electron-updater emits `error` for both, and
     *  in this window `downloading` is already false (the early proxy event cleared it) — so an
     *  unconditional cleanup on `error` killed a listener whose download was alive, and "Restart
     *  Now" was then never offered again for the life of the process. */
    it('a failed CHECK mid-transfer does not cost the restart prompt', async () => {
      const m = await freshModule({ platform: 'darwin' });
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-downloaded', { version: '2.0.0' }); // proxy up, Squirrel pulling
      await settle();

      m.checkForUpdatesInteractive();
      fakeUpdater.emit('error', new Error('Cannot check for updates')); // the feed blipped
      await settle();
      expect(lastBox().title).toBe('Update Check Failed');
      showMessageBox.mockClear();

      squirrelFinishes(); // …and the transfer that was never in trouble completes
      await settle();
      expect(lastBox().title, 'the restart prompt was lost to an unrelated check failure').toBe('Update Ready');
    });

    /** ⚠️ The parked readiness listener must not OUTLIVE its transfer.
     *
     *  `whenInstallable` registers a `.once` holding ITS download's version in a closure. With
     *  nothing removing it, a superseded transfer leaves it parked forever — so when Squirrel
     *  finally finishes the OLD build it sets `squirrelReady = true` and prompts with the old
     *  version, after which the NEW build's early proxy event finds readiness already true and
     *  prompts on it: #1033, restored. (`MacUpdater` has the same bug: it sets
     *  `squirrelDownloadedUpdate` with `on` and never resets it.) They also pile up on a shared
     *  emitter whose default `maxListeners` is 10.
     *
     *  Found by review as a mechanism with NO test — deleting the removal left the suite green. */
    it('a superseded transfer does not leave a listener that can speak for the next one', async () => {
      const m = await freshModule({ platform: 'darwin' });
      showMessageBox.mockResolvedValue({ response: 1 }); // "Later" on anything offered
      m.setupAutoUpdate();

      fakeUpdater.emit('update-downloaded', { version: '2.0.0' }); // parks a listener for 2.0.0
      await settle();
      expect(nativeUpdater.listenerCount('update-downloaded')).toBe(1);

      // A newer build supersedes it and the user consents to the download.
      showMessageBox.mockResolvedValue({ response: 0 });
      fakeUpdater.emit('update-available', { version: '3.0.0' });
      await settle();
      expect(fakeUpdater.downloadUpdate).toHaveBeenCalled();
      expect(
        nativeUpdater.listenerCount('update-downloaded'),
        "2.0.0's parked listener must be gone — it would speak for 3.0.0's transfer",
      ).toBe(0);

      // Squirrel now finishes the SUPERSEDED 2.0.0 transfer. Nothing may come of it.
      showMessageBox.mockClear();
      squirrelFinishes();
      await settle();
      expect(showMessageBox, 'a superseded transfer must not produce a restart prompt').not.toHaveBeenCalled();

      // …and readiness must NOT have been armed, so 3.0.0 still waits for its own signal.
      fakeUpdater.emit('update-downloaded', { version: '3.0.0' });
      await settle();
      expect(showMessageBox, '3.0.0 prompted on its EARLY event — stale readiness leaked').not.toHaveBeenCalled();
    });

    /** Defence in depth. `whenInstallable` should make the quit immediate, but this is the one
     *  path where we cannot see inside Squirrel, and a click answered with neither a quit nor a
     *  message is exactly the shape #1032 existed to remove. */
    it('a "Restart Now" that does not quit says so instead of leaving silence', async () => {
      vi.useFakeTimers();
      try {
        const m = await freshModule({ platform: 'darwin' });
        windows = [mkWin()]; // the watchdog stays silent with no window — see the case below
        showMessageBox.mockResolvedValue({ response: 0 });
        m.setupAutoUpdate();
        fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
        squirrelFinishes();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.isUpdateInstalling()).toBe(true);
        showMessageBox.mockClear();

        await vi.advanceTimersByTimeAsync(8_000);
        expect(lastBox().title).toBe('Finishing Update');
      } finally { vi.useRealTimers(); }
    });

    /** ⚠️ With no window `mainDialog` falls back to a PARENTLESS box, which is app-modal and
     *  would block the very quit-and-install this is reporting on — and by 8s in, the windows may
     *  well be going away for that quit. Nobody is looking at a windowless app anyway. */
    it('the watchdog stays silent when there is no window to parent to', async () => {
      vi.useFakeTimers();
      try {
        const m = await freshModule({ platform: 'darwin' });
        windows = [];
        showMessageBox.mockResolvedValue({ response: 0 });
        m.setupAutoUpdate();
        fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
        squirrelFinishes();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.isUpdateInstalling()).toBe(true);
        showMessageBox.mockClear();

        await vi.advanceTimersByTimeAsync(8_000);
        expect(showMessageBox).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });

    it('…and stays quiet when the install already failed and reported itself', async () => {
      vi.useFakeTimers();
      try {
        const m = await freshModule({ platform: 'darwin' });
        showMessageBox.mockResolvedValue({ response: 0 });
        m.setupAutoUpdate();
        fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
        squirrelFinishes();
        await vi.advanceTimersByTimeAsync(0);
        fakeUpdater.emit('error', new Error('refused'));   // releases `installing`, reports
        await vi.advanceTimersByTimeAsync(0);
        showMessageBox.mockClear();

        await vi.advanceTimersByTimeAsync(8_000);
        expect(showMessageBox).not.toHaveBeenCalled();     // no SECOND box on top of the error
      } finally { vi.useRealTimers(); }
    });
  });

  // ── #1032: one eligibility rule for both entry points ───────────────────────
  describe('#1032 — ineligible builds say so and never hit the feed', () => {
    it('a dev build explains itself and does not check', async () => {
      const m = await freshModule();
      isPackaged = false;
      m.checkForUpdatesInteractive();
      expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(lastBox().title).toBe('Updates Unavailable');
      expect(lastBox().detail).toMatch(/development build/i);
    });

    it('MODOKI_NO_AUTOUPDATE=1 blocks the INTERACTIVE check too — it used to skip only the launch one', async () => {
      const m = await freshModule();
      process.env.MODOKI_NO_AUTOUPDATE = '1';
      m.checkForUpdatesInteractive();
      expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(lastBox().title).toBe('Updates Unavailable');
    });

    it('an ineligible launch disables install-on-quit so a staged build cannot revert this one', async () => {
      const m = await freshModule();
      process.env.MODOKI_NO_AUTOUPDATE = '1';
      m.setupAutoUpdate();
      expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });
});
