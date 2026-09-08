/** Guard: a build/scaffold/publish child is aborted through `killBuildProcess`, never by
 *  signalling the spawned pid directly (#176).
 *
 *  The distinction is invisible at the call site and that is exactly why it needs a test.
 *  `activeProc?.kill('SIGTERM')` READS as "stop the build", and for a simple step it is —
 *  `bash -c` exec-replaces itself, so the signal lands on vite/xcodebuild/gradlew. But bash
 *  FORKS for a compound command, and three real steps are compound (the iOS `Installing on
 *  device...`, icon generation, the web deploy's per-extension `for` loop). There the signal
 *  kills the shell and leaves `devicectl`/`gcloud` running, orphaned, holding no build slot —
 *  free to race the retry that the freed slot admits moments later.
 *
 *  So the failure mode of regressing this is a line that looks correct, passes every unit
 *  test, and only misbehaves on a client disconnect during one of the compound steps. The
 *  three `(D6)` comments in this very file asserted the fixed behaviour for months while the
 *  code delivered the broken one — a comment cannot hold this, and a reviewer reading the
 *  diff would not see it either.
 *
 *  The mechanism itself (does a group kill actually reach the grandchild?) is proven in
 *  `engine/tests/plugins/buildStepShell.test.ts`, which spawns real processes. This guard
 *  only pins the CALL SITES to it. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const scannerPath = path.resolve(__dirname, '../../plugins/vite-asset-scanner.ts');

describe('build children are killed as a process group (#176)', () => {
  const src = readScannedSource(scannerPath).code;

  it('no abort path signals the spawned pid directly', () => {
    // Matches `activeProc.kill(`, `activeProc?.kill(`, `proc.kill(` — the pre-#176 form.
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      // Comments are excluded deliberately: the three `(D6)` blocks NAME the old
      // `proc.kill()` shape to explain why it was wrong, and a guard that forbids
      // describing a bug pressures the next author to delete the explanation.
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      .filter(({ line }) => /\b(activeProc|proc)\s*\??\.kill\s*\(/.test(line));
    expect(
      offenders.map(({ n, line }) => `${n}: ${line}`),
      'use killBuildProcess(proc) — a direct .kill() orphans a compound step\'s grandchildren',
    ).toEqual([]);
  });

  it('every route that tracks an activeProc aborts it through killBuildProcess', () => {
    // Three routes keep an `activeProc`: /api/add-native-target, /api/build, /api/ota/publish.
    // A fourth added later must not quietly reintroduce the direct-kill shape.
    const tracked = src.match(/let activeProc\b/g) ?? [];
    const killed = src.match(/killBuildProcess\(activeProc\)/g) ?? [];
    expect(tracked.length).toBeGreaterThanOrEqual(3);
    expect(killed.length).toBe(tracked.length);
  });
});
