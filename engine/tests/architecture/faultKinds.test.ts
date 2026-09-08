/** The fault-kind vocabulary is declared in FOUR places and must not drift (#278).
 *
 *  `FaultKind` exists twice by necessity — once in `capacitor-game-debug` (the implementation) and
 *  once in `@modoki/engine`'s `faultProvider` seam (the engine cannot depend on the plugin) — and
 *  each kind is then handled by hand in Java and Swift. Nothing in the type system connects the
 *  four, so a kind added on one side and forgotten on another produces exactly the failure this
 *  whole feature exists to eliminate: a probe that looks live and raises nothing.
 *
 *  This is a TEXT guard over source files, which is a weak instrument — it can only see that a
 *  kind is MENTIONED, not that its implementation is correct. It is here for the drift case
 *  (a fifth kind appears in one list), not as evidence any probe works; the only oracle for that
 *  is a real device and a crash console. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readScannedSource(path.join(repoRoot, rel)).code;

const PLUGIN_TS = 'engine/packages/capacitor-game-debug/src/definitions.ts';
const ENGINE_TS = 'engine/packages/modoki/src/runtime/core/faultProvider.ts';
const ANDROID = 'engine/packages/capacitor-game-debug/android/src/main/java/com/modokiengine/capacitor/gamedebug/GameDebugPlugin.java';
const IOS = 'engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift';

/** Pull the string-literal members out of `export type FaultKind = 'a' | 'b';`. */
function faultKinds(source: string, where: string): string[] {
  const m = source.match(/export type FaultKind =([^;]+);/);
  expect(m, `no "export type FaultKind" in ${where}`).toBeTruthy();
  const kinds = [...m![1].matchAll(/'([a-z-]+)'/g)].map((k) => k[1]);
  expect(kinds.length, `no string members in ${where}'s FaultKind`).toBeGreaterThan(0);
  return kinds;
}

describe('fault kinds stay in sync across the four declarations (#278)', () => {
  const pluginKinds = faultKinds(read(PLUGIN_TS), PLUGIN_TS);
  const engineKinds = faultKinds(read(ENGINE_TS), ENGINE_TS);

  it('the plugin and the engine seam declare the same kinds', () => {
    expect([...engineKinds].sort()).toEqual([...pluginKinds].sort());
  });

  it('every kind has a label + a detail line for the Device tab', () => {
    const labels = read(ENGINE_TS);
    for (const kind of engineKinds) {
      expect(labels, `FAULT_LABELS is missing "${kind}"`).toContain(`  ${kind}: {`);
    }
  });

  it('the Android plugin handles every kind by name', () => {
    const java = read(ANDROID);
    for (const kind of pluginKinds) {
      expect(java, `GameDebugPlugin.java does not handle "${kind}"`).toContain(`case "${kind}":`);
    }
  });

  // iOS deliberately supports a SUBSET (crash only) — but it must still name every kind, either to
  // raise it or to reject it with a reason. A kind it has never heard of falls into the default
  // branch and reports "unknown", which reads as a typo rather than as an unsupported platform.
  it('the iOS plugin names every kind — raising it or rejecting it explicitly', () => {
    const swift = read(IOS);
    for (const kind of pluginKinds) {
      expect(swift, `GameDebugPlugin.swift never mentions "${kind}"`).toMatch(new RegExp(`"${kind}"`));
    }
  });
});
