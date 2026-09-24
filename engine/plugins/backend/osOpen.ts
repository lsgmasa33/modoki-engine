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
 *  failed, and `cmd /c start` (the opener before `explorer`) did not exit at all while a modal dialog was up. The
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
 *  the missing-file one. We no longer hang on it, but whatever launcher sits behind
 *  that dialog is `unref`'d and orphaned (measured with `cmd`; not re-measured since
 *  the opener became `explorer`), and the route has already answered `ok`. That
 *  is judged better than blocking the request forever; a watchdog that killed the
 *  child would also kill a legitimately slow launcher. */
function launchDetached(cmd: string, args: string[], opts: { windowsVerbatimArguments?: boolean } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
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
 *  `absPath` is passed as a single argv element, never shell-parsed (on win32,
 *  explorer still parses it — see below). Isolated in
 *  its own module so the platform branch is unit-testable without mocking a node
 *  builtin. Rejects if the opener errors (caller maps that to a 500) — on darwin
 *  and linux that includes a non-zero exit, where the exit code is meaningful;
 *  on win32 it means only that the opener would not start (`launchDetached`).
 *
 *  ⚠️ **win32 hands the path to `explorer`, never to `cmd /c start`.** `cmd` parses
 *  its command line as shell text, so a file or folder name holding `&` ran the rest
 *  as a second COMMAND, `%OS%` expanded and `^` vanished — command injection from a
 *  file name, with the route still answering ok (found in review, measured with a
 *  harmless `echo`). `explorer <file>` opens the file with its default app, like
 *  `start`, but no shell reads the path: `R&D %OS% ^x o'b\…` arrived intact where
 *  `start` opened nothing (measured, docs/windows.md).
 *
 *  ⚠️ **Quoted and verbatim, ALWAYS — explorer parses its own command line.** A `,`
 *  is its switch separator, and Node quotes an argument only when it holds a space:
 *  so `…\Game,v2\a.ts` reached explorer bare and opened NOTHING (measured; found in
 *  review), while every path with a space happened to work. Quoting it ourselves makes
 *  the tested shape the one every path takes. Same trailing-`\` caveat as below. */
export async function openInOS(absPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [absPath]);
  } else if (process.platform === 'win32') {
    await launchDetached('explorer', [`"${absPath.replace(/\//g, '\\')}"`], { windowsVerbatimArguments: true });
  } else {
    await execFileAsync('xdg-open', [absPath]);
  }
}

/** Reveal a file in the OS file manager, selecting it. Shared shape with
 *  `openInOS`; kept here so both platform branches live in one place.
 *
 *  ⚠️ **win32: the argument is `/select,"<path>"`, passed VERBATIM.** Left to Node,
 *  a path with a space gets the WHOLE token quoted — `"/select,C:\My Game\x.png"` —
 *  which explorer does not parse as `/select`, so it opens the user's Documents
 *  folder instead and the reveal silently lands in the wrong place (measured; an
 *  apostrophe alone was fine). Explorer wants the quotes around the path only. A
 *  Windows path cannot contain `"`; the one sequence left that could break the quoting
 *  is a TRAILING `\` (`"X:\"` reads as an escaped quote), which the callers rule out by
 *  resolving through `path.resolve` first — it drops a trailing separator except on a
 *  bare drive root (`X:\`), the one input this shape would still mis-quote. */
export async function revealInOS(absPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', absPath]);
  } else if (process.platform === 'win32') {
    await launchDetached('explorer', [`/select,"${absPath.replace(/\//g, '\\')}"`], { windowsVerbatimArguments: true });
  } else {
    await execFileAsync('xdg-open', [path.dirname(absPath)]);
  }
}
