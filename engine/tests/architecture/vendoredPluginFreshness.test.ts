/** Every project's VENDORED engine Capacitor plugin must match the plugin's CURRENT source (#90).
 *
 *  Why this guard exists. Games do not build engine plugins from source — they depend on a
 *  content-addressed tarball committed into the project
 *  (`"capacitor-game-debug": "file:plugins/capacitor-game-debug-1.0.0-<hash>.tgz"`). Nothing in the
 *  repo forced that tarball to be refreshed when the plugin's SOURCE changed: `vendorEnginePlugins`
 *  detects content changes correctly, but the native build only called it on the scaffold path, or
 *  gated behind `ensureCapacitorDeps.changed` — which fires only for a MISSING dep, and a plugin
 *  already depended on is never missing.
 *
 *  The failure mode is the dangerous one: the gradle build succeeds, the APK installs, the app
 *  launches, and it silently contains the PREVIOUS native code. Every signal says the change
 *  shipped. Measured 2026-08-02 while fixing #88 — the first build compiled the pre-fix Java, and
 *  it was caught only because the tarball hash was checked by hand. A guard is what removes the
 *  "someone has to think of it" step.
 *
 *  This asserts the STATE (what is committed), which is what an APK is actually built from. The
 *  build-path fix in `vite-asset-scanner.ts` keeps it true going forward; this catches a project
 *  that drifts anyway — e.g. a plugin edited without rebuilding every consumer, exactly the
 *  situation #88 created across nine projects. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pluginContentHash, listEnginePlugins } from '../../plugins/vendorPlugins';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every project directory under the configured roots that has its own package.json. */
function allProjects(): { id: string; dir: string }[] {
  const out: { id: string; dir: string }[] = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(abs, entry.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ id: `${root}/${entry.name}`, dir });
    }
  }
  return out;
}

describe('vendored engine plugins are not stale (#90)', () => {
  const plugins = listEnginePlugins(repoRoot);
  const projects = allProjects();

  it('finds engine plugins and projects to check (a guard that checks nothing is not a guard)', () => {
    expect(plugins.length).toBeGreaterThan(0);
    expect(projects.length).toBeGreaterThan(0);
  });

  it('every project pinning an engine plugin pins the CURRENT content hash', () => {
    const stale: string[] = [];

    for (const plugin of plugins) {
      const currentHash = pluginContentHash(plugin.dir);
      for (const project of projects) {
        const pkg = JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        const spec = pkg.dependencies?.[plugin.name];
        // A project that does not depend on this plugin is not stale — it opted out, which is a
        // legitimate state (no native target yet, or a project that never needed the bridge).
        if (!spec) continue;
        if (!spec.includes(currentHash)) {
          stale.push(`${project.id}: ${plugin.name} pins "${spec}" but the plugin's current content hash is ${currentHash}`);
        }
      }
    }

    expect(stale, stale.length
      ? `Stale vendored plugin(s) — these projects would build an APK/IPA containing OLD native code, `
        + `while the build reports success:\n  ${stale.join('\n  ')}\n\n`
        + `Fix: re-vendor them (the native build now does this automatically per #90; to do it by `
        + `hand, call vendorEnginePlugins(projectRoot, repoRoot) then \`npm install\` in the project).`
      : '',
    ).toEqual([]);
  });
});
