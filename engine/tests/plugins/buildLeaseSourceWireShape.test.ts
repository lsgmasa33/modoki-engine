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
import {
  callsTo, declarationOf, findNodes, flatText, guardProves, importsIn, parseSource, referencesToPath, stringValueOf, ts, unwrapValue,
} from '@modoki/engine/testing/sourceAst';

const SRC = path.join(__dirname, '../../plugins/vite-asset-scanner.ts');
/** The lease manager's specifier, with or without an emitted extension. */
const DEVICE_CONNECTION_MODULE = /^\.\/backend\/deviceConnection(?:\.[cm]?[jt]s)?$/;
const SINGLETON = 'deviceConnection';

/** `e` and what every binding it reads is computed from, followed through the file's own scopes: a
 *  `const`/`let` initialiser, a destructure's initialiser, a `for…of`/`for…in` binding's iterable, a
 *  parameter default, every later assignment to it (`=`, `??=`, `+=`…, and as a destructuring target), a
 *  function declaration's body and a class's members, and a destructure's or parameter's defaults. A
 *  TAINT, not a value flow: a binding that only feeds a CONDITION is in it (`ownClaim ? stale : undefined`),
 *  as it was for the text check this replaced. NOT followed: an import, what a caller passes for a
 *  parameter, and a PROPERTY written elsewhere (`state.serial = …` read back as `state.serial`). */
function taintOf(e: ts.Node, out = new Set<ts.Node>()): Set<ts.Node> {
  if (out.has(e)) return out;
  out.add(e);
  const sf = e.getSourceFile();
  for (const id of findNodes(e, ts.isIdentifier)) {
    let decl: ts.Node | undefined = declarationOf(id);
    if (!decl) continue;
    if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) { taintOf(decl, out); continue; }
    // Climb a destructure to what holds it, tainting every default on the way (`{ a = dflt } = v`).
    while (ts.isBindingElement(decl) || ts.isObjectBindingPattern(decl) || ts.isArrayBindingPattern(decl)) {
      if (ts.isBindingElement(decl) && decl.initializer) taintOf(decl.initializer, out);
      decl = decl.parent;
    }
    if (ts.isParameter(decl)) { if (decl.initializer) taintOf(decl.initializer, out); continue; }
    if (!ts.isVariableDeclaration(decl)) continue;
    if (decl.initializer) taintOf(decl.initializer, out);
    const loop = decl.parent.parent;
    if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) taintOf(loop.expression, out);
    for (const w of assignmentsIn(sf).get(decl) ?? []) taintOf(w, out);
  }
  return out;
}

/** Every assignment in a file — `x = v`, `x ??= v`, `x += v`, and each name a destructuring target binds
 *  (`({ a: x } = v)`, `[x] = v`) — grouped by the declaration the assigned name resolves to. Built once. */
function assignmentsIn(sf: ts.SourceFile): Map<ts.Node, ts.Expression[]> {
  const cached = assignments.get(sf);
  if (cached) return cached;
  const byDecl = new Map<ts.Node, ts.Expression[]>();
  const record = (target: ts.Expression, value: ts.Expression) => {
    const t = unwrapValue(target);
    if (ts.isIdentifier(t)) {
      const decl = declarationOf(t);
      if (decl) byDecl.set(decl, [...(byDecl.get(decl) ?? []), value]);
    } else if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) {
      // A key (`{ serial: x }`'s `serial`) resolves to the property, never to a local: no filter needed.
      for (const id of findNodes(t, ts.isIdentifier)) record(id, value);
    }
  };
  for (const a of findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n)
    && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) {
    record(a.left, a.right);
  }
  // `for (x of v)` / `for (x in v)` with an EXPRESSION target assigns to `x` each turn.
  for (const loop of findNodes(sf, (n): n is ts.ForOfStatement | ts.ForInStatement => ts.isForOfStatement(n) || ts.isForInStatement(n))) {
    if (!ts.isVariableDeclarationList(loop.initializer)) record(loop.initializer, loop.expression);
  }
  assignments.set(sf, byDecl);
  return byDecl;
}

const assignments = new WeakMap<ts.SourceFile, Map<ts.Node, ts.Expression[]>>();

/** The lease-source facts of a build router, each read from its own node (#1179).
 *
 *  - `blocks`: every `if` that proves `platform === 'android'` and calls `resolveBuildAndroidSerial` —
 *    the serial-resolution block. It was a text slice from `if (platform === 'android'…) {` to the next
 *    `const adb = `, which a wrapped condition, or any reordering of the two anchors, re-aimed.
 *  - `leaseFromClaims`: every resolver call in them passes a `leaseSerial` computed from `ownAdbClaim()`.
 *    It was "`ownAdbClaim(` appears in the slice", which a call whose result went nowhere satisfied.
 *  - `singletonReads`: every read of the per-process singleton inside them, or in anything the lease is
 *    computed from (`taintOf`) — `deviceConnection`, under any alias this file imports it by, or through
 *    a namespace. It was the text `deviceConnection.status()`,
 *    which `deviceConnection\n.status()`, `?.status()` or `import { deviceConnection as dc }` did not contain.
 *  - `singletonImports`: every import of the lease manager that can reach the singleton — a named
 *    binding of it under any alias, a namespace, a whole-module `import()`. It was the bindings of the one
 *    LINE holding `from './backend/deviceConnection'`: a wrapped import's `from` line has no `{`, so its
 *    bindings read as none and the check passed, and `deviceConnection as dc` trimmed to itself. */
export function androidLeaseSource(code: string, label: string) {
  const sf = parseSource(code, label);
  const isAndroid = (e: ts.Expression) => ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ((ts.isIdentifier(e.left) && e.left.text === 'platform' && stringValueOf(e.right) === 'android')
      || (ts.isIdentifier(e.right) && e.right.text === 'platform' && stringValueOf(e.left) === 'android'));
  const blocks = findNodes(sf, ts.isIfStatement).filter((s) => guardProves({ test: s.expression, holds: true, by: s }, isAndroid)
    && callsTo(s.thenStatement, 'resolveBuildAndroidSerial').length > 0);
  const edges = importsIn(sf).filter((e) => DEVICE_CONNECTION_MODULE.test(e.spec) && !e.typeOnly);
  const singletonImports = edges.flatMap((e) => (e.kind === 'dynamic' ? ['import()']
    : e.bindings.filter((b) => b.imported === SINGLETON || b.imported === '*').map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`))));
  const names = [SINGLETON, ...edges.flatMap((e) => e.bindings.filter((b) => b.imported === SINGLETON).map((b) => b.local))];
  const leases = blocks.flatMap((b) => callsTo(b.thenStatement, 'resolveBuildAndroidSerial').map((call) =>
    call.arguments.flatMap((arg) => (objectLiteralProperties(arg) ?? []).filter((p) => p.name === 'leaseSerial').map((p) => taintOf(p.value)))));
  // Read inside the block AND anywhere the lease is computed from — a `const cached = deviceConnection.status()`
  // above the block, handed in as `leaseSerial: cached`, is outside the block and is still the source.
  const readSites = new Set<ts.Node>([...blocks, ...leases.flat().flatMap((t) => [...t])]);
  const reads = new Set<ts.Node>();
  for (const site of readSites) for (const r of referencesToPath(site, ...names)) reads.add(r);
  return {
    blocks: blocks.length,
    leaseFromClaims: blocks.length > 0 && leases.every((perCall) => perCall.some((t) => [...t].some((n) => callsTo(n, 'ownAdbClaim').length > 0))),
    singletonReads: [...reads].sort((a, b) => a.pos - b.pos).map((r) => flatText(r)),
    moduleImported: edges.length > 0,
    singletonImports,
  };
}

/** An object literal's own `key: value` and `{ key }` entries, or `undefined` for anything else. */
function objectLiteralProperties(e: ts.Expression): Array<{ name: string; value: ts.Node }> | undefined {
  const u = unwrapValue(e);
  if (!ts.isObjectLiteralExpression(u)) return undefined;
  return u.properties.flatMap((p) => {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return [{ name: p.name.text, value: p.initializer }];
    if (ts.isShorthandPropertyAssignment(p)) return [{ name: p.name.text, value: p.name }];
    return [];
  });
}

const real = androidLeaseSource(readScannedSource(SRC).code, 'vite-asset-scanner.ts');

describe('android build lease source', () => {
  it('finds exactly one android serial-resolution block (re-aim this guard if it moved)', () => {
    // Matched as a NODE, not a text anchor: #370 added a `&& !isRelease` arm (a release build installs
    // nothing, so it must not consult adb at all), which broke a literal anchor. Any further condition
    // on the same `if`, however it wraps, keeps it aimed.
    expect(real.blocks).toBe(1);
  });

  it('resolves the lease from the machine-wide claims file', () => {
    expect(real.leaseFromClaims, 'resolveBuildAndroidSerial is not handed a leaseSerial computed from ownAdbClaim()').toBe(true);
  });

  it('does NOT read the per-process deviceConnection singleton', () => {
    // The exact regression: process-local state that is blind to the lease the user actually holds.
    expect(real.singletonReads).toEqual([]);
  });

  it('does not import the lease manager for its connection state at all', () => {
    // `reclaimStaleDeviceStateAtStartup` is a legitimate import from that module (a startup sweep,
    // not lease state), so this pins the SYMBOL rather than the module path.
    expect(real.moduleImported, 'nothing imports ./backend/deviceConnection — re-aim this guard').toBe(true);
    expect(real.singletonImports).toEqual([]);
  });

  const scan = (body: string) => androidLeaseSource(body, 'fixture.ts');
  const BLOCK = (lease: string, extra = '') => `
    if (platform === 'android'
      && !isRelease) {
      ${lease}
      const picked = resolveBuildAndroidSerial(listAndroidDevices(), { projectPin, leaseSerial });
      ${extra}
    }
    const adb = 'adb';`;

  it('reads each fact from its own node (#1179)', () => {
    const good = scan(`import { reclaimStaleDeviceStateAtStartup } from './backend/deviceConnection';
      ${BLOCK('const ownClaim = ownAdbClaim();\n      const leaseSerial = ownClaim ? adbSerialOf(ownClaim.deviceId) : undefined;')}`);
    expect(good).toEqual({ blocks: 1, leaseFromClaims: true, singletonReads: [], moduleImported: true, singletonImports: [] });

    // `ownAdbClaim()` called, and its result not what the resolver gets.
    expect(scan(BLOCK('ownAdbClaim();\n      const leaseSerial = deviceConnection\n        .status()?.serial;')))
      .toMatchObject({ leaseFromClaims: false, singletonReads: ['deviceConnection'] });
    // An aliased, wrapped import of the singleton, read under its alias.
    expect(scan(`import {
        reclaimStaleDeviceStateAtStartup,
        deviceConnection as dc,
      } from './backend/deviceConnection';
      ${BLOCK('const leaseSerial = dc?.status().serial;')}`))
      .toMatchObject({ leaseFromClaims: false, singletonReads: ['dc'], singletonImports: ['deviceConnection as dc'] });
    // A namespace, and a whole-module import(): both reach the singleton.
    expect(scan(`import * as leases from './backend/deviceConnection';
      async function f() { return import('./backend/deviceConnection'); }
      ${BLOCK('const leaseSerial = leases.deviceConnection.status().serial;')}`))
      .toMatchObject({ singletonReads: ['leases.deviceConnection'], singletonImports: ['* as leases', 'import()'] });
    // The claim feeding a DIFFERENT option is not the lease; either spelling order is the android block.
    expect(scan(`if ('android' === platform) { resolveBuildAndroidSerial(d, { projectPin: ownAdbClaim(), leaseSerial: cached }); }`))
      .toMatchObject({ blocks: 1, leaseFromClaims: false });
    // A singleton read OUTSIDE the block that the lease is computed from is still the lease's source (#1179
    // P4 review), and the manager imported with an emitted extension is still the manager.
    expect(scan(`import { deviceConnection as dc } from './backend/deviceConnection.js';
      const cached = dc.status()?.serial;
      const claim = ownAdbClaim();
      ${BLOCK('const leaseSerial = claim ? cached : undefined;')}`))
      .toMatchObject({ leaseFromClaims: true, singletonReads: ['dc'], singletonImports: ['deviceConnection as dc'] });
    // …however that source is bound: a destructure, a later assignment, a function declaration.
    for (const source of [
      'const { serial: cached } = deps.deviceConnection.status() ?? {};',
      'let cached; cached = deps.deviceConnection.status()?.serial;',
      'function cachedSerial() { return deps.deviceConnection.status()?.serial; }\n      const cached = cachedSerial();',
      'let cached; cached ??= deps.deviceConnection.status()?.serial;',
      'let cached; ({ serial: cached } = deps.deviceConnection.status());',
      'let cached; [cached] = [deps.deviceConnection.status()?.serial];',
      'let cached; for (const s of [deps.deviceConnection.status()?.serial]) cached = s;',
      'class Lease { static serial() { return deps.deviceConnection.status()?.serial; } }\n      const cached = Lease.serial();',
    ]) {
      expect(scan(`${source}\n      ${BLOCK('const leaseSerial = ownAdbClaim() ? cached : undefined;')}`).singletonReads, source)
        .toEqual(['deps.deviceConnection']);
    }
    // A parameter's default is what the lease is computed from when no caller passes one.
    expect(scan(`function build(cached = deps.deviceConnection.status()?.serial) {
      ${BLOCK('const leaseSerial = ownAdbClaim() ? cached : undefined;')}
    }`).singletonReads).toEqual(['deps.deviceConnection']);
    // Defaults in a destructure or a destructured parameter, and an expression target of a for-of.
    for (const source of [
      'const { serial: cached = deps.deviceConnection.status()?.serial } = {};',
      'let cached; for (cached of [deps.deviceConnection.status()?.serial]) {}',
    ]) {
      expect(scan(`${source}\n      ${BLOCK('const leaseSerial = ownAdbClaim() ? cached : undefined;')}`).singletonReads, source)
        .toEqual(['deps.deviceConnection']);
    }
    expect(scan(`function build({ cached = deps.deviceConnection.status()?.serial } = {}) {
      ${BLOCK('const leaseSerial = ownAdbClaim() ? cached : undefined;')}
    }`).singletonReads).toEqual(['deps.deviceConnection']);
    // A destructuring KEY is not an assignment to a local of the same name.
    expect(scan(`const serial = pinned; let other;
      ({ serial: other } = deps.deviceConnection.status());
      ${BLOCK('const leaseSerial = ownAdbClaim() ? serial : undefined;')}`).singletonReads).toEqual([]);
    // A type-only import carries no runtime state.
    expect(scan(`import type { deviceConnection } from './backend/deviceConnection';`)).toMatchObject({ moduleImported: false, singletonImports: [] });
  });

  it('…and the block is the android if that resolves the serial — not a neighbour', () => {
    // A singleton read AFTER the block, or in an `else`, is not the block's.
    expect(scan(`${BLOCK('const leaseSerial = ownAdbClaim()?.deviceId;')}
      const other = deviceConnection.status();
      if (platform === 'android') {} else { deviceConnection.status(); }`))
      .toMatchObject({ blocks: 1, leaseFromClaims: true, singletonReads: [] });
    // A non-android condition, an android `if` that resolves nothing, and an `||` do not make a block.
    expect(scan(`if (platform === 'ios') { resolveBuildAndroidSerial(d, { leaseSerial }); }
      if (platform === 'android') { adbDevices(); }
      if (platform === 'android' || force) { resolveBuildAndroidSerial(d, { leaseSerial }); }`).blocks).toBe(0);
  });
});
