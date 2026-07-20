import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

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
