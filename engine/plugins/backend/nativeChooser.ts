/** The native file choosers behind `POST /api/save-dialog` and `POST /api/pick-path` (#1440).
 *
 *  The router owns what each route ANSWERS (asset-root mapping, project-relative paths); the host
 *  owns how the panel is SHOWN, through `BackendContext.nativeChooser`:
 *
 *  - **Electron** injects `electron/electronChooser.ts` — `dialog.showSaveDialog`/`showOpenDialog`
 *    parented to the editor window (a sheet). That is the only form that works properly: the panel
 *    gets the app's Edit menu, so ⌘V pastes into its name field; it is async, so the main process —
 *    which also runs this backend — keeps serving; and it exists on Windows too.
 *  - **Everything else** (the Vite dev server serving a browser tab) falls back to `osascriptChooser`
 *    below: macOS only, `{unsupported}` elsewhere, which the renderer answers with its in-app prompt.
 *
 *  ── What was wrong (#1440) ──────────────────────────────────────────────────────────────────────
 *  Both routes used to run `execFileSync('osascript', …)` in every host. Three defects, one cause:
 *  ① the panel belonged to a faceless `osascript` process with no application menu, so ⌘V had no
 *  Edit ▸ Paste to reach and pasted nothing; ② the SYNC spawn stalled the whole event loop while the
 *  panel was open — in Electron that is the main process, so the editor froze (QA-PARTICLE-0011);
 *  ③ every non-zero exit read as a user cancel, so a broken dialog looked exactly like Cancel.
 *
 *  ⚠️ The osascript fallback still has ① — a panel owned by another process cannot use this app's
 *  menu, and no argv changes that. It is kept only for the browser dev loop; the editor proper is
 *  Electron, which never reaches it. ② and ③ are fixed for it too: it is async, and only `-128`
 *  (AppleScript's "User canceled") counts as a cancel. */
import { execFile } from 'child_process';

/** What a chooser reports. `unsupported` = this host has no native panel (the caller falls back to
 *  an in-app prompt); `error` = a panel that should exist failed, which must NOT read as a cancel. */
export type ChooserOutcome =
  | { canceled: true }
  | { path: string }
  | { error: string }
  | { unsupported: true };

export interface NativeChooser {
  /** A "Save As" panel starting in `startDir` with `defaultName` typed in. `path` is absolute. */
  saveFile(opts: { prompt: string; defaultName: string; startDir: string }): Promise<ChooserOutcome>;
  /** An open panel for one existing file or folder. `path` is absolute. */
  pickPath(opts: { mode: 'file' | 'folder'; prompt: string }): Promise<ChooserOutcome>;
}

/** Runs osascript. Injected so the classification below is testable without a panel. */
export type OsascriptRunner = (args: string[]) => Promise<{ stdout: string }>;

const runOsascript: OsascriptRunner = (args) => new Promise((resolve, reject) => {
  // ASYNC on purpose: the sync form blocked the host's whole event loop while a human looked at
  // the panel (#1440 ②).
  execFile('osascript', args, { encoding: 'utf-8' }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr }));
    else resolve({ stdout });
  });
});

/** True only for AppleScript's "User canceled." — error `-128`, which osascript prints to stderr as
 *  `execution error: User canceled. (-128)`. Anything else is a real failure (#1440 ③). */
export function isOsascriptUserCancel(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' && /\(-128\)/.test(stderr);
}

async function runChooser(run: OsascriptRunner, args: string[]): Promise<ChooserOutcome> {
  try {
    const { stdout } = await run(args);
    return { path: stdout.trim() };
  } catch (e) {
    if (isOsascriptUserCancel(e)) return { canceled: true };
    const stderr = (e as { stderr?: unknown }).stderr;
    return { error: (typeof stderr === 'string' && stderr.trim()) || String(e) };
  }
}

/** The fallback chooser for a host with no Electron. The user's strings travel as ARGV
 *  (`on run argv`), never spliced into the script, so a quote in a name cannot break out of it. */
export function osascriptChooser(run: OsascriptRunner = runOsascript, platform: NodeJS.Platform = process.platform): NativeChooser {
  return {
    async saveFile({ prompt, defaultName, startDir }) {
      if (platform !== 'darwin') return { unsupported: true };
      return runChooser(run, [
        '-e', 'on run argv',
        '-e', 'set f to choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (POSIX file (item 3 of argv))',
        '-e', 'return POSIX path of f',
        '-e', 'end run',
        prompt, defaultName, startDir,
      ]);
    },
    async pickPath({ mode, prompt }) {
      if (platform !== 'darwin') return { unsupported: true };
      const chooser = mode === 'file' ? 'choose file' : 'choose folder';
      return runChooser(run, [
        '-e', 'on run argv',
        '-e', `set f to ${chooser} with prompt (item 1 of argv)`,
        '-e', 'return POSIX path of f',
        '-e', 'end run',
        prompt,
      ]);
    },
  };
}
