/** Guard: every harness that launches the PACKAGED editor isolates its Chromium profile.
 *
 *  `resolveUserDataDir` (engine/electron/userDataDir.ts) scopes the profile by clone ONLY
 *  on the dev branch; packaged deliberately returns the single `<appData>/Modoki Editor`,
 *  on the sound premise that a shipped app is installed once. Our HARNESSES break that
 *  premise — four clones share this machine (CLAUDE.md § Clones) and each builds and runs
 *  its OWN packaged app, so they all landed in one profile.
 *
 *  What that costs: `modoki-last-scene:<project name>` is keyed by the project NAME while
 *  its value is a clone-ABSOLUTE path, and `games/3d-test` is "Tropical Island" in every
 *  clone. Measured 2026-08-02 — `smoke:packaged` on the hub restored modoki-ai2's
 *  remembered scene, `/@fs` (scoped to the serving clone's root) correctly 403'd it, and
 *  the gate reported FAILED. The boot was fine (loadFirstScene self-heals to
 *  config.scenePath, 136 entities); the console error was RECOVERY RESIDUE, and both these
 *  scripts treat any console error as fatal. So the gate failed for a reason unrelated to
 *  the commit under test — the mirror image of #89, where it PASSED while provisioning was
 *  wholly broken. Either way the gate did not control what it measured.
 *
 *  Why a test rather than a comment: `assert-app-csp.mjs` got this right from the start
 *  and `shouldOverrideUserData()` exists specifically to let a harness do it — yet the two
 *  sibling scripts beside it both launched with the shared profile anyway. That is the same
 *  shape as reapScoping.test.ts (#69): an unenforced convention held for the file that was
 *  audited and not for the one next to it. `assert-app-renders.sh` is the RELEASE gate for
 *  the signed artifact, so the one left unfixed was the higher-stakes one.
 *
 *  The rule: a script that launches a packaged Electron binary must pass --user-data-dir.
 *  Scoped to launches, so a script that merely resolves or reaps a path is not implicated. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptsDir = path.resolve(__dirname, '../../scripts');

/** Scripts that spawn the packaged app. Kept explicit rather than inferred: the launch
 *  shapes differ (bash `"$BIN" …` vs node `spawn(bin, …)`), and a regex loose enough to
 *  catch both would also catch every mention of the variable. A NEW launcher is caught by
 *  the completeness check below, not by this list. */
const LAUNCHERS = ['smoke-packaged.sh', 'assert-app-renders.sh', 'assert-app-csp.mjs'] as const;

function read(name: string): string {
  return fs.readFileSync(path.join(scriptsDir, name), 'utf8');
}

describe('packaged-app launches isolate their Chromium profile', () => {
  it.each(LAUNCHERS)('%s passes --user-data-dir', (name) => {
    const src = read(name);
    // The flag must appear on a line that is not a comment — a script explaining the rule
    // in prose while launching without it is exactly the failure this guards.
    const live = src
      .split('\n')
      .filter((l) => !/^\s*(#|\/\/|\*)/.test(l))
      .join('\n');
    expect(live).toContain('--user-data-dir');
  });

  it('no launcher reaches into the real shared profile by hardcoded path', () => {
    // `assert-app-renders.sh` used to `rm -rf "$HOME/Library/Application Support/Modoki
    // Editor/vite-cache"`. A fresh profile makes that unnecessary (it cannot hold a stale
    // cache), and the hardcoded reach mutated the human's real editor state.
    for (const name of LAUNCHERS) {
      const live = read(name)
        .split('\n')
        .filter((l) => !/^\s*(#|\/\/|\*)/.test(l))
        .join('\n');
      expect(live, `${name} still touches the shared packaged profile`).not.toMatch(
        /Application Support\/Modoki Editor/,
      );
    }
  });

  it('the launcher list is complete — no un-listed script spawns a packaged binary', () => {
    const missed: string[] = [];
    for (const entry of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(sh|mjs)$/.test(entry.name)) continue;
      if ((LAUNCHERS as readonly string[]).includes(entry.name)) continue;
      const live = read(entry.name)
        .split('\n')
        .filter((l) => !/^\s*(#|\/\/)/.test(l))
        .join('\n');
      // A launch is a spawn/background-exec of the resolved packaged binary. `packagedAppPaths.mjs`
      // RESOLVES and REAPS one without ever launching it, which is why the match is on the
      // execution form rather than on the variable name.
      if (/"\$BIN"\s.*&\s*$/m.test(live) || /\bspawn\(\s*bin\b/.test(live)) missed.push(entry.name);
    }
    expect(missed, 'new packaged-app launcher(s) must isolate their profile and be listed here').toEqual([]);
  });
});
