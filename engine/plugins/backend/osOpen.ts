import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Open a file in the OS default app/editor (e.g. a .ts script → the user's
 *  default TypeScript editor). ASYNC — a synchronous spawn would block the
 *  Node/Electron main thread (janking the editor) while the OS launches the app.
 *  `absPath` is passed as a single argv element, never shell-parsed. Isolated in
 *  its own module so the platform branch is unit-testable without mocking a node
 *  builtin. Rejects if the opener errors (caller maps that to a 500). */
export async function openInOS(absPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [absPath]);
  } else if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', absPath]);
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
    await execFileAsync('explorer', [`/select,${absPath.replace(/\//g, '\\')}`]);
  } else {
    await execFileAsync('xdg-open', [path.dirname(absPath)]);
  }
}
