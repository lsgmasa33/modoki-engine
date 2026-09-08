/** The CLI native build must run the SAME three in-process heals as the editor's `/api/build`
 *  before its shell steps: `healNativeConfig` → `ensureCapacitorDeps` → `vendorEnginePlugins`
 *  (#148 landed the third alone; #150 closes the remaining gap).
 *
 *  Games depend on a content-addressed tarball committed into the project, not on the plugin
 *  source — so a plugin edit reaches a device only once that tarball is re-packed and installed.
 *  Likewise machine/identity settings (iOS DEVELOPMENT_TEAM) and engine-required Capacitor deps
 *  only reach a device once they're healed into the project. The editor's `/api/build` did all
 *  three; `build-web.mjs` (what `npm run build` actually runs, and what `docs/build.md` presents
 *  as the manual EQUIVALENT of Build → iOS/Android Device) did none, then only the vendor step
 *  (#148). Result: the documented CLI recipe could produce an IPA/APK signed with a stale team,
 *  missing a newly-required Capacitor plugin, or containing the PREVIOUS native code — while
 *  every signal reported success. Measured on `games/audio-demo`, whose vendor pin only moved
 *  once `vendor-plugins.mjs` was run by hand.
 *
 *  Why a SOURCE assertion rather than a behavioural one. Driving `build-web.mjs` end to end costs
 *  a full tsc + vite build and mutates a real project's `package.json`/`plugins/`/`node_modules`
 *  — far too heavy for `npm test`. `vendoredPluginFreshness.test.ts` already asserts the STATE
 *  this protects (no project pins a stale hash); what has no other guard is the WIRING, and the
 *  wiring is exactly what was missing for as long as the bug existed. Same posture as
 *  `reapScoping.test.ts`, which pins `pkill` patterns by source for the same reason.
 *
 *  Kept deliberately loose about HOW (any call shape passes) and strict about the facts that
 *  broke: each heal is reachable at all, gated on the native target, and — for #150's ordering
 *  trap — `ensureCapacitorDeps` runs BEFORE `vendorEnginePlugins` (vendoring rewrites the
 *  placeholder `capacitor-game-debug` spec that `ensureCapacitorDeps` writes; the other order
 *  around, the placeholder is never rewritten). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const assetScanner = path.join(repoRoot, 'engine', 'plugins', 'vite-asset-scanner.ts');

describe('build-web.mjs heals the native project on --target native (#148, #150)', () => {
  const src = readScannedSource(buildWeb).code;

  it('imports the generalized engine-plugin loader', () => {
    expect(src).toMatch(/import\s*\{[^}]*loadEnginePluginModule[^}]*\}\s*from\s*'\.\/loadVendorPlugins\.mjs'/);
  });

  it('calls healNativeConfig', () => {
    expect(src).toContain('healNativeConfig(');
  });

  it('calls ensureCapacitorDeps', () => {
    expect(src).toContain('ensureCapacitorDeps(');
  });

  it('calls vendorEnginePlugins', () => {
    expect(src).toContain('vendorEnginePlugins(');
  });

  it('runs ensureCapacitorDeps BEFORE vendorEnginePlugins (the placeholder-rewrite ordering trap)', () => {
    // ensureCapacitorDeps writes a PLACEHOLDER capacitor-game-debug spec; vendorEnginePlugins
    // rewrites that placeholder to the real file: tarball spec. Vendoring first means the
    // placeholder is never rewritten.
    const depsCall = src.indexOf('ensureCapacitorDeps(');
    const vendorCall = src.indexOf('vendorEnginePlugins(');
    expect(depsCall).toBeGreaterThan(-1);
    expect(vendorCall).toBeGreaterThan(-1);
    expect(depsCall).toBeLessThan(vendorCall);
  });

  it('installs the project when EITHER heal actually changed something', () => {
    // A fresh tarball or a newly-added dep spec is inert until installed — stopping short of
    // install would leave the exact stale artifact this is about, one step later. Gating on
    // only one of the two conditions would silently skip the other's install.
    expect(src).toMatch(/depsChanged\s*\|\|\s*v\?\.needsInstall/);
    expect(src).toContain('npm install');
    expect(src).toContain('writeVendorMarker(');
  });

  it('does not skip the install just because the VENDOR module could not be loaded', () => {
    // The install must be gated on what CHANGED, never on which module happened to load. An
    // early `return` when `vendorEnginePlugins` is unavailable would abandon deps that step 2
    // had already written into package.json — leaving the project claiming a dependency that is
    // not on disk, the same silent-success shape as the bug this whole guard is about.
    const installCall = src.indexOf("execSync('npm install'");
    const vendorLoad = src.indexOf("loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'vendorPlugins.ts'))");
    expect(installCall).toBeGreaterThan(-1);
    expect(vendorLoad).toBeGreaterThan(-1);
    // Nothing between loading the vendor module and the install may bail out on it being null.
    expect(src.slice(vendorLoad, installCall)).not.toMatch(/if\s*\(\s*!vendorMod\s*\)\s*return/);
  });

  it('gates the heal on the NATIVE target', () => {
    // Every heal here is a native-artifact concern: a web/playable build has nothing to keep
    // fresh and must not pay the cost (nor mutate the project) for it.
    expect(src).toMatch(/target\s*!==\s*'native'/);
  });

  it('runs the heal BEFORE the typecheck', () => {
    // The typecheck resolves the plugin's types out of the project's node_modules, so a heal
    // landing after it would be checked against the old copy.
    const healCall = src.indexOf('await healNativeProject()');
    const tscCall = src.indexOf('tsconfig.app.scoped.json`');
    expect(healCall).toBeGreaterThan(-1);
    expect(tscCall).toBeGreaterThan(-1);
    expect(healCall).toBeLessThan(tscCall);
  });
});

// ── #685: node_modules can hold a PREVIOUS tarball's bytes while every signal step 4's `if` gate
// trusts (the dep spec, the lockfiles, the install marker) agrees the current one is installed —
// so the gate is false and step 4 does nothing. A check placed INSIDE that `if` could therefore
// never fire in the one case it exists for: the exact unreachable-mechanism shape #148/#150
// already burned this file on once (see the file header). This proves the check runs
// UNCONDITIONALLY — structurally, by matching braces, not merely "the string appears somewhere"
// (a naive `toContain` would still pass with the call nested inside the `if`).
describe('build-web.mjs verifies node_modules against the tarball UNCONDITIONALLY, not gated on step 4 (#685)', () => {
  // Comments stripped (#685 FIX 5), through the shared scanner (#812) — a doc-comment mention of
  // the call name would otherwise fool the position-based assertions below.
  const src = readScannedSource(buildWeb).code;

  /** Index of the `}` that closes the brace opened at `openBraceIdx` (which must itself be `{`). */
  function matchingBraceEnd(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error('no matching close brace found');
  }

  // The check's OWN enclosing block (`if (vendorMod) { … }`), computed once and reused by every
  // `it` below that needs to scope a slice — not "anywhere later in the file" (an unrelated step
  // added after this one must not turn a slice red) and not a magic char count (#685 FIX: a
  // constant window either overruns the block or clips it, depending on unrelated edits nearby).
  const blockStart = src.indexOf('if (vendorMod) {');
  const blockEnd = matchingBraceEnd(src, src.indexOf('{', blockStart));

  it('calls verifyInstalledMatchesTarballResult', () => {
    // #731: switched from the plain verifyInstalledMatchesTarball to the Result variant so this
    // step can tell "no problems" apart from "could not even read package.json" and warn instead
    // of reporting the check as clean.
    expect(src).toContain('verifyInstalledMatchesTarballResult(');
  });

  it('the call sits AFTER step 4\'s `if (depsChanged || v?.needsInstall)` block closes, not inside it', () => {
    const ifIdx = src.indexOf('if (depsChanged || v?.needsInstall)');
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = src.indexOf('{', ifIdx);
    expect(openBrace).toBeGreaterThan(-1);
    const closeBrace = matchingBraceEnd(src, openBrace);

    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(closeBrace);
  });

  it('warns (does not throw) when package.json could not be read (#731)', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(blockStart).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(blockStart);
    expect(verifyIdx).toBeLessThan(blockEnd);
    const nextChunk = src.slice(verifyIdx, blockEnd);
    expect(nextChunk).toMatch(/unreadable-package-json/);
    expect(nextChunk).toMatch(/console\.warn/);
  });

  it('throws (does not merely log), documents the SAFE remedy, and never auto-repairs', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(blockStart).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(blockStart);
    expect(verifyIdx).toBeLessThan(blockEnd);
    // Scoped to the check's OWN enclosing block (`if (vendorMod) { … }`), not a magic char count —
    // a constant window either overruns the block (pulling in unrelated later code) or clips it
    // (#685 FIX).
    const nextChunk = src.slice(verifyIdx, blockEnd);
    expect(nextChunk).toMatch(/problems\.length/);
    expect(nextChunk).toMatch(/throw new Error/);
    // The remedy is DOCUMENTED in the message, but the script itself must never execute it.
    // ⚠️ It must be the SAFE remedy: delete the lockfile entry, then a PLAIN `npm install`, with a
    // conditional rm -rf third step. `npm install --package-lock-only` is what CREATES this state
    // (#685, measured 2026-09-05) — a message that recommends it as a STEP walks the reader into an
    // unrecoverable tree, so the only permitted mention of it is a warning not to run it.
    expect(nextChunk).toMatch(/package-lock\.json/);
    expect(nextChunk).toMatch(/npm install/);
    // Robust to SHAPE, not just the one syntactic form the author happened to remove: count every
    // occurrence of the literal string and require exactly one, and require that the one occurrence
    // is inside the "Do NOT reach for" warning — never offered as a numbered remedy STEP.
    const ploCount = (nextChunk.match(/--package-lock-only/g) ?? []).length;
    expect(ploCount, 'the only permitted mention of --package-lock-only is the "Do NOT reach for" warning — it must never appear as a remedy STEP (#685: it CAUSES this state)').toBe(1);
    expect(nextChunk).toMatch(/Do NOT reach for[^\n]*--package-lock-only/);

    // ⚠️ The CONDITIONAL third step must survive. Measured (#685 close-out, npm 11.12.1/node v26):
    // on a PLO-poisoned tree — the state the SUPERSEDED remedy left behind — "delete the entry +
    // plain npm install" returns `up to date` and never re-extracts; only removing the package dir
    // repairs it. Dropping step 3 therefore strands exactly the reader who followed the old advice,
    // and every other assertion here would still pass.
    expect(nextChunk, 'the remedy must keep its conditional rm -rf third step — the only thing that repairs a PLO-poisoned tree (#685)')
      .toMatch(/rm -rf node_modules/);
    expect(nextChunk, 'step 3 must stay CONDITIONAL — an unconditional rm -rf is not the documented remedy')
      .toMatch(/ONLY if/);

    // An unrelated step added after this one that happens to call execSync() must not turn this red
    // (#685 FIX 5).
    const execIdx = src.indexOf('execSync(', verifyIdx);
    expect(execIdx === -1 || execIdx >= blockEnd).toBe(true);
  });
});

// ── #685 PARITY. The editor's `/api/build` and the CLI `--target native` recipe are documented
// as equivalent (docs/build.md), and #148 is exactly what a divergence between them costs: the
// CLI ran NONE of the editor's heals and could ship the PREVIOUS native code with every signal
// reporting success. A guard added to only ONE path recreates that asymmetry — and the editor's
// Build menu is the CANONICAL path (root CLAUDE.md), so a CLI-only guard protects the path
// fewer humans use. This pins both.
describe('the editor /api/build runs the same #685 check as the CLI, unconditionally', () => {
  // Comments stripped (#685 FIX 5), through the shared scanner (#812) — a doc-comment mention of
  // the call name would otherwise fool the position-based assertions below.
  const src = readScannedSource(assetScanner).code;

  function matchingBraceEnd(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('no matching close brace found');
  }

  // The check's OWN enclosing block (`if (stale.length) { … }`), computed once and reused below —
  // not a magic char count (#685 FIX: a constant window either overruns the block or clips it,
  // depending on unrelated edits nearby).
  const blockStart = src.indexOf('if (stale.length)');
  const blockEnd = matchingBraceEnd(src, src.indexOf('{', blockStart));

  it('imports and calls verifyInstalledMatchesTarballResult', () => {
    // #731: switched from the plain verifyInstalledMatchesTarball to the Result variant — see the
    // build-web.mjs describe block above for the same change on the CLI side.
    expect(src).toMatch(/import\s*\{[^}]*verifyInstalledMatchesTarballResult[^}]*\}\s*from\s*'\.\/vendorPlugins'/);
    expect(src).toContain('verifyInstalledMatchesTarballResult(');
  });

  it("the call sits AFTER the install `if (depHeal.changed || v.needsInstall)` block closes, not inside it", () => {
    const ifIdx = src.indexOf('if (depHeal.changed || v.needsInstall)');
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = src.indexOf('{', ifIdx);
    const closeBrace = matchingBraceEnd(src, openBrace);
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(closeBrace);
  });

  it('sends a warning (does not fail the build) when package.json could not be read (#731)', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(-1);
    const chunk = src.slice(verifyIdx, blockStart);
    expect(chunk).toMatch(/unreadable-package-json/);
    expect(chunk).toMatch(/send\(/);
  });

  it('fails the build on a problem, documents the SAFE remedy, and never auto-repairs', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarballResult(');
    expect(blockStart).toBeGreaterThan(-1);
    // Here the call sits BEFORE its own `if (stale.length) { … }` — unlike the build-web.mjs
    // block above, whose call is nested inside `if (vendorMod) { … }`.
    expect(verifyIdx).toBeLessThan(blockStart);
    expect(blockStart).toBeLessThan(blockEnd);
    // Scoped to the check's OWN enclosing block, not a magic char count (#685 FIX).
    const chunk = src.slice(verifyIdx, blockEnd);
    expect(chunk).toMatch(/stale\.length/);
    expect(chunk).toMatch(/res\.end\(\)/);   // the build is ENDED, not merely logged
    expect(chunk).toMatch(/package-lock\.json/); // the remedy is documented to the human…
    // Robust to SHAPE, not just the one syntactic form the author happened to remove: count every
    // occurrence of the literal string and require exactly one, inside the "Do NOT reach for"
    // warning — never offered as a numbered remedy STEP.
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
    // …but never executed: no shell runner between the check and the end of its block.
    expect(chunk).not.toMatch(/runScaffoldShell\(|spawnBuildCommand\(|execSync\(/);
  });
});

// ── #731 equivalence, take 2. The previous version of this block proved the two call sites' own
// STRING LITERALS matched byte for byte (`eval`-ing each extracted argument expression) — a
// text-extraction guard that (a) still passed when the `if` guarding either call was defeated
// (e.g. `if (false && verifyReason === 'unreadable-package-json')` — condition and message both
// intact, still finds and evals the same literal), (b) broke on an unbounded forward `indexOf`
// latching onto an unrelated later call of the same name if the real one were ever deleted, and
// (c) — the fatal one — went RED the moment the fix it was implicitly asking for actually landed:
// extracting the shared text into ONE function, as `staleNodeModulesWarning.mjs`'s own header
// explains, leaves no per-file literal for either side to `eval` at all.
//
// With the text now living in exactly one place, byte-for-byte drift between the two messages is
// no longer a reachable failure mode — there is only one copy to drift from. What replaces the old
// test is REACHABILITY (both files import the shared function and call it, rather than each
// re-inlining its own string) plus a DIRECT test of the producer's own output, below.
describe('build-web.mjs and the editor /api/build share ONE stale-package.json warning producer (#731 equivalence)', () => {
  function matchingBraceEnd(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('no matching close brace found');
  }

  const buildWebSrc = readScannedSource(buildWeb).code;
  const scannerSrc = readScannedSource(assetScanner).code;

  it('both files import describeUnreadablePackageJsonWarning from the shared .mjs module', () => {
    expect(buildWebSrc).toMatch(/import\s*\{\s*describeUnreadablePackageJsonWarning\s*\}\s*from\s*'\.\/staleNodeModulesWarning\.mjs'/);
    expect(scannerSrc).toMatch(/import\s*\{\s*describeUnreadablePackageJsonWarning\s*\}\s*from\s*'\.\.\/scripts\/staleNodeModulesWarning\.mjs'/);
  });

  it('build-web.mjs calls the shared producer, inside console.warn, inside its OWN unreadable-package-json branch', () => {
    const ifIdx = buildWebSrc.indexOf("if (verifyReason === 'unreadable-package-json')");
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = buildWebSrc.indexOf('{', ifIdx);
    const closeBrace = matchingBraceEnd(buildWebSrc, openBrace);
    const branch = buildWebSrc.slice(openBrace, closeBrace);
    // Nested — not merely present somewhere in the branch — so a call that ignores the producer's
    // return value (e.g. a stray `describeUnreadablePackageJsonWarning(projectRoot);` beside an
    // unrelated console.warn) does not pass this.
    expect(branch).toMatch(/console\.warn\([^)]*describeUnreadablePackageJsonWarning\(projectRoot\)/);
  });

  it('the editor route calls the shared producer, inside send(), inside its OWN unreadable-package-json branch', () => {
    const ifIdx = scannerSrc.indexOf("if (staleCheckReason === 'unreadable-package-json')");
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = scannerSrc.indexOf('{', ifIdx);
    const closeBrace = matchingBraceEnd(scannerSrc, openBrace);
    const branch = scannerSrc.slice(openBrace, closeBrace);
    expect(branch).toMatch(/send\(\s*describeUnreadablePackageJsonWarning\(projectRoot\)\s*\)/);
  });
});

describe('describeUnreadablePackageJsonWarning (the shared #685/#731 producer)', () => {
  it('names the project root, the #685 check, and why it matters — asserted DIRECTLY, not via a caller', async () => {
    const { describeUnreadablePackageJsonWarning } = await import('../../scripts/staleNodeModulesWarning.mjs');
    const msg = describeUnreadablePackageJsonWarning('/tmp/fixture-project');
    expect(msg).toContain('/tmp/fixture-project/package.json');
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

  // `/api/build` runs projectConfigUnionErrors + validateBuildConfig for EVERY target
  // (web/playable/ios/android alike) before its platform branch — vite-asset-scanner.ts's
  // `/api/build` handler. add-native-targets.mjs (#589) added the identical pair before its
  // scaffold. This is the same check's sibling in the third CLI path that reaches a native
  // project unvalidated: `build-web.mjs`, what `npm run build` actually runs and what
  // `docs/build.md` documents as the manual native-build recipe.
  //
  // The BEHAVIOURAL half — that these validators genuinely reject a bad config (an appId with a
  // space, an orientation typo) and pass a good one — is already covered by
  // `cliNativeTargetValidates.test.ts`'s first describe block (#589); not duplicated here.

  it('reaches both projectConfigUnionErrors and validateBuildConfig', () => {
    expect(src).toMatch(/projectConfigUnionErrors\(/);
    expect(src).toMatch(/validateBuildConfig\(/);
  });

  it('runs the check BEFORE the first healNativeConfig( call', () => {
    // Same technique as the ensureCapacitorDeps-before-vendorEnginePlugins ordering test above:
    // loose about HOW, strict about the ordering fact that matters — validation must land before
    // ANY native file gets healed from a config nothing has checked yet.
    const unionCall = src.indexOf('projectConfigUnionErrors(');
    const validateCall = src.indexOf('validateBuildConfig(');
    const healConfigCall = src.indexOf('healNativeConfig(');
    expect(unionCall).toBeGreaterThan(-1);
    expect(validateCall).toBeGreaterThan(-1);
    expect(healConfigCall).toBeGreaterThan(-1);
    expect(unionCall).toBeLessThan(healConfigCall);
    expect(validateCall).toBeLessThan(healConfigCall);
  });

  it('exits non-zero on the error path, without a --force-style bypass', () => {
    const validateCall = src.indexOf('validateBuildConfig(');
    const nextChunk = src.slice(validateCall, validateCall + 400);
    expect(nextChunk).toMatch(/cfgErrors\.length/);
    expect(nextChunk).toMatch(/process\.exit\(1\)/);
    // The issue explicitly leaves a bypass as an owner call — this check must not grow one.
    expect(nextChunk).not.toMatch(/--force/);
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
    const ifIdx = src.indexOf('if (!cfgMod)', fnStart);
    expect(ifIdx).toBeGreaterThan(-1);
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
 *  seam is reached on the path that matters, and `cliBuildClaims.test.ts:165` records the scar
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
const DIRECT_ESBUILD_ALLOWED = new Map([
  ['engine/scripts/loadVendorPlugins.mjs',
    'IS the seam — the one bundle-to-temp-and-import in the repo.'],
  ['engine/scripts/build-electron.mjs',
    'Not a loader: it esbuild-BUNDLES Electron main + the MCP entry to shippable `outfile`s. It '
    + 'never imports what it builds, so there is nothing here to route through the seam.'],
  ['engine/scripts/stage-vite-config.cjs',
    'Not a loader, same category as build-electron.mjs: it esbuild-BUNDLES engine/vite.config.ts to '
    + 'a persistent, shipped engine/vite.config.cjs for the packaged editor (#326). It never '
    + 'imports what it builds.'],
  ['engine/scripts/migrate-meta-sidecars.mjs',
    'IS a third copy of the mechanism, not merely a third shape — its `execFileSync("npx", '
    + '["esbuild", …])` writes a temp `outFile` which it then `await import(pathToFileURL(outFile))`s: '
    + 'the same bundle-to-temp-and-import, driven through a subprocess. (Cited by SYMBOL, not line '
    + 'number — this branch ruled in a8fb0dfca that a line number rots silently, and docCitations '
    + 'only enforces that under docs/.) Left out of #827 DELIBERATELY (a '
    + 'one-off migration with no preamble and no build claim), which is a scope call, not an '
    + 'absolution: this entry exists so the next sweep reads "deferred", never "not an instance".'],
]);

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

  it.each(scripts.map((f) => f.rel))('%s does not name esbuild in code', (rel) => {
    if (DIRECT_ESBUILD_ALLOWED.has(rel)) return;
    const code = readScannedSource(path.join(repoRoot, rel)).code;
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
    expect(code, `${rel} names esbuild in code. Load engine TypeScript through loadVendorPlugins.mjs `
      + '(loadEnginePluginModuleResult, or loadRequiredEngineModules when the caller cannot '
      + 'degrade) — a private copy is #827. A genuine non-loader use goes on the allowlist above, '
      + 'with its reason.')
      .not.toMatch(/['"`]esbuild(?:-wasm)?(?:\/[^'"`]*)?['"`]/);
  });

  it('every allowlisted script still exists and still uses esbuild', () => {
    // An allowlist entry for a file that stopped using esbuild is a licence nobody needs, and one
    // for a deleted file hides the next real instance behind a stale name.
    for (const [rel, why] of DIRECT_ESBUILD_ALLOWED) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `${rel} is allowlisted but gone — drop the entry (${why})`).toBe(true);
      expect(readScannedSource(abs).code, `${rel} no longer uses esbuild — drop the entry`)
        .toMatch(/esbuild/);
    }
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
