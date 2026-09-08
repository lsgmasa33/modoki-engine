/** Guard: a FAILED launch must not exit 0 (#68).
 *
 *  `main.ts` defers quitting — `before-quit` preventDefaults once, awaits a bounded
 *  teardown (E4), then exits for real. That single exit is the only one most startup
 *  paths reach, so whatever it passes becomes the exit code for BOTH a clean user quit
 *  and a hard startup failure. It used to pass a literal `0`.
 *
 *  The cost of that was not theoretical. When `startDevServer()` failed, the app showed a
 *  dialog, called `app.quit()`, and exited **0**. `assert-app-csp.mjs` reported it as
 *  "app exited early (code 0)", and #68 reasonably concluded "exit code 0 is a clean quit,
 *  not a crash" and went looking for a teardown race — because the exit code was lying.
 *  An untrue exit code does not just lose information, it aims the investigation at the
 *  wrong thing.
 *
 *  This is a source guard rather than a unit test because the quit path lives in the
 *  Electron entry point, which has no harness here (the tests in this directory cover
 *  EXTRACTED modules — backendPort, devServer, userDataDir…). Extracting a one-variable
 *  lifecycle detail purely to test it would be worse than grepping for it. Same shape as
 *  reapScoping.test.ts and posixPathGuard.test.ts, which guard source patterns for the
 *  same reason.
 *
 *  Deliberately NOT asserted: that every quit is non-zero. Two quits are legitimately
 *  clean — the packaged first-launch picker being cancelled (nothing to open) and
 *  window-all-closed off darwin. Only a FAILED launch must be non-zero. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const mainTs = readScannedSource(path.resolve(__dirname, '../../electron/main.ts')).code;

describe('a failed launch exits non-zero', () => {
  it('the deferred-quit teardown exits with the tracked code, not a hard-coded 0', () => {
    expect(
      mainTs,
      'the before-quit teardown must exit with `quitExitCode`. A literal `app.exit(0)` there ' +
        'makes a startup FAILURE indistinguishable from a clean quit — the #68 bug.',
    ).toContain('app.exit(quitExitCode)');
  });

  it('the dev-server startup failure declares a non-zero code', () => {
    // The failure path is: catch → showErrorBox → closeSplash → quit. Without setting the
    // code, that whole path lands on the teardown's exit and reports success.
    expect(
      mainTs,
      'the `startDevServer()` catch must set `quitExitCode = 1` before `app.quit()`, or a ' +
        'launch that could not start the editor still reports success to its caller.',
    ).toMatch(/quitExitCode = 1/);
  });
});
