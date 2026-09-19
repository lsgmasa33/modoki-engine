/** #1440 — the Electron host's chooser shows the save/pick panels through `mainDialog.ts`, parented
 *  to the editor window (a sheet: async, and covered by the app's Edit menu so ⌘V pastes), and maps
 *  Electron's `{canceled, filePath(s)}` onto the router's outcomes without turning a failure into a
 *  Cancel. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const showSaveDialog = vi.hoisted(() => vi.fn());
const showOpenDialog = vi.hoisted(() => vi.fn());
vi.mock('../../electron/mainDialog', () => ({ showSaveDialog, showOpenDialog }));

import { createElectronChooser } from '../../electron/electronChooser';
import { readScannedSource } from '@modoki/engine/testing';

const win = { tag: 'editor' } as unknown as Electron.BrowserWindow;

beforeEach(() => { showSaveDialog.mockReset(); showOpenDialog.mockReset(); });

describe('createElectronChooser', () => {
  it('saveFile opens the panel on the CURRENT editor window, starting at startDir/defaultName', async () => {
    let current: Electron.BrowserWindow | null = null;
    const chooser = createElectronChooser(() => current);
    current = win; // read per call — mainWindow is reassigned across Open Project
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/p/assets/scenes/x.scene.json' });
    const out = await chooser.saveFile({ prompt: 'Create Scene', defaultName: 'New.scene.json', startDir: '/p/assets/scenes' });
    expect(out).toEqual({ path: '/p/assets/scenes/x.scene.json' });
    const [opts, parent] = showSaveDialog.mock.calls[0];
    expect(parent).toBe(win);
    expect(opts.defaultPath).toBe(path.join('/p/assets/scenes', 'New.scene.json'));
    expect(opts.message).toBe('Create Scene');
  });

  it('saveFile: canceled is {canceled}; a throwing dialog is {error}, not a Cancel', async () => {
    const chooser = createElectronChooser(() => win);
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    expect(await chooser.saveFile({ prompt: 'p', defaultName: 'n', startDir: '/d' })).toEqual({ canceled: true });
    showSaveDialog.mockRejectedValue(new Error('Object has been destroyed'));
    expect(await chooser.saveFile({ prompt: 'p', defaultName: 'n', startDir: '/d' })).toEqual({ error: 'Object has been destroyed' });
  });

  it('pickPath asks for a file or a folder by mode, on the editor window', async () => {
    const chooser = createElectronChooser(() => win);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/p/icon.png'] });
    expect(await chooser.pickPath({ mode: 'file', prompt: 'Choose a file' })).toEqual({ path: '/p/icon.png' });
    expect(showOpenDialog.mock.calls[0][0].properties).toContain('openFile');
    expect(showOpenDialog.mock.calls[0][1]).toBe(win);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/p/sdk'] });
    await chooser.pickPath({ mode: 'folder', prompt: 'Choose a folder' });
    expect(showOpenDialog.mock.calls[1][0].properties).toContain('openDirectory');
    expect(showOpenDialog.mock.calls[1][0].properties).not.toContain('openFile');
  });

  it('pickPath: canceled or empty is {canceled}; a throw is {error}', async () => {
    const chooser = createElectronChooser(() => win);
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await chooser.pickPath({ mode: 'folder', prompt: 'p' })).toEqual({ canceled: true });
    showOpenDialog.mockRejectedValue(new Error('nope'));
    expect(await chooser.pickPath({ mode: 'folder', prompt: 'p' })).toEqual({ error: 'nope' });
  });
});

/** The unit tests above inject their own chooser, so nothing here would notice main.ts dropping the
 *  wiring — and the router would then fall back to osascript SILENTLY: async now, so even "the
 *  backend answers while a panel is open" stays true, and only ⌘V and Windows would break (review
 *  finding, #1440). Pinned in the source, as mainDialog.test.ts pins its owner. */
describe('main.ts wires the Electron chooser and the dialog-open menu gate', () => {
  it('passes createElectronChooser as nativeChooser, and rebuilds the menu from mainDialog\'s open count', async () => {
    // Comments stripped: a comment quoting the wiring must not satisfy this guard (#812).
    const { code: src } = readScannedSource(path.join(__dirname, '../../electron/main.ts'));
    expect(src).toMatch(/nativeChooser:\s*createElectronChooser\(\s*\(\)\s*=>\s*mainWindow\s*\)/);
    expect(src).toMatch(/setOpenDialogListener\(\s*\(open\)\s*=>\s*\{\s*nativeDialogOpen\s*=\s*open;\s*rebuildMenu\(\);/);
    expect(src).toMatch(/installAppMenu\(\{[\s\S]*?\bnativeDialogOpen,/);
  });
});
