/**
 * The FIRST thing the main process evaluates — a last-ditch crash sink for the window in which
 * nothing else can report anything (#1043).
 *
 * ── The unlogged window ──────────────────────────────────────────────────────────────────────
 * `initFileLog()` installs the console tee AND the `uncaughtException` / `unhandledRejection`
 * handlers (`fileLog.ts`). It is called near the top of `main.ts` — but **ES module imports are
 * hoisted**, so the forty imports written BELOW that call (assetBackend, ../toolchain,
 * backendServer, rendererOps, ssrLoader, devServer, connectClaude, vendorPlugins, autoUpdate, the
 * eight reimport plugins, …) are fully evaluated BEFORE it runs. So is `setUserDataDir()`.
 *
 * A throw anywhere in that window produced **nothing at all**: no stdout (a macOS Finder-launch
 * and any Windows GUI launch have no attached terminal) and no `logs/main.log`, because the file
 * that would hold it had not been opened and no handler existed to write to it. The one artifact
 * a user could send is the one thing that did not exist.
 *
 * That is not hypothetical: it is exactly how #1035 presented. Reading the actual exception
 * required extracting `app.asar`, renaming it so the extracted tree won, and prepending an
 * `uncaughtException` recorder to `main.cjs` by hand.
 *
 * ── Why a SINK and not a buffer ──────────────────────────────────────────────────────────────
 * ⚠️ The obvious alternative — buffer early output and flush it once `initFileLog()` opens the
 * real log — is the shape this repo has already retired **three times**. #861 named the class:
 * *"a buffer whose only delivery path sits behind the boot that fills it"*, with #859 (the #633
 * early-console ring stranded on a boot that dies) and #825 (a boot dying at module evaluation
 * reports nothing, because both the drain and the Crashlytics sink sit behind it) as instances.
 * A boot that dies during module evaluation never reaches the flush, so the buffer dies with the
 * process holding the only copy of why. This writes through on the spot instead.
 *
 * ── Why tmpdir ───────────────────────────────────────────────────────────────────────────────
 * The real log lives under `app.getPath('userData')`, and WHICH userData is itself decided inside
 * the unlogged window (`main.ts` §"userData MUST be decided FIRST"). Reading it here would both
 * fail to be available and re-break the thing that comment exists to protect — Electron caches
 * userData on first read, and an early reader once silently relocated the shipped editor's entire
 * profile for weeks. `os.tmpdir()` needs no decision, which is the whole point; it is the same
 * fallback `initFileLog` already carries for the pre-app case.
 *
 * ── Ordering: measured, not assumed ──────────────────────────────────────────────────────────
 * ⚠️ This module only works if it is the FIRST import in `main.ts`, and what ships is not ESM —
 * it is a bundled CJS `main.cjs` (esbuild, `format: 'cjs'`, `packages: 'external'`). Measured on
 * this repo's real build options: esbuild emits bundled modules inline **in source order**, and
 * an external `require("electron")` lands at its own source position rather than being hoisted
 * above them. A first-position import therefore runs before every other module AND before
 * electron itself is required. `crashSinkOrder.test.ts` pins both halves.
 *
 * ⚠️ Nothing here may import anything but node builtins, and nothing may throw at module scope.
 * A sink that dies while being installed is worse than none: it turns a diagnosable failure into
 * this same silence one line earlier.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where an early crash is recorded. Deliberately NOT under userData — see the header. */
export const earlyCrashLogPath = path.join(os.tmpdir(), 'modoki-logs', 'early-crash.log');


/** Best-effort, synchronous, and silent on failure. `appendFileSync` with `mkdirSync` ahead of it
 *  is the most that can be relied on while the process is dying — an async write would not finish.
 *  ⚠️ Every failure is swallowed on purpose: this runs INSIDE a crash handler, and a throw here
 *  replaces the crash the user needs to see with one from the thing trying to report it. */
export function recordEarlyCrash(kind: string, err: unknown, now: () => Date = () => new Date()): void {
  try {
    const detail = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
    // ⚠️ 0700 buys CONFIDENTIALITY only, and it is worth being precise about that: `os.tmpdir()`
    // is per-user on macOS and Windows but SHARED on Linux, so the default 0755 would make one
    // user's stack traces — which carry $HOME paths — readable by everyone on the box. It does NOT
    // fix availability: a second user still cannot write here, they just get EACCES on traverse
    // instead of on the file, silently either way since this swallows everything. A per-uid path
    // would fix both; it is not worth it while no linux target ships (dev boxes + the ubuntu CI
    // leg only). ⚠️ `mode` is also ignored when the dir already exists, and `fileLog.ts`'s pre-app
    // fallback creates this SAME path with no mode — so whichever runs first wins.
    fs.mkdirSync(path.dirname(earlyCrashLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      earlyCrashLogPath,
      `${now().toISOString()} [${kind}] pid=${process.pid} ${process.execPath}\n${detail}\n\n`,
    );
  } catch { /* a reporter that throws is worse than a reporter that is silent */ }
}

/**
 * Install the handlers. Idempotent, and returns whether it did anything so a caller can say so.
 *
 * ⚠️ These are ADDITIONAL listeners, not replacements. `initFileLog` registers its own once the
 * real log exists; Node runs every registered listener, so a late crash is recorded in both
 * places and an early one only here. That redundancy is deliberate — the alternative is a
 * handover between two sinks, and a handover is a thing that can be missed.
 *
 * ⚠️ Installing an `uncaughtException` listener SUPPRESSES Node's default termination, and this
 * one covers a window that previously had no listener at all — so under bare `node` a boot that
 * used to exit 1 now exits 0. **Measured, and accepted.** Nothing runs `main.cjs` under plain
 * node; under ELECTRON the outcome is identical with and without this module, because Electron's
 * own loader wraps the main-module load in a try/catch and raises a native modal — the process
 * hangs either way, which is exactly the #1035 shape docs/build.md already describes. What
 * changes is only that the stack now exists on disk. `crashSinkOrder.test.ts` pins the exit code
 * so the trade cannot drift unnoticed.
 *
 * ⚠️ It deliberately does NOT exit. Node's default behaviour for an uncaught exception is to
 * terminate, and adding a listener SUPPRESSES that — so this re-throws responsibility by leaving
 * the process's fate to whoever else is listening, exactly as `fileLog.ts` already does. Making
 * this one exit would change startup semantics for every failure, which is #1034's business and
 * not this module's.
 */
export function installEarlyCrashSink(): boolean {
  if (installed) return false;
  installed = true;
  process.on('uncaughtException', (e) => recordEarlyCrash('uncaughtException', e));
  process.on('unhandledRejection', (e) => recordEarlyCrash('unhandledRejection', e));
  return true;
}
let installed = false;

// Installed as a side effect of being imported: the import position IS the mechanism, and a
// module that had to be called would be one more line that can be written in the wrong place.
installEarlyCrashSink();
