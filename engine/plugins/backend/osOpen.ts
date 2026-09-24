import { execFile, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Launch a GUI opener and resolve as soon as it has STARTED — never waiting for
 *  it to exit.
 *
 *  ⚠️ The asymmetry with the darwin/linux branches below is deliberate; do not
 *  "tidy" it into one shape. On Windows a launcher's termination says nothing about
 *  the operation the user asked for — `explorer` exits 1 whether it succeeded or
 *  failed, and `cmd /c start` does not exit at all while a modal dialog is up. The
 *  measurements, and why ignoring exit code 1 specifically would be false precision,
 *  are in docs/windows.md § "A GUI launcher's exit status is not the operation's
 *  outcome" (#1508, #1515). Both were found on a real Windows box; a Mac cannot see
 *  either.
 *
 *  So the exit status is dropped and the one signal Windows still gives honestly is
 *  kept: whether the opener could be STARTED at all (`ENOENT` and friends arrive as
 *  `'error'`, before `'spawn'`).
 *
 *  ⚠️ **Accepted cost of detaching:** the shell's "Windows cannot find…" modal is
 *  still reachable for a path that EXISTS but cannot be opened — a dangling file
 *  association, say. The callers' `existsSync` check does not cover that case, only
 *  the missing-file one. We no longer hang on it, but the `cmd` sitting behind that
 *  dialog is `unref`'d and orphaned, and the route has already answered `ok`. That
 *  is judged better than blocking the request forever; a watchdog that killed the
 *  child would also kill a legitimately slow launcher. */
function launchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Open a file in the OS default app/editor (e.g. a .ts script → the user's
 *  default TypeScript editor). ASYNC — a synchronous spawn would block the
 *  Node/Electron main thread (janking the editor) while the OS launches the app.
 *  `absPath` is passed as a single argv element, never shell-parsed. Isolated in
 *  its own module so the platform branch is unit-testable without mocking a node
 *  builtin. Rejects if the opener errors (caller maps that to a 500) — on darwin
 *  and linux that includes a non-zero exit, where the exit code is meaningful;
 *  on win32 it means only that the opener would not start (`launchDetached`). */
export async function openInOS(absPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [absPath]);
  } else if (process.platform === 'win32') {
    await launchDetached('cmd', ['/c', 'start', '', absPath]);
  } else {
    await execFileAsync('xdg-open', [absPath]);
  }
}

/** Reveal a file in the OS file manager, selecting it. Shared shape with
 *  `openInOS`; kept here so both platform branches live in one place. */
export async function revealInOS(absPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', absPath]);
  } else if (process.platform === 'win32') {
    await launchDetached('explorer', [`/select,${absPath.replace(/\//g, '\\')}`]);
  } else {
    await execFileAsync('xdg-open', [path.dirname(absPath)]);
  }
}
