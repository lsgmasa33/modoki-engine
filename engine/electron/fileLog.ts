/**
 * Persistent main-process log file (both macOS AND Windows).
 *
 * The packaged editor has no terminal attached — a macOS .app launched from Finder
 * and a Windows GUI .exe both send `console.log/error` into the void. So when the
 * editor fails on a user's machine (esp. the class that ends in `app.quit()`), there
 * was previously NO record of why. This tees every console call to a real file in the
 * per-app writable dir so a user can send us the log, and a crash leaves a trail.
 *
 *   macOS:   ~/Library/Application Support/<AppName>/logs/main.log
 *   Windows: %APPDATA%\<AppName>\logs\main.log
 *
 * `app.getPath('userData')` resolves both without a ready-wait, so init can run at the
 * very top of main. Best-effort throughout: a logging failure must NEVER break the
 * editor, so every fs op is guarded and we always still call the original console.
 */

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let stream: fs.WriteStream | null = null;
let logFilePath = '';

/** Absolute path of the active log file (empty until initFileLog runs). */
export function getLogFilePath(): string {
  return logFilePath;
}

/**
 * Append a line to the log file only (does NOT echo to the main-process console) —
 * used to persist the RENDERER's console-message events, which already show in the
 * renderer's own devtools; we just want them in main.log too so a user can send ONE
 * file. No-op until initFileLog has run.
 */
export function logToFile(level: string, message: string): void {
  try { stream?.write(fmt(level, [message])); } catch { /* best-effort */ }
}

function fmt(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  return `${ts} [${level}] ${body}\n`;
}

/** Whether the once-per-process "(Use `… --trace-…`)" hint has been printed, matching Node. */
let warningHintShown = false;

/** Reproduce what Node's own default handler prints. Every rule here is MEASURED on node 24.18.0 —
 *  and an earlier version of this function got FOUR of them wrong, each in the direction of quietly
 *  losing something a reader of `main.log` needs (all four found by close-out review):
 *
 *    plain             `(node:5200) [DEP9999] DeprecationWarning: a`, and `(node:5200) Warning: x`
 *                      with no code and the bare name `Warning`
 *    `detail`          appended on its OWN line — public `emitWarning` API, and it was silently
 *                      DROPPED, so a dependency's warning lost its explanatory half
 *    detail + tracing  ALSO printed, AFTER the stack frames. ⚠️ This line first said "not printed",
 *                      from a probe that piped Node through `head -5` — the frames filled those
 *                      five lines and the detail, which comes last, was cut off. A truncated probe
 *                      recorded as a measurement, in the same commit that fixed that class
 *                      elsewhere. Re-measured on 24 untruncated, and confirmed independently on 26.
 *    tracing           Node prints `prefix + warning.stack`, and a stack already opens with
 *                      "Name: message" — so slicing its first line DUPLICATES a multi-line message:
 *                        Node   …DeprecationWarning: line1 / line2 /     at …
 *                        ours   …DeprecationWarning: line1 / line2 / line2 /     at …
 *    hint              once per PROCESS, across name AND code. Measured in one process, in order:
 *                      `[DEP9999]` printed it; a second `[DEP9999]` did not; `[DEP8888]` did not; a
 *                      bare `Warning` did not; a `CustomWarning` did not. Hence one boolean, not a
 *                      keyed `Set`. ⚠️ And a TRACED warning does NOT consume it — measured, a traced
 *                      deprecation first still left the hint for the next warning — which is why the
 *                      tracing branch returns ABOVE the flag rather than through it.
 *
 *  The hint and `detail` are further lines inside the SAME string, which is why `fmt` timestamps
 *  only the first — the unprefixed continuation lines in `main.log` are Node's shape, not a bug.
 *
 *  ⚠️ **NOT byte-exact in one place, deliberately, and an earlier docblock claimed it was.** Node
 *  hardcodes `node` in the hint; this uses `path.basename(process.execPath)`, so Windows renders
 *  `node.exe` and the packaged editor renders `Modoki Editor.exe`. That is better advice for
 *  someone holding OUR log than a literal `node`, so the behaviour stays and the claim goes. */
function formatWarning(w: Error & { code?: string; detail?: unknown }): string {
  const prefix = `(node:${process.pid}) ${w.code ? `[${w.code}] ` : ''}`;

  // Node's real condition: `traceProcessWarnings || (isDeprecation && traceDeprecation)`.
  // ⚠️ An earlier version made these EXCLUSIVE, so `--trace-warnings` on a deprecation printed the
  // hint — and advised a different flag — where Node prints the stack. It also sniffed
  // `process.argv` for the flag, under a comment claiming it "is exposed NOWHERE". It is:
  // `process.traceProcessWarnings` is what Node's own handler reads (measured: `true` under the
  // flag, `undefined` without), and it is what this reads now. Losing the argv sniff also closes a
  // real hole — in the Electron main process `process.argv` carries launch arguments, so a project
  // path containing the literal `--trace-warnings` would have switched stacks on.
  const tracing = process.traceProcessWarnings
    || (w.name === 'DeprecationWarning' && process.traceDeprecation);
  // Node prints `prefix + warning.stack`, and a stack ALREADY opens with "Name: message" — so it
  // needs no head of our own.
  const traced = Boolean(tracing && w.stack);
  let out = traced ? prefix + w.stack : `${prefix}${w.name}: ${w.message}`;

  // `detail` is appended in BOTH branches — after the message normally, after the STACK FRAMES when
  // tracing. ⚠️ An earlier version returned early above and dropped it while tracing, on the
  // strength of a probe that piped Node's output through `head -5`: the frames filled those five
  // lines and the detail line, which comes last, was cut off. I recorded the truncation as a
  // measurement. Cross-checked since on node 24 (full output) and independently on node 26.
  if (typeof w.detail === 'string' && w.detail) out += `\n${w.detail}`;

  // A traced warning does NOT consume the once-per-process hint (measured), so return before the
  // flag rather than through it.
  if (traced) return out;
  if (warningHintShown) return out;
  warningHintShown = true;
  const flag = w.name === 'DeprecationWarning' ? '--trace-deprecation' : '--trace-warnings';
  return `${out}\n(Use \`${path.basename(process.execPath)} ${flag} ...\` to show where the warning was created)`;
}

/**
 * Take over Node's `'warning'` handling so a process warning is logged at `[warn]`, not `[error]`.
 *
 * **The defect (#955).** Node's default `'warning'` listener — an internal function literally named
 * `onWarning` — routes through `console.error`. By the time it fires, `console.error` is the tee
 * above, so EVERY process warning lands in `main.log` tagged `[error]`. On packaged Windows that is
 * one guaranteed `[error]` per launch (DEP0190, from the `shell: true` that `toolchain/index.ts:380`
 * documents as load-bearing against `spawn EINVAL`), and `QA-PKG-0001` step 8 tells its runner to
 * read that log for failures. The honest failure mode is a runner filing a bug against a healthy
 * build — or learning to ignore `[error]` there, which is the assertion going quiet.
 *
 * ⚠️ **The mechanism is ALL warnings, not DEP0190.** Filtering that one id at the logger would leave
 * the class open and the next deprecation Node adds re-files the ticket. `shell: true` itself is not
 * touched — removing it is the fix that keeps being re-litigated and it breaks Windows.
 *
 * **The RENDERER channel already gets this right, which is the sharpest statement of the scope.**
 * A tag census of a real 1.3 MB packaged macOS `main.log`: 1322 `[renderer:info]`, 59 `[info]`,
 * 19 `[renderer:debug]`, 6 `[error]`, 4 `[renderer:error]`, **3 `[renderer:warning]`** (three.js
 * multiple-instances, a Capacitor double-registration, a shader falling back). So a warning
 * arriving through `main.ts`'s `console-message` handler is tagged `warning` correctly, because
 * that path reads Electron's own level. The collapse this fixes is specific to the MAIN-process
 * `console.error` seam — which makes it the outlier rather than the norm, and is a positive
 * argument for the fix rather than merely an absence of counter-evidence.
 *
 * **And macOS carries no second instance — measured, not assumed.** 0 DEP0190 lines in that log,
 * and all 10 error-tagged lines are genuine: 6 `[error]` (`CHILD PROCESS GONE` for the
 * GPU / NetworkService / AudioService plus their paired forensic snapshots) and 4
 * `[renderer:error]` (a `registerSystems()` failure, unrelated to this). So on macOS the change is
 * all cost and no benefit, and it is still unconditional: the mechanism is platform-independent and
 * only the `shell: true` that triggers it is Windows-only.
 *
 * ⚠️ That count was FIRST REPORTED AS 6, from a plain `grep '\[error\]'` — which does not match
 * `[renderer:error]`. Recorded because it is the same instrument-not-the-log mistake that the QA
 * case now warns its runner about, committed while measuring evidence FOR this fix.
 *
 * ⚠️ **The `onWarning` name match survives a Node MAJOR bump** — the suite below passes on node
 * v26.0.0, and its adoption case can only pass if the name was found. That is reassurance, not a
 * guarantee: CI and the packaged editor run node 24, so a 24-only behaviour would not show up in a
 * v26 green. The loud-refusal path exists for the version where the name finally changes.
 *
 * Three measured behaviours this must not break, each of which a naive
 * `removeAllListeners('warning')` + `process.on('warning')` gets WRONG:
 *
 *  - **`--no-warnings` installs NO listener at all** (measured: `listenerCount` 0, where it is 1
 *    normally). Adding ours unconditionally would RE-ENABLE the warnings that flag exists to
 *    suppress. So an empty listener set means leave it empty.
 *  - **`--trace-deprecation` prints the stack instead of the hint** — and that formatting was the
 *    default handler's job, so replacing it without re-implementing the branch turns the flag off.
 *    `formatWarning` carries it.
 *
 * ⚠️ **`--no-deprecation` needs NOTHING from us, and an earlier version of this comment said the
 * opposite.** It claimed the suppression "lives INSIDE the handler", so a replacement had to
 * re-implement it, and the listener duly carried an `if (process.noDeprecation) return`. Both were
 * wrong. That was inferred from `listenerCount` still being 1 under the flag, which shows only that
 * a listener EXISTS — not that it is where the suppression happens. Measured properly, with our own
 * listener substituted for Node's:
 *
 *     process.noDeprecation = true   -> our listener reached: 0
 *     process.noDeprecation = false  -> our listener reached: 1
 *
 * `emitWarning` itself drops the warning before any listener runs. The guard was dead code, and it
 * is gone. Caught by a mutation check: deleting it left the suite green.
 *
 * ⚠️ **`--throw-deprecation` is the fourth of that family and is SAFE — measured, not assumed.**
 * The worry is real and worth stating: if it were honoured inside the default handler, replacing
 * that handler would turn a deprecation that should CRASH the process into a log line, which is the
 * worst direction this change could fail in. It is not. `process.emitWarning` throws before any
 * listener runs — measured both ways on node 24.18.0, with Node's handler in place and with ours
 * substituted, and the process died with `DeprecationWarning`/`DEP7777` identically. So this
 * listener is never reached under that flag and cannot swallow it.
 *
 * ⚠️ **And we remove only the listener we can identify as Node's**, rather than everything on the
 * event. If Node ever renames `onWarning`, the name match stops matching — and the failure must not
 * be "adopt anyway and drop a listener somebody else owns", nor "install ours alongside Node's and
 * log every warning twice". It is: change nothing, and SAY SO in the log, because a silent no-op
 * here reads exactly like a working fix (the log simply keeps saying `[error]`, which is what it
 * said before).
 */
function adoptProcessWarnings(): void {
  const all = process.listeners('warning');
  if (all.length === 0) return; // --no-warnings: Node installed none. Leave it that way.

  const nodeDefaults = all.filter((l) => l.name === 'onWarning');
  if (nodeDefaults.length !== all.length) {
    try {
      stream?.write(fmt('warn', [
        '[modoki-electron] leaving process warnings on Node\'s handler: expected only Node\'s own '
        + `"onWarning" on the 'warning' event, found [${all.map((l) => l.name || '(anonymous)').join(', ')}]. `
        + 'Warnings will keep being logged at [error] (#955).',
      ]));
    } catch { /* best-effort */ }
    return;
  }

  // ⚠️ Surgical rather than `removeAllListeners('warning')`, whose blast radius would be a function
  // of import order — the least stable thing in the process. Note the honest limit: under the guard
  // above, every listener present IS an `onWarning`, so the two forms are EQUIVALENT here and a
  // mutation swapping them stays green. What actually protects a foreign listener is the refusal
  // above, not this loop; the loop is belt-and-braces for a future where the guard is relaxed.
  for (const l of nodeDefaults) process.removeListener('warning', l);
  // No `noDeprecation` check: `emitWarning` already drops those before any listener runs (measured
  // — see the docblock). A guard here would be dead code.
  process.on('warning', (w: unknown) => {
    // ⚠️ Node's `onWarning` OPENS with `if (!(warning instanceof Error)) return;` and this dropped
    // it. Anything can `process.emit('warning', <anything>)`, and without the guard the damage is
    // threefold: `process.emit('warning', 'a string')` writes `(node:N) undefined: undefined` into
    // `main.log` where Node writes nothing; it BURNS the once-per-process hint, so the next real
    // warning loses it; and `process.emit('warning')` or `…, null` throws a TypeError out of a
    // `nextTick`, which the `uncaughtException` handler below then swallows into a `[fatal]` line
    // the editor runs past. Measured: Node prints nothing for both non-Error cases.
    if (w instanceof Error) console.warn(formatWarning(w));
  });
}

/**
 * Redirect console.{log,info,warn,error} to ALSO append to a log file. Idempotent
 * (a second call is a no-op). Rotates once at startup when the file exceeds ~5 MB
 * (main.log → main.prev.log) so it can't grow unbounded across launches.
 */
export function initFileLog(): string {
  if (stream) return logFilePath;
  let dir: string;
  try {
    dir = path.join(app.getPath('userData'), 'logs');
  } catch {
    dir = path.join(os.tmpdir(), 'modoki-logs'); // pre-app fallback, never /tmp-hardcoded
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'main.log');
    // One-shot rotation so the file can't grow without bound.
    try {
      if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
        fs.renameSync(logFilePath, path.join(dir, 'main.prev.log'));
      }
    } catch { /* rotation is best-effort */ }
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    stream.on('error', () => { stream = null; }); // stop teeing if the FD dies; console still works
  } catch {
    return ''; // couldn't open a log file — leave console untouched
  }

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const tee = (level: string, fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
    fn(...args);
    try { stream?.write(fmt(level, args)); } catch { /* best-effort */ }
  };
  console.log = tee('info', orig.log);
  console.info = tee('info', orig.info);
  console.warn = tee('warn', orig.warn);
  console.error = tee('error', orig.error);

  adoptProcessWarnings();

  // Last-ditch: log an otherwise-silent hard crash before the process dies.
  process.on('uncaughtException', (e) => { try { stream?.write(fmt('fatal', ['uncaughtException', e])); } catch { /* noop */ } });
  process.on('unhandledRejection', (e) => { try { stream?.write(fmt('fatal', ['unhandledRejection', e])); } catch { /* noop */ } });

  orig.log(`[modoki-electron] logging to ${logFilePath}`);
  return logFilePath;
}
