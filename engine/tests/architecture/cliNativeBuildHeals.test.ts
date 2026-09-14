/** Both native-build entry points must heal through the ONE sequence, `healNativeProject`
 *  (`engine/plugins/healNativeProject.ts`, #827): the editor's `/api/build` in-process, and
 *  `build-web.mjs --target native`, which is what `npm run build` runs and what `docs/build.md`
 *  presents as the manual EQUIVALENT of Build → iOS/Android Device.
 *
 *  The history is why this is a census and not a courtesy. Games depend on a content-addressed
 *  tarball committed into the project, not on plugin source, so a plugin edit reaches a device only
 *  once it is re-packed and installed; identity settings and engine-required Capacitor deps likewise
 *  only reach a device once healed in. The editor did all of it. `build-web.mjs` did none (#148),
 *  then one step (#150), then lacked the stale-`node_modules` check (#685) — the documented CLI
 *  recipe could ship an IPA/APK with a stale team, a missing plugin or the PREVIOUS native code
 *  while every signal reported success. Each fix copied one more step into one more file.
 *
 *  The sequence's BEHAVIOUR — order, install gating, the unconditional stale check, the claim gate,
 *  the remedy text — is tested once, directly, in `tests/plugins/healNativeProject.test.ts`. What
 *  this file pins is WIRING: each entry point reaches that function, and neither reaches a step of it
 *  directly, because a step called beside the sequence is exactly the hand-copy #827 removed.
 *
 *  ⚠️ Wiring, not behaviour — a source census proves a call is written, not that it runs on the path
 *  that matters (`cliBuildClaims.test.ts` carries the scar where one stayed green through a
 *  deadlock). Driving `build-web.mjs` end to end costs a full tsc + vite build and mutates a real
 *  project, which is why the behaviour lives in the unit suite instead. */

import { describe, it, expect } from 'vitest';
import { expectInOrder, found } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const assetScanner = path.join(repoRoot, 'engine', 'plugins', 'vite-asset-scanner.ts');

/** The steps of the sequence. An entry point calling any of these itself is composing the sequence
 *  by hand again. */
const HEAL_STEPS = /\b(healNativeConfig|ensureCapacitorDeps|vendorEnginePlugins|writeVendorMarker|verifyInstalledMatchesTarball(?:Result)?)\(/;

/** Index of the `}` that closes the brace opened at `openBraceIdx` (which must itself be `{`). */
function matchingBraceEnd(text: string, openBraceIdx: number): number {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('no matching close brace found');
}

describe('build-web.mjs heals through the ONE shared sequence (#148, #150, #685, #827)', () => {
  const src = readScannedSource(buildWeb).code;
  const fnStart = src.indexOf('async function healNativeProject()');
  const fnEnd = fnStart === -1 ? -1 : matchingBraceEnd(src, src.indexOf('{', fnStart));
  const fnBody = src.slice(fnStart, fnEnd);

  it('has its heal function (the anchor every assertion below slices from)', () => {
    expect(fnStart, 'build-web.mjs no longer has `async function healNativeProject()` — re-anchor, do not delete').toBeGreaterThan(-1);
  });

  it('loads healNativeProject.ts through the reason-reporting loader, and calls it', () => {
    expect(fnBody).toMatch(/loadEnginePluginModuleResult\(repoRoot, path\.join\('plugins', 'healNativeProject\.ts'\)\)/);
    expect(fnBody).toMatch(/\.healNativeProject\(projectRoot, repoRoot, platforms,/);
  });

  it('derives platforms through nativeHealPlatforms, so the editor\'s per-platform step is honoured (#1062)', () => {
    expect(fnBody).toMatch(/const platforms = nativeHealPlatforms\(process\.env,/);
  });

  it('calls no step of the sequence directly — anywhere in the script', () => {
    expect(src).not.toMatch(HEAL_STEPS);
  });

  it('gates the heal on the NATIVE target', () => {
    expect(fnBody).toMatch(/target\s*!==\s*'native'/);
  });

  it('heals BEFORE the typecheck, which resolves plugin types out of the project node_modules', () => {
    expectInOrder(src, ['await healNativeProject()', 'tsconfig.app.scoped.json`'], 'the native build');
  });

  it('FAILS the build (throws) on a stale node_modules, a failed install and a Firebase auth manifest refusal (#1062) — never merely logs', () => {
    expect(fnBody).toMatch(/'stale-node-modules'\)\s*throw new Error/);
    expect(fnBody).toMatch(/'install-failed'\)\s*throw new Error/);
    expect(fnBody).toMatch(/'facebook-sdk-manifest'\)\s*throw new Error/);
  });

  it('warns with the reason and RETURNS — never process.exit — when the module cannot load (#714, #731)', () => {
    const ifIdx = fnBody.indexOf('if (!healMod)');
    expect(ifIdx).toBeGreaterThan(-1);
    const branch = fnBody.slice(ifIdx, matchingBraceEnd(fnBody, fnBody.indexOf('{', ifIdx)));
    expect(branch).toMatch(/reason === 'no-esbuild'/);
    expect(branch).toMatch(/console\.warn/);
    expect(branch).toMatch(/return;/);
    expect(branch).not.toMatch(/process\.exit/);
  });
});

describe('the editor /api/build heals through the same sequence (#685 parity, #827)', () => {
  const src = readScannedSource(assetScanner).code;

  it('imports healNativeProject from the shared module and calls it for the build platform', () => {
    expect(src).toMatch(/import\s*\{\s*healNativeProject\s*\}\s*from\s*'\.\/healNativeProject'/);
    expect(src).toMatch(/await healNativeProject\(projectRoot, buildCwd, \[platform\],/);
  });

  it('calls no step of the sequence directly', () => {
    expect(src).not.toMatch(HEAL_STEPS);
  });

  it('names the platform on BOTH scaffold runners too — the auto-scaffold shift()s the plan\'s own step away (#1062)', () => {
    const runners = src.match(/env: \{ \.\.\.buildEnv, MODOKI_ICONS_HANDLED: '1', MODOKI_NATIVE_PLATFORM: platform \?\? '' \}/g) ?? [];
    expect(runners.length, '/api/add-native-target runShell and the /api/build runScaffoldShell').toBe(2);
  });

  it('names the platform on each per-platform build-web step — or an Android build heals iOS too (#1062)', () => {
    for (const [plan, platform] of [['iosPrefixSteps', 'ios'], ['androidPrefixSteps', 'android']] as const) {
      const at = src.indexOf(`const ${plan}: BuildStep[] = [`);
      expect(at, `${plan} is gone — re-anchor`).toBeGreaterThan(-1);
      const step = src.slice(at, src.indexOf('},', src.indexOf("build-web.mjs --target native'", at)));
      expect(step).toContain(`MODOKI_NATIVE_PLATFORM: '${platform}'`);
    }
  });

  it('heals BEFORE the #370 release-file writes — the heal is what gitignores keystore.properties', () => {
    // `healNativeConfig` adds `keystore.properties` to a freshly scaffolded `android/.gitignore`;
    // writing the upload key's passwords first leaves them unignored for as long as the heal takes,
    // or for good if it refuses.
    const heal = found(src.indexOf('await healNativeProject('), 'await healNativeProject(');
    for (const write of ['renderKeystoreProperties(', 'renderExportOptionsPlist(']) {
      const at = found(src.indexOf(write), `${write} (gone? re-anchor)`);
      expect(heal, `the heal runs after ${write}`).toBeLessThan(at);
    }
  });

  it('installs through the abort-aware scaffold shell, not a blocking exec', () => {
    const call = src.indexOf('await healNativeProject(');
    const portsEnd = src.indexOf('});', call);
    expect(src.slice(call, portsEnd)).toMatch(/install:\s*\(why\)\s*=>\s*runScaffoldShell\(/);
  });

  it('ENDS the build on every refusal — the block cannot fall through to the build steps', () => {
    const ifIdx = src.indexOf('if (!heal.ok)');
    expect(ifIdx).toBeGreaterThan(-1);
    const block = src.slice(ifIdx, matchingBraceEnd(src, src.indexOf('{', ifIdx)));
    expect(block).toMatch(/sendStatus\(`FAILED:stale node_modules`|sendStatus\('FAILED:stale node_modules'\)/);
    expect(block).toMatch(/res\.end\(\);\s*return;\s*$/);
    expect(block).not.toMatch(/runScaffoldShell\(|spawnBuildCommand\(|execSync\(/);
  });
});

describe('describeUnreadablePackageJsonWarning (the shared #685/#731 producer)', () => {
  it('names the project root, the #685 check, and why it matters — asserted DIRECTLY, not via a caller', async () => {
    const { describeUnreadablePackageJsonWarning } = await import('../../scripts/staleNodeModulesWarning.mjs');
    const msg = describeUnreadablePackageJsonWarning('/tmp/fixture-project');
    expect(msg).toContain(path.join('/tmp/fixture-project', 'package.json'));
    expect(msg).toMatch(/could not be read or parsed/);
    expect(msg).toContain('#685');
    expect(msg).toMatch(/stale-node_modules check did NOT run/);
    expect(msg).toMatch(/undetected/);
    // No caller-specific prefix baked in here — build-web.mjs adds its own "[build-web] " on top.
    expect(msg.startsWith('[build-web]')).toBe(false);
  });
});

describe('build-web.mjs validates project config before it builds anything (#589 sibling)', () => {
  const src = readScannedSource(buildWeb).code;

  // `/api/build` runs projectBuildConfigErrors (#827) for EVERY target
  // (web/playable/ios/android alike) before its platform branch — vite-asset-scanner.ts's
  // `/api/build` handler. add-native-targets.mjs (#589) added the identical pair before its
  // scaffold. This is the same check's sibling in the third CLI path that reaches a native
  // project unvalidated: `build-web.mjs`, what `npm run build` actually runs and what
  // `docs/build.md` documents as the manual native-build recipe.
  //
  // The BEHAVIOURAL half — that these validators genuinely reject a bad config (an appId with a
  // space, an orientation typo) and pass a good one — is already covered by
  // `cliNativeTargetValidates.test.ts`'s first describe block (#589); not duplicated here.

  it('reaches the shared projectBuildConfigErrors, and neither half of it directly (#827)', () => {
    expect(src).toMatch(/projectBuildConfigErrors\(/);
    expect(src).not.toMatch(/projectConfigUnionErrors\(|validateBuildConfig\(/);
  });

  it('runs the check BEFORE the heal', () => {
    // Loose about HOW, strict about the ordering fact that matters — validation must land before
    // ANY native file gets healed from a config nothing has checked yet. Compared at the CALL sites
    // in the main flow: the two function DEFINITIONS' order in the file says nothing about which runs.
    expectInOrder(src, ['await validateProjectConfig();', 'await healNativeProject();'], 'the native build');
  });

  it('exits non-zero on the error path, without a --force-style bypass', () => {
    const validateCall = src.indexOf('projectBuildConfigErrors(');
    const nextChunk = src.slice(validateCall, validateCall + 400);
    expect(nextChunk).toMatch(/cfgErrors\.length/);
    expect(nextChunk).toMatch(/process\.exit\(1\)/);
    // The issue explicitly leaves a bypass as an owner call — this check must not grow one.
    expect(nextChunk).not.toMatch(/--force/);
  });
});

describe('both editor routes validate through the shared projectBuildConfigErrors (#589, #827)', () => {
  const src = readScannedSource(assetScanner).code;

  it('/api/build and /api/add-native-target each call it, and neither calls a half of it', () => {
    // Two calls: one per route. Fewer means a route stopped validating; a half called directly is
    // the hand-assembled expression #827 removed, which the next check added to the function misses.
    expect(src.match(/projectBuildConfigErrors\(projectRoot\)/g) ?? []).toHaveLength(2);
    expect(src).not.toMatch(/projectConfigUnionErrors\(|validateBuildConfig\(/);
  });
});

// ── #731: validateProjectConfig used to skip in TOTAL SILENCE — `if (!cfgMod) return;` — on a
// source checkout with an incomplete `npm install` exactly as much as on the legitimate
// packaged-editor case, the same null-conflates-absent-with-unknown shape #714 fixed one level up
// in the loader itself (pinned below by the unmodified "loadEnginePluginModule degrades instead of
// throwing" describe block — the reason discriminant itself is not re-tested here). What's new
// here is that build-web.mjs's OWN degrade branch now consumes that reason instead of discarding
// it silently.
describe('build-web.mjs warns (never silently) when the project-config gate cannot load (#731)', () => {
  const src = readScannedSource(buildWeb).code;

  function matchingBraceEnd(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('no matching close brace found');
  }

  const fnStart = src.indexOf('async function validateProjectConfig()');
  const fnEnd = matchingBraceEnd(src, src.indexOf('{', fnStart));

  it('uses loadEnginePluginModuleResult for the load, not the plain null-returning wrapper', () => {
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/loadEnginePluginModuleResult\(repoRoot, path\.join\('plugins', 'load-project-config\.ts'\)\)/);
  });

  it('warns with the reason and RETURNS — never process.exit — when the module cannot load', () => {
    const ifIdx = found(src.indexOf('if (!cfgMod)', fnStart), 'if (!cfgMod) after validateProjectConfig opens');
    expect(ifIdx).toBeLessThan(fnEnd);
    const ifOpenBrace = src.indexOf('{', ifIdx);
    const ifCloseBrace = matchingBraceEnd(src, ifOpenBrace);
    const branch = src.slice(ifIdx, ifCloseBrace);
    expect(branch).toMatch(/reason === 'no-esbuild'/);
    expect(branch).toMatch(/console\.warn/);
    expect(branch).not.toMatch(/process\.exit/);
  });
});

/** #827's census: `engine/scripts/**.mjs` reaches TypeScript through the ONE seam, never a
 *  private copy of it.
 *
 *  This is the recurrence half of that issue, and it is the half with actual evidence behind it.
 *  Two scripts each carried their own bundle-to-temp-and-import — `add-native-targets.mjs` and
 *  `print-toolchain-env.mjs` — and the former's own comment said *"Same approach as
 *  print-toolchain-env.mjs"*, citing the other copy in prose instead of importing it. Nothing was
 *  wrong with either copy; the cost is that a fix to the seam (#714's `…Result` discriminant, the
 *  per-clone temp-file naming) reached one of three implementations.
 *
 *  ⚠️ Wiring, not behaviour. A source census proves a script IMPORTS the seam; it cannot prove the
 *  seam is reached on the path that matters, and `cliBuildClaims.test.ts`'s note above its "build-web.mjs inherits an ancestor claim" block records the scar
 *  where exactly that census stayed green through a deadlock. The behavioural cover is the
 *  no-esbuild subprocess case below, plus running the two scripts by hand.
 *
 *  ⚠️ Scoped to `engine/scripts/**` and that scope is a CLAIM, so here is its limit. The #827
 *  close-out sweep found ONE more instance of this exact shape repo-wide —
 *  `games/wordweave/tools/run.mjs` (bundle to temp, `import(pathToFileURL(...))`, run) — and it is
 *  deliberately NOT in scope: `CLAUDE.md` requires a game to be self-contained, so reaching
 *  `engine/scripts/loadVendorPlugins.mjs` from `games/**` is a portability violation
 *  `gamePortability.test.ts` fails on. The seam is unreachable from a game BY DESIGN, so that copy
 *  is a legitimate second implementation rather than a member of this class. No other instance
 *  exists: `git ls-files | xargs grep -l pathToFileURL` cross-checked against files mentioning
 *  esbuild/outfile returns only the seam itself, the two scripts folded here, the tests, that
 *  wordweave runner, and two non-loaders (`native-dynamic-import.ts`, `stage-vite-config.cjs`).
 *
 *  The allowlist is a CLAIM too, so each entry states why it is not a loader rather than just
 *  naming a file. */
/** The seam itself — structural, not a pardon: `loadVendorPlugins.mjs` IS the one
 *  bundle-to-temp-and-import in the repo, so its specifier is the thing every other script routes
 *  through. Still staleness-checked, which is also what proves the detector is alive. */
const SEAM_SPECIFIERS: readonly string[] = ['engine/scripts/loadVendorPlugins.mjs::esbuild'];

/** Keyed `file::specifier` and counted (#1128) — one row per esbuild specifier a script may name,
 *  measured at ONE each on 2026-09-13. */
const DIRECT_ESBUILD_ALLOWED: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'engine/scripts/build-electron.mjs::esbuild',
    reason: 'Not a loader: it esbuild-BUNDLES Electron main + the MCP entry to shippable `outfile`s. It '
      + 'never imports what it builds, so there is nothing here to route through the seam.',
  },
  {
    item: 'engine/scripts/stage-vite-config.cjs::esbuild',
    reason: 'Not a loader, same category as build-electron.mjs: it esbuild-BUNDLES engine/vite.config.ts to '
      + 'a persistent, shipped engine/vite.config.cjs for the packaged editor (#326). It never '
      + 'imports what it builds.',
  },
  {
    item: 'engine/scripts/migrate-meta-sidecars.mjs::esbuild',
    reason: 'IS a third copy of the mechanism, not merely a third shape — its `execFileSync("npx", '
      + '["esbuild", …])` writes a temp `outFile` which it then `await import(pathToFileURL(outFile))`s: '
      + 'the same bundle-to-temp-and-import, driven through a subprocess. (Cited by SYMBOL, not line '
      + 'number — this branch ruled in a8fb0dfca that a line number rots silently, and docCitations '
      + 'only enforces that under docs/.) Left out of #827 DELIBERATELY (a '
      + 'one-off migration with no preamble and no build claim), which is a scope call, not an '
      + 'absolution: this entry exists so the next sweep reads "deferred", never "not an instance".',
  },
];


describe('no engine/scripts/*.mjs rolls its own esbuild module loader (#827)', () => {
  // Enumerated through git, not a filesystem walk — an untracked stray must not silently widen or
  // narrow the corpus. MEASURED at 89 files today (not the "~30" an earlier version of this comment
  // guessed — it was wrong by ~3x, and a floor set from a guess is not a floor). The corpus spans
  // three directories: `engine/scripts`, `engine/scripts/lib`, `engine/scripts/ota`.
  const scripts = repoFiles({
    under: path.join(repoRoot, 'engine', 'scripts'),
    // `.cjs` too: `engine/scripts/` is not uniformly `.mjs`, and a census that matched only one
    // extension would let a private loader written as `.cjs` evade it entirely. Found by the #827
    // close-out sweep — `stage-vite-config.cjs` sits in this directory and this guard could not see
    // it. `A test file the globs do not match is silent` applies to the SUBJECT corpus too.
    match: /\.(mjs|cjs)$/,
    exclude: ['node_modules'],
    floor: 70,
  });

  it('the corpus is real and includes the two scripts #827 folded', () => {
    // Guards the guard: a filter that silently empties proves nothing about anything.
    const rels = scripts.map((f) => f.rel);
    expect(rels).toContain('engine/scripts/add-native-targets.mjs');
    expect(rels).toContain('engine/scripts/print-toolchain-env.mjs');
    // …and that the corpus reaches BELOW the top level, because the two names above are both at
    // the top: a narrowing that dropped the subdirectories would keep them and clear the floor.
    //
    // ⚠️ MEASURED: that is 8 files (`lib/` 1, `ota/` 7), not the "20-odd" an earlier version of
    // this very comment claimed — which was a guess, in the paragraph whose subject is that a
    // guessed number is not a measurement. 8 is still worth pinning; 20-odd would have had the
    // next reader weighting this check at 2.5x its real cover.
    //
    // Asserted as "some file is nested", not "lib/ exists": `lib/` holds exactly one matching file
    // today, so pinning it by name turns this guard red on an ordinary rename for a reason that
    // has nothing to do with census narrowing. `ota/` is pinned by name because 7 files make it a
    // real cohort rather than a coincidence.
    expect(rels.some((r) => r.split('/').length > 3), 'the corpus no longer reaches below the top level').toBe(true);
    expect(rels.some((r) => r.startsWith('engine/scripts/ota/')), 'ota/ fell out of the corpus').toBe(true);
    // The `.cjs` half of the match is load-bearing (#827 close-out) — pin that it still matches.
    expect(rels.some((r) => r.endsWith('.cjs')), 'the .cjs half of the match stopped matching').toBe(true);
  });

  it('no script names esbuild in code beyond what its allowlist row pays for — counted per specifier (#1128)', () => {
    // ⚠️ Matches the SPECIFIER, not an import STATEMENT, and that is the whole point. The first
    // version of this assertion was
    //     /(?:import|require)\s*\(?\s*\{?[^}\n]*\}?\s*(?:from\s*)?['"]esbuild['"]/
    // whose `[^}\n]*` cannot cross a newline — so `import {\n  build,\n} from 'esbuild';` evaded
    // it completely, and a private loader came back through nothing more exotic than a formatter
    // wrapping one line. Confirmed by planting exactly that: 124 tests passed.
    //
    // A bare specifier match covers far more: the multi-line import, `require`, a dynamic
    // `import('esbuild')`, a backtick specifier, a subpath (`esbuild/lib/main.js`), the
    // `execFileSync('npx', ['esbuild', …])` shell form, and `esbuild-wasm`. It is blunt on purpose
    // — `readScannedSource` returns `.code` with comments STRIPPED, so prose cannot trip it, and a
    // script with a real reason to name esbuild in CODE belongs on the allowlist above, with that
    // reason written down.
    //
    // ⚠️ It is NOT airtight, and an earlier version of this comment claimed it was ("no such
    // seam") — the exact over-claim this repo keeps re-shipping. `import('es' + 'build')` and any
    // variable-held specifier still evade, and no regex closes that. This is a tripwire against
    // the shape that actually recurred twice (a plain import someone reached for because the seam
    // degraded), not a proof of absence.
    //
    // ⚠️ **Counted per SPECIFIER, and the staleness check uses THIS detector (#1128).** The allowlist
    // used to skip a file whole (`.has(rel)`), so a second esbuild specifier added to
    // `build-electron.mjs` — whose reason is "never imports what it builds" — was green; now it is
    // an unexcused occurrence. ⚠️ What the count still CANNOT see: a private loader built on the
    // file's EXISTING `import esbuild from 'esbuild'` (`await esbuild.build({ outfile }); return
    // import(url)`) adds no new specifier, and stays green — confirmed by review. That is the
    // tripwire limit stated above, not something a count closes. And its staleness check matched
    // a bare `/esbuild/`, LOOSER than the ban: a file that lost its real import but kept the word in
    // a string stayed "still uses esbuild". The ledger's over-blessed arm now runs on the same
    // population as the ban, so the two cannot disagree.
    const SPECIFIER = /['"`]esbuild(?:-wasm)?(?:\/[^'"`]*)?['"`]/g;
    const uses: Array<{ item: string; site: string }> = [];
    for (const { rel } of scripts) {
      readScannedSource(path.join(repoRoot, rel)).code.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(SPECIFIER)) {
          const spec = m[0].slice(1, -1);
          uses.push({ item: `${rel}::${spec}`, site: `${rel}:${i + 1} — ${spec}` });
        }
      });
    }
    assertExemptionLedger({
      label: 'DIRECT_ESBUILD_ALLOWED in cliNativeBuildHeals',
      population: uses,
      exempt: DIRECT_ESBUILD_ALLOWED,
      sanctioned: SEAM_SPECIFIERS,
      // Liveness is the seam's own specifier (`sanctioned` is staleness-checked); an exact floor
      // would report every legitimate removal as a dead detector.
      floor: 1,
      fix: 'Load engine TypeScript through loadVendorPlugins.mjs (loadEnginePluginModuleResult, or '
        + 'loadRequiredEngineModules when the caller cannot degrade) — a private copy is #827. A '
        + 'genuine non-loader use goes on the allowlist above, with its reason.',
    });
  });
});

describe('loadRequiredEngineModules THROWS instead of degrading (#827)', () => {
  /** The opposite disposition to the describe below, and it needs its own cover for a specific
   *  reason: the census above is a SOURCE census, so it proves the two CLI scripts *call* this
   *  function and can say nothing about what the function does. Every mutation to the throw
   *  survived the whole suite before these tests existed — deleting the `if (!module) throw` put
   *  the callers straight back to the `Cannot destructure property 'detect' of 'undefined'` deref
   *  the function was written to replace, and the suite stayed green.
   *
   *  `engine/tests` as the repo root is the same `emptyRepo` trick the degrade tests below use: it
   *  contains no `plugins/*.ts`, so the load hits `no-source` without any fixture setup. */
  const emptyRepo = path.join(repoRoot, 'engine', 'tests');
  const rel = path.join('plugins', 'healNativeConfig.ts');

  it('throws rather than returning a null the caller would deref', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs')).rejects.toThrow();
  });

  it('names the caller and the CORRECT reason — the two are not interchangeable', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // ⚠️ The `no-source` and `no-esbuild` branches produce different remedies, and swapping them
    // survives every other assertion in this file while re-shipping exactly #714's confusion (a
    // packaged editor told to check out sources it already has). So this pins WHICH branch fired,
    // not merely that the message is non-empty.
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.toThrow(/a-caller\.mjs cannot run/);
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.toThrow(/is not on disk/);
    // …and specifically NOT the other branch's remedy.
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.not.toThrow(/esbuild could not be imported/);
  });

  it('stops at the FIRST unloadable entry rather than reporting the last', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // Order matters for the message: a caller loading three modules must be told which one is
    // missing. A loop that overwrote the reason, or gathered then reported, would name the wrong
    // file — and `add-native-targets.mjs` loads two.
    await expect(loadRequiredEngineModules(
      emptyRepo,
      [path.join('plugins', 'aaa-first.ts'), path.join('plugins', 'zzz-second.ts')],
      'a-caller.mjs',
    )).rejects.toThrow(/aaa-first\.ts/);
  });

  it('normalises a back-slashed entry path in the message (the win clone)', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // Both callers build the entry with `path.join`, so on Windows it arrives back-slashed and an
    // un-normalised message reads `engine/plugins\addNativeTarget.ts` — half one separator, half
    // the other.
    //
    // ⚠️ This test is the REASON the implementation splits on a separator CLASS rather than
    // `path.sep`. `path.sep` is `/` on POSIX, so the `path.sep` version was an identity here: it
    // could not be exercised or falsified from a Mac, and `docs/windows.md` is explicit that the
    // local gate cannot see Windows — so it would have shipped unverified. Splitting on either
    // separator fixes the same message and makes the back-slashed input drivable from any box.
    await expect(loadRequiredEngineModules(emptyRepo, ['plugins\\nope.ts'], 'a-caller.mjs'))
      .rejects.toThrow(/engine\/plugins\/nope\.ts/);
    await expect(loadRequiredEngineModules(emptyRepo, ['plugins\\nope.ts'], 'a-caller.mjs'))
      .rejects.not.toThrow(/\\/);
  });

  it('returns the namespaces UNMERGED and in the requested order, when they DO load', () => {
    // ⚠️ In a PLAIN `node` subprocess, not inline — the precedent set by the very next describe
    // ('loadEnginePluginModule degrades instead of throwing'), for its reason plus one more. Under vitest, `import('esbuild')`
    // inside the seam FAILS, so an inline version of this test does not exercise the success path
    // at all: it takes the `no-esbuild` branch and throws. (Measured while writing it — the inline
    // form failed with "esbuild could not be imported", which is the branch the tests above
    // already cover.) A subprocess runs the real loader against the real engine sources.
    //
    // The array contract is what `add-native-targets.mjs` destructures POSITIONALLY, so an
    // implementation that merged, or reversed the order, would bind the wrong module to the wrong
    // name at that call site while every source-level assertion stayed green.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-required-modules-'));
    try {
      const seam = path.join(repoRoot, 'engine', 'scripts', 'loadVendorPlugins.mjs');
      const runner = path.join(dir, 'runner.mjs');
      fs.writeFileSync(runner, `
        import { loadRequiredEngineModules } from ${JSON.stringify(pathToFileURL(seam).href)};
        import path from 'node:path';
        const mods = await loadRequiredEngineModules(
          ${JSON.stringify(repoRoot)},
          [path.join('plugins', 'addNativeTarget.ts'), path.join('plugins', 'load-project-config.ts')],
          'a-caller.mjs',
        );
        console.log(JSON.stringify({
          isArray: Array.isArray(mods),
          length: mods.length,
          firstHasScaffold: 'scaffoldNativeTarget' in mods[0],
          secondHasUnionErrors: 'projectConfigUnionErrors' in mods[1],
          firstLeakedSecond: 'projectConfigUnionErrors' in mods[0],
        }));
      `);
      const out = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8', cwd: repoRoot }));
      expect(out.isArray).toBe(true);
      expect(out.length).toBe(2);
      expect(out.firstHasScaffold).toBe(true);
      expect(out.secondHasUnionErrors).toBe(true);
      // Unmerged: entry 0 must NOT carry entry 1's exports.
      expect(out.firstLeakedSecond).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('loadEnginePluginModule degrades instead of throwing', () => {
  it('returns null when there is no source file to load (the packaged editor)', async () => {
    const { loadEnginePluginModule, loadVendorPlugins } = await import('../../scripts/loadVendorPlugins.mjs');
    // An empty dir has no engine/plugins/*.ts — the packaged editor's situation, where `main.ts`
    // has already healed/vendored on project open and a build must not die for it.
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    expect(await loadEnginePluginModule(emptyRepo, path.join('plugins', 'healNativeConfig.ts'))).toBeNull();
    expect(await loadVendorPlugins(emptyRepo)).toBeNull();
  });

  it('loadEnginePluginModuleResult reports WHY (#714) while the old null-returning wrapper is unchanged', async () => {
    const { loadEnginePluginModule, loadEnginePluginModuleResult } = await import('../../scripts/loadVendorPlugins.mjs');
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    const rel = path.join('plugins', 'healNativeConfig.ts');

    const result = await loadEnginePluginModuleResult(emptyRepo, rel);
    expect(result).toEqual({ module: null, reason: 'no-source' });

    // Same input through the old contract must still yield a bare null — proving
    // loadEnginePluginModule is a thin wrapper, not a second implementation that could drift.
    expect(await loadEnginePluginModule(emptyRepo, rel)).toBeNull();
  });

  it('returns no-esbuild when the entry .ts exists but esbuild cannot be imported (the packaged-editor case)', () => {
    // The `no-esbuild` branch is only reachable when the entry file DOES exist (the no-source
    // check above returns first otherwise) and `import('esbuild')` genuinely fails — the
    // packaged-editor case (#714): esbuild is a devDependency, pruned by electron-builder, while
    // the plugin source ships. Faking that hermetically without touching this repo's real
    // node_modules: copy loadVendorPlugins.mjs's OWN source into a scratch dir under the OS temp
    // root, then run it in a PLAIN `node` subprocess (not through vitest/vite-node, whose SSR
    // dynamic-import is resolved through Vite's own module graph and refuses a file outside
    // `server.fs.allow` even past `@vite-ignore`). Node resolves a bare `import('esbuild')` by
    // walking up node_modules directories from the IMPORTING module's own location, not from the
    // `repoRoot` argument passed in — so the copy, sitting outside this repo's ancestry, hits no
    // node_modules/esbuild at all and the import genuinely throws, with the real function running
    // unmodified.
    const importerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-no-esbuild-'));
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-fake-repo-'));
    try {
      const importerPath = path.join(importerDir, 'loadVendorPlugins.mjs');
      fs.copyFileSync(path.join(repoRoot, 'engine', 'scripts', 'loadVendorPlugins.mjs'), importerPath);

      const rel = path.join('plugins', 'fakePlugin.ts');
      fs.mkdirSync(path.join(fakeRepo, 'engine', 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, 'engine', rel), 'export const x = 1;\n');

      const runnerPath = path.join(importerDir, 'runner.mjs');
      fs.writeFileSync(runnerPath, `
        import { loadEnginePluginModule, loadEnginePluginModuleResult } from ${JSON.stringify(pathToFileURL(importerPath).href)};
        const repo = ${JSON.stringify(fakeRepo)};
        const rel = ${JSON.stringify(rel)};
        const result = await loadEnginePluginModuleResult(repo, rel);
        const bare = await loadEnginePluginModule(repo, rel);
        console.log(JSON.stringify({ result, bare }));
      `);

      const output = execFileSync(process.execPath, [runnerPath], { encoding: 'utf8', cwd: importerDir });
      const { result, bare } = JSON.parse(output);

      expect(result).toEqual({ module: null, reason: 'no-esbuild' });
      // Same input through the old contract must still yield a bare null.
      expect(bare).toBeNull();
    } finally {
      fs.rmSync(importerDir, { recursive: true, force: true });
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

/** The THIRD human-facing #685 remedy — the one `npm test` itself prints when lockfile integrity
 *  drifts — lives in vendoredPluginFreshness.test.ts's own failure message. The other two are
 *  guarded above; without this it is the one place a future author can put the footgun back and
 *  have nothing go red. Same rule, same reason: `npm install --package-lock-only` CREATES the
 *  state (#685, measured 2026-09-05), so its ONLY permitted mention is the warning not to run it. */
describe('the lockfile-integrity guard prints the SAFE remedy too', () => {
  const src = readScannedSource(
    path.join(repoRoot, 'engine', 'tests', 'architecture', 'vendoredPluginFreshness.test.ts'),
  ).code;

  it('never offers --package-lock-only as a remedy step', () => {
    const msgIdx = src.indexOf('Lockfile integrity does not match');
    expect(msgIdx).toBeGreaterThan(-1);
    const chunk = src.slice(msgIdx, src.indexOf('.toEqual([])', msgIdx));
    expect(chunk).toMatch(/package-lock\.json/);
    expect(chunk).toMatch(/npm install/);
    const ploCount = (chunk.match(/--package-lock-only/g) ?? []).length;
    expect(ploCount, 'the only permitted mention of --package-lock-only is the "Do NOT reach for" warning — it must never appear as a remedy STEP (#685: it CAUSES this state)').toBe(1);
    expect(chunk).toMatch(/Do NOT reach for[^\n]*--package-lock-only/);

    // ⚠️ The CONDITIONAL third step must survive. Measured (#685 close-out, npm 11.12.1/node v26):
    // on a PLO-poisoned tree — the state the SUPERSEDED remedy left behind — "delete the entry +
    // plain npm install" returns `up to date` and never re-extracts; only removing the package dir
    // repairs it. Dropping step 3 therefore strands exactly the reader who followed the old advice,
    // and every other assertion here would still pass.
    expect(chunk, 'the remedy must keep its conditional rm -rf third step — the only thing that repairs a PLO-poisoned tree (#685)')
      .toMatch(/rm -rf node_modules/);
    expect(chunk, 'step 3 must stay CONDITIONAL — an unconditional rm -rf is not the documented remedy')
      .toMatch(/ONLY if/);
  });
});
