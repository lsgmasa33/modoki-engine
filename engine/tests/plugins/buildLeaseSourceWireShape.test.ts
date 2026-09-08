/** Guard on WHERE the Android build path reads its lease from (#235 cross-process).
 *
 *  #235 taught the build to honour the held lease, so its refusal would stop naming two remedies
 *  (`device_connect {useAdb:true, serial}`, the AI panel's picker) that it then ignored. The fix
 *  was correct and still never fired, because it read `deviceConnection.status()` — a MODULE
 *  SINGLETON, and this router is mounted in two processes: the Electron backend
 *  (`electron/backendServer.ts`) and the Vite dev server (`plugins/vite-asset-scanner.ts`).
 *  `device_connect` opens the lease in the Electron one; the build resolves its serial in the Vite
 *  one, where that singleton is permanently `disconnected`. The lease was real, visible over
 *  `curl :5183/api/device/status`, and invisible to the build.
 *
 *  Why a SOURCE-TEXT assertion rather than a behavioural one. The defect is not "the resolver
 *  mishandles a lease" — `resolveBuildAndroidSerial` was always right, and `androidDevices.test.ts`
 *  proves it by passing `leaseSerial` in as an argument. That is exactly why the bug survived: an
 *  injected argument pins how the value is USED and can say nothing about whether the caller can
 *  SEE one. The failure lives in the one line that chooses the source, inside a Vite plugin closure
 *  that no test can construct. So the honest guard is on that line.
 *
 *  What it protects against is a plausible "simplification" back to the singleton — which would
 *  typecheck, pass every existing test, and silently restore a dishonest refusal.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.join(__dirname, '../../plugins/vite-asset-scanner.ts');
const src = readScannedSource(SRC).code;

/** The `platform === 'android'` serial-resolution block, sliced out so the assertions below cannot
 *  be satisfied (or broken) by an unrelated mention of these names elsewhere in a 2600-line file. */
function androidSerialBlock(): string {
  // Matched as a PATTERN, not a literal: #370 added a `&& !isRelease` arm (a release build installs
  // nothing, so it must not consult adb at all), which broke a literal anchor. The guard failed
  // LOUDLY, as designed — but it failed for a reason that has nothing to do with what it protects,
  // and a guard that cries wolf at every neighbouring edit is one somebody eventually deletes. Any
  // further condition on the same `if` now keeps it aimed.
  const start = src.search(/if \(platform === 'android'[^)]*\) \{/);
  expect(start, "the android serial-resolution block moved — re-aim this guard").toBeGreaterThan(-1);
  const end = src.indexOf('const adb = ', start);
  expect(end, 'the end anchor moved — re-aim this guard').toBeGreaterThan(start);
  // Comments stripped: that block DOCUMENTS the wrong call in order to warn against it, and a
  // guard that cannot tell code from prose about code would fail on its own warning.
  // Already stripped at the read (#816) — the `//` filter matched nothing.
  return src.slice(start, end);
}

describe('android build lease source', () => {
  it('resolves the lease from the machine-wide claims file', () => {
    expect(androidSerialBlock()).toContain('ownAdbClaim(');
  });

  it('does NOT read the per-process deviceConnection singleton', () => {
    // The exact regression: process-local state that is blind to the lease the user actually holds.
    expect(androidSerialBlock()).not.toContain('deviceConnection.status()');
  });

  it('does not import the lease manager for its connection state at all', () => {
    // `reclaimStaleDeviceStateAtStartup` is a legitimate import from that module (a startup sweep,
    // not lease state), so this pins the SYMBOL rather than the module path.
    const importLine = src.split('\n').find((l) => l.includes("from './backend/deviceConnection'"));
    expect(importLine).toBeDefined();
    // The BINDINGS only — the module path necessarily contains the word.
    const bindings = /import\s*\{([^}]*)\}/.exec(importLine!)?.[1] ?? '';
    expect(bindings.split(',').map((b) => b.trim())).not.toContain('deviceConnection');
  });
});
