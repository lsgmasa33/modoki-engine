import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import picomatch from 'picomatch';
import { repoIgnoredFiles, repoFiles } from '../../scripts/repoCorpus.mjs';
// ⚠️ electron-builder matches with MINIMATCH (app-builder-lib/out/fileMatcher.js), not picomatch,
// and they disagree in the FALSE-GREEN direction — pinned in the instrument test below. The rules
// in this describe model the real packer, so they use minimatch. The older describe above keeps
// picomatch: its question is 'is this glob over-broad', where the more permissive one is safe.
import { Minimatch } from 'minimatch';
import { hasOssOverlay } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';

const GITIGNORE_AS_DATA = {
  comments: 'include',
  reason: '.gitignore is not source — its `#` lines are data this parser drops by git\'s own rule',
} as const;

const DOC_AS_PROSE = {
  comments: 'include',
  reason: 'CLAUDE.md is Markdown prose, not source — its content is what this guard matches on',
} as const;

/**
 * PACKAGING GUARD — electron-builder.yml packaging contract.
 *
 * The packaged editor runs "Vite in prod": main spawns a Vite dev server that
 * serves the editor shell + the open game from engine/ SOURCE and node_modules on
 * disk, and the packaged web/native BUILD shells out to `node
 * engine/scripts/build-web.mjs` reading the root package.json. None of that works
 * unless the right paths are UNPACKED out of the asar (Vite can't read/exec inside
 * an asar, and a sealed package.json is unreadable → ENOENT). These are prod-only
 * failures a dev run can't surface, so the asarUnpack/files contract is locked here.
 *
 * Concrete regressions this guards:
 *  - package.json sealed in the asar → packaged web build ENOENT ("Connection lost").
 *  - engine/** or node_modules/** left packed → Vite can't serve the shell/deps.
 *  - re-adding a broad `capacitor-*` exclude → drops capacitor-game-debug (engine
 *    debug bridge the editor imports) → white-screen.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cfg = yaml.load(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')) as {
  asar?: boolean;
  asarUnpack?: string[];
  files?: string[];
  extraResources?: Array<{ from: string; to: string }>;
};

describe('electron-builder packaging manifest', () => {
  it('keeps asar enabled with an explicit unpack list', () => {
    expect(cfg.asar).toBe(true);
    expect(Array.isArray(cfg.asarUnpack)).toBe(true);
  });

  it('unpacks everything Vite-in-prod must read as real files on disk', () => {
    const unpack = cfg.asarUnpack ?? [];
    // engine source + node_modules → Vite reads/execs them from app.asar.unpacked/.
    expect(unpack).toContain('**/engine/**');
    expect(unpack).toContain('**/node_modules/**');
    // root package.json + lock must be real files — the packaged web/native build
    // (`node engine/scripts/build-web.mjs`) resolves the editor root by walking up
    // for a package.json; sealed-in-asar → ENOENT.
    expect(unpack).toContain('package.json');
    expect(unpack).toContain('package-lock.json');
  });

  it('ships the engine tree + root package.json', () => {
    const files = cfg.files ?? [];
    expect(files).toContain('engine/**/*');
    expect(files).toContain('package.json');
  });

  it('ships the bundled-tool staging dir (build/bin → resources/bin)', () => {
    // The bundled CLI tools (toktx + ktx.dll, msdf-atlas-gen) are staged into build/bin
    // and shipped as extraResources → resources/bin, where main.ts resolveBundled points
    // MODOKI_TOKTX / MODOKI_MSDF_ATLAS_GEN. Dropping this mapping would silently ship a
    // toolless installer (KTX2 import + MTSDF font bake break on a user's box). See
    // docs/bundle-new-tools.md. The ACTUAL presence of the tools is CI-verified post-build
    // (release-windows.yml "Verify bundled tools"); this locks the config wiring CI feeds into.
    const extra = cfg.extraResources ?? [];
    expect(
      extra.some((e) => e && e.from === 'build/bin' && e.to === 'bin'),
      `electron-builder.yml must ship build/bin → bin (extraResources); got ${JSON.stringify(extra)}`,
    ).toBe(true);
  });

  it('excludes the test suites (dead weight + a stale-copy footgun in release/)', () => {
    // `engine/**/*` swept up 201 test files (~5.9MB) into every install. Worse, `release/`
    // then held a build-time COPY of the suite: vite.config excludes `**/release/**`, but a
    // vitest run given an explicit path or a bare `-t` filter treats it as a filter that
    // RE-INCLUDES excluded files, so build-time-stale tests ran against current source and
    // produced phantom failures. Nothing imports tests at runtime, so they must stay out.
    const files = cfg.files ?? [];
    for (const needle of ['!engine/tests/**', '!engine/packages/*/tests/**']) {
      expect(files, `electron-builder.yml must exclude ${needle}`).toContain(needle);
    }
  });

  it('the test exclude does NOT over-reach into shipped engine code', () => {
    // The counterweight to the test above: `!engine/tests/**` must not become something
    // like `!engine/**/test*/**`, which would also drop engine/templates (New Project) or
    // engine/tools. This exclude list is documented as unverified against a real packaged
    // Vite run — an over-broad entry surfaces as a runtime 404, never a build error.
    //
    // Matched with a REAL glob engine against representative file paths, not a prefix
    // heuristic: a naive "does this dir start with the glob's literal prefix" test reports
    // `!engine/packages/*/tests/**` as dropping `engine/packages/modoki/src/**`, which it
    // plainly does not (that was this test's own first draft, and it failed on it).
    const excludes = (cfg.files ?? []).filter((f) => f.startsWith('!')).map((f) => f.slice(1));
    const mustShip = [
      'engine/app/main.tsx',
      'engine/plugins/vite-asset-scanner.ts',
      'engine/electron/main.ts',
      'engine/templates/starter/CLAUDE.md',
      'engine/tools/modoki-mcp/src/index.ts',
      'engine/packages/modoki/src/editor/createEditor.tsx',
      'engine/packages/modoki/src/runtime/core/clock.ts',
      // engine/vite.config.cjs (gitignored, staged into the source tree only at pack time by
      // stage-vite-config.cjs) is chooseViteConfig()'s ONLY way to avoid the .vite-temp write
      // (#326) in a packaged app — an exclude dropping it silently restores the write this test
      // file's other describe block exists to keep gone. Not present on disk in a dev clone, so
      // this asserts against the GLOB, same as every other entry here, not a real file read.
      'engine/vite.config.cjs',
    ];
    for (const file of mustShip) {
      const hit = excludes.filter((glob) => picomatch.isMatch(file, glob));
      expect(hit, `exclude(s) dropping runtime-shipped ${file}: ${hit.join(', ')}`).toHaveLength(0);
    }
    // …and the excludes we DO want must actually match what they claim to.
    for (const [file, glob] of [
      ['engine/tests/assets/publishExclusions.test.ts', 'engine/tests/**'],
      ['engine/packages/modoki/tests/runtime/clock.test.ts', 'engine/packages/*/tests/**'],
    ] as const) {
      expect(picomatch.isMatch(file, glob), `${glob} should match ${file}`).toBe(true);
    }
  });

  it('does not broadly exclude capacitor plugins the editor imports at runtime', () => {
    // capacitor-game-debug is the engine debug bridge (engine/app/debug/bridge.ts);
    // a broad `!node_modules/capacitor-*/**` would drop it → white-screen. Only the
    // narrow litert-lm exclude (a game plugin pulling ~76MB @mediapipe) is allowed.
    const files = cfg.files ?? [];
    const capExcludes = files.filter((f) => f.startsWith('!') && /capacitor-\*/.test(f));
    expect(capExcludes, `over-broad capacitor exclude(s): ${capExcludes.join(', ')}`).toHaveLength(0);
  });
});

/**
 * PACKAGING GUARD — a gitignored path under a shipped root is CLASSIFIED, never defaulted
 * (#1050, and the third list of #885).
 *
 * `files: engine/**\/*` ships the WORKING TREE, not the repo. Every gitignored build or
 * local-state artifact under `engine/` is packaged, signed and notarized unless a `!` glob in
 * `files` says otherwise — and for most of this repo's life the only ones anyone had thought
 * of were `.vite` and the test suites, each added after a specific incident. The list was a
 * scar record, not a policy.
 *
 * What that cost (#1050, measured on one Mac, same commit, caches present vs moved aside):
 * a local `dist:mac` produced a **1.8 GB** app against CI's 881 MB, because five SwiftPM
 * caches — **731 MB, 9,609 files** — were packaged into `app.asar.unpacked` and then signed
 * one file at a time. `codesign` was still walking
 * `capacitor-modoki-ota/core/.build/debug/index/store/v5/records/…` **58 minutes in**. It has
 * never reached a user (releases are cut on a clean CI runner, which has no such caches), but
 * it bites every developer who builds locally, and a Swift index database inside a signed,
 * notarized bundle is content nobody intended to ship.
 *
 * ## Why this is #885's mechanism, and why its fix could not just be reused
 *
 * #885 — *"two hand-maintained ignore lists must agree, and nothing makes them"* — reconciled
 * `.gitignore` with `engine/eslint.config.js`'s `ignores` behind
 * `tests/architecture/ignoreListsAgree.test.ts`, and closed saying it was about *"the seam
 * that lets the eighth instance happen, not about the seven."* The eighth instance is #1050,
 * on the third list #885 never enumerated.
 *
 * ⚠️ But `files` **cannot be DERIVED from `.gitignore`** the way `ignores` was, and that is
 * the whole design constraint here: `engine/electron/dist/`, `engine/packages/*\/dist/`,
 * `engine/tools/*\/dist/`, `node_modules/` and `engine/vite.config.cjs` are all **gitignored
 * and all REQUIRED at runtime** — the packaged editor spawns
 * `engine/tools/modoki-mcp/dist/index.js` directly, and #326 turns on `vite.config.cjs` being
 * present. "Gitignored" carries no packaging verdict at all.
 *
 * So the rule this guard enforces is not agreement, it is **exhaustive classification**: every
 * `.gitignore` pattern that CAN match under `engine/` carries a row below saying `ship`,
 * `exclude` or `absent`, with the reason. A pattern with no row is a RED — which is what makes
 * the ninth instance a failing test at the moment someone adds the artifact, instead of a
 * 1.8 GB app discovered by hand a year later.
 *
 * ## Two traps this file has to get right
 *
 * ⚠️ **`{ dot: true }` is not cosmetic — without it this file models a packaging config in
 * which #1050 is IMPOSSIBLE.** picomatch will not let a *wildcard* consume a leading dot unless
 * the option is set, and nearly every artifact here is dot-prefixed (`.build`, `.gradle`,
 * `.swiftpm`, `.env`, `.modoki`). So by default `isMatch(<a real .build path>, 'engine/**\/*')`
 * is FALSE: the matcher denies that the include glob picks the caches up at all, while the
 * measurement this whole file exists for is a 1.8 GB app containing 9,609 of exactly those
 * files. ⚠️ The distinction is **wildcard vs literal**, NOT "dot segments are special" — a dot
 * segment written literally in a glob matches either way, which is why every (sample, exclude)
 * pair in the table below happens to be insensitive to the option today. That is a property of
 * how those globs are currently written, not a guarantee, and it is measured rather than
 * assumed: the first draft of this file asserted the broad claim and was RED against picomatch.
 *
 * ⚠️ **Classify by PATTERN, not by what is on this disk.** A clone that has never run the
 * Swift build has no `.build` directory, and a disk-walking guard would pass on CI and on four
 * of the six clones. Only the `absent` rows read the tree, and they can only red — never green
 * — from what they find, so they cannot mask a missing exclusion.
 *
 * SCOPE: the private repo only. The public snapshot's `electron-builder.yml` is rewritten by
 * `scripts/publish-engine-oss.sh` and its tree is a different set of files, so this
 * classification does not describe it.
 */
describe('gitignored paths under engine/ are classified, not defaulted (#1050)', () => {
  /** A `.gitignore` pattern matches under `engine/` if it is unanchored, `**\/`-rooted, or
   *  explicitly `engine/`-scoped. Git anchors any pattern containing a non-trailing `/` to the
   *  file's own directory — the repo root here — so `games/*\/ios/App/Pods/` and
   *  `/build/ota-keys/` cannot reach a shipped path and carry no row. */
  function canMatchUnderEngine(pattern: string): boolean {
    const p = pattern.replace(/\/$/, '');
    if (p.startsWith('/')) return p.startsWith('/engine/');
    if (p.startsWith('**/')) return true;
    return !p.includes('/') || p.startsWith('engine/');
  }

  // #812: read through the shared scanner, declaring that the `#` lines must SURVIVE the read.
  // `.gitignore` is not source — its comments are data this parser drops by git's own rule (a
  // leading `#`, un-escaped), not by a code-comment stripper, and a stripper keyed on file
  // extension would silently take `#`-prefixed PATTERNS with it on some other filename.
  const parseIgnore = (abs: string) => readScannedSource(abs, GITIGNORE_AS_DATA).raw
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));

  // ⚠️ NESTED .gitignore files count. Three live under engine/, and `repoIgnoredFiles` HONOURS
  // them (git does), so a rule reading only the root file would let a nested `.xcodebuild-cache/`
  // become a gitignored artifact under a shipped root with no row, no RED and no `!` glob — the
  // exact #1050 shape. This is not hypothetical: including them immediately surfaced a bare
  // `.build/` (capacitor-appsflyer's and capacitor-game-debug's own spelling of the root's
  // `**/.build/`) that had no row. Ones inside .build/checkouts are skipped — vendored SwiftPM
  // sources in a tree that is excluded wholesale say nothing about what ships.
  const nested = repoFiles({
    under: 'engine', match: /(^|\/)\.gitignore$/, exclude: ['node_modules', '.build'], floor: 0,
  });
  const gitignore = [
    ...parseIgnore(path.join(repoRoot, '.gitignore')),
    ...nested.flatMap((f: { abs: string }) => parseIgnore(f.abs)),
  ];
  const reachable = [...new Set(gitignore.filter(canMatchUnderEngine))];

  type Verdict = 'ship' | 'exclude' | 'absent';
  /** `sample` is a real path shape for that pattern under `engine/`; `absent` rows need none
   *  because nothing produces one here (asserted against the tree below). */
  const TABLE: Record<string, { verdict: Verdict; sample?: string; why: string; absentOk?: string }> = {
    // ── REQUIRED AT RUNTIME, despite being gitignored ────────────────────────────────
    'node_modules/': { verdict: 'ship', sample: 'engine/tools/modoki-mcp/node_modules/router/package.json', why: 'Vite-in-prod resolves renderer deps from node_modules per-request' },
    // ⚠️ The sample is capacitor-game-debug, NOT modoki: engine/packages/modoki/dist does not
    // exist and never has (the engine is consumed as SOURCE under Vite-in-prod), so a modoki
    // sample would make the accept side guard a path that cannot occur — an assertion that
    // protects nothing. game-debug's dist is real, ships 10 files at the twin path, and IS
    // runtime-required: it is the engine debug bridge engine/app/debug/bridge.ts imports.
    'dist/': { verdict: 'ship', sample: 'engine/packages/capacitor-game-debug/dist/plugin.js', why: 'plugin JS ships only in a gitignored dist/ (CLAUDE.md clones RULE 1); the editor imports this one at runtime' },
    'engine/electron/dist/': { verdict: 'ship', sample: 'engine/electron/dist/main.cjs', why: 'the packaged main process itself', absentOk: 'gitignored output of `npm run build:electron` — absent in any checkout that has not built, which includes every ci/main check job' },
    'engine/tools/game-debug-mcp/dist/': { verdict: 'ship', sample: 'engine/tools/game-debug-mcp/dist/index.js', why: 'the MCP server the packaged editor spawns', absentOk: "built on demand by that tool's own build, not by postinstall — absent in a fresh clone" },
    'Package.resolved': { verdict: 'ship', sample: 'engine/packages/capacitor-game-debug/Package.resolved', absentOk: 'SwiftPM WRITES it during an Xcode/cap-sync iOS build and .gitignore:83 excludes it, so it is absent on any clone that has not run one (every ci/main check job included) — and PERMANENTLY absent on the Windows clone, where that toolchain cannot run. It exists on a Mac that has built iOS, which is why this row was green on the clone that added it and red on the next gate to see it', why: 'a SwiftPM version PIN (~4 KB); dropping it makes a native build re-resolve to different SDK versions, which is the opposite of what a lockfile is for' },
    'engine/vite.config*.cjs': { verdict: 'ship', sample: 'engine/vite.config.cjs', absentOk: 'staged into the source tree only at pack time by stage-vite-config.cjs', why: '#326 — chooseViteConfig()\'s only way to avoid the .vite-temp write inside a signed bundle. Staged at pack time, so absent in a dev clone; see the mustShip list above, which asserts the same thing from the other side' },

    // ── NATIVE BUILD OUTPUT — the #1050 measurement ──────────────────────────────────
    // The NESTED spelling of the same cache (capacitor-appsflyer / capacitor-game-debug carry
    // their own .gitignore). Found the moment nested files were included — same artifact,
    // different spelling, no row.
    '.build/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/ios/Tests/.build/debug/x.o', why: 'as **/.build/' },
    '**/.build/': { verdict: 'exclude', sample: 'engine/packages/capacitor-modoki-ota/core/.build/debug/index/store/v5/records/a/b', why: '731 MB / 9,609 files across five dirs; ~1h of codesign' },
    '.swiftpm/': { verdict: 'exclude', sample: 'engine/packages/capacitor-modoki-iap/.swiftpm/xcode/x', why: 'local SwiftPM workspace state' },
    '.spm-cache/': { verdict: 'exclude', sample: 'engine/packages/capacitor-modoki-ota/.spm-cache/x', why: 'SwiftPM dependency cache' },
    'DerivedData/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/ios/DerivedData/Build/x', why: 'Xcode build output' },
    '*.xcuserdata/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/ios/App.xcodeproj/x.xcuserdata/y', why: 'per-user Xcode state' },
    'engine/packages/*/android/build/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/android/build/x.jar', why: 'Gradle output' },
    'engine/packages/*/android/.gradle/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/android/.gradle/x', why: 'Gradle state' },
    'engine/packages/*/android/test-harness/build/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/android/test-harness/build/x', why: 'Gradle output (present on this tree)' },
    'engine/packages/*/android/test-harness/.gradle/': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/android/test-harness/.gradle/x', why: 'Gradle state (present on this tree)' },
    'local.properties': { verdict: 'exclude', sample: 'engine/packages/capacitor-game-debug/android/local.properties', why: 'a machine-local Android SDK path' },

    // ── LOCAL EDITOR / BUILD STATE (the five that ship today) ────────────────────────
    '.modoki/': { verdict: 'exclude', sample: 'engine/packages/modoki/.modoki', why: 'per-clone editor state; engine/.modoki and engine/packages/modoki/.modoki ship today' },
    '**/.modoki-building/': { verdict: 'exclude', sample: 'engine/.modoki-building/lock', why: 'transient build lock' },
    'engine/coverage/': { verdict: 'exclude', sample: 'engine/coverage/index.html', why: 'coverage report' },
    'engine/tsconfig.app.scoped*.json': { verdict: 'exclude', sample: 'engine/tsconfig.app.scoped.json', why: '#885 row 6 — untracked in-tree for a whole tsc run; ships today' },
    '*.tsbuildinfo': { verdict: 'exclude', sample: 'engine/app/tsconfig.tsbuildinfo', why: 'incremental-compile state' },
    '*.meta.local.json': { verdict: 'exclude', sample: 'engine/packages/modoki/src/runtime/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf.meta.local.json', why: 'per-machine asset overrides; two font sidecars ship today' },
    '*.meta.json.corrupt': { verdict: 'exclude', sample: 'engine/packages/modoki/src/x.png.meta.json.corrupt', why: 'a salvage copy of a broken sidecar' },
    '.vite/': { verdict: 'exclude', sample: 'engine/.vite/deps/chunk.js', why: 'dev optimize-cache, baked against the dev tree and unwritable in a signed bundle (pre-existing exclude)' },
    '*.log': { verdict: 'exclude', sample: 'engine/scripts/build.log', why: 'a log is never load-bearing' },
    'npm-debug.log*': { verdict: 'exclude', sample: 'engine/npm-debug.log', why: 'as above' },
    '.DS_Store': { verdict: 'exclude', sample: 'engine/app/.DS_Store', why: 'Finder junk' },

    // ── SECRET-CLASS. Gitignored, excluded by NOTHING until #1050 ────────────────────
    // ⚠️ Verified 2026-09-11: none of these exists under engine/ today, so these rows close a
    // LATENT gap rather than an incident. They are `exclude` and not `absent` deliberately —
    // `absent` would make the guard depend on nobody ever creating one, and the cost of being
    // wrong is a credential inside a signed, notarized, publicly distributed app, in the clear
    // (asarUnpack is a real directory on disk, not a sealed archive).
    '.env': { verdict: 'exclude', sample: 'engine/.env', why: 'credentials' },
    '.env.local': { verdict: 'exclude', sample: 'engine/.env.local', why: 'credentials' },
    '.env.*.local': { verdict: 'exclude', sample: 'engine/.env.production.local', why: 'credentials' },
    '.env.notarize': { verdict: 'exclude', sample: 'engine/.env.notarize', why: 'Apple notarization credentials' },
    '*.p8': { verdict: 'exclude', sample: 'engine/AuthKey_ABC123.p8', why: 'Apple auth key' },
    '*.jks': { verdict: 'exclude', sample: 'engine/release.jks', why: 'Android signing keystore' },
    '*.keystore': { verdict: 'exclude', sample: 'engine/release.keystore', why: 'Android signing keystore' },
    'project.user.json': { verdict: 'exclude', sample: 'engine/templates/starter/project.user.json', why: 'holds the Apple Team ID (CLAUDE.md § App Identity, #172)' },
    'modoki.local.xcconfig': { verdict: 'exclude', sample: 'engine/packages/capacitor-modoki-iap/modoki.local.xcconfig', why: 'machine-local signing config' },

    // ── NO PRODUCER UNDER engine/ — asserted against the tree, and can only RED ──────
    'ads/': { verdict: 'absent', why: 'playable export writes games/<id>/ads' },
    'subgame-dist/': { verdict: 'absent', why: 'sub-game bundles are per-project' },
    '.cache/': { verdict: 'absent', why: 'no producer under engine/' },
    '*.thumb.jpg': { verdict: 'absent', why: 'asset thumbnails live in projects' },
    '*.thumb.jpg.meta.json': { verdict: 'absent', why: 'as above' },
    '*.xcworkspacedata': { verdict: 'absent', why: 'no .xcworkspace under engine/packages' },
    '*.apk': { verdict: 'absent', why: 'Android artifacts are per-project' },
    '*.aab': { verdict: 'absent', why: 'as above' },
    'release/': { verdict: 'absent', why: 'electron-builder output is at the repo root' },
    '.idea/': { verdict: 'absent', why: 'IDE state, repo root' },
    '.vscode/': { verdict: 'absent', why: 'IDE state, repo root' },
    '.opencode/': { verdict: 'absent', why: 'agent tool state, repo root' },
    'opencode.json': { verdict: 'absent', why: 'as above' },
    '*.swp': { verdict: 'absent', why: 'editor swap files' },
    '*.swo': { verdict: 'absent', why: 'editor swap files' },
  };

  const excludeGlobs = (cfg.files ?? []).filter((f) => f.startsWith('!')).map((f) => f.slice(1));
  const DOT = { dot: true } as const;
  const mm = new Map<string, Minimatch>();
  const matches = (file: string, glob: string) => {
    let m = mm.get(glob);
    if (!m) { m = new Minimatch(glob, DOT); mm.set(glob, m); }
    return m.match(file);
  };
  const isExcluded = (file: string) => excludeGlobs.filter((g) => matches(file, g));

  /** ⚠️ The same artifact reaches the packaged app at TWO paths, and this is what an
   *  `engine/**`-anchored exclude misses. npm WORKSPACES symlink each `engine/packages/<dir>`
   *  into the root `node_modules` under its package NAME, and electron-builder DEREFERENCES
   *  those links at pack time — so a SwiftPM cache arrives as
   *  `node_modules/capacitor-modoki-ota/.build/…`, never as the `engine/packages/…` path this
   *  issue's table reports (which is where the files sit on disk).
   *
   *  Measured, not theorised: the first fix for #1050 was `engine/**`-anchored, passed every
   *  assertion in this file, and still shipped **3,506 `.build` files into a 1.1 GB app**. The
   *  unit test and the packaged build disagreed, and the packaged build was right.
   *
   *  Derived from each package's own `name`, not a hand-written table, so a renamed or added
   *  workspace package cannot silently fall out of coverage. */
  const workspaceTwin = (() => {
    const pkgDir = path.join(repoRoot, 'engine/packages');
    const byDir = new Map<string, string>();
    for (const dir of readdirSync(pkgDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifest = path.join(pkgDir, dir.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (name) byDir.set(dir.name, name);
    }
    return (file: string): string | undefined => {
      const m = /^engine\/packages\/([^/]+)\/(.+)$/.exec(file);
      const name = m && byDir.get(m[1]);
      return name ? `node_modules/${name}/${m![2]}` : undefined;
    };
  })();

  it('the instrument models electron-builder — without {dot:true} it denies a MEASURED fact', () => {
    // The include glob vs a path that provably shipped. Default picomatch says engine/**/* does
    // not match it, i.e. that the caches were never packaged — against a 1.8 GB app that
    // contained 9,609 of them. That is the failure this assertion pins, and it is why the
    // option cannot be quietly dropped.
    const real = 'engine/packages/capacitor-modoki-ota/core/.build/debug/index/store/v5/records/a/b';
    // Read the include glob from the config — a hardcoded 'engine/**/*' keeps asserting about a
    // glob the config may no longer have.
    const include = (cfg.files ?? []).find((f) => f === 'engine/**/*');
    expect(include, 'files no longer ships engine/**/* — this instrument assumes it').toBeDefined();
    expect(picomatch.isMatch(real, include!, DOT)).toBe(true);
    expect(picomatch.isMatch(real, include!)).toBe(false);

    // ⚠️ picomatch is NOT electron-builder's matcher, and on a DIRECTORY-shaped path it is the
    // more permissive of the two — the false-green direction, where the model says "excluded"
    // and the real packer ships the file. Pinned so the next person who reaches for picomatch
    // in the rules below sees why they do not.
    const bareDir = 'node_modules/capacitor-modoki-ota/.build';
    expect(picomatch.isMatch(bareDir, '**/.build/**', DOT)).toBe(true);
    expect(new Minimatch('**/.build/**', DOT).match(bareDir)).toBe(false);

    // ⚠️ wildcard vs LITERAL — the half the first draft of this test got wrong. A `**` that has
    // to consume `.modoki-building` is sensitive to the option:
    expect(picomatch.isMatch('engine/.modoki-building/x.log', 'engine/**/*.log', DOT)).toBe(true);
    expect(picomatch.isMatch('engine/.modoki-building/x.log', 'engine/**/*.log')).toBe(false);
    // …while `.build` spelled out in the pattern is NOT, which is exactly why the exclude rows
    // below pass either way and cannot themselves prove the option is doing anything.
    expect(picomatch.isMatch(real, 'engine/**/.build/**', DOT)).toBe(true);
    expect(picomatch.isMatch(real, 'engine/**/.build/**')).toBe(true);
  });

  it('the enumeration found the repo — a vacuous pass is a failure', () => {
    expect(gitignore.length).toBeGreaterThan(80);
    expect(reachable.length).toBeGreaterThan(30);
  });

  it('every .gitignore pattern that can reach engine/ carries a classification', () => {
    // THE RULE. A new artifact type is a decision — ship it, exclude it, or state that
    // nothing under engine/ produces it — and this is where the decision is forced. Adding
    // the .gitignore line without a row here is the failure #1050 was.
    const unclassified = reachable.filter((p) => !(p in TABLE));
    expect(
      unclassified,
      `unclassified .gitignore pattern(s) reaching engine/: ${unclassified.join(', ')}\n`
      + 'Add a row to TABLE above: ship (required at runtime), exclude (add a ! glob to '
      + 'electron-builder.yml files), or absent (nothing under engine/ produces it).',
    ).toHaveLength(0);
  });

  it('no classification row has gone stale against .gitignore', () => {
    // The mirror of the rule above: a row whose pattern was removed or reworded is a
    // guard aimed at nothing, and it would keep this suite green over a gap.
    const orphans = Object.keys(TABLE).filter((p) => !reachable.includes(p));
    expect(orphans, `TABLE row(s) with no matching .gitignore pattern: ${orphans.join(', ')}`).toHaveLength(0);
  });

  it('the workspace-twin derivation is not vacuous — it really maps a package dir to its name', () => {
    // If this returned undefined for everything, the rule above would silently revert to
    // checking one path shape, which is the state that shipped 3,506 files.
    expect(workspaceTwin('engine/packages/capacitor-modoki-ota/.build/x'))
      .toBe('node_modules/capacitor-modoki-ota/.build/x');
    expect(workspaceTwin('engine/packages/modoki/tests/x.ts'))
      .toBe('node_modules/@modoki/engine/tests/x.ts');
    expect(workspaceTwin('engine/electron/dist/main.js')).toBeUndefined();
  });

  it('no `ship` row guards a sample that cannot exist (#1050 close-out)', () => {
    // ⚠️ The ACCEPT SIDE is the rule that catches an over-broad exclude dropping something
    // required, and it can only do that if the path it names can actually occur. Twice in this
    // file's short life it could not: engine/packages/platform-tech/dist (a package that no
    // longer exists) and engine/packages/modoki/dist (which never has — the engine is consumed
    // as SOURCE under Vite-in-prod). Both made the accept side assert about a hypothetical, i.e.
    // unable to fail: this repo's dominant defect class, inside the guard written to prevent it.
    // A legitimately-absent row says so in `absentOk`, with a reason a human had to write.
    const phantom = Object.entries(TABLE)
      .filter(([, r]) => r.verdict === 'ship' && r.sample && !r.absentOk)
      // `path.join(repoRoot, '')` is repoRoot, which EXISTS — so a blank sample would pass while
      // guarding nothing. That happened once, from a shell substitution that silently produced an
      // empty string.
      .filter(([, r]) => !r.sample!.trim() || !existsSync(path.join(repoRoot, r.sample!)))
      .map(([pattern, r]) => `${pattern} → ${r.sample}`);
    expect(
      phantom,
      `\`ship\` row(s) sampling a path that does not exist, so the accept side cannot fail:\n  `
      + `${phantom.join('\n  ')}\nFix the sample, or declare absentOk with the reason.`,
    ).toHaveLength(0);
  });

  it('every `exclude` row is actually matched by a ! glob in files', () => {
    const misses: string[] = [];
    for (const [pattern, row] of Object.entries(TABLE)) {
      if (row.verdict !== 'exclude') continue;
      if (!row.sample) { misses.push(`${pattern} (no sample path)`); continue; }
      // BOTH paths the artifact can arrive at — the on-disk one and the workspace-linked one.
      // Checking only the first is the exact hole that shipped 3,506 files; see workspaceTwin.
      for (const shape of [row.sample, workspaceTwin(row.sample)]) {
        if (shape && isExcluded(shape).length === 0) misses.push(`${pattern} → ${shape}`);
      }
    }
    expect(misses, `classified 'exclude' but nothing in files excludes them:\n  ${misses.join('\n  ')}`).toHaveLength(0);
  });

  it('ACCEPT SIDE — no `ship` row is caught by an exclude', () => {
    // The half a "does it exclude?" test cannot see, and the failure mode #1050 named: an
    // over-broad glob silently drops a required binary and the app fails at RUNTIME, never
    // at build time. `!engine/**/*.log` must not eat engine/**/dist; `!engine/**/.modoki`
    // must not eat engine/packages/modoki/**.
    const dropped: string[] = [];
    for (const [pattern, row] of Object.entries(TABLE)) {
      if (row.verdict !== 'ship' || !row.sample) continue;
      // BOTH shapes, exactly as the exclude side does. Checking only the on-disk one is the
      // same blind spot pointing the other way — and #1050's move to unanchored `!**/` globs
      // is what makes this direction newly dangerous: `node_modules/@modoki/engine/dist/…` is
      // the path the packaged renderer actually resolves @modoki/engine through.
      for (const shape of [row.sample, workspaceTwin(row.sample)]) {
        if (!shape) continue;
        const hits = isExcluded(shape);
        if (hits.length > 0) dropped.push(`${pattern} → ${shape} dropped by ${hits.join(', ')}`);
      }
    }
    expect(dropped, `exclude(s) dropping a runtime-REQUIRED gitignored path:\n  ${dropped.join('\n  ')}`).toHaveLength(0);
  });

  it('the tests exclusion reaches the workspace TWIN, not just the on-disk path', () => {
    // `!engine/packages/*/tests/**` cannot match `node_modules/@modoki/engine/tests/**`, and
    // that twin IS copied (852 files ship under that dep today). Until #1050's close-out, those
    // ~200 test files were held out solely by a hardcoded basename set inside app-builder-lib
    // (`topLevelExcludedFiles`), which is third-party, top-level-only and undocumented.
    for (const file of [
      'node_modules/@modoki/engine/tests/runtime/clock.test.ts',
      'node_modules/capacitor-game-debug/tests/x.test.ts',
    ]) {
      expect(isExcluded(file), `nothing in files excludes ${file}`).not.toHaveLength(0);
    }
    // ACCEPT SIDE — #1024 ships the starter's test on purpose, so `!**/tests/**` is wrong.
    expect(isExcluded('engine/templates/starter/tests/tapTargets.test.ts'))
      .toHaveLength(0);
  });

  it('no classification row names an engine/packages/<dir> that does not exist', () => {
    // ⚠️ The vacuity hole this rule closes: the two staleness rules above compare the TABLE to
    // .gitignore and nothing else, so a row and a pattern that are BOTH stale stay mutually
    // consistent and green forever. That was live — `.gitignore` carried
    // `engine/packages/platform-tech/dist/` and the TABLE carried its row, for a package that
    // has not existed for some time. Only patterns naming a LITERAL package dir are checked;
    // a `*` segment is a glob over whatever exists, and engine/coverage/ is legitimately
    // absent until someone runs coverage.
    const missing = Object.keys(TABLE)
      .map((p) => /^engine\/packages\/([^/*]+)\//.exec(p))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => !existsSync(path.join(repoRoot, 'engine/packages', m[1])))
      .map((m) => m[0]);
    expect(missing, `TABLE row(s) naming a non-existent package: ${missing.join(', ')}`).toHaveLength(0);
  });

  // The ONLY rule here that reads the tree, so the only one whose answer depends on which
  // checkout it runs in. Everything else classifies by PATTERN and must run EVERYWHERE —
  // including the public snapshot, which is where the CI that actually runs lives, and which
  // ships electron-builder.yml and .gitignore verbatim (publish-engine-oss.sh:212 — the old
  // rewrite is gone, see :285). Skipping the whole block there left the guard firing only on
  // a developer's local verify, and a skipped test looks exactly like a passing one.
  it.skipIf(!hasOssOverlay())('every `absent` row really has no producer under engine/', () => {
    // The one rule that reads the tree, and it can only ever RED from what it finds — a clone
    // where the artifact is missing proves nothing and is allowed to pass. So it cannot mask a
    // missing exclusion the way a disk-reading version of the rules above would.
    //
    // Enumerated through git, not a walker (#799): the corpus wanted here is precisely the
    // GITIGNORED set, which `repoFiles()` cannot return — it enumerates with
    // `--exclude-standard`. `repoIgnoredFiles` is that producer, and it lives in repoCorpus.mjs
    // because that is the one sanctioned caller of git. `--directory` collapses a wholly-ignored
    // dir to itself, so a row is `engine/packages/x/.build`, matched below against both
    // `<pattern>` and `<pattern>/**`.
    // floor 0 ON PURPOSE. `floor: 5` was satisfied by exactly the five
    // engine/packages/capacitor-*/dist dirs postinstall emits — so renaming one plugin reddened
    // this test with a CORPUS error while the packaging config was correct, and a clean checkout
    // with no npm install threw outright (measured: 0 paths). This rule is one-directional by
    // design, so an empty corpus is a rule that finds nothing, not a rule that is broken.
    const seen = repoIgnoredFiles({ under: 'engine', exclude: ['node_modules'], floor: 0 })
      .map((f: { rel: string }) => f.rel);

    const found: string[] = [];
    for (const [pattern, row] of Object.entries(TABLE)) {
      if (row.verdict !== 'absent') continue;
      const bare = pattern.replace(/\/$/, '');
      const base = bare.startsWith('engine/') ? bare
        : bare.startsWith('**/') ? `engine/**/${bare.slice(3)}`
        : `engine/**/${bare}`;
      const globs = pattern.endsWith('/') ? [base, `${base}/**`] : [base];
      const hit = seen.find((f) => globs.some((g) => picomatch.isMatch(f, g, DOT)));
      if (hit) found.push(`${pattern} → ${hit}`);
    }
    expect(
      found,
      `classified 'absent' but present under engine/ — reclassify as ship or exclude:\n  ${found.join('\n  ')}`,
    ).toHaveLength(0);
  });
});

/**
 * PACKAGING GUARD — the OSS release workflows must attach their update MANIFEST.
 *
 * The public repo's electron-builder.yml uses the `github` provider (rewritten by
 * scripts/publish-engine-oss.sh), so electron-updater discovers a new version by
 * fetching a manifest from the Release ASSETS: latest.yml on Windows,
 * latest-mac.yml on macOS. Attaching the installer WITHOUT its manifest yields a
 * release that looks complete on the Releases page but that no installed editor can
 * ever find — every update check 404s, silently, forever.
 *
 * That shipped: the Windows workflow attached only *.exe + *.blockmap on a tag while
 * its own win-nightly step attached latest.yml, so the nightly channel updated and
 * every STABLE release (v0.3.0 → v0.3.5) stranded users on whatever they had. It
 * surfaced as a user on v0.3.4 who could not update to the v0.3.5 that fixed his bug.
 *
 * ⚠️ That win-nightly step no longer exists (#1085) — so the asymmetry that masked the
 * bug is gone, and this guard is now the only thing standing between a dropped
 * manifest and a silently un-updatable release. Do not relax it on the grounds that
 * "both workflows look the same now": that is exactly the state the bug shipped from.
 *
 * Asserted as a PAIR — the two workflows are twins and the bug was exactly one of
 * them drifting from the other, which a single-platform test cannot catch.
 */
// The public engine snapshot does not ship the oss/ publish overlay it is itself built
// from (it IS the output of that overlay) — nothing to read here in that checkout.
describe.skipIf(!hasOssOverlay())('OSS release workflows attach the electron-updater manifest', () => {
  const cases = [
    { file: 'release-windows.yml', manifest: 'release/latest.yml', installer: 'release/*.exe' },
    { file: 'release.yml', manifest: 'release/latest-mac.yml', installer: 'release/*.dmg' },
  ];

  for (const { file, manifest, installer } of cases) {
    it(`${file} attaches ${path.basename(manifest)} on a version tag`, () => {
      const wf = yaml.load(
        readFileSync(path.join(repoRoot, 'oss', '.github', 'workflows', file), 'utf8'),
      ) as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> };

      // The tag-gated publish step — the one that builds a real versioned Release.
      const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
      const tagged = steps.filter((s) => {
        const uses = String(s.uses ?? '');
        const cond = String(s.if ?? '');
        const withBlock = (s.with ?? {}) as { tag_name?: string };
        // Excludes any step pinning its own tag_name. That was the rolling win-nightly
        // prerelease, which attached the manifest and so masked the bug; the step is gone
        // (#1085) and the clause is kept as the rule — a step publishing to a FIXED tag is
        // never the versioned release this guard is about.
        return uses.includes('action-gh-release') && cond.includes('refs/tags/v') && !withBlock.tag_name;
      });
      expect(tagged.length).toBe(1);

      const withBlock = (tagged[0].with ?? {}) as { files?: string; fail_on_unmatched_files?: boolean };
      const files = String(withBlock.files ?? '')
        .split('\n').map((l) => l.trim()).filter(Boolean);
      expect(files).toContain(installer); // sanity: this is the installer-publishing step
      expect(files).toContain(manifest);  // …and it must carry the update manifest

      // Listing the manifest is not enough on its own: softprops WARNS (not fails) on an
      // unmatched pattern by default, so if the build stopped emitting it the release would
      // silently ship without it again — the exact recurrence this pair of asserts exists
      // to prevent.
      expect(withBlock.fail_on_unmatched_files).toBe(true);
    });
  }
});

/**
 * PACKAGING GUARD — the starter template ships in the installer.
 *
 * New Project (File → New Project) AND the packaged first-run scaffold both copy
 * engine/templates/starter from REPO_ROOT (= app.asar.unpacked when packaged). Its
 * CLAUDE.md is what primes a freshly-connected Claude Code with the modoki tool surface.
 * It ships via the engine `files` glob and unpacks via the engine `asarUnpack` glob (both
 * asserted above) — but only if nothing excludes it. A silent drop would leave New Project
 * fileless / unprimed on a real DMG/exe only, so the template + its CLAUDE.md content are
 * locked here. See docs/connect-claude-code.md.
 */
describe('starter template ships (New Project / Connect Claude Code)', () => {
  const starter = path.join(repoRoot, 'engine', 'templates', 'starter');

  it('has the scaffolder contract files incl. CLAUDE.md', () => {
    for (const f of ['CLAUDE.md', 'game.ts', 'project.config.json', 'package.json']) {
      expect(existsSync(path.join(starter, f)), `missing template file: ${f}`).toBe(true);
    }
  });

  it('CLAUDE.md primes the full agent surface (MCP verify loop + Enact + CDP + GUID rule)', () => {
    const md = readScannedSource(path.join(starter, 'CLAUDE.md'), DOC_AS_PROSE).raw;
    for (const needle of ['modoki_get_scene_state', 'modoki_mutate_scene', 'Enact', 'CDP', 'GUID']) {
      expect(md, `starter CLAUDE.md should mention ${needle}`).toContain(needle);
    }
  });

  it('no files exclude drops engine/templates from the package', () => {
    const excludes = (cfg.files ?? []).filter((f) => f.startsWith('!') && /templates/.test(f));
    expect(excludes, `exclude(s) dropping the template: ${excludes.join(', ')}`).toHaveLength(0);
  });
});

/**
 * NSIS `.vite-temp` ACL grant (bug vSlzfZLr7pIX5Yw0RSSe) — nsis.include has no explicit
 * override in electron-builder.yml, so it defaults to `build/installer.nsh` (verified against
 * app-builder-lib/scheme.json's documented default) and electron-builder picks it up with no
 * config change needed. That implicit pickup is exactly the kind of wiring that goes stale
 * silently, which is why this guard still asserts the file EXISTS at that path even though the
 * grant itself was removed (#326, 2026-08-27): the CJS packaged Vite config no longer writes
 * into `.vite-temp` at all (measured on Windows, grant removed, real Build press, zero files
 * created), so a `customInstall` macro would have nothing left to grant. See
 * docs/windows.md's "Packaged-app bugs" entry #5 and `engine/scripts/build-web.mjs`'s comment
 * on the `vite build` call for the fuller history.
 */
describe('installer.nsh', () => {
  const installerNsh = path.join(repoRoot, 'build', 'installer.nsh');

  it('exists at the path nsis.include defaults to (no explicit override in electron-builder.yml)', () => {
    expect(existsSync(installerNsh)).toBe(true);
  });

  it('defines customInstall (electron-builder inserts a call to it post-install) with no ACL grant left in it', () => {
    const nsh = readFileSync(installerNsh, 'utf8');
    expect(nsh, 'must define the customInstall macro electron-builder inserts post-install').toMatch(
      /!macro\s+customInstall/,
    );
    // Strip `;`-comments first — this doc's own commentary describes the removed grant by name
    // (icacls, .vite-temp), and a bare substring check over the whole file would fail on that
    // prose rather than on actual NSIS code. Only CODE re-adding the grant should trip this.
    const code = nsh
      .split('\n')
      .map((line) => line.replace(/;.*$/, ''))
      .join('\n');
    // The .vite-temp write this used to work around is gone at the source (#326) — any of these
    // ACL mechanisms reappearing in CODE would mean someone reintroduced the write it was
    // compensating for (icacls/cacls the CLI tools, Set-Acl/AccessControl the NSIS-plugin routes).
    expect(code, 'must not re-add an ACL grant this issue removed').not.toMatch(
      /\bicacls\b|\bcacls\b|Set-Acl|AccessControl::/i,
    );
  });
});
