/** Guard: a capacitor plugin's `capacitor` platform block must match how its native source is
 *  ACTUALLY linked, and every concrete file it promises in `files[]` must exist.
 *
 *  ## Why the android-only blocks are correct, not a bug
 *
 *  SPM's static linker **strips a Capacitor plugin class that has no external framework
 *  dependency** — the class compiles, links, and is then absent at runtime, so Capacitor reports
 *  `"GameDebug" plugin is not implemented on ios`. The workaround (docs/native-and-sdks.md,
 *  `engine/plugins/healNativeConfig.ts`) is to bypass SPM entirely for those plugins: the App
 *  target gets a project-relative pbxproj file reference straight to the plugin's `.swift`, and
 *  `MyViewController.swift` calls `bridge?.registerPluginInstance(...)` to keep the class alive.
 *
 *  So for `capacitor-game-debug` and `capacitor-modoki-ota`, `"capacitor": { "android": … }` with
 *  no `ios` entry is DELIBERATE. `cap sync ios` must not add the SPM package, because the class is
 *  already being compiled into the App target — declaring both compiles it twice, into two
 *  modules, giving one `@objc` runtime class name two implementations and (for game-debug) two
 *  `NWListener`s racing to bind :9095.
 *
 *  ⚠️ **This reads like a bug from the manifest alone, and was filed as one** (#368): `cap sync
 *  ios` reports one fewer plugin than `cap sync android`, the package plainly ships iOS Swift, and
 *  the proposed one-line "fix" was to add the `ios` entry. Counting `cap sync` output cannot see
 *  the pbxproj road, so the count is the expected reading, not evidence of a defect. This test is
 *  the thing that says so at the point somebody would change it.
 *
 *  `capacitor-modoki-iap` is the genuine SPM case and correctly declares both platforms — StoreKit
 *  is an external framework dependency, so the linker keeps the class.
 *
 *  The `files[]` half caught the other half of #368: `capacitor-game-debug` promised a
 *  `CapacitorGameDebug.podspec` that does not exist in the package, so the CocoaPods fallback
 *  docs/native-and-sdks.md describes was never actually shipped for it.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasNativeProjects } from '../helpers/repoLayout';

const repoRoot = path.resolve(__dirname, '../../..');
const PKG_DIR = 'engine/packages';

interface PluginPkg {
  name: string;
  dir: string;
  files: string[];
  platforms: string[];
}

function pluginPackages(): PluginPkg[] {
  const dir = path.join(repoRoot, PKG_DIR);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('capacitor-'))
    .map((e) => ({ name: e.name, dir: path.join(dir, e.name) }))
    .filter((p) => fs.existsSync(path.join(p.dir, 'package.json')))
    .map((p) => {
      const json = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
      return {
        ...p,
        files: (json.files ?? []) as string[],
        platforms: Object.keys(json.capacitor ?? {}),
      };
    });
}

/** Does any TRACKED pbxproj compile this package's iOS source directly into an App target?
 *
 *  Tracked-only (`git grep`) on purpose: a generated-but-uncommitted pbxproj would let a stale
 *  working tree vouch for a link that no committed project actually makes.
 *
 *  ⚠️ Matches `<name>/ios/Sources` WITHOUT a `node_modules/` prefix, because there are two
 *  path forms and only one has it. `healNativeConfig.ts`'s `findGameDebugSwift` prefers the
 *  vendored `node_modules/...` copy but FALLS BACK to the in-repo `engine/packages/...` one
 *  for a monorepo project not yet `npm install`ed, and `healIosGameDebugWiring` bakes whichever
 *  it found into the pbxproj. Anchoring on `node_modules/` would read a project healed in that
 *  state as "not compiled into the App target" and silently stop guarding it. */
function compiledIntoAppTarget(name: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', '--', `${name}/ios/Sources`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').some((f) => f.endsWith('project.pbxproj'));
  } catch {
    return false;                       // git grep exits 1 on "no matches" — that is a real answer
  }
}

describe('capacitor plugin platform declarations', () => {
  const pkgs = pluginPackages();

  it('finds plugin packages to check — a vacuous pass is a failure', () => {
    // Floor well under the real count (4 as of 2026-08-27), so only a broken enumeration trips it.
    expect(pkgs.length).toBeGreaterThanOrEqual(3);
    expect(pkgs.some((p) => p.platforms.includes('ios'))).toBe(true);
  });

  // Gated on native content specifically. `scripts/publish-engine-oss.sh` deletes `ios android
  // packages plugins` from every demo it stages, so the public CI snapshot has projects and NO
  // pbxproj — `compiledIntoAppTarget` is false for everything there, and asserting otherwise
  // would go red on the public gate only. `hasAnyProject()` is the wrong gate for the same
  // reason: it reads true on that snapshot.
  it.skipIf(!hasNativeProjects())('sees the pbxproj road it is meant to police', () => {
    expect(pkgs.some((p) => compiledIntoAppTarget(p.name))).toBe(true);
  });

  it('a plugin compiled into the App target does NOT also declare ios', () => {
    const doubled = pkgs
      .filter((p) => compiledIntoAppTarget(p.name) && p.platforms.includes('ios'))
      .map((p) => p.name);
    expect(
      doubled,
      `${doubled.join(', ')}: iOS source is already compiled into the App target via a pbxproj ` +
        `file reference, so declaring "capacitor": { "ios": … } makes cap sync ALSO add the SPM ` +
        `package — the plugin class ends up in two modules. Drop the ios entry, or move the ` +
        `plugin fully onto SPM (see capacitor-modoki-iap) and remove the pbxproj reference from ` +
        `healNativeConfig.ts. See docs/native-and-sdks.md.`,
    ).toEqual([]);
  });

  /** #368's third plugin, which the pbxproj rule above cannot reach.
   *
   *  `capacitor-litert-lm` is compiled into no App target, so `compiledIntoAppTarget` is false
   *  and the doubling rule has nothing to say about it — yet adding `ios` there is just as
   *  wrong, for an unrelated reason: its `LitertLmPlugin.swift` really does `import
   *  MediaPipeTasksGenAI` (it is a full implementation, NOT the stub a stale Package.swift
   *  comment still calls it), the podspec declares that dependency, and `Package.swift` does
   *  not. So an SPM build of the target cannot compile, while `npm run verify` stays green.
   *
   *  The rule, stated generally: if the podspec needs a dependency the SPM manifest lacks, the
   *  package must not claim SPM support. */
  it('a package whose Package.swift lacks a podspec dependency does NOT declare ios', () => {
    const offenders: string[] = [];
    for (const p of pkgs) {
      if (!p.platforms.includes('ios')) continue;
      const podspec = fs.readdirSync(p.dir).find((f) => f.endsWith('.podspec'));
      const manifest = path.join(p.dir, 'Package.swift');
      if (!podspec || !fs.existsSync(manifest)) continue;
      const spm = fs.readFileSync(manifest, 'utf8');
      const deps = [...fs.readFileSync(path.join(p.dir, podspec), 'utf8')
        .matchAll(/s\.dependency\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
        // Capacitor/Cordova arrive through capacitor-swift-pm under different product names.
        .filter((d) => !/^(Capacitor|Cordova)$/.test(d));
      for (const d of deps) if (!spm.includes(d)) offenders.push(`${p.name}: podspec needs ${d}, Package.swift does not declare it`);
    }
    expect(
      offenders,
      `${offenders.join('; ')} — declaring capacitor.ios claims SPM support the manifest cannot `
        + `deliver: cap sync adds the package and the target fails to compile on the missing import.`,
    ).toEqual([]);
  });

  it('every concrete file promised in files[] exists', () => {
    // Directory entries ("dist/", "ios/Sources/") are skipped: `dist/` is a gitignored build
    // output, absent on a fresh clone, so requiring it would fail for the wrong reason.
    const missing: string[] = [];
    for (const p of pkgs) {
      for (const f of p.files) {
        if (f.endsWith('/') || !path.extname(f)) continue;
        if (!fs.existsSync(path.join(p.dir, f))) missing.push(`${p.name}/${f}`);
      }
    }
    expect(missing, `files[] promises a file the package does not ship: ${missing.join(', ')}`).toEqual([]);
  });
});
