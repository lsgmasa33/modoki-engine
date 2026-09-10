/** `fileLog.ts` must log a process warning at `[warn]`, not `[error]` (#955).
 *
 *  **The defect.** Node's default `'warning'` listener — an internal function named `onWarning` —
 *  routes through `console.error`. `initFileLog` has replaced `console.error` with its tee by the
 *  time it fires, so EVERY process warning is written to `main.log` tagged `[error]`. On packaged
 *  Windows that is one guaranteed `[error]` per launch (DEP0190, from the `shell: true` that
 *  `toolchain/index.ts` documents as load-bearing), and `QA-PKG-0001` step 8 tells its runner to
 *  read that log for failures.
 *
 *  ⚠️ **The bar this suite is written to: a quiet log cannot tell "warnings are handled" from
 *  "warnings are gone".** Deleting the whole `'warning'` mechanism would satisfy any assertion of
 *  the form *"no `[error]` line appears"*. So every case here is a POSITIVE control — it emits a
 *  warning and asserts the line is PRESENT at the right level — and the absence of `[error]` is
 *  only ever checked alongside the presence of `[warn]`.
 *
 *  ⚠️ **What is real here and what is simulated.** The `'warning'` event, the listener set, the
 *  console tee and the log file are all real: this drives the actual exported `initFileLog` and
 *  asserts on bytes in a real file. Only `electron`'s `app.getPath` is mocked, which is not the
 *  mechanism under test. The FLAG behaviours cannot be set on an already-running process, so they
 *  are reproduced at the observable state the code actually branches on — an empty listener set,
 *  `process.noDeprecation`, `process.traceDeprecation` — and each such case says so. All of it was
 *  measured for real first, with the flags, on node 24.18.0 and in an electron 43.2.0 MAIN process:
 *
 *    default            listenerCount('warning') = 1, name "onWarning", reaches console.error
 *    --no-warnings      listenerCount('warning') = 0   <- no listener is installed at all
 *    --no-deprecation   listenerCount 1, nothing printed
 *    --trace-deprecation  a stack instead of the "(Use `… --trace-deprecation`)" hint
 *    --trace-warnings   sets `process.traceProcessWarnings` (true under the flag, undefined
 *                       without) and traces a DEPRECATION too — Node ORs the two conditions
 *    --throw-deprecation  throws from emitWarning, before any listener — we cannot swallow it
 *
 *  ⚠️ **One of those lines used to draw a conclusion the measurement did not support**, and it is
 *  worth keeping the correction visible because it shaped both the code and a test. From
 *  `--no-deprecation` leaving `listenerCount` at 1, this file concluded the suppression lived
 *  INSIDE the handler and that a replacement had to re-implement it. A listener EXISTING says
 *  nothing about where the suppression happens. `emitWarning` drops it before any listener runs —
 *  so the guard written for it was dead code, and the case written for it could not fail. Both
 *  fixed; see the case below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

/** The console methods and `'warning'` listeners `initFileLog` mutates are GLOBAL to this vitest
 *  worker. Captured and restored around every case, or one test's tee stays installed for the
 *  rest of the file — and for whatever else shares the worker. */
let savedConsole: Record<string, unknown>;
let savedWarningListeners: ((warning: Error) => void)[];
let savedNoDeprecation: boolean | undefined;
let savedTraceDeprecation: boolean | undefined;
let savedTraceProcessWarnings: boolean | undefined;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'filelog-'));
  savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  savedWarningListeners = process.listeners('warning') as ((warning: Error) => void)[];
  savedNoDeprecation = process.noDeprecation;
  savedTraceDeprecation = process.traceDeprecation;
  savedTraceProcessWarnings = process.traceProcessWarnings;
  vi.resetModules(); // `stream` is module-level and initFileLog is idempotent — force a fresh one.
});

afterEach(() => {
  Object.assign(console, savedConsole);
  process.removeAllListeners('warning');
  for (const l of savedWarningListeners) process.on('warning', l);
  process.noDeprecation = savedNoDeprecation as boolean;
  process.traceDeprecation = savedTraceDeprecation as boolean;
  process.traceProcessWarnings = savedTraceProcessWarnings as boolean;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

/** Emit a warning and return the log file's contents once it has been flushed. `emitWarning`
 *  delivers on the next tick, so a same-turn read would report an empty file whether the listener
 *  fired or not — the "deferred tail asserted in the same turn" trap. */
async function emitAndRead(logPath: string, ...args: [string, string?, string?]): Promise<string> {
  const before = sizeOf(logPath);
  process.emitWarning(...(args as [string, string, string]));
  return pollUntilLongerThan(logPath, before);
}

/** ⚠️ Missing counts as ZERO, not as a `-1` sentinel. With `-1`, a file that merely APPEARED — the
 *  stream's `open`, before any bytes — satisfied `size > before` and the poll returned an empty
 *  string immediately. That made the first case fail every run, and it is the same
 *  "the check passed for a reason that is not the property" shape as everything else in this file. */
function sizeOf(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Wait for THIS emit's line to flush — polling until the file is LONGER than it was before the
 *  emit, not merely non-empty.
 *
 *  ⚠️ Two wrong versions preceded this, and the second was worse than the first. A fixed 20ms sleep
 *  can be beaten by the stream `open` under AV or load. Replacing it with "poll until the file has
 *  any bytes" then made the multi-emit cases FLAKY (measured: 2 reds in 5 runs) — after the first
 *  warning the file is already non-empty, so the poll returned instantly and the case asserted on a
 *  log the second and third warnings had not reached yet. Growth is the property that actually says
 *  "my line landed". */
async function pollUntilLongerThan(logPath: string, before: number): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (sizeOf(logPath) > before) return fs.readFileSync(logPath, 'utf8');
    await new Promise((r) => setTimeout(r, 10));
  }
  return fs.readFileSync(logPath, 'utf8'); // deadline: let the assertion report the real content
}

/** For the case that expects NO output: there is no growth to wait for, so drain the tick queue and
 *  give the stream a moment. Waiting for growth here would just burn the whole deadline. */
async function drain(logPath: string): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
  }
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
}

describe('fileLog: process warnings are [warn], not [error] (#955)', () => {
  it('logs a deprecation at [warn], with Node own text — and NOT at [error]', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();
    expect(logPath).not.toBe('');

    const body = await emitAndRead(logPath, 'synthetic body', 'DeprecationWarning', 'DEP9999');

    // POSITIVE control first: the warning still reaches the log at all. Without this line every
    // other assertion here is satisfied by deleting the warning mechanism outright.
    expect(body).toContain('DEP9999');
    expect(body).toMatch(/\[warn\] \(node:\d+\) \[DEP9999\] DeprecationWarning: synthetic body/);
    // The defect itself.
    expect(body).not.toMatch(/\[error\].*DEP9999/);
  });

  /** #1043's signpost must reach the LOG FILE, not just stdout.
   *
   *  ⚠️ This is the whole point of the line, and an earlier version got it exactly backwards. It
   *  used `orig.log` — the console method captured BEFORE the tee is installed — which writes to
   *  stdout only. A Finder-launched `.app` and any Windows GUI launch have no terminal, which is
   *  the entire premise of #1043; a signpost that exists only on a stream nobody can read points
   *  at the early-crash file for precisely nobody. The fix was green when deleted until this case
   *  existed, because nothing else reads for it. */
  it('names the early-crash file INSIDE main.log, not only on stdout (#1043)', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const { earlyCrashLogPath } = await import('../../electron/crashSink');
    const logPath = initFileLog();
    expect(logPath).not.toBe('');

    // The tee's write is async — poll for it, exactly as the warning cases do.
    const body = await pollUntilLongerThan(logPath, 0);
    expect(body, 'the #1043 signpost is missing from main.log entirely').toContain('#1043');
    expect(
      body,
      'main.log must name the actual early-crash path — a reader holding one file finds the other',
    ).toContain(earlyCrashLogPath);
  });

  it('adopts the event: Node own onWarning is GONE and exactly one listener remains', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    initFileLog();

    const after = process.listeners('warning');
    // Two mistakes this pins at once. Leaving Node's listener in place alongside ours logs every
    // warning TWICE (once [error], once [warn]) — the defect surviving next to its own fix. And a
    // count above 1 means the adoption ran more than once.
    expect(after).toHaveLength(1);
    expect(after.map((l) => l.name)).not.toContain('onWarning');
  });

  /** ⚠️ **This case does NOT cover any of our code, and says so rather than looking like it does.**
   *  It was written believing the suppression lived inside Node's handler, so a replacement had to
   *  re-implement it — and the listener carried a `process.noDeprecation` guard accordingly. A
   *  mutation check killed that: deleting the guard left this case GREEN. Measured properly,
   *  `emitWarning` drops the warning before any listener runs, so the guard was dead code and is
   *  gone. What survives here is a genuine end-to-end assertion — that adopting the event does not
   *  BREAK `--no-deprecation` — which is worth keeping and is not the same claim. */
  it('does not break --no-deprecation (Node suppresses at emitWarning, before any listener)', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();
    process.noDeprecation = true;

    const body = await emitAndRead(logPath, 'suppressed body', 'DeprecationWarning', 'DEP9998');
    expect(body).not.toContain('DEP9998');

    // ⚠️ POSITIVE control for the suppression itself: without this the case passes on a listener
    // that drops EVERYTHING, which is the same fix-by-deletion this file exists to rule out.
    process.noDeprecation = false;
    const after = await emitAndRead(logPath, 'not suppressed', 'DeprecationWarning', 'DEP9997');
    expect(after).toContain('DEP9997');
  });

  it('a NON-deprecation warning is logged too — the mechanism is all warnings, not DEP0190', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    // The reason #955's option 2 (filter DEP0190 at the logger) was rejected: the next thing Node
    // deprecates arrives by the same route. A fix keyed to one id would leave this red.
    const body = await emitAndRead(logPath, 'plain body');
    expect(body).toMatch(/\[warn\] \(node:\d+\) Warning: plain body/);
    expect(body).not.toMatch(/\[error\].*plain body/);
  });

  it('honours --trace-deprecation: the stack, not the hint — this one IS our formatting', async () => {
    // Unlike --no-deprecation, this branch really is ours: Node's default handler chose between a
    // stack and the "(Use `… --trace-deprecation`)" hint, and we replaced that handler. Simulated
    // via `process.traceDeprecation`, the public boolean the flag sets and the branch reads.
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    const plain = await emitAndRead(logPath, 'untraced', 'DeprecationWarning', 'DEP9995');
    expect(plain).toContain('to show where the warning was created');
    expect(plain).not.toMatch(/DEP9995[\s\S]*\n\s+at /);

    process.traceDeprecation = true;
    try {
      const traced = await emitAndRead(logPath, 'traced', 'DeprecationWarning', 'DEP9994');
      // A stack frame follows the head line, and the hint does NOT reappear for this one.
      expect(traced).toMatch(/\[DEP9994\] DeprecationWarning: traced\n\s+at /);
    } finally {
      process.traceDeprecation = false;
    }
  });

  /** Close-out review found `if (warningHintShown) return out` had NO case that could fail —
   *  deleting it, so the hint prints on every warning, left the whole suite green. No case emitted
   *  two hint-eligible warnings: one suppressed its first, another traced it. */
  it('prints the "(Use ...)" hint ONCE per process, across a change of code AND of name', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    await emitAndRead(logPath, 'first', 'DeprecationWarning', 'DEP9993');
    await emitAndRead(logPath, 'second', 'DeprecationWarning', 'DEP9992'); // different CODE
    const body = await emitAndRead(logPath, 'third');                      // different NAME

    // All three arrived — the positive control, so "once" cannot be satisfied by dropping two.
    for (const c of ['DEP9993', 'DEP9992', 'Warning: third']) expect(body).toContain(c);
    const hints = body.match(/to show where the warning was created/g) ?? [];
    expect(hints).toHaveLength(1);
  });

  /** Also uncovered until close-out review: the tracing branch was reachable only through
   *  `traceDeprecation`, so nothing constrained the `traceProcessWarnings` half in either
   *  direction — and that half was WRONG (exclusive with the deprecation one, where Node ORs them,
   *  and sniffed from `process.argv`). */
  it('honours --trace-warnings for a NON-deprecation, and for a deprecation too (Node ORs them)', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    process.traceProcessWarnings = true;
    try {
      const plain = await emitAndRead(logPath, 'traced plain');
      expect(plain).toMatch(/Warning: traced plain\n\s+at /);

      // ⚠️ The half that was inverted: with --trace-warnings and NOT --trace-deprecation, Node
      // still prints a stack for a deprecation. The old ternary printed the hint instead, and
      // advised a flag the user had not been asked for.
      const dep = await emitAndRead(logPath, 'traced dep', 'DeprecationWarning', 'DEP9991');
      expect(dep).toMatch(/\[DEP9991\] DeprecationWarning: traced dep\n\s+at /);
    } finally {
      process.traceProcessWarnings = false;
    }
  });

  it('keeps `detail` and does not duplicate a MULTI-LINE message when tracing', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    // `detail` is public emitWarning API and was being dropped, so a dependency's warning lost its
    // explanatory half in the one log a user can send us.
    const withDetail = await emitAndRead(
      logPath,
      // @ts-expect-error — the options-object overload, which the tuple signature above does not model
      'body', { type: 'DeprecationWarning', code: 'DEP9990', detail: 'EXTRA DETAIL LINE' },
    );
    expect(withDetail).toContain('EXTRA DETAIL LINE');

    process.traceProcessWarnings = true;
    try {
      const traced = await emitAndRead(logPath, 'line1\nline2', 'DeprecationWarning', 'DEP9989');
      // Node emits prefix + stack, and the stack ALREADY opens with "Name: message". Slicing its
      // first line printed `line2` twice. One occurrence, not two.
      expect(traced.match(/line2/g) ?? []).toHaveLength(1);

      // ⚠️ And `detail` survives HERE too, after the frames. The first version returned early in
      // this branch and dropped it — on a probe truncated by `head -5`, which cut the detail line
      // off because it comes last. Nothing pinned the tracing branch, so the omission was invisible.
      const tracedDetail = await emitAndRead(
        logPath,
        // @ts-expect-error — the options-object overload, which the tuple signature does not model
        'traced body', { type: 'DeprecationWarning', code: 'DEP9987', detail: 'TRACED DETAIL LINE' },
      );
      expect(tracedDetail).toContain('TRACED DETAIL LINE');
      expect(tracedDetail).toMatch(/DEP9987[\s\S]*\n\s+at [\s\S]*TRACED DETAIL LINE/); // after the frames
    } finally {
      process.traceProcessWarnings = false;
    }
  });

  it('ignores a NON-Error warning, exactly as Node does — and does not burn the hint on it', async () => {
    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    // Node's onWarning opens with `if (!(warning instanceof Error)) return`. Without it this wrote
    // `(node:N) undefined: undefined` and consumed the once-per-process hint.
    process.emit('warning', 'just a string' as unknown as Error);
    process.emit('warning', { name: 'X' } as unknown as Error);
    await drain(logPath);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('undefined: undefined');

    // The hint survived for the first REAL warning — the half that makes this more than a filter.
    const body = await emitAndRead(logPath, 'real one', 'DeprecationWarning', 'DEP9988');
    expect(body).toContain('to show where the warning was created');
  });

  it('installs NOTHING when Node installed nothing — the --no-warnings case', async () => {
    // Simulated at the state the code branches on: `--no-warnings` makes Node install no listener
    // at all (measured: listenerCount 0, where it is 1 normally). Adding ours unconditionally would
    // RE-ENABLE the warnings that flag exists to suppress, which is a regression the naive
    // `removeAllListeners()` + `on()` shape ships silently.
    process.removeAllListeners('warning');

    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    expect(process.listenerCount('warning')).toBe(0);
    const body = await emitAndRead(logPath, 'should not appear', 'DeprecationWarning', 'DEP9996');
    expect(body).not.toContain('DEP9996');
  });

  it('refuses to adopt when a FOREIGN listener is present, and says so in the log', async () => {
    const foreign = function myOwnHandler() { /* someone else owns this event */ };
    process.on('warning', foreign);

    const { initFileLog } = await import('../../electron/fileLog');
    const logPath = initFileLog();

    // Node's own listener is untouched, so warnings keep working the way that process expects.
    expect(process.listeners('warning')).toContain(foreign);
    expect(process.listeners('warning').map((l) => l.name)).toContain('onWarning');

    // ⚠️ The load-bearing half. A silent no-op here is indistinguishable from a working fix — the
    // log just keeps saying `[error]`, exactly as it did before — so the refusal must be VISIBLE.
    // The write stream is async, so this waits rather than reading in the same turn — a same-turn
    // read reports ENOENT whether the line was written or not.
    const body = await drain(logPath);
    expect(body).toContain('leaving process warnings on Node');
    expect(body).toContain('myOwnHandler');
  });
});
