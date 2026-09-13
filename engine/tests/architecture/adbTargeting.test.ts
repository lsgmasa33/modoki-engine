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
import { callsTo, parseSource } from '@modoki/engine/testing/sourceAst';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

const BACKEND = path.resolve(__dirname, '../../plugins/backend');

/** Calls that are deliberately GLOBAL — each needs a reason.
 *
 *  ⚠️ **SPENT per call, not matched per function (#1140).** This was a `Record<file:function>`
 *  looked up with `[near]`, so a SECOND un-targeted adb call written into `listForwards` inherited
 *  a reason argued about the first, and the staleness test only checked the function still held
 *  an adb call — not that the call was still un-targeted. Each row now pays for one call; a second
 *  global call in the same function needs `count: 2` and a sentence. */
const ALLOWED_UNTARGETED: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  { item: 'androidDevices.ts:list', reason:
    'The device LISTING itself. `adb devices -l` enumerates every attached device, so targeting it '
    + 'at one would defeat its entire purpose — this is the call whose OUTPUT the serial is chosen '
    + 'from, so it cannot already know the serial.' },
  { item: 'deviceConnection.ts:listForwards', reason:
    'The forward LISTING (#158). `adb forward --list` is daemon-wide and accepts no `-s` at all — '
    + 'and being global is exactly what makes it useful here: it is the only way to ask "which '
    + 'device owns the rule on host port N?", which is the question a serial-scoped removal has to '
    + 'answer before deleting anything (`--remove` matches on the port spec and IGNORES `-s`).' },
  { item: 'deviceCdp.ts:listForwards', reason:
    'Same call, same reason, for the webview CDP tunnel — see deviceConnection.ts:listForwards.' },
];

/** Every `execFileSync(adbBinary(), …)` with the source window that builds its argv.
 *
 *  The window is the call expression's OWN extent, taken from the TypeScript AST — so a long argv
 *  builder sits inside it and nothing past its closing `)` can.
 *
 *  ⚠️ **Parsed, because both text windows before it failed OPEN (#1140).** A fixed 400 chars
 *  reached the NEXT call: `androidDevices.ts`' un-targeted `adb devices -l` sits three lines above
 *  `deviceName`'s `adbArgs(serial, …)` and read as targeted, while its allowlist row stayed
 *  "load-bearing". Its replacement — a hand-balanced paren scan — was then shown by review to
 *  over-read on a quote inside a regex literal, and a heuristic regex-vs-division rule on top of
 *  that still over-read on `w! / 2`, `=> /'/`, `+ /'/`, deep indentation and a backtick inside
 *  `${}`. Every one of those is a private tokenizer being wrong; the AST is not a tokenizer this
 *  file maintains, and it is parsed through `sourceAst`, the shared node-not-window helper #1144
 *  extracted from this fix. (The "an AST walk is too heavy" reason the first version gave does not hold:
 *  `updateEachFanoutGuard` already parses with `typescript` in this suite.) Pinned below. */
function adbCallSitesIn(entry: string, src: string): Array<{ file: string; near: string; window: string }> {
  const out: Array<{ file: string; near: string; window: string }> = [];
  const sf = parseSource(src, entry);
  for (const node of callsTo(sf, 'execFileSync')) {
    if (node.arguments[0]?.getText(sf) !== 'adbBinary()') continue;
    const at = node.getStart(sf);
    // The enclosing function/method name, for a failure message that says WHERE rather than
    // making the reader count line numbers.
    const before = src.slice(0, at);
    const fnName = [...before.matchAll(/(?:function\s+|^\s{2})([A-Za-z_$][\w$]*)\s*\(/gm)].pop()?.[1] ?? '?';
    out.push({ file: entry, near: `${entry}:${fnName}`, window: src.slice(at, node.getEnd()) });
  }
  return out;
}

function adbCallSites(): Array<{ file: string; near: string; window: string }> {
  const out: Array<{ file: string; near: string; window: string }> = [];
  for (const entry of fs.readdirSync(BACKEND)) {
    if (!entry.endsWith('.ts')) continue;
    out.push(...adbCallSitesIn(entry, readScannedSource(path.join(BACKEND, entry)).code));
  }
  return out;
}

describe('adb targeting — every backend adb call names a device (#149)', () => {
  it('finds the call sites at all (the guard must not pass by scanning nothing)', () => {
    // A guard whose scan silently matches zero files is the failure mode this repo keeps hitting:
    // it reports a cheerful pass forever. Pin the count's floor instead.
    expect(adbCallSites().length).toBeGreaterThanOrEqual(6);
  });

  it('the window is the call\'s own argv — a NEXT call\'s adbArgs( cannot vouch for it', () => {
    const src = [
      'export const seam = {',
      '  list(): string {',
      "    return execFileSync(adbBinary(), ['devices', '-l'], { timeout: 4000 });",
      '  },',
      '  type(text: string): void {',
      "    execFileSync(adbBinary(), ['shell', 'input', 'text', text.replace(/'/g, '')], { timeout: 4000 });",
      '  },',
      '  tap(w: number): void {',
      "    execFileSync(adbBinary(), ['shell', 'input', 'tap', String(w! / 2), `a ${w ? '`' : ''} b`,",
      "                                                    String(w",
      "                                                    / 2)].filter((x) => /'/.test(x) || 'a' + /'/.source), {});",
      '  },',
      '  name(serial: string): string {',
      "    return execFileSync(adbBinary(), adbArgs(serial, [",
      "      'shell', `getprop ${'ro.x'}`,",
      "    ]), { timeout: 4000, encoding: 'utf8' });",
      '  },',
      '};',
    ].join('\n');
    expect(adbCallSitesIn('synthetic.ts', src).map((c) => [c.near, c.window.includes('adbArgs(')])).toEqual([
      ['synthetic.ts:list', false],
      ['synthetic.ts:type', false], // a quote inside a REGEX literal must not open a string
      ['synthetic.ts:tap', false],  // `w! / 2`, `=> /'/`, `+ /'/`, deep-indented `/`, backtick in `${}`
      ['synthetic.ts:name', true],
    ]);
  });

  it('routes every call through adbArgs(), or spends an allowlist row with a reason', () => {
    assertExemptionLedger({
      label: 'ALLOWED_UNTARGETED in adbTargeting',
      population: adbCallSites()
        .filter((c) => !c.window.includes('adbArgs('))
        .map((c) => ({ item: c.near, site: c.near })),
      exempt: ALLOWED_UNTARGETED,
      floor: 1,
      fix: 'adb call(s) that do not pass their argv through `adbArgs(serial, …)`. An un-targeted adb '
        + 'call works with one phone attached and fails outright with two ("more than one '
        + 'device/emulator"), which is how the whole Android debug surface broke in #149. Take the '
        + 'serial from the LEASE (`DeviceConnectStatus.target.serial`) and pass it through adbArgs — '
        + 'never resolve one locally, or two calls in a session can drive two different phones and '
        + 'both report success.',
    });
  });
});
