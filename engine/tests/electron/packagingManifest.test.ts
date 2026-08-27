import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import picomatch from 'picomatch';
import { hasOssOverlay } from '../helpers/repoLayout';

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
      ['engine/tests/assets/agentConfigSync.test.ts', 'engine/tests/**'],
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
        // Exclude the rolling win-nightly prerelease: it pins its own tag_name and
        // already attaches the manifest, which is what masked the bug.
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
    const md = readFileSync(path.join(starter, 'CLAUDE.md'), 'utf8');
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
