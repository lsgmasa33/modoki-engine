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
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { join } from 'node:path';
import { DEVICE_STATUS_TARGET_FIELDS } from '../../tools/game-debug-mcp/src/mcp-tools';
import { readScannedSource } from '@modoki/engine/testing';
import { parseSource, ts, typeMembers, typesNamed } from '@modoki/engine/testing/sourceAst';

const SRC = join(__dirname, '../../plugins/backend/deviceConnection.ts');

/** The `target: { … } | null` member of `DeviceConnectStatus`, by its field names.
 *
 *  ⚠️ From the parser (#1195). This used to take the interface up to the first `'\n}'` and the target
 *  up to its first `}`, then split on `;` and `:` — so a nested literal inside the target ended it
 *  early, and a field typed `(a: number) => void` would have split into two names. */
function realTargetFields(): string[] {
  const sf = parseSource(readScannedSource(SRC).code, SRC);
  const decls = typesNamed(sf, 'DeviceConnectStatus');
  expect(decls.length, 'DeviceConnectStatus not found — did the interface move or get renamed?').toBe(1);
  const members = typeMembers(decls[0]);
  expect(members, 'DeviceConnectStatus is no longer a plain interface (it extends another, or became an alias) — read its new shape').toBeDefined();
  const target = members!.filter((m) => m.name === 'target');
  expect(target.length, 'DeviceConnectStatus has no `target` member').toBe(1);
  const t = target[0]!.type;
  const literal = t && ts.isUnionTypeNode(t) ? t.types.filter(ts.isTypeLiteralNode) : t && ts.isTypeLiteralNode(t) ? [t] : [];
  expect(literal.length, 'DeviceConnectStatus.target is no longer an inline object literal (or `literal | null`)').toBe(1);
  return typeMembers(literal[0])!.map((m) => m.name);
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

  it('every /api/device/status read is decoded through the one status decoder', () => {
    // The mechanism, not just the two instances: every status read goes through `decodeLeaseStatus`,
    // which returns the typed mirror — so a future field cannot be conjured by a fresh `as { … }`,
    // and a field that is missing at runtime is a refusal (#1313). Since #1313 the helpers REQUIRE a
    // decoder, so the second argument is what varies.
    const src = readScannedSource(join(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts')).code;
    const reads = [...src.matchAll(/backendGet\('\/api\/device\/status',\s*([^)]*)\)/g)].map((m) => m[1].trim());
    expect(reads.length, 'no status reads found — did the route or helper name change?').toBeGreaterThan(0);
    assertExemptionLedger({
      label: 'status decoders in deviceStatusShape',
      population: reads.map((t) => ({ item: t, site: t })),
      sanctioned: ['decodeLeaseStatus'],
      floor: 1,
      fix: 'read /api/device/status through decodeLeaseStatus (reply.ts), not a decoder of its own',
    });
  });

  it('no backend reply in the device MCP is cast (§9-bis, #1313)', () => {
    const src = readScannedSource(join(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts')).code;
    // One level of nested parens covers a payload like `{ ...(ip ? { ip } : {}) }`.
    // `await backendGet(…) as X` parses as `(await …) as X` too, so the closing paren is optional.
    const CAST = /backend(?:Get|Post)\((?:[^()]|\([^()]*\))*\)\)?\s*as\s/g;
    const casts = [...src.matchAll(CAST)].map((m) => m[0].slice(0, 80));
    expect(casts, 'a backend reply is cast instead of decoded — pass a decoder to backendGet/backendPost').toEqual([]);
    // Accept side: the pattern matches the shape it exists to catch, including a multi-line payload.
    const probe = "const s = (await backendPost('/api/device/connect', {\n  ...(ip ? { ip } : {}),\n})) as LeaseStatus;";
    expect([...probe.matchAll(CAST)]).toHaveLength(1);
    expect([..."const s = await backendGet('/api/x', d) as X;".matchAll(CAST)]).toHaveLength(1);
    expect([..."const s = await backendGet('/api/x', d);".matchAll(CAST)]).toHaveLength(0);
    // And the helpers take the decoder as a REQUIRED parameter — an optional one would let a
    // call site skip it and get `unknown` back to cast.
    expect(src).toMatch(/async function backendGet<T>\(path: string, decode: Decoder<T>\): Promise<T>/);
    expect(src).toMatch(/async function backendPost<T>\(path: string, payload: unknown, decode: Decoder<T>\): Promise<T>/);
  });
});
