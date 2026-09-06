/** `bootstrap-game-deps.mjs` must vendor engine plugins BEFORE installing a game's deps, and
 *  record the vendor marker only AFTER the install succeeds (#650, the smaller half of that
 *  issue). `engine/electron/main.ts`'s `ensureProjectDeps` already runs vendor → install →
 *  write-marker in that order, with its own comment (`:322-329`) explaining why: vendoring is
 *  what rewrites an engine plugin's dep from the placeholder `"*"` to a real
 *  `file:plugins/<name>-<hash>.tgz`, and those plugins are not on the public npm registry — so
 *  installing first (or never vendoring at all, which is what this script did before #650) means
 *  `npm install` here can resolve a STALE committed tarball spec with no error at all.
 *
 *  Why a SOURCE assertion — same posture as `cliNativeBuildHeals.test.ts` (see its header): this
 *  script runs from the root `postinstall`, over every real project in the repo; actually
 *  exercising the ordering would mean running a real `npm install` per project, far too heavy for
 *  `npm test`. `engine/tests/electron/projectDeps.test.ts` covers `main.ts`'s OWN helpers
 *  (`composeDepsInstallError`, `hasStaleWorkspaceLink`) but — checked while writing this test —
 *  does not itself assert `main.ts`'s vendor-before-install ORDERING behaviourally either; that
 *  fact lives only in `main.ts`'s source today. This is the first behavioural-shape (source-text)
 *  guard for the ordering, on the `bootstrap-game-deps.mjs` side of it. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repoRoot, 'engine', 'scripts', 'bootstrap-game-deps.mjs');
const src = readScannedSource(script).code;

describe('bootstrap-game-deps.mjs vendors before installing (#650)', () => {
  it('loads vendorPlugins.ts through the shared loadVendorPlugins.mjs seam (plain .mjs cannot import TypeScript)', () => {
    expect(src).toMatch(/import\s*\{\s*loadVendorPlugins\s*\}\s*from\s*'\.\/loadVendorPlugins\.mjs'/);
  });

  it('calls vendorEnginePlugins and npmRun([\'install\'...) — the two calls this ordering is about', () => {
    expect(src).toContain('vendorEnginePlugins(');
    expect(src).toMatch(/npmRun\(\['install'/);
  });

  it('runs vendorEnginePlugins BEFORE the install call for each project', () => {
    const vendorIdx = src.indexOf('vendorEnginePlugins(');
    const installIdx = src.indexOf("npmRun(['install'");
    expect(vendorIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(vendorIdx).toBeLessThan(installIdx);
  });

  it('writes the vendor marker AFTER the install call, not before', () => {
    const installIdx = src.indexOf("npmRun(['install'");
    const markerIdx = src.indexOf('writeVendorMarker(');
    expect(installIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(markerIdx);
  });

  it('the marker write sits INSIDE the install\'s own try block (only meaningful once install succeeded)', () => {
    // Loose about HOW (any call shape passes), strict about the ordering fact that matters — same
    // technique as cliNativeBuildHeals.test.ts's ensureCapacitorDeps-before-vendorEnginePlugins
    // check. A marker written after a FAILED install would record a vendor spec nothing actually
    // installed.
    const tryIdx = src.indexOf('console.log(`[bootstrap-game-deps] installing');
    const catchIdx = src.indexOf('} catch (e) {', tryIdx);
    const markerIdx = src.indexOf('writeVendorMarker(');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(tryIdx);
    expect(markerIdx).toBeLessThan(catchIdx);
  });

  it('vendoring failure is non-fatal — the install still runs (a game with no engine plugin still installs fine)', () => {
    const vendorIdx = src.indexOf('vendorEnginePlugins(');
    const installIdx = src.indexOf("npmRun(['install'");
    const between = src.slice(vendorIdx, installIdx);
    expect(between).toMatch(/catch\s*\(e\)\s*\{/);
    // No early `continue`/`return` between a vendoring catch and the install — a caught vendoring
    // error must fall through to the install, not skip it.
    const catchIdx = between.indexOf('catch (e) {');
    // Without this, a miss (e.g. source drifting to `catch(e) {`, which the PRECEDING
    // `toMatch(/catch\s*\(e\)\s*\{/)` above tolerates but this literal `indexOf` does not) makes
    // `catchIdx` -1, `afterCatch` a one-character slice, and the `not.toMatch` below pass
    // VACUOUSLY instead of failing — two coupled edits (the regex above and this literal) would
    // have to move together for this test to keep meaning anything (#682 close-out round 3, NIT 6).
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = between.slice(catchIdx);
    const closeBrace = afterCatch.indexOf('\n  }');
    const catchBody = closeBrace === -1 ? afterCatch : afterCatch.slice(0, closeBrace);
    expect(catchBody).not.toMatch(/\bcontinue\b|\breturn\b/);
  });
});
