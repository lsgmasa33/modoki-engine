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

/** Remove Swift comments while PRESERVING string literals.
 *
 *  A scanner, not a regex, because three separate regex attempts here were each subtly wrong and
 *  each failure disarmed or falsely tripped the guard below:
 *    · a naive line-comment pattern ate the `//` in `https://…/Dep.git`, erasing the dependency
 *      NAME from a manifest that correctly declared it — a false failure that fires exactly when
 *      someone does the right thing;
 *    · guarding it with `[^:]` still lost `https://host//path` (doubled separator) and still
 *      treated `dependencies://x` as code;
 *    · stripping block comments first is blind to `//`, so a `/*` inside a LINE comment ate
 *      forward to the next `*​/` anywhere in the file — the same asymmetry that terminated a
 *      JSDoc in this very file.
 *  Tokenizing is the only thing that gets all of them, and it is 20 lines. Swift block comments
 *  nest, so the depth counter is real rather than defensive. */
export function stripSwiftComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let inLine = false;
  let blockDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }        // keep the newline: lines stay aligned
      i += 1;
    } else if (blockDepth > 0) {
      if (c === '/' && d === '*') { blockDepth += 1; i += 2; }
      else if (c === '*' && d === '/') { blockDepth -= 1; i += 2; }
      else { if (c === '\n') out += c; i += 1; }
    } else if (inString) {
      if (c === '\\') { out += c + (d ?? ''); i += 2; }     // an escape cannot close the literal
      else { if (c === '"') inString = false; out += c; i += 1; }
    } else if (c === '"') { inString = true; out += c; i += 1; }
    else if (c === '/' && d === '/') { inLine = true; i += 2; }
    else if (c === '/' && d === '*') { blockDepth = 1; i += 2; }
    else { out += c; i += 1; }
  }
  return out;
}

/** Podspec dependencies that `Package.swift` does not declare — the reason a package must not
 *  claim `capacitor.ios` (cap sync would add an SPM package whose target cannot compile).
 *
 *  Comments are stripped first: a dependency NAMED in prose is not a declaration, and a guard that
 *  substring-matches raw source is silently disarmed by any comment mentioning the name. That is
 *  not hypothetical — the commit that introduced this rule also wrote an explanatory comment into
 *  `capacitor-litert-lm/Package.swift` naming `MediaPipeTasksGenAI`, and the guard went quiet. */
export function missingSpmDeps(podspecText: string, spmText: string): string[] {
  const code = stripSwiftComments(spmText);
  return [...podspecText.matchAll(/s\.dependency\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    // Capacitor/Cordova reach an SPM target through capacitor-swift-pm under different product
    // names, so their absence from the manifest is expected rather than a defect.
    .filter((d) => !/^(Capacitor|Cordova)$/.test(d))
    .filter((d) => !code.includes(d));
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
      for (const d of missingSpmDeps(
        fs.readFileSync(path.join(p.dir, podspec), 'utf8'),
        fs.readFileSync(manifest, 'utf8'),
      )) offenders.push(`${p.name}: podspec needs ${d}, Package.swift does not declare it`);
    }
    expect(
      offenders,
      `${offenders.join('; ')} — declaring capacitor.ios claims SPM support the manifest cannot `
        + `deliver: cap sync adds the package and the target fails to compile on the missing import.`,
    ).toEqual([]);
  });

  /** The rule above executes its body ZERO times on the shipped tree — `capacitor-modoki-iap` is
   *  the only `ios` declarer and ships no podspec, so every other package `continue`s. It is a
   *  trap set for a future edit, which means the repo state can never exercise it and a broken
   *  rule would look exactly like a clean pass.
   *
   *  ⚠️ It WAS broken exactly that way. The first version substring-matched the raw `Package.swift`,
   *  and the very commit that added it also wrote an explanatory comment into
   *  `capacitor-litert-lm/Package.swift` naming `MediaPipeTasksGenAI` — so the manifest "declared"
   *  the dependency in prose and the guard went quiet. Applying #368's exact one-liner left the
   *  suite green. The mutation check missed it only because it ran BEFORE that comment was written.
   *  Hence fixtures: they exercise the rule directly, so it cannot be disarmed by repo content. */
  describe('missingSpmDeps — the rule itself, on fixtures (it is vacuous against the repo)', () => {
    const POD = `s.dependency 'Capacitor'\ns.dependency 'MediaPipeTasksGenAI'\n`;

    it('flags a dependency the manifest never declares', () => {
      expect(missingSpmDeps(POD, '.package(url: "…/capacitor-swift-pm.git", from: "8.0.0")'))
        .toEqual(['MediaPipeTasksGenAI']);
    });

    it('a dependency named only in a COMMENT does not count as declared', () => {
      const commented = `// Add MediaPipeTasksGenAI here before declaring "ios".\n`
        + `/* MediaPipeTasksGenAI is what the podspec uses. */\n`
        + `.package(url: "…/capacitor-swift-pm.git", from: "8.0.0")`;
      expect(missingSpmDeps(POD, commented)).toEqual(['MediaPipeTasksGenAI']);
    });

    it('a real declaration satisfies it — with a REAL https URL, which contains //', () => {
      expect(missingSpmDeps(POD,
        '.package(url: "https://github.com/google/MediaPipeTasksGenAI.git", from: "1.0.0")',
      )).toEqual([]);
    });

    it('a trailing comment after a real declaration is still stripped', () => {
      expect(missingSpmDeps(POD,
        '.package(url: "https://github.com/google/MediaPipeTasksGenAI.git", from: "1.0.0") // ok',
      )).toEqual([]);
      // …and the comment alone still does not count as a declaration.
      expect(missingSpmDeps(POD, '.package(url: "https://example.com/x.git") // MediaPipeTasksGenAI'))
        .toEqual(['MediaPipeTasksGenAI']);
    });

    // The comment stripper's edges. `^` has no `m` flag, so a comment on a later line is matched
    // via `[^:]` consuming the preceding newline and `$1` restoring it — checked here rather than
    // reasoned about, because that is a non-obvious way for a stripper to be subtly wrong.
    it.each([
      ['comment at the very start', '// MediaPipeTasksGenAI\n.package(url: "https://x/Dep.git")'],
      ['comment on a later line', '.package(url: "https://x/Dep.git")\n// MediaPipeTasksGenAI'],
      ['two consecutive comment lines', '// MediaPipeTasksGenAI\n// MediaPipeTasksGenAIC\n.package(url: "https://x/Dep.git")'],
      ['a URL inside a comment', '// see https://github.com/google/MediaPipeTasksGenAI\n.package(url: "https://x/Dep.git")'],
      ['a URL inside a block comment', '/* https://github.com/google/MediaPipeTasksGenAI */\n.package(url: "https://x/Dep.git")'],
    ])('a name only in a comment never counts as declared — %s', (_label, spm) => {
      expect(missingSpmDeps(`s.dependency 'MediaPipeTasksGenAI'\n`, spm)).toEqual(['MediaPipeTasksGenAI']);
    });

    // The three shapes that defeated the regex versions. Each was VERIFIED broken before the
    // scanner replaced them, so these are regression pins, not speculation.
    it('a `:` adjacent to // is still a comment (regex `[^:]` guard read it as code)', () => {
      expect(missingSpmDeps(POD, 'dependencies:// MediaPipeTasksGenAI')).toEqual(['MediaPipeTasksGenAI']);
    });

    it('a /* inside a LINE comment does not open a block (it ate the file)', () => {
      const src = '// a /* opener\n.package(url: "https://github.com/google/MediaPipeTasksGenAI.git")\n/* real */';
      expect(missingSpmDeps(POD, src)).toEqual([]);
    });

    it('a doubled path separator in a URL does not eat the name', () => {
      expect(missingSpmDeps(POD, '.package(url: "https://github.com//google/MediaPipeTasksGenAI.git")')).toEqual([]);
    });

    it('nested block comments close at the right depth (Swift allows nesting)', () => {
      expect(missingSpmDeps(POD, '/* outer /* inner */ still comment MediaPipeTasksGenAI */')).toEqual(['MediaPipeTasksGenAI']);
    });

    it('Capacitor/Cordova are exempt — they arrive via capacitor-swift-pm under other names', () => {
      expect(missingSpmDeps(`s.dependency 'Capacitor'\ns.dependency 'Cordova'\n`, '')).toEqual([]);
    });
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
