/** Guard: every adb call in the backend names WHICH device (#149).
 *
 *  WHY THIS EXISTS, and why it is a SOURCE guard rather than another unit test.
 *
 *  All six adb call sites were originally un-targeted. That is invisible with one phone attached
 *  and fatal with two — adb answers `more than one device/emulator` and refuses — so
 *  `device_connect {useAdb:true}`, the CDP discovery behind trusted Android input, and
 *  `device_screenshot` all failed together on a machine with a second handset plugged in.
 *
 *  The behaviour tests cannot catch a regression here, and this was MEASURED during the #149
 *  close-out rather than assumed: deleting the `-s` prefix from `adbArgs` killed exactly ONE test.
 *  The reason is structural — `adbRunner` and `deviceCdpAdb` are overridable seams that every test
 *  replaces with a spy (correctly: no test should shell out to real hardware), so the argv those
 *  functions really build is executed by nothing. A seam that makes a module testable also makes
 *  the code BEHIND the seam untested, and the argv is behind it.
 *
 *  So the invariant is enforced where it lives — in the source. `adbArgs(serial, [...])` is the one
 *  function that adds `-s`, which makes "does this call name a device?" answerable by reading a
 *  single call rather than auditing six, and makes a NEW seventh call site fail here on the day it
 *  is written instead of on the day someone plugs in a second phone.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const BACKEND = path.resolve(__dirname, '../../plugins/backend');

/** Calls that are deliberately GLOBAL — each needs a reason. */
const ALLOWED_UNTARGETED: Record<string, string> = {
  'androidDevices.ts:list':
    'The device LISTING itself. `adb devices -l` enumerates every attached device, so targeting it '
    + 'at one would defeat its entire purpose — this is the call whose OUTPUT the serial is chosen '
    + 'from, so it cannot already know the serial.',
  'deviceConnection.ts:listForwards':
    'The forward LISTING (#158). `adb forward --list` is daemon-wide and accepts no `-s` at all — '
    + 'and being global is exactly what makes it useful here: it is the only way to ask "which '
    + 'device owns the rule on host port N?", which is the question a serial-scoped removal has to '
    + 'answer before deleting anything (`--remove` matches on the port spec and IGNORES `-s`).',
  'deviceCdp.ts:listForwards':
    'Same call, same reason, for the webview CDP tunnel — see deviceConnection.ts:listForwards.',
};

/** Every `execFileSync(adbBinary(), …)` with the source window that builds its argv.
 *
 *  Windowed rather than parsed: a real AST walk would be a heavier dependency than the invariant
 *  warrants, and every call site in this repo builds its argv on the same or next line. The window
 *  stops at the call's own closing `)` + option object, which is the shape all of them share. If a
 *  future call site spreads its argv across a long builder, this guard will fail loudly (no
 *  `adbArgs(` in the window) rather than silently pass — the safe direction for a guard to be wrong.
 */
function adbCallSites(): Array<{ file: string; near: string; window: string }> {
  const out: Array<{ file: string; near: string; window: string }> = [];
  for (const entry of fs.readdirSync(BACKEND)) {
    if (!entry.endsWith('.ts')) continue;
    const src = readScannedSource(path.join(BACKEND, entry)).code;
    const marker = 'execFileSync(adbBinary()';
    let at = src.indexOf(marker);
    while (at !== -1) {
      const window = src.slice(at, at + 400);
      // The enclosing function/method name, for a failure message that says WHERE rather than
      // making the reader count line numbers.
      const before = src.slice(0, at);
      const fnName = [...before.matchAll(/(?:function\s+|^\s{2})([A-Za-z_$][\w$]*)\s*\(/gm)].pop()?.[1] ?? '?';
      out.push({ file: entry, near: `${entry}:${fnName}`, window });
      at = src.indexOf(marker, at + marker.length);
    }
  }
  return out;
}

describe('adb targeting — every backend adb call names a device (#149)', () => {
  it('finds the call sites at all (the guard must not pass by scanning nothing)', () => {
    // A guard whose scan silently matches zero files is the failure mode this repo keeps hitting:
    // it reports a cheerful pass forever. Pin the count's floor instead.
    expect(adbCallSites().length).toBeGreaterThanOrEqual(6);
  });

  it('routes every call through adbArgs(), or allowlists it with a reason', () => {
    const violations = adbCallSites()
      .filter((c) => !c.window.includes('adbArgs('))
      .filter((c) => !ALLOWED_UNTARGETED[c.near])
      .map((c) => c.near);

    expect(
      violations,
      'adb call(s) that do not pass their argv through `adbArgs(serial, …)`:\n'
      + `  ${violations.join('\n  ')}\n\n`
      + 'An un-targeted adb call works with one phone attached and fails outright with two '
      + '("more than one device/emulator"), which is how the whole Android debug surface broke in '
      + '#149. Take the serial from the LEASE (`DeviceConnectStatus.target.serial`) and pass it '
      + 'through adbArgs — never resolve one locally, or two calls in a session can drive two '
      + 'different phones and both report success.\n'
      + 'If a call is genuinely meant to be global, add it to ALLOWED_UNTARGETED with the reason.',
    ).toEqual([]);
  });

  it('every allowlist entry still corresponds to a real call site', () => {
    // A stale allowlist entry is a permission nobody granted on purpose — it would silently exempt
    // a future function that happens to reuse the name.
    const found = new Set(adbCallSites().map((c) => c.near));
    for (const key of Object.keys(ALLOWED_UNTARGETED)) {
      expect(found, `ALLOWED_UNTARGETED lists "${key}", which no longer exists`).toContain(key);
    }
  });
});
