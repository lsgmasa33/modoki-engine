/** Every project with a native target carries the engine-required Capacitor plugins.
 *
 *  WHY THIS EXISTS, and why it is a guard over COMMITTED STATE rather than another unit test.
 *
 *  `ensureCapacitorDeps` adds these on every native build, so a project that has drifted off the
 *  list still builds fine HERE — the editor heals it on the way past, and the working tree it
 *  writes is never the tree that gets committed. That is exactly what let four projects drift
 *  unnoticed: `games/alien-animal`, `games/audio-demo`, `games/chess`, and `demos/2d-physics-demo`
 *  were each missing all four, and every local build silently papered over it.
 *
 *  The one that matters is the demo. `demos/2d-physics-demo` is PUBLISHED, and
 *  `publish-demo.sh` exports committed content — so the public snapshot shipped a `package.json`
 *  with no `@capacitor/preferences`. Someone following that demo's own README (`npm install` →
 *  `npx cap sync` → build, with no Modoki editor anywhere in the loop) never runs the heal, and
 *  gets an app that dies at launch with `"Preferences" plugin is not implemented on android` the
 *  moment PlayerPrefs is touched. A heal that only runs on OUR machines cannot protect a stranger
 *  building from the snapshot; only the committed file can.
 *
 *  So this asserts the committed state, which is the artifact that actually ships. It reads
 *  `ENGINE_REQUIRED_CAP_PLUGINS` from the module that owns the healing rather than restating the
 *  list — a second copy would be free to drift exactly as the projects did (and this repo has
 *  been bitten by a duplicated list before: see the four copies of the `.rig2d.json` bone
 *  coercion in docs/editor.md § Panels).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_REQUIRED_CAP_PLUGINS } from '../../plugins/addNativeTarget';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every `games/<id>` / `demos/<id>` that has actually had a native target added — the only
 *  ones the requirement applies to. A project with no `ios/`/`android/` has nothing to register
 *  a native impl into, and `ensureCapacitorDeps` correspondingly never runs for it. */
function nativeProjects(): { id: string; dir: string; pkg: string }[] {
  const out: { id: string; dir: string; pkg: string }[] = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const rootDir = path.join(repoRoot, root);
    if (!fs.existsSync(rootDir)) continue;
    for (const entry of fs.readdirSync(rootDir)) {
      const dir = path.join(rootDir, entry);
      const pkg = path.join(dir, 'package.json');
      const hasNative = fs.existsSync(path.join(dir, 'ios')) || fs.existsSync(path.join(dir, 'android'));
      if (!hasNative || !fs.existsSync(pkg)) continue;
      out.push({ id: `${root}/${entry}`, dir, pkg });
    }
  }
  return out;
}

describe('native projects carry the engine-required Capacitor plugins', () => {
  // Gated on `hasInternalGames()`: the public snapshot ships no `games/` at all, and
  // `publish-demo.sh` strips `ios/`+`android/` out of every demo it exports — so the scan there
  // correctly matches zero, and an ungated floor fails the shipped guards run inside the assembled
  // snapshot (step 4b) for content that root is never supposed to have. The floor still binds
  // where the projects actually live, and the private tripwire keeps the skip from going silent.
  it.skipIf(!hasInternalGames())(
    'finds native projects at all (the guard must not pass by scanning nothing)',
    () => {
      // A guard whose scan silently matches zero projects reports a cheerful pass forever — the
      // failure mode this repo keeps hitting. Pin the floor instead.
      expect(nativeProjects().length).toBeGreaterThanOrEqual(5);
    },
  );

  it('the required list is non-empty and includes the one that fails hardest', () => {
    // PlayerPrefs is engine-owned persistence: it is reached on ordinary gameplay paths, so its
    // absence is not an edge case. If this list is ever emptied, the guard above still passes
    // vacuously — hence pinning it here too.
    expect(ENGINE_REQUIRED_CAP_PLUGINS.length).toBeGreaterThan(0);
    expect(ENGINE_REQUIRED_CAP_PLUGINS).toContain('@capacitor/preferences');
  });

  it.each(nativeProjects())('$id declares every engine-required Capacitor plugin', ({ pkg }) => {
    const deps = (JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies ?? {}) as Record<string, string>;
    const missing = ENGINE_REQUIRED_CAP_PLUGINS.filter((name) => !(name in deps));
    expect(
      missing,
      `${path.relative(repoRoot, pkg)} is missing: ${missing.join(', ')}\n\n`
      + 'The engine runtime calls these on every platform. The build will still SUCCEED (the web '
      + 'build inlines the JS proxy from the editor\'s node_modules) and the app will die at '
      + 'LAUNCH with `"<Plugin>" plugin is not implemented on <platform>`.\n'
      + 'Fix: run a native build for this project (the editor\'s Build → iOS/Android, or '
      + '`MODOKI_PROJECT=<root>/<id> npm run build -- --target native`), which heals it, then '
      + '`npm install` in the project and COMMIT the package.json + package-lock.json. '
      + 'Committing is the part that matters — a published snapshot ships the committed file, '
      + 'and nobody building from it runs our heal.',
    ).toEqual([]);
  });
});
