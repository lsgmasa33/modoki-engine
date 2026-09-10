/** autoUpdate — self-update wiring. Verifies the "Restart Now" install path sets
 *  the installing flag (so main's before-quit defers to Squirrel — E1), the
 *  dev/no-autoupdate no-ops, wire() listener idempotency, and #1032's consent +
 *  feedback contract: nothing downloads unasked, and no outcome of a check is
 *  silent. `electron` + `electron-updater` are mocked so this runs headless. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ──────────────────────────────────────────────
const showMessageBox = vi.fn();
// Mutable so a test can run as a dev build, and so the progress bar has a window to
// land on (the default [] models the launch check, which fires before any window).
let isPackaged = true;
type FakeWin = { setProgressBar: ReturnType<typeof vi.fn>; isVisible: () => boolean };
let windows: FakeWin[] = [];
const mkWin = (): FakeWin => ({ setProgressBar: vi.fn(), isVisible: () => true });
vi.mock('electron', () => ({
  app: { get isPackaged() { return isPackaged; }, getVersion: () => '1.2.3' },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...a) },
  BrowserWindow: { getAllWindows: () => windows },
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

async function freshModule() {
  vi.resetModules();
  fakeUpdater = new FakeUpdater();
  showMessageBox.mockReset();
  isPackaged = true;
  windows = [];
  splashWin = null;
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

    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(m.isUpdateInstalling()).toBe(true);
  });

  it('"Later" does NOT install and leaves installing=false', async () => {
    const m = await freshModule();
    showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
    m.setupAutoUpdate();
    fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
    await settle();

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
      await settle();
      showMessageBox.mockClear();

      m.checkForUpdatesInteractive();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();
      expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
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
      const hidden: FakeWin = { setProgressBar: vi.fn(), isVisible: () => false };
      windows = [hidden];
      showMessageBox.mockResolvedValue({ response: 1 });
      m.setupAutoUpdate();
      fakeUpdater.emit('update-available', { version: '2.0.0' });
      await settle();

      expect(lastBoxParent()).toBeNull();
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
