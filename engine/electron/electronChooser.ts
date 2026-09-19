/**
 * The Electron host's `NativeChooser` (#1440) — the panels behind `/api/save-dialog` and
 * `/api/pick-path`, shown through `mainDialog.ts` so they are parented to the editor window.
 *
 * Why this and not the router's osascript fallback: a parented panel is a sheet of THIS app, so the
 * app's Edit menu (`role:'paste'`, projects.ts) reaches its name field and ⌘V pastes; it is async,
 * so the main process — which also serves the backend — keeps running while a human looks at it;
 * `canceled` is the real Cancel, so a failure is no longer reported as one; and it exists on
 * Windows, where the osascript route answered `{unsupported}`. Full story: `nativeChooser.ts`.
 */
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ChooserOutcome, NativeChooser } from '../plugins/backend/nativeChooser';
import { showOpenDialog, showSaveDialog } from './mainDialog';

/** `getWindow` is read per call: `mainWindow` is reassigned across Open Project. The menu gating
 *  while a panel is open lives in `mainDialog.ts`, which counts every dialog, not just these two. */
export function createElectronChooser(getWindow: () => BrowserWindow | null): NativeChooser {
  return {
    async saveFile({ prompt, defaultName, startDir }): Promise<ChooserOutcome> {
      try {
        const r = await showSaveDialog({
          // `defaultPath` carries both the start folder and the typed name. macOS's remembered
          // last location does not override an explicit directory here, unlike osascript's
          // `default location`.
          defaultPath: path.join(startDir, defaultName),
          title: prompt,
          message: prompt, // macOS shows `message` in the panel; `title` is the window title elsewhere
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        }, getWindow());
        if (r.canceled || !r.filePath) return { canceled: true };
        return { path: r.filePath };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    async pickPath({ mode, prompt }): Promise<ChooserOutcome> {
      try {
        const r = await showOpenDialog({
          title: prompt,
          message: prompt,
          properties: mode === 'file' ? ['openFile'] : ['openDirectory', 'createDirectory'],
        }, getWindow());
        const chosen = r.filePaths[0];
        if (r.canceled || !chosen) return { canceled: true };
        return { path: chosen };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
