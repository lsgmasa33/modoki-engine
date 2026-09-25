/** The device teardown/reclaim hooks are actually WIRED — a mechanism nothing calls is not a fix.
 *
 *  This guard exists because both halves of it have already failed silently, in the same file:
 *
 *  - **`releaseDeviceResourcesOnExit` was named `OnExit` and reached no exit at all** (#225). It
 *    was written to close #160's leak (an adb forward and a device claim outliving the editor),
 *    it is exported, it is unit-tested, its own doc described "the exit hooks" — and grepping
 *    production sources found exactly zero callers. The leak it was written for was still open,
 *    and every reader of that file, human or agent, would have concluded otherwise. It is now
 *    called from Electron's awaited `before-quit` teardown.
 *  - **`reclaimStaleDeviceStateAtStartup` is the backstop for the endings that hook cannot cover**
 *    — a crash, `kill -9`, and the SIGKILL `stop-editor.sh` falls back to. (A single SIGTERM from
 *    `stop-editor.sh` DOES reach `before-quit` since #1580, which stopped it double-signalling.) It has to run in BOTH backend hosts
 *    (Electron's `startBackendServer` and the Vite plugin's `configureServer`); a host that drops
 *    it leaves that lane un-swept, and nothing about the running editor would look wrong.
 *
 *  Deliberately a source check rather than a behavioural test: what failed was not the logic (which
 *  the unit tests cover) but the WIRING, and a test that mounts the module cannot see whether
 *  production calls it. Tests are excluded from the scan for exactly that reason — the dead
 *  version had test callers and that is what made it look alive.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { accessPath, callsTo, declarationOf, enclosingNamedFunction, parseSource, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface CallSite {
  /** What the call runs inside, outermost first: a named function by its name, an anonymous function
   *  by the call it is handed to — `app.on('before-quit')`. Any other anonymous function adds nothing: an
   *  IIFE, but also one stored, returned or put in an array. ⚠️ So this says where a call is WRITTEN, not that
   *  it runs: `app.on('before-quit', () => { cb = () => release(); })` still reads as the quit path — only a
   *  closure bound to a name (`const later = () => …`) shows up as `later`. */
  within: string[];
  /** `import` when the callee is an imported binding, `local` for a declaration in the file, and
   *  `unresolved` otherwise (a member call, a global). */
  resolves: 'import' | 'local' | 'unresolved';
}

/**
 * Every call to `name` in `code`, and where it runs (#1195).
 *
 * These checks used to be text: the quit path was the file from `app.on('before-quit'` to its END, so
 * a call in any later listener counted; the startup sweep was `reclaimStaleDeviceStateAtStartup`'s body
 * cut to the first `'\n}\n'`; and a host "called" the reclaim wherever `reclaimStaleDeviceStateAtStartup()`
 * appeared, including a stub of the same name.
 */
function callSites(code: string, label: string, name: string): CallSite[] {
  const sf = parseSource(code, label);
  return callsTo(sf, name).filter((c) => ts.isIdentifier(c.expression)).map((call) => {
    const within: string[] = [];
    for (let cur = call.parent; cur; cur = cur.parent) {
      if (!ts.isFunctionLike(cur)) continue;
      const body = (cur as { body?: ts.Node }).body;
      const named = body && enclosingNamedFunction(body);
      const p = cur.parent;
      if (named && named.node === cur) within.unshift(named.name);
      else if (p && ts.isCallExpression(p) && p.arguments.includes(cur as ts.Expression)) {
        const first = stringValueOf(p.arguments[0]);
        within.unshift(`${accessPath(p.expression) ?? '?'}(${first === undefined ? '…' : `'${first}'`})`);
      }
    }
    const decl = declarationOf(call.expression as ts.Identifier);
    const resolves = !decl ? 'unresolved' : ts.isImportSpecifier(decl) || ts.isImportClause(decl) ? 'import' : 'local';
    return { within, resolves };
  });
}

const sites = (rel: string, name: string) => callSites(readScannedSource(path.join(repoRoot, rel)).code, rel, name);

describe('device teardown hooks are reachable from production code', () => {
  it('releaseDeviceResourcesOnExit is called on the Electron quit path', () => {
    // Inside the before-quit listener specifically, and the imported function — importing it and never
    // calling it on the quit path is the exact shape that made this dead for months.
    expect(sites('engine/electron/main.ts', 'releaseDeviceResourcesOnExit'), 'the before-quit teardown must call it')
      .toEqual([{ within: ["app.on('before-quit')"], resolves: 'import' }]);
  });

  it.each([
    ['Electron backend host', 'engine/electron/backendServer.ts', ['startBackendServer']],
    ['Vite plugin backend host', 'engine/plugins/vite-asset-scanner.ts', ['assetScannerPlugin', 'configureServer']],
  ])('%s calls reclaimStaleDeviceStateAtStartup', (_label, rel, within) => {
    expect(sites(rel, 'reclaimStaleDeviceStateAtStartup')).toEqual([{ within, resolves: 'import' }]);
  });

  it('the startup reclaim sweeps device CLAIMS, not only adb forwards (#225)', () => {
    // The forwards half predates the claims half; a refactor that drops the sweep would leave the
    // claims file accumulating corpses again with every adb test still green.
    expect(sites('engine/plugins/backend/deviceConnection.ts', 'sweepStaleClaims'))
      .toEqual([{ within: ['reclaimStaleDeviceStateAtStartup'], resolves: 'import' }]);
  });

  it('places a call by the function it runs in, not by what text follows it (#1195)', () => {
    const probe = (src: string) => callSites(src, 'probe.ts', 'release');
    // A later listener is not the quit path, and a column-0 `}` in a string does not end a function.
    expect(probe("import { release } from './d';\napp.on('before-quit', () => { const s = `\n}\n`; });\napp.on('will-quit', () => release());"))
      .toEqual([{ within: ["app.on('will-quit')"], resolves: 'import' }]);
    expect(probe("import { release } from './d';\napp.on('before-quit', (e) => { void (async () => { try { release(); } catch {} })(); });"))
      .toEqual([{ within: ["app.on('before-quit')"], resolves: 'import' }]);
    // A same-named stub, a member call, and a method inside a named factory.
    expect(probe('function release() {}\nfunction host() { release(); }')).toEqual([{ within: ['host'], resolves: 'local' }]);
    expect(probe('adb.release();')).toEqual([]);
    expect(probe("import release from './d';\nexport function plugin() { return { configureServer() { if (here()) release(); } }; }"))
      .toEqual([{ within: ['plugin', 'configureServer'], resolves: 'import' }]);
    expect(probe('declare const release: () => void;\nsetTimeout(() => release(), 0);')).toEqual([{ within: ['setTimeout(…)'], resolves: 'local' }]);
    expect(probe('run(() => release());')).toEqual([{ within: ['run(…)'], resolves: 'unresolved' }]);
  });
});
