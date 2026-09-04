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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const assetScanner = path.join(repoRoot, 'engine', 'plugins', 'vite-asset-scanner.ts');

/** Strip `//…` line comments and `/*…*\/` block comments from `src`, without touching
 *  comment-LOOKING text inside a string/template literal (both subject files contain
 *  `https://` URLs in strings, which a naive regex would truncate mid-line). Tracks
 *  single/double/backtick string state and treats a backslash as escaping the next character, so
 *  a quote-in-a-string doesn't end it early. Not a full JS parser — it only has to survive real
 *  source, not arbitrary JS.
 *
 *  Why this exists (#685 FIX 5): the two describe blocks below locate a call by the first
 *  TEXTUAL occurrence of its name (`src.indexOf('verifyInstalledMatchesTarball(')`). A doc-comment
 *  MENTION of that name — placed after the real block, with the actual call moved inside it —
 *  would satisfy every position-based assertion below while the mechanism itself is unreachable;
 *  a mention placed before the guarding `if` would conversely turn a correct file red. Stripping
 *  comments before locating anything closes both holes. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
        out += src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; } // closing quote
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++; // drop through to the newline, which is kept below
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // keep newlines so nearby line-based reasoning survives
        i++;
      }
      i += 2; // skip the closing */
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe('build-web.mjs heals the native project on --target native (#148, #150)', () => {
  const src = fs.readFileSync(buildWeb, 'utf8');

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
    const vendorLoad = src.indexOf("loadEnginePluginModule(repoRoot, path.join('plugins', 'vendorPlugins.ts'))");
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
  // Comments stripped (#685 FIX 5) — see stripComments' own header for why a doc-comment mention
  // of the call name would otherwise fool the position-based assertions below.
  const src = stripComments(fs.readFileSync(buildWeb, 'utf8'));

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

  it('calls verifyInstalledMatchesTarball', () => {
    expect(src).toContain('verifyInstalledMatchesTarball(');
  });

  it('the call sits AFTER step 4\'s `if (depsChanged || v?.needsInstall)` block closes, not inside it', () => {
    const ifIdx = src.indexOf('if (depsChanged || v?.needsInstall)');
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = src.indexOf('{', ifIdx);
    expect(openBrace).toBeGreaterThan(-1);
    const closeBrace = matchingBraceEnd(src, openBrace);

    const verifyIdx = src.indexOf('verifyInstalledMatchesTarball(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(closeBrace);
  });

  it('throws (does not merely log) when problems are found, and never auto-repairs with rm -rf', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarball(');
    const nextChunk = src.slice(verifyIdx, verifyIdx + 500);
    expect(nextChunk).toMatch(/problems\.length/);
    expect(nextChunk).toMatch(/throw new Error/);
    // The remedy is DOCUMENTED in the message, but the script itself must never execute it.
    expect(nextChunk).toMatch(/rm -rf/);

    // Scoped to the check's OWN enclosing block (`if (vendorMod) { … }`), not "anywhere later in
    // the file" — an unrelated step added after this one that happens to call execSync() must not
    // turn this red (#685 FIX 5).
    const blockStart = src.indexOf('if (vendorMod) {');
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = matchingBraceEnd(src, src.indexOf('{', blockStart));
    expect(verifyIdx).toBeGreaterThan(blockStart);
    expect(verifyIdx).toBeLessThan(blockEnd);
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
  // Comments stripped (#685 FIX 5) — see stripComments' own header for why a doc-comment mention
  // of the call name would otherwise fool the position-based assertions below.
  const src = stripComments(fs.readFileSync(assetScanner, 'utf8'));

  function matchingBraceEnd(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('no matching close brace found');
  }

  it('imports and calls verifyInstalledMatchesTarball', () => {
    expect(src).toMatch(/import\s*\{[^}]*verifyInstalledMatchesTarball[^}]*\}\s*from\s*'\.\/vendorPlugins'/);
    expect(src).toContain('verifyInstalledMatchesTarball(');
  });

  it("the call sits AFTER the install `if (depHeal.changed || v.needsInstall)` block closes, not inside it", () => {
    const ifIdx = src.indexOf('if (depHeal.changed || v.needsInstall)');
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = src.indexOf('{', ifIdx);
    const closeBrace = matchingBraceEnd(src, openBrace);
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarball(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(closeBrace);
  });

  it('fails the build on a problem and never auto-repairs with rm -rf', () => {
    const verifyIdx = src.indexOf('verifyInstalledMatchesTarball(');
    const chunk = src.slice(verifyIdx, verifyIdx + 1300);
    expect(chunk).toMatch(/stale\.length/);
    expect(chunk).toMatch(/res\.end\(\)/);   // the build is ENDED, not merely logged
    expect(chunk).toMatch(/rm -rf/);          // the remedy is documented to the human…
    // …but never executed: no shell runner between the check and the end of its block.
    expect(chunk).not.toMatch(/runScaffoldShell\(|spawnBuildCommand\(|execSync\(/);
  });
});

describe('build-web.mjs validates project config before it builds anything (#589 sibling)', () => {
  const src = fs.readFileSync(buildWeb, 'utf8');

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

describe('loadEnginePluginModule degrades instead of throwing', () => {
  it('returns null when there is no source file to load (the packaged editor)', async () => {
    const { loadEnginePluginModule, loadVendorPlugins } = await import('../../scripts/loadVendorPlugins.mjs');
    // An empty dir has no engine/plugins/*.ts — the packaged editor's situation, where `main.ts`
    // has already healed/vendored on project open and a build must not die for it.
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    expect(await loadEnginePluginModule(emptyRepo, path.join('plugins', 'healNativeConfig.ts'))).toBeNull();
    expect(await loadVendorPlugins(emptyRepo)).toBeNull();
  });
});
