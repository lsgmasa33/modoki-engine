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
 *  only pins the CALL SITES to it.
 *
 *  ⚠️ **Both checks read the parse, not lines or whole-file counts (#1179).** A per-line match missed
 *  `activeProc\n  ?.kill(…)`; and "as many `killBuildProcess(activeProc)` as `let activeProc`" was a
 *  FILE-grain count, so a route killing twice paid for a route that never kills. Each binding must
 *  now reach a kill of its own, resolved by symbol. Comments are blanked by the scanner, so the
 *  three `(D6)` blocks may still NAME the old `proc.kill()` shape to explain why it was wrong. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, findNodes, lineOf, parseSource, readsOf, referencesToPath, ts } from '@modoki/engine/testing/sourceAst';

const scannerPath = path.resolve(__dirname, '../../plugins/vite-asset-scanner.ts');

/** Every read of `activeProc.kill` / `proc.kill` — called or handed on — as `line: text`. */
function directKills(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  return referencesToPath(sf, 'activeProc.kill', 'proc.kill').map((r) => `${lineOf(r)}: ${r.getText(sf)}`);
}

/** Every `let activeProc` binding, with whether one of ITS OWN reads is `killBuildProcess`'s argument. */
function trackedProcs(code: string, label: string): Array<{ line: number; killed: boolean }> {
  const sf = parseSource(code, label);
  const kills = new Set(callsTo(sf, 'killBuildProcess').flatMap((c) => [...c.arguments]));
  return findNodes(sf, (n): n is ts.VariableDeclaration & { name: ts.Identifier } =>
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'activeProc')
    .map((d) => ({ line: lineOf(d), killed: readsOf(d.name).some((r) => kills.has(r)) }));
}

describe('build children are killed as a process group (#176)', () => {
  const src = readScannedSource(scannerPath).code;

  it('no abort path signals the spawned pid directly', () => {
    expect(
      directKills(src, 'vite-asset-scanner.ts'),
      'use killBuildProcess(proc) — a direct .kill() orphans a compound step\'s grandchildren',
    ).toEqual([]);
  });

  it('every route that tracks an activeProc aborts it through killBuildProcess', () => {
    // Three routes keep an `activeProc`: /api/add-native-target, /api/build, /api/ota/publish.
    // A fourth added later must not quietly reintroduce the direct-kill shape.
    const tracked = trackedProcs(src, 'vite-asset-scanner.ts');
    expect(tracked.length).toBeGreaterThanOrEqual(3);
    expect(tracked.filter((t) => !t.killed).map((t) => `line ${t.line}`)).toEqual([]);
  });

  it('the detectors see a WRAPPED kill, and a route is not paid for by its neighbour\'s kill (#1179)', () => {
    expect(directKills('declare const activeProc: any;\nactiveProc\n  ?.kill(\'SIGTERM\');\nconst k = proc.kill.bind(proc);', 'f.ts'))
      .toEqual(['2: activeProc\n  ?.kill', '4: proc.kill']);
    const twoRoutes = [
      'function a() { let activeProc = null; on(() => { killBuildProcess(activeProc); killBuildProcess(activeProc); }); }',
      'function b() { let activeProc = null; on(() => { activeProc = null; }); }',
    ].join('\n');
    expect(trackedProcs(twoRoutes, 'f.ts')).toEqual([{ line: 1, killed: true }, { line: 2, killed: false }]);
  });
});
