/** Drift guard: the device MCP's local mirror of `DeviceConnectStatus` matches the real interface.
 *
 *  WHY THIS EXISTS (independent review, 2026-07-30). `engine/tools/game-debug-mcp` is a separate
 *  package and cannot import `DeviceConnectStatus` from `engine/plugins/backend/deviceConnection.ts`,
 *  so it read `/api/device/status` through inline `as { … }` casts. A cast cannot be wrong at
 *  compile time, so two helpers invented fields the payload has never carried:
 *
 *    - `leaseIsAndroid()` read `target.platform` — so the ONLY branch that could return true was
 *      `target.useAdb`, a lease that has already taken the adb screenshot path. The S2.6
 *      black-canvas warning was therefore dead in exactly the case its comment named (an Android
 *      connected over WiFi).
 *    - `leaseKey()` built `adb:${t.serial ?? t.deviceId ?? ''}` — so every adb lease keyed to the
 *      constant string "adb:", and the stale-screenshot-scale check it feeds always passed on the
 *      USB-device-swap it was written to close.
 *
 *  Both compiled, shipped, and could never fire, while their comments assured the next reader the
 *  cases were handled. A guard that cannot fire is worse than no guard.
 *
 *  This test is the structural fix: it parses the REAL interface and fails if the mirror claims a
 *  field the payload does not have, or misses one it does. Either direction is a bug — an invented
 *  field is a guard that silently never fires; a missing one is data the tools cannot reach.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DEVICE_STATUS_TARGET_FIELDS } from '../../tools/game-debug-mcp/src/mcp-tools';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = join(__dirname, '../../plugins/backend/deviceConnection.ts');

/** The `target: { … } | null` member of `DeviceConnectStatus`, by its field names. */
function realTargetFields(): string[] {
  const src = readScannedSource(SRC).code;
  const iface = /export interface DeviceConnectStatus \{([\s\S]*?)\n\}/.exec(src);
  expect(iface, 'DeviceConnectStatus not found — did the interface move or get renamed?').toBeTruthy();
  const target = /^\s*target:\s*\{([^}]*)\}/m.exec(iface![1]);
  expect(target, 'DeviceConnectStatus.target is no longer an inline object literal').toBeTruthy();
  return target![1]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':')[0].trim().replace(/\?$/, ''));
}

describe('device MCP status mirror vs DeviceConnectStatus', () => {
  it('claims exactly the target fields the payload really has', () => {
    expect([...DEVICE_STATUS_TARGET_FIELDS].sort()).toEqual(realTargetFields().sort());
  });

  it('does not claim the fields two dead guards used to invent', () => {
    // Named explicitly so a re-introduction is unmistakable rather than just an array diff.
    //
    // `serial` used to be on this list and is deliberately OFF it now (#149): the payload really
    // carries `target.serial` — the adb device the lease resolved at connect time — so a helper
    // reading it is no longer inventing anything. It is exactly the field `leaseKey()` wished for
    // in this file's header, finally made real rather than assumed. The structural check above is
    // what keeps that honest; this list stays for the two fields that are still fiction.
    for (const invented of ['platform', 'deviceId']) {
      expect(
        [...DEVICE_STATUS_TARGET_FIELDS],
        `target.${invented} does not exist on DeviceConnectStatus — a guard reading it can never fire`,
      ).not.toContain(invented);
    }
  });

  it('no device tool reads a status field through an inline cast that could invent one', () => {
    // The mechanism, not just the two instances: every `/api/device/status` read must go through
    // the typed mirror, so a future field can't be conjured by a fresh `as { … }`.
    const src = readScannedSource(join(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts')).code;
    const reads = [...src.matchAll(/backendGet\('\/api\/device\/status'\)\)\s*as\s+([A-Za-z_$][\w$]*|\{[^;\n]*)/g)]
      .map((m) => m[1].trim());
    expect(reads.length, 'no status reads found — did the route or helper name change?').toBeGreaterThan(0);
    const ALLOWED = new Set(['DeviceStatusReply', 'LeaseStatus']);
    expect(
      reads.filter((t) => !ALLOWED.has(t)),
      'these reads use an inline object cast; use DeviceStatusReply so an invented field is a compile error',
    ).toEqual([]);
  });
});
