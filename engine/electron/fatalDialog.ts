// Reporting a FATAL startup failure without hanging the process (#1034).
//
// The three startup-failure paths in main.ts all had the same shape:
//
//     console.error(msg); dialog.showErrorBox(title, msg); app.exit(1);
//
// `dialog.showErrorBox` is SYNCHRONOUS — it runs a nested native modal loop. With nobody to click
// OK (headless smoke, CI, a scripted or launchd launch) it never returns, so **the terminating call
// placed after it is never reached**. The app sits alive with no window, no stdout and no exit code:
// a harness waiting on it sees a hang rather than a failure, which is the opposite of what the
// handler exists to do. Measured on a hung packaged editor: the main thread parked in
// `-[NSAlert runModal]` → `_DPSNextEvent` → `_BlockUntilNextEventMatchingListInMode`.
//
// ⚠️ **The ordering is the defect, not the dialog.** The dialog is wanted — a human who
// double-clicks the .app deserves to be told why it died. So the fix is not to drop it but to stop
// sequencing termination behind it: arm the exit FIRST, then show the dialog asynchronously, and
// let whichever finishes first end the process.
//
// ⚠️ **Deliberately NOT gated on a TTY, and NOT on a harness env var.**
//  - A TTY check looks right and is wrong in both directions: the .app double-clicked by a real
//    user has no TTY either, so it would suppress the dialog in exactly the case the dialog is for.
//  - An env var (`MODOKI_HEADLESS=1`) makes correctness depend on the caller remembering to set it.
//    An unattended launch that is NOT our own smoke harness — CI, launchd, a shell script — would
//    still hang. The timer needs no caller to opt in.
//  - Measured while a packaged editor was blocked in `runModal`: a full-screen `screencapture`
//    showed NO alert anywhere on screen. This early in startup the dialog does not even render, so
//    "the human can still click OK" is protecting a path that, here, does not exist.
//
// ⚠️⚠️ **AND THE ASYNC DIALOG IS NOT ENOUGH — arming a timer does NOT save you. MEASURED.**
// The first version of this fix did exactly what the issue suggested: arm a `setTimeout`, then show
// the ASYNC `dialog.showMessageBox`. It hung anyway — 4m51s against a 10s timer, in a real packaged
// launch. Instrumented, `finish()` was never called by EITHER racer; `sample` on the main process:
//
//     -[NSAlert runModal] → _NSTryRunModal → -[NSApplication _doModalLoop:peek:]
//       → _DPSNextEvent → _BlockUntilNextEventMatchingListInMode
//
// **`showMessageBox` with NO parent window is APP-MODAL on macOS: it runs a nested native modal
// loop on the main thread even though it returns a Promise.** Node is single-threaded, so the
// blocked loop cannot run the timer that was supposed to rescue it. The Promise is a liar here — it
// says "async" and behaves synchronously.
//
// So the rule is stronger than "arm the exit first": **never open a parentless modal on a path that
// must terminate.** With a parent window it is a SHEET (genuinely async, loop keeps running); with
// none it is a trap, and the only safe thing is to log and exit.

/** How long to leave the dialog up before terminating anyway. Long enough that a human who IS
 *  present can read it and click through; short enough that a harness fails in bounded time rather
 *  than being killed by an outer timeout with no exit code. This is mechanism (a liveness bound),
 *  not a tunable knob — see CLAUDE.md's single-source-of-truth table. */
export const FATAL_DIALOG_TIMEOUT_MS = 10_000;

export interface FatalDialogDeps {
  /** A live BrowserWindow to attach the dialog to as a SHEET, or null when there is none.
   *
   *  ⚠️ Load-bearing, not a nicety: with a parent the dialog is a sheet and the event loop keeps
   *  running; with none it is app-modal and BLOCKS the loop (measured — see the header). When this
   *  returns null we show NO dialog at all and terminate immediately, because a dialog there cannot
   *  be survived and, this early in startup, is not even drawn. */
  parentWindow(): unknown | null;
  /* ⚠️ ANY live window will do, INCLUDING the splash — deliberately unlike `autoUpdate.ts`'s
   *  `show()`, which refuses to parent to the splash because that window is destroyed the moment
   *  the renderer mounts and would take an open sheet down with it UNANSWERED. That matters there
   *  (it needs the user's answer) and not here (we terminate on the armed timer either way). All
   *  this probe has to buy is "not app-modal"; copying the stricter rule would hand back the
   *  parentless case, which is the hang. */
  /** Electron's `dialog.showMessageBox` — the ASYNC one, called WITH the parent window. Never the
   *  `…Sync` twin, and never parentless: both run a nested native modal loop. */
  showMessageBox(parent: unknown, opts: { type: 'error'; title: string; message: string; detail?: string; buttons: string[] }): Promise<unknown>;
  /** What actually ends the process. Injected because the three call sites do NOT agree: two want
   *  `app.exit(1)`, while the dev-server failure must go through `closeSplash()` +
   *  `quitExitCode = 1` + `app.quit()` so the deferred before-quit teardown still runs and the
   *  exit code stays non-zero (#68). Collapsing them onto one exit would fix this bug and
   *  reintroduce that one. */
  terminate(): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/**
 * Report a fatal startup failure and terminate — with termination guaranteed regardless of the
 * dialog.
 *
 * Returns immediately; the caller should treat it as the end of that path. `terminate` is called
 * exactly once, whichever of the two racers wins.
 */
export function reportFatalStartup(
  opts: { title: string; message: string; detail?: string; timeoutMs?: number },
  deps: FatalDialogDeps,
): void {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let done = false;
  // ⚠️ A const HOLDER, mutated later — not a `const handle` declared below `finish`, and not a bare
  // `let` either. `finish` needs the timer handle, but a `const` declared after it would make a
  // early `finish()` throw a TDZ ReferenceError out of the one function whose job is to terminate.
  // A bare `let` fixes that and then trips `prefer-const` (one assignment). The holder is
  // initialised before `finish` is defined, so there is no temporal dead zone to fall into, and it
  // is genuinely const.
  const timer: { h?: unknown } = {};
  const finish = () => {
    if (done) return; // exactly once — the dialog resolving and the timer firing can race
    done = true;
    clearT(timer.h);
    try {
      deps.terminate();
    } catch (e) {
      // ⚠️ NOT silent. A swallowed throw here is a fail-open guard on the one line that ends the
      // process — it would present as exactly the hang this module exists to prevent, with nothing
      // in the log to say why. We cannot do anything about it, but we can refuse to hide it.
      console.error('[modoki-electron] FATAL: terminate() threw — the process may not exit:', e);
    }
  };

  // ⚠️ ARMED BEFORE THE DIALOG IS SHOWN — necessary, but NOT sufficient on its own: a parentless
  // modal blocks the very loop this timer runs on. The `parent` check below is the other half.
  timer.h = setT(finish, opts.timeoutMs ?? FATAL_DIALOG_TIMEOUT_MS);

  let parent: unknown | null;
  try { parent = deps.parentWindow(); } catch { parent = null; } // a throwing probe is a no-window answer

  if (parent == null) {
    // No window to hang a sheet on. A dialog HERE would be app-modal, would block the loop, and
    // would not be drawn anyway — the exact hang #1034 is about. The message has already gone to
    // the console and the log file; terminate now rather than pretending.
    finish();
    return;
  }

  try {
    void deps
      .showMessageBox(parent, { type: 'error', title: opts.title, message: opts.message, detail: opts.detail, buttons: ['OK'] })
      .then(finish, finish); // a REJECTED dialog must terminate too, not leave the timer as the only path
  } catch {
    // Synchronous throw — the old code caught this and carried on to its exit. The timer already
    // covers us, but there is no reason to wait it out.
    finish();
  }
}
