/** autoUpdate — self-update wiring. Verifies the "Restart Now" install path sets
 *  the installing flag (so main's before-quit defers to Squirrel — E1), the
 *  dev/no-autoupdate no-ops, and wire() listener idempotency. `electron` +
 *  `electron-updater` are mocked so this runs headless. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ──────────────────────────────────────────────
const showMessageBox = vi.fn();
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.2.3' },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...a) },
  BrowserWindow: { getAllWindows: () => [] },
}));

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(() => Promise.resolve(null));
  quitAndInstall = vi.fn();
}
let fakeUpdater: FakeUpdater;
vi.mock('electron-updater', () => ({ default: { get autoUpdater() { return fakeUpdater; } } }));

async function freshModule() {
  vi.resetModules();
  fakeUpdater = new FakeUpdater();
  showMessageBox.mockReset();
  delete process.env.MODOKI_NO_AUTOUPDATE;
  return import('../../electron/autoUpdate');
}

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
    expect(m.isAdhocSignature('Authority=Developer ID Application: Modoki (KQ6FQ2BS8H)\nTeamIdentifier=KQ6FQ2BS8H\n')).toBe(false);
    expect(m.isAdhocSignature('')).toBe(false);
  });

  it('"Restart Now" sets installing=true before quitAndInstall (E1 — before-quit must defer)', async () => {
    const m = await freshModule();
    showMessageBox.mockResolvedValue({ response: 0 }); // "Restart Now"
    m.setupAutoUpdate();
    fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((r) => setImmediate(r)); // let the dialog .then(after) run

    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(m.isUpdateInstalling()).toBe(true);
  });

  it('"Later" does NOT install and leaves installing=false', async () => {
    const m = await freshModule();
    showMessageBox.mockResolvedValue({ response: 1 }); // "Later"
    m.setupAutoUpdate();
    fakeUpdater.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((r) => setImmediate(r));

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
});
