/**
 * The ONE place a main-process native dialog gets its parent window (#1044).
 *
 * ── The mechanism ────────────────────────────────────────────────────────────────────────────
 * On macOS, `dialog.showMessageBox(options)` **with no parent window** is APP-MODAL: it runs a
 * nested native modal loop on the main thread even though it returns a Promise. The main process
 * is single-threaded, so for as long as that box is up **nothing else in it runs** — no timers, no
 * IPC, no backend HTTP handling. Measured on the #1034 startup path, where an armed 10-second
 * `setTimeout` never fired for 4m51s:
 *
 *     -[NSAlert runModal] → _NSTryRunModal → -[NSApplication _doModalLoop:peek:]
 *       → _DPSNextEvent → _BlockUntilNextEventMatchingListInMode
 *
 * With a parent it is a SHEET: genuinely async, and the loop keeps running.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 * `autoUpdate.ts` already had the right helper — a `show()` that parents to a real visible
 * non-splash window — and **three sites in that same file bypassed it**, passing no parent
 * UNCONDITIONALLY rather than "when there is no window". So they took the app-modal path with a
 * perfectly good editor window open: the ORDINARY case, not an edge one. **Those three are the
 * whole behavioural surface of the fix.**
 *
 * ⚠️ The other eight sites are routed for UNIFORMITY, not for effect, and saying otherwise
 * overstates the blast radius. Six already parented whenever a window existed and only fell back
 * to parentless on a null `mainWindow`. The two in `main.ts`'s first-run picker
 * (`resolveInitialProject`) run at `whenReady` BEFORE `showSplash()` and `createWindow()`, so
 * there is provably no window to parent to and they stay app-modal either way — which is fine
 * there, because nothing else is running yet to be starved. Centralising is what stops a twelfth
 * site being added parentless.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────────────────────
 * ⚠️ **When there is no window it still shows the box, parentless.** That is the considered
 * answer, not an oversight. The alternative — skip the dialog and write to the log instead —
 * re-creates the defect #1032 spent a whole issue removing: a user-visible outcome reported
 * somewhere the user never looks. A packaged editor's `main.log` is not a UI. Blocking the loop
 * while a message the user must dismiss is on screen is a stall; showing them nothing is a lie.
 *
 * The ONE caller that must not take that trade is `fatalDialog.ts`, which is on a path that must
 * TERMINATE — a blocked loop kills the timer that does the terminating. It keeps its own
 * "no parent ⇒ show nothing, exit now" rule.
 *
 * ⚠️ **But it is NOT independent of this module, and reading it as such is the trap.** main.ts
 * wires both of its injected deps through here: its parent probe is
 * `resolveDialogParent('anyWindow')` and its show is `showMessageBox(o, parent)`. What
 * `fatalDialog` keeps is the DECISION (it returns early on a null parent, so this module's
 * "resolve one anyway" branch is unreachable from there) — not the plumbing. So a change to the
 * default policy here, or anything that makes these functions retry or queue, is inherited by
 * the terminate path silently. See its header, and docs/build.md § #1034.
 */

import { BrowserWindow, dialog } from 'electron';
import { isSplashWindow } from './splash';

/**
 * Which window may be used as a parent. The two rules are genuinely different and BOTH are
 * correct — the caller says which it needs:
 *
 *  - `visibleNonSplash` — needs the user's ANSWER. ⚠️ Never the splash: at launch
 *    `getAllWindows()[0]` IS the splash (main shows it, creates the editor window *hidden*, then
 *    wires auto-update), and `closeSplash()` destroys it the instant the renderer mounts, taking
 *    an open sheet down with it UNANSWERED. A feed round-trip beats a React mount often enough
 *    that this is the normal case, not a race. Also never the still-hidden editor window.
 *  - `anyWindow` — only needs "not app-modal". The splash counts, because the caller terminates
 *    on its own timer either way and an unanswered sheet costs it nothing.
 */
export type DialogParentPolicy = 'visibleNonSplash' | 'anyWindow';

/**
 * The window to parent a dialog to under `policy`, or null when there is none.
 *
 * ⚠️ Every candidate is filtered on `isDestroyed()` FIRST. `show()` in `autoUpdate.ts` did not,
 * and `isVisible()` throws on a destroyed window — so a window torn down between
 * `getAllWindows()` and the probe turned a dialog into an exception. Order matters here.
 *
 * `liveParent` below applies the same liveness rule to an EXPLICITLY passed window, which this
 * function never sees.
 */
export function resolveDialogParent(policy: DialogParentPolicy): BrowserWindow | null {
  // Read per call, never hoisted to module scope: the window set changes under us constantly.
  const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (policy === 'anyWindow') return live[0] ?? null;
  return live.find((w) => !isSplashWindow(w) && w.isVisible()) ?? null;
}

/**
 * An explicitly-supplied parent, but only if it is still alive.
 *
 * ⚠️ **A caller's own window handle is not a guarantee.** `main.ts` nulls `mainWindow` on the
 * window's `'closed'` event, and `close` → `closed` is not instantaneous: `win.destroy()` flips
 * `isDestroyed()` before `closed` dispatches, so there is a window in which `mainWindow` is
 * non-null AND destroyed. Handing that to `dialog.showMessageBox` throws
 * `Object has been destroyed` — which `healConnectedMcp` swallows in its outer catch (the user
 * gets no dialog at all, the #1032 shape) and which escapes `setProject` entirely, skipping its
 * `return` and leaving the project half-swapped. Falling back to the resolver is strictly better
 * than either.
 */
function liveParent(parent: BrowserWindow | null | undefined): BrowserWindow | null {
  if (!parent) return null;
  try { return parent.isDestroyed() ? null : parent; } catch { return null; }
}

/**
 * Show a message box parented to a real window when one is available, and free-floating only
 * when there is genuinely none.
 *
 * `parent` is an OPTIONAL explicit override for a caller that already holds the window it means
 * (main's `mainWindow`); it wins over `policy`. A null/absent one resolves through `policy` —
 * which is the half that matters, because the old call sites spelled that fallback
 * `: dialog.showMessageBox(opts)` and went parentless instead of looking for another window. **Every main-process message box goes through here** —
 * `engine/tests/electron/mainDialog.test.ts` fails the build if any other module under
 * `engine/electron/**` so much as IMPORTS `dialog` from `'electron'`.
 */
export function showMessageBox(
  opts: Electron.MessageBoxOptions,
  parent?: BrowserWindow | null,
  policy: DialogParentPolicy = 'visibleNonSplash',
): Promise<Electron.MessageBoxReturnValue> {
  const win = liveParent(parent) ?? resolveDialogParent(policy);
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

/**
 * The same rule for the folder pickers. `showOpenDialog` runs the identical nested modal loop
 * when parentless, so the two `projects.ts` pickers belong to this class even though #1044's
 * title names `showMessageBox`.
 */
export function showOpenDialog(
  opts: Electron.OpenDialogOptions,
  parent?: BrowserWindow | null,
  policy: DialogParentPolicy = 'visibleNonSplash',
): Promise<Electron.OpenDialogReturnValue> {
  const win = liveParent(parent) ?? resolveDialogParent(policy);
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}
