/** Guard (#1333): every project that ships `@capacitor-community/admob` carries the iOS revenue-unit patch.
 *
 *  The plugin's iOS executors forward `GADAdValue.value` under the key `valueMicros`, but on iOS that
 *  value is an `NSDecimalNumber` in WHOLE currency units, and `.int64Value` truncates it. A $0.0012
 *  impression arrives as `0`, so every iOS `ad_revenue` event reports nothing. Android's
 *  `AdValue.valueMicros` really is micros, and both games' `ads.ts` divide by 1e6 for it. Upstream 8.1.0
 *  (and its `master`, checked 2026-09-17) still has the bug, and the value is lost natively, so no JS
 *  fix can recover it. The fix is a `patch-package` patch per project (owner ruling, 2026-09-17), which
 *  scales the value by 10^6 before truncating, so iOS matches Android's contract.
 *
 *  Why a guard: the patch lives OUTSIDE the tracked tree until `npm install` applies it, and
 *  `patch-package` exits 0 on a failed apply outside CI. So a plugin bump, a regenerated lockfile or
 *  a project that adopts the plugin without the patch all ship zero iOS revenue silently. No off-device
 *  test sees the number; only a Firebase DebugView on an iPhone does.
 *
 *  What a compliant project carries:
 *  - the plugin pinned to an EXACT version (a caret lets npm move under the patch);
 *  - `patches/@capacitor-community+admob+<that version>.patch`, tracked;
 *  - a `postinstall` that runs `patch-package`;
 *  - an installed copy of that version in which EVERY Swift file that sets a `paidEventHandler` is
 *    named by the patch and scales every `adValue.value`. The set is read from the installed plugin,
 *    not from the patch, so a patch that drops a file, or a bump that adds a new executor, goes red.
 *
 *  When upstream fixes it: bump the pin, delete the patch, and replace the per-project checks below
 *  with a floor on the fixed version — do not just delete this file, or the next downgrade is silent.
 *
 *  Layouts: the public snapshot ships no `games/`, and no demo uses AdMob, so the population is
 *  empty there and only the checker's own cases run.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

const repoRoot = path.resolve(__dirname, '../../..');
const PLUGIN = '@capacitor-community/admob';
const SCALED = '.multiplying(byPowerOf10: 6)';

/** Why one patched Swift file still reports the wrong unit; `[]` when it is correct. */
function revenueUnitViolations(swift: string): string[] {
  const out: string[] = [];
  if (!swift.includes('paidEventHandler')) {
    out.push('sets no paidEventHandler — the plugin changed shape; re-read it before trusting the patch');
  }
  const uses = [...swift.matchAll(/\badValue\.value\b/g)];
  if (uses.length === 0) out.push('reads no adValue.value — nothing here reports revenue');
  for (const m of uses) {
    if (!swift.startsWith(SCALED, m.index! + m[0].length)) {
      const line = swift.slice(0, m.index).split('\n').length;
      out.push(`line ${line}: adValue.value is not scaled by 10^6 (whole currency units sent as valueMicros)`);
    }
  }
  return out;
}

/** The plugin files a patch touches, read from its own `diff --git` headers. */
function patchedPluginFiles(patch: string): string[] {
  const prefix = `a/node_modules/${PLUGIN}/`;
  return [...patch.matchAll(/^diff --git (\S+) /gm)]
    .map((m) => m[1])
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

describe('revenueUnitViolations — the Swift checker', () => {
  const OK = `ad.paidEventHandler = { adValue in\n  send(["valueMicros": adValue.value${SCALED}.int64Value])\n}`;

  it('accepts a scaled value', () => {
    expect(revenueUnitViolations(OK)).toEqual([]);
  });

  it.each([
    ['the unpatched upstream line', OK.replace(SCALED, ''), /line 2: adValue\.value is not scaled/],
    ['a different unscaled accessor', OK.replace(`${SCALED}.int64Value`, '.doubleValue'), /not scaled/],
    ['a scale by the wrong power', OK.replace('byPowerOf10: 6', 'byPowerOf10: 3'), /not scaled/],
    ['one scaled use and one not', `${OK}\nlog(adValue.value.int64Value)`, /line 4: /],
    ['no paid handler at all', 'let x = adValue.value' + SCALED, /no paidEventHandler/],
    ['a handler that never reads the value', 'ad.paidEventHandler = { _ in }', /reads no adValue\.value/],
  ])('rejects %s', (_label, swift, reason) => {
    expect(revenueUnitViolations(swift).join('\n')).toMatch(reason);
  });

  it('reads the patched file list from diff headers only', () => {
    const patch = [
      `diff --git a/node_modules/${PLUGIN}/ios/A.swift b/node_modules/${PLUGIN}/ios/A.swift`,
      '--- a/x', '+++ b/x', '+diff --git a/node_modules/other/B.swift b/B.swift',
      `diff --git a/node_modules/${PLUGIN}/ios/C.swift b/node_modules/${PLUGIN}/ios/C.swift`,
    ].join('\n');
    expect(patchedPluginFiles(patch)).toEqual(['ios/A.swift', 'ios/C.swift']);
  });
});

function admobProjects(): Array<{ rel: string; dir: string; pkg: Record<string, any> }> {
  return discoverProjects(repoRoot)
    .map((p: { root: string; name: string; dir: string }) => ({ rel: `${p.root}/${p.name}`, dir: p.dir }))
    .filter((p) => fs.existsSync(path.join(p.dir, 'package.json')))
    .map((p) => ({ ...p, pkg: JSON.parse(readScannedSource(path.join(p.dir, 'package.json')).code) }))
    .filter((p) => PLUGIN in { ...p.pkg.dependencies, ...p.pkg.devDependencies });
}

/** Every iOS Swift file in an installed plugin that sets a paid-event handler, plugin-relative. */
function installedPaidEventFiles(installed: string): string[] {
  // Node's own recursion, not a hand-rolled walker: node_modules is gitignored, so `repoFiles` cannot list it.
  return (fs.readdirSync(path.join(installed, 'ios'), { recursive: true, encoding: 'utf8' }))
    .filter((f) => f.endsWith('.swift'))
    .map((f) => `ios/${f.split(path.sep).join('/')}`)
    .filter((f) => readScannedSource(path.join(installed, f)).code.includes('paidEventHandler'))
    .sort();
}

describe('every AdMob project carries the iOS revenue-unit patch (#1333)', () => {
  const projects = admobProjects();

  // Accept side, from OUTSIDE the detector: both shipping games serve AdMob (Weaveling #1309, Court #1312).
  it.runIf(hasInternalGames())('games/court and games/wordweave are detected as AdMob projects (accept side)', () => {
    expect(projects.map((p) => p.rel)).toEqual(expect.arrayContaining(['games/court', 'games/wordweave']));
  });

  it.each(projects.length ? projects.map((p) => p.rel) : ['(none in this layout)'])('%s', (rel) => {
    const project = projects.find((p) => p.rel === rel);
    if (!project) return;
    const version = { ...project.pkg.dependencies, ...project.pkg.devDependencies }[PLUGIN] as string;
    expect(version, `${rel}: pin ${PLUGIN} to an exact version, so npm cannot move it under the patch`)
      .toMatch(/^\d+\.\d+\.\d+$/);
    expect(project.pkg.scripts?.postinstall ?? '', `${rel}: a postinstall must run patch-package`)
      .toMatch(/\bpatch-package\b/);

    const patchRel = `${rel}/patches/${PLUGIN.replace('/', '+')}+${version}.patch`;
    const tracked = repoFiles({ under: `${rel}/patches`, floor: 0, includeUntracked: false });
    const patchFile = tracked.find((f: { rel: string }) => f.rel === patchRel);
    expect(patchFile, `${patchRel} must exist and be committed`).toBeDefined();
    const files = patchedPluginFiles(readScannedSource(patchFile!.abs, {
      comments: 'include', reason: 'a unified diff has no comment syntax; its headers are the data',
    }).code);
    expect(files.length, `${patchRel} patches no plugin file`).toBeGreaterThan(0);

    // The INSTALLED copy — what an iOS build compiles. `npm install` (the root postinstall) puts it here.
    const installed = path.join(project.dir, 'node_modules', PLUGIN);
    expect(fs.existsSync(path.join(installed, 'package.json')), `${rel}: ${PLUGIN} is not installed — run npm install`).toBe(true);
    const installedVersion = JSON.parse(readScannedSource(path.join(installed, 'package.json')).code).version;
    expect(installedVersion, `${rel}: installed ${PLUGIN} is not the pinned version — run npm install`).toBe(version);
    const paid = installedPaidEventFiles(installed);
    expect(paid.length, `${rel}: the installed plugin sets no paidEventHandler — it changed shape; re-read it`).toBeGreaterThan(0);
    expect(paid.filter((f) => !files.includes(f)), `${rel}: paid-event files the patch does not cover`).toEqual([]);
    const violations = [...new Set([...files, ...paid])].flatMap((f) =>
      revenueUnitViolations(readScannedSource(path.join(installed, f)).code).map((v) => `${f}: ${v}`));
    expect(violations, `${rel}: the patch is not applied — run \`npm install\` in ${rel} and read patch-package's output`)
      .toEqual([]);
  });
});
