/** The shipped browser floor is a REVIEWED decision with ONE source of truth.
 *
 *  Two separate failures produced the structural tests below, both silent, both found only on
 *  old hardware:
 *
 *  1. Vite 8's default `build.target` is 'baseline-widely-available' → ios16.4. Left implicit,
 *     that made iOS 16.4 the minimum for every game we ship: esbuild emitted ES2022 static
 *     class blocks (three.js uses them), older WebKit failed to PARSE the chunk, the eager
 *     module graph died, and the app hung on the splash with zero JS console output.
 *  2. The native floor and the JS floor were independent hardcoded numbers that DISAGREED —
 *     every pbxproj said 15.0 while the bundle needed 15.4, so the App Store would offer the
 *     game to a device that installs it and then dies on a missing runtime API.
 *
 *  Both found on an iPhone 7 / iOS 15.8.2 (Court, 2026-08-04) — that incident is HISTORY
 *  explaining why the pin exists at all, not the current floor. The floor itself was
 *  subsequently RAISED, deliberately, from the 15.4 that incident produced to **16.4** (owner
 *  decision, 2026-08-04), knowingly dropping the iPhone 7 / 6s / SE1 era. The tests below fail
 *  if the pin is removed, if the JS/native consumers are allowed to drift apart again, or if the
 *  floor value moves without someone reviewing it here.
 *
 *  ⚠️ The current floor (16.4) happens to EQUAL the value failure #1 produced — that is a
 *  coincidence, not a regression. #1 was never about the number: it was about the floor being
 *  IMPLICIT (inherited from a bundler default that moves between majors, and disagreeing with
 *  the native target). 16.4 chosen deliberately, pinned here, and driving both consumers is the
 *  opposite of that bug. Do not "fix" this by lowering the floor. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VITE_CONFIG = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
const PROJECT_CONFIG = fs.readFileSync(path.join(ROOT, 'project-config.ts'), 'utf8');
const HEAL = fs.readFileSync(path.join(ROOT, 'plugins', 'healNativeConfig.ts'), 'utf8');

/** The schema default for `build.iosMinVersion` — the floor every project inherits. */
function defaultIosMinVersion(): number {
  const m = PROJECT_CONFIG.match(/iosMinVersion:\s*'([\d.]+)'/);
  if (!m) throw new Error('build.iosMinVersion default not found in project-config.ts');
  return parseFloat(m[1]);
}

/** The schema default for `build.androidMinSdk` — the Android sibling of `iosMinVersion`. */
function defaultAndroidMinSdk(): number {
  const m = PROJECT_CONFIG.match(/androidMinSdk:\s*(\d+)/);
  if (!m) throw new Error('build.androidMinSdk default not found in project-config.ts');
  return parseInt(m[1], 10);
}

describe('shipped iOS floor', () => {
  it('pins build.target explicitly (never inherits the bundler default)', () => {
    expect(VITE_CONFIG).toMatch(/\n\s*target:\s*\[/);
  });

  it('does not use a moving alias whose meaning drifts between Vite majors', () => {
    const line = VITE_CONFIG.match(/\n\s*target:\s*([^\n]+)/)![1];
    for (const alias of ['baseline-widely-available', 'modules', 'esnext']) {
      expect(line).not.toContain(alias);
    }
  });

  // The bug: two hardcoded numbers, no link between them. The fix is that the JS target is
  // DERIVED from the same config value the native deployment target is.
  it('derives the JS target from build.iosMinVersion, not a second literal', () => {
    const line = VITE_CONFIG.match(/\n\s*target:\s*([^\n]+)/)![1];
    expect(line).toContain('iosMinVersion');
    expect(line).toMatch(/ios\$\{/);
    expect(line).toMatch(/safari\$\{/);
    // A bare `ios15.4`-style literal here would mean the link was quietly severed again.
    expect(line).not.toMatch(/['"`]ios[\d.]+['"`]/);
  });

  it('drives the NATIVE deployment target from the same value', () => {
    expect(HEAL).toContain('IPHONEOS_DEPLOYMENT_TARGET');
    expect(HEAL).toMatch(/healIosDeploymentTarget\(projectRoot,\s*cfg\.build\.iosMinVersion\)/);
  });

  // A pbxproj carries the key once per build configuration; healing only the first leaves
  // Release — the one that ships — on the old floor.
  it('rewrites EVERY deployment-target occurrence, not just the first', () => {
    const fn = HEAL.slice(HEAL.indexOf('function healIosDeploymentTarget'));
    expect(fn).toMatch(/IPHONEOS_DEPLOYMENT_TARGET = \[0-9\.\]\+;\/g/);
  });

  // The floor was raised from 15.4 to 16.4 on 2026-08-04 by owner decision, deliberately
  // dropping the iPhone 7 / 6s / SE1 era (the iPhone 7 tops out at iOS 15.8). That is a
  // reviewed, one-time move — this test pins the CURRENT value so the floor cannot drift
  // again (up OR down) without someone deliberately updating this assertion. 15.4 remains the
  // hard LOWER bound for any future change: esbuild lowers syntax but cannot add missing
  // runtime APIs, and structuredClone / Array.at / Object.hasOwn all land in exactly 15.4, so
  // dropping below it needs polyfills, not just a smaller number.
  it('pins the default iOS floor at 16.4 (reviewed 2026-08-04)', () => {
    expect(defaultIosMinVersion()).toBe(16.4);
  });
});

describe('shipped Android floor', () => {
  // The Android sibling of `iosMinVersion` — 31 (Android 12), reviewed alongside the iOS
  // raise on 2026-08-04. Pinned for the same reason: the value should only move by someone
  // deliberately updating this assertion, not by an unreviewed edit to the default.
  it('pins the default Android floor at API 31 (Android 12, reviewed 2026-08-04)', () => {
    expect(defaultAndroidMinSdk()).toBe(31);
  });

  it('drives the NATIVE minSdkVersion from the same config value (no drift)', () => {
    expect(HEAL).toMatch(/healAndroidMinSdk\(projectRoot,\s*cfg\.build\.androidMinSdk\)/);
  });

  // variables.gradle carries `minSdkVersion` once per project; a bare (non-global) replace
  // would still work today but silently stop healing a duplicated/aliased assignment.
  it('rewrites EVERY minSdkVersion occurrence, not just the first', () => {
    const fn = HEAL.slice(HEAL.indexOf('function healAndroidMinSdk'));
    expect(fn).toMatch(/minSdkVersion\\s\*=\\s\*\\d\+\/g/);
  });
});
