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
 *    — a SIGTERM from `stop-editor.sh`, a crash, `kill -9`. It has to run in BOTH backend hosts
 *    (Electron's `startBackendServer` and the Vite plugin's `configureServer`); a host that drops
 *    it leaves that lane un-swept, and nothing about the running editor would look wrong.
 *
 *  Deliberately a source grep rather than a behavioural test: what failed was not the logic (which
 *  the unit tests cover) but the WIRING, and a test that mounts the module cannot see whether
 *  production calls it. Tests are excluded from the scan for exactly that reason — the dead
 *  version had test callers and that is what made it look alive.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (rel: string) => readScannedSource(path.join(repoRoot, rel)).code;

describe('device teardown hooks are reachable from production code', () => {
  it('releaseDeviceResourcesOnExit is called on the Electron quit path', () => {
    const main = read('engine/electron/main.ts');
    expect(main, 'main.ts must import the teardown').toMatch(/releaseDeviceResourcesOnExit/);
    // Inside the before-quit listener specifically — importing it and never calling it on the quit
    // path is the exact shape that made this dead for months.
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
    expect(beforeQuit, 'the before-quit teardown must call it').toMatch(/releaseDeviceResourcesOnExit\(\)/);
  });

  it.each([
    ['Electron backend host', 'engine/electron/backendServer.ts'],
    ['Vite plugin backend host', 'engine/plugins/vite-asset-scanner.ts'],
  ])('%s calls reclaimStaleDeviceStateAtStartup', (_label, rel) => {
    expect(read(rel)).toMatch(/reclaimStaleDeviceStateAtStartup\(\)/);
  });

  it('the startup reclaim sweeps device CLAIMS, not only adb forwards (#225)', () => {
    // The forwards half predates the claims half; a refactor that drops the sweep would leave the
    // claims file accumulating corpses again with every adb test still green.
    const conn = read('engine/plugins/backend/deviceConnection.ts');
    const fn = conn.slice(conn.indexOf('export function reclaimStaleDeviceStateAtStartup'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/sweepStaleClaims\(\)/);
  });
});
