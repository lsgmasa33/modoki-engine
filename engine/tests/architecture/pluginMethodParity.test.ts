/** Guard: for EVERY Capacitor plugin package, the TS contract, the Android plugin class and the iOS
 *  plugin expose EXACTLY the same set of method names, under the same plugin name.
 *
 *  ## The scar
 *
 *  `ModokiIapPlugin.products()` on Android existed and compiled but was MISSING its
 *  `@PluginMethod` annotation since the plugin's first commit. Capacitor indexes plugin methods
 *  by that annotation (`PluginHandle.indexMethods`), so every JS call failed at dispatch with
 *  `"ModokiIap.products() is not implemented on android"`. Court's store could never price
 *  anything on Android and emitted `store_products_failed` on every open. iOS was fine — it had
 *  its `CAPPluginMethod(name: "products")` entry — so the defect was invisible on the platform
 *  where IAP was most exercised. Device-confirmed and fixed 2026-09-03 (#586).
 *
 *  ## Why this is a SOURCE guard and not a compile — and why it covers every package (#992)
 *
 *  ⚠️ **No compiler can catch this class.** `PluginHandle` finds methods at RUNTIME —
 *  `pluginClass.getMethods()` (public only) filtered by `getAnnotation(PluginMethod.class)` — and
 *  `PluginMethod` carries no `@Target`, so javac accepts a MISSING annotation and one on a PRIVATE
 *  helper alike. #992 was filed expecting `test:native`'s `android/class/*` compile legs to catch
 *  both #971 defects; they cannot, and this file is what does. It began hard-wired to
 *  `capacitor-modoki-iap`, the one package that had been bitten, which left the other seven
 *  unguarded against the defect that bit it. The package list is now DISCOVERED
 *  (`discoverPluginPackages`, the same function the native gate uses), so a ninth plugin is covered
 *  the day it is added. ⚠️ That holds only for a plugin with a `Package.swift`, which is what discovery
 *  keys on. Every plugin has one today; an ANDROID-ONLY package with none would be missed here and in
 *  the leg table alike.
 *
 *  It reads the sources as TEXT through the shared scanner (#419/#812 — comments blanked, so a
 *  `@PluginMethod` quoted in prose neither counts nor hides one), then diffs name sets. It cannot
 *  exercise dispatch; only a device run does that. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { REPO_ROOT } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
// @ts-expect-error — .mjs script module, no type declarations by design (it is a build script).
import { discoverPluginPackages, relKey } from '../../scripts/nativePluginLegs.mjs';

// Inherited from Capacitor's base Plugin/CAPPlugin, never annotated/declared by a plugin's own
// methods, and not part of the parity this guards.
const BUILTIN_LISTENER_METHODS = new Set(['addListener', 'removeAllListeners']);

const withoutBuiltins = (names: string[]): Set<string> =>
  new Set(names.filter((n) => !BUILTIN_LISTENER_METHODS.has(n)));

const describeSet = (s: Set<string>): string => `{ ${[...s].sort().join(', ')} }`;

/** A package's source files under `sub`, through the shared git-enumerated corpus (#799/#771/#805)
 *  — never a private readdir walker, which `corpusProducerIsShared.test.ts` rejects. Sorted by path. */
const filesUnder = (pkgRel: string, sub: string, match: RegExp): string[] =>
  // floor 0: the callers' own "expected exactly one …" refusal names the problem better than a floor.
  repoFiles({ under: `${pkgRel}/${sub}`, match, floor: 0 }).map((f: { abs: string }) => f.abs);

/** The body between a `signature` ending in an open bracket and its balancing close. Run on
 *  comment-STRIPPED code, so a bracket inside prose cannot unbalance it. */
function bracketBody(code: string, signature: string, open: string, close: string, where: string): string {
  const start = code.indexOf(signature);
  if (start === -1) throw new Error(`could not find "${signature}" in ${where}`);
  let depth = 1;
  let i = start + signature.length;
  const bodyStart = i;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) depth--;
  }
  if (depth !== 0) throw new Error(`"${signature}" never balances in ${where} — malformed source?`);
  return code.slice(bodyStart, i - 1);
}

/** Method members of an interface body: an identifier, optional generics, then `(` — `purchase(`,
 *  `listen<T>(`. A field (`productId: string;`) has `:` there, and comment lines are already blank. */
function tsMethodNames(interfaceBody: string): string[] {
  return [...interfaceBody.matchAll(/^[ \t]*([a-zA-Z_$][\w$]*)[ \t]*(?:<[^>\n]*>)?[ \t]*\(/gm)].map((m) => m[1]);
}

/** A signature Capacitor can dispatch into: public, void/Unit, exactly one `PluginCall`.
 *  Java `public void x(PluginCall call)`; Kotlin `fun x(call: PluginCall)` (public by default).
 *  Deliberately NOT matched: `private`/`protected`/package-private Java, and `private`/`internal`
 *  Kotlin (`internal` compiles to a mangled name), because `getMethods()` cannot dispatch to them. */
const JAVA_DISPATCHABLE = /^public\s+void\s+(\w+)\s*\(\s*(?:final\s+)?PluginCall\s+\w+\s*\)/;
const KOTLIN_DISPATCHABLE = /^(?:(?:public|override)\s+)*fun\s+(\w+)\s*\(\s*\w+\s*:\s*PluginCall\s*\)/;
const PLUGIN_METHOD = /^@PluginMethod\b(?:\s*\([^)]*\))?\s*(.*)$/;

/**
 * Plugin funcs Capacitor's iOS bridge can actually PERFORM. It looks the method up by
 * `NSSelectorFromString(name + ":")` and asks `responds(to:)` (CapacitorBridge.swift,
 * CAPPluginMethod.m), so the func must be exposed to Objective-C under EXACTLY `name:`. Measured with
 * a compiled NSObject probe (#992 close-out §2d):
 *   - `async` / `throws` rename the selector (`name:completionHandler:` / `name:error:`) → NOT performable
 *   - `@objc(other:)` replaces it → performable only when the explicit selector is `name:`
 *   - `private`, `dynamic`, `@MainActor`, `nonisolated`, a `CAPPluginCall!` parameter → still performable
 * Deliberately no `@objcMembers` shortcut: none exists today, and a file-wide skip would switch the
 * check off for a whole file on a helper class's attribute. A plugin that adopts it goes RED here,
 * loudly, and this function is extended then.
 */
function objcPerformableMethods(swiftCode: string): Set<string> {
  const re = /@objc(?:\(\s*([\w:]+)\s*\))?\s+(?:(?:@\w+(?:\([^)]*\))?|public|open|internal|fileprivate|private|override|final|dynamic|nonisolated)\s+)*func\s+(\w+)\s*\(\s*_\s+\w+\s*:\s*CAPPluginCall\s*!?\s*\)\s*(?:->\s*(?:Void|\(\))\s*)?(\S)/g;
  const out = new Set<string>();
  for (const [, selector, name, next] of swiftCode.matchAll(re)) {
    if (next !== '{') continue;                        // `async`, `throws`, a return type: not `name:`
    if (selector && selector !== `${name}:`) continue; // an explicit selector must be exactly `name:`
    out.add(name);
  }
  return out;
}

interface Surface {
  jsName: string;
  tsMethods: Set<string>;
  androidFile: string;
  androidName: string | null;
  androidMethods: Set<string>;
  /** `@PluginMethod`s that do not sit on a dispatchable method — #971's private-helper shape. */
  deadAnnotations: string[];
  iosFile: string;
  /** The stripped code of the file declaring `pluginMethods` ONLY. ⚠️ Joining every Swift file under
   *  `ios/Sources` let a same-named `@objc func` in an unrelated helper class satisfy the plugin's
   *  entry, which is a silent pass on a method that never answers (#992 close-out review, compiled
   *  probe). Scoped to one file, a plugin method in an extension ELSEWHERE goes red instead: loud,
   *  and the right direction to be wrong in. */
  iosSwiftCode: string;
  iosName: string | null;
  iosMethods: Set<string>;
}

function readSurface(pkgAbs: string): Surface {
  const rel = relKey(REPO_ROOT, pkgAbs) as string;

  // TS: `registerPlugin<Iface>('JsName', …)` names both the interface to read and the plugin name.
  const indexCode = readScannedSource(path.join(pkgAbs, 'src', 'index.ts')).code;
  const reg = /registerPlugin<\s*(\w+)\s*>\(\s*['"]([^'"]+)['"]/.exec(indexCode);
  if (!reg) throw new Error(`${rel}/src/index.ts has no registerPlugin<Interface>('Name') call`);
  const [, iface, jsName] = reg;
  const defsCode = readScannedSource(path.join(pkgAbs, 'src', 'definitions.ts')).code;
  const tsMethods = withoutBuiltins(tsMethodNames(
    bracketBody(defsCode, `export interface ${iface} {`, '{', '}', `${rel}/src/definitions.ts`),
  ));

  // Android: the ONE class carrying @CapacitorPlugin.
  const androidCandidates = filesUnder(rel, 'android/src/main', /\.(?:java|kt)$/)
    .map((f) => ({ f, code: readScannedSource(f).code }))
    .filter(({ code }) => /@CapacitorPlugin\b/.test(code));
  if (androidCandidates.length !== 1) {
    throw new Error(`${rel}: expected exactly one @CapacitorPlugin class under android/src/main, found ${androidCandidates.length}`);
  }
  const { f: androidFile, code: androidCode } = androidCandidates[0];
  const androidName = /@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/.exec(androidCode)?.[1] ?? null;
  const dispatchable = androidFile.endsWith('.kt') ? KOTLIN_DISPATCHABLE : JAVA_DISPATCHABLE;
  // Blank lines are what the scanner leaves where comments were — skip them, so an annotation above
  // a doc comment still reads as directly preceding its method.
  const lines = androidCode.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const androidNames: string[] = [];
  const deadAnnotations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ann = PLUGIN_METHOD.exec(lines[i]);
    if (!ann) continue;
    // The signature is the rest of this line, else the next line that is not another annotation.
    let sig = ann[1];
    let j = i;
    while (!sig && j + 1 < lines.length) {
      j++;
      if (!lines[j].startsWith('@')) sig = lines[j];
    }
    const m = dispatchable.exec(sig);
    if (m) androidNames.push(m[1]);
    else deadAnnotations.push(`${path.basename(androidFile)}: @PluginMethod on \`${sig}\``);
  }

  // iOS: the Swift file declaring the `pluginMethods` array.
  const iosSources = filesUnder(rel, 'ios/Sources', /\.swift$/).map((f) => ({ f, code: readScannedSource(f).code }));
  const iosCandidates = iosSources.filter(({ code }) => code.includes('let pluginMethods: [CAPPluginMethod] = ['));
  if (iosCandidates.length !== 1) {
    throw new Error(`${rel}: expected exactly one Swift file declaring pluginMethods under ios/Sources, found ${iosCandidates.length}`);
  }
  const { f: iosFile, code: iosCode } = iosCandidates[0];
  const iosBody = bracketBody(iosCode, 'let pluginMethods: [CAPPluginMethod] = [', '[', ']', path.basename(iosFile));

  return {
    jsName,
    tsMethods,
    androidFile,
    androidName,
    androidMethods: withoutBuiltins(androidNames),
    deadAnnotations,
    iosFile,
    iosSwiftCode: iosCode,
    iosName: /jsName\s*=\s*"([^"]+)"/.exec(iosCode)?.[1] ?? null,
    iosMethods: withoutBuiltins([...iosBody.matchAll(/CAPPluginMethod\(name:\s*"([^"]+)"/g)].map((m) => m[1])),
  };
}

const packages = (discoverPluginPackages(REPO_ROOT) as string[]).map((abs) => [relKey(REPO_ROOT, abs) as string, abs] as const);

describe('plugin method parity covers every discovered package (#992)', () => {
  it('discovers packages at all, including the one that was bitten', () => {
    // An empty discovery would make every describe.each below vanish and this file pass on nothing.
    // `capacitor-modoki-iap` is engine-owned, so it exists in the OSS snapshot too.
    expect(packages.map(([rel]) => rel)).toContain('engine/packages/capacitor-modoki-iap');
  });
});

describe('objcPerformableMethods — what Capacitor iOS can actually perform as `name:` (#992 close-out §2d)', () => {
  // Every case below was measured with a compiled NSObject probe (`responds(to: "x:")`), not reasoned.
  const one = (decl: string) => [...objcPerformableMethods(`class P: CAPPlugin {\n  ${decl}\n}`)];

  it.each([
    ['plain', '@objc func x(_ call: CAPPluginCall) {'],
    ['public', '@objc public func x(_ call: CAPPluginCall) {'],
    ['private (still in the ObjC runtime)', '@objc private func x(_ call: CAPPluginCall) {'],
    ['dynamic', '@objc dynamic func x(_ call: CAPPluginCall) {'],
    ['an attribute between', '@objc @MainActor func x(_ call: CAPPluginCall) {'],
    ['nonisolated', '@objc nonisolated func x(_ call: CAPPluginCall) {'],
    ['an implicitly-unwrapped call', '@objc func x(_ call: CAPPluginCall!) {'],
    ['an explicit selector that IS name:', '@objc(x:) func x(_ call: CAPPluginCall) {'],
    ['@objc on its own line', '@objc\n  func x(_ call: CAPPluginCall) {'],
    ['an explicit -> Void', '@objc func x(_ call: CAPPluginCall) -> Void {'],
  ])('ACCEPT: %s', (_label, decl) => {
    expect(one(decl)).toEqual(['x']);
  });

  it.each([
    ['async (selector becomes x:completionHandler:)', '@objc func x(_ call: CAPPluginCall) async {'],
    ['throws (selector becomes x:error:)', '@objc func x(_ call: CAPPluginCall) throws {'],
    ['an explicit selector that is NOT name:', '@objc(xSel:) func x(_ call: CAPPluginCall) {'],
    ['no @objc at all', 'func x(_ call: CAPPluginCall) {'],
  ])('REJECT: %s', (_label, decl) => {
    expect(one(decl)).toEqual([]);
  });
});

describe.each(packages)('%s: TS / Android / iOS plugin methods stay in parity', (_rel, abs) => {
  let cached: Surface | undefined;
  const surface = (): Surface => (cached ??= readSurface(abs));

  it('extracted every set from real source — a broken extractor cannot pass the checks below vacuously', () => {
    const s = surface();
    expect(s.tsMethods.size, 'extracted 0 TS methods — extractor is broken').toBeGreaterThan(0);
    expect(s.androidMethods.size, `extracted 0 dispatchable @PluginMethod methods from ${s.androidFile}`).toBeGreaterThan(0);
    expect(s.iosMethods.size, `extracted 0 CAPPluginMethod entries from ${s.iosFile}`).toBeGreaterThan(0);
  });

  it('registers ONE plugin name on all three sides', () => {
    // A mismatch is the same symptom as a missing annotation — "not implemented on <platform>" — for
    // every method at once, and it compiles just as happily.
    const s = surface();
    expect({ android: s.androidName, ios: s.iosName }).toEqual({ android: s.jsName, ios: s.jsName });
  });

  it('TS definitions.ts and Android @PluginMethod-annotated methods match', () => {
    const s = surface();
    const onlyInTs = [...s.tsMethods].filter((n) => !s.androidMethods.has(n));
    const onlyInAndroid = [...s.androidMethods].filter((n) => !s.tsMethods.has(n));
    expect(
      { onlyInTs, onlyInAndroid },
      `TS methods ${describeSet(s.tsMethods)} vs Android @PluginMethod methods ${describeSet(s.androidMethods)} — `
        + 'a method declared in definitions.ts with no dispatchable `@PluginMethod` on Android dispatches '
        + 'nowhere (exactly how products() broke); the reverse means Android exposes something JS has no contract for.',
    ).toEqual({ onlyInTs: [], onlyInAndroid: [] });
  });

  it('TS definitions.ts and iOS CAPPluginMethod entries match', () => {
    const s = surface();
    const onlyInTs = [...s.tsMethods].filter((n) => !s.iosMethods.has(n));
    const onlyInIos = [...s.iosMethods].filter((n) => !s.tsMethods.has(n));
    expect(
      { onlyInTs, onlyInIos },
      `TS methods ${describeSet(s.tsMethods)} vs iOS pluginMethods ${describeSet(s.iosMethods)} — a method `
        + 'declared in definitions.ts with no `CAPPluginMethod(name:)` entry on iOS dispatches nowhere; the '
        + 'reverse means iOS exposes something JS has no contract for.',
    ).toEqual({ onlyInTs: [], onlyInIos: [] });
  });

  it('every iOS pluginMethods entry has an @objc func Capacitor can perform', () => {
    // The iOS twin of the missing-annotation defect, and just as invisible to a compile. The bridge
    // dispatches by `NSSelectorFromString(name + ":")` + `responds(to:)` (CapacitorBridge.swift), so a
    // `CAPPluginMethod(name: "x")` whose `func x(_ call: CAPPluginCall)` lacks `@objc` builds cleanly
    // and answers "not implemented" at runtime. `ios/class/*` cannot see that; this can.
    const s = surface();
    const performable = objcPerformableMethods(s.iosSwiftCode);
    expect(
      [...s.iosMethods].filter((n) => !performable.has(n)),
      `${path.basename(s.iosFile)}: pluginMethods entries with no func Capacitor can perform as \`name:\``,
    ).toEqual([]);
  });

  it('every @PluginMethod sits on a method Capacitor can dispatch to', () => {
    // #971's shape: `rejectWithBilling`, a PRIVATE helper, carried a stray `@PluginMethod` until
    // `2d711ee05`. It changes nothing at runtime — `getMethods()` never sees it — which is exactly why
    // it is worth failing on: an annotation that indexes nothing says the author believed something
    // about dispatch that is false, and the method they meant to annotate may be the one missing it.
    expect(surface().deadAnnotations).toEqual([]);
  });
});
