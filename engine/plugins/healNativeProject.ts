/** Heal a native project before it is built — THE sequence, called by every entry point that
 *  builds one (#827): the editor's `/api/build` in-process, and `build-web.mjs --target native`
 *  through `loadEnginePluginModuleResult`.
 *
 *  Before #827 each entry point composed the steps below by hand, and the copies drifted: the CLI
 *  ran none of them (#148), then one (#150), then missed the stale-`node_modules` check (#685) — a
 *  guard landing in one copy was a trap for whichever entry point lacked it. The steps themselves
 *  were always single-sourced; what was duplicated was WHICH steps run and in WHAT ORDER. That is
 *  this function, and it is the only thing that knows.
 *
 *  ⚠️ Both entry points really do call it, and on a dev machine an editor native build runs it
 *  TWICE: once in-process, then again inside the `build-web.mjs --target native` step it spawns.
 *  That is not a duplicate to delete. A PACKAGED editor ships no esbuild, so the spawned script
 *  cannot load this module and degrades — there the route's in-process call is the only one that
 *  runs. Every step is idempotent, so the second run costs a few reads.
 *
 *  ORDER IS LOAD-BEARING — do not reorder:
 *   1. `healNativeConfig` — machine/identity settings (iOS DEVELOPMENT_TEAM, Android
 *      local.properties) that must land before anything shells out to xcodebuild/gradle.
 *   2. `ensureCapacitorDeps`, per platform — adds any Capacitor dep the engine now requires. When
 *      it adds `capacitor-game-debug`, it writes a PLACEHOLDER spec (`'*'`).
 *   3. `vendorEnginePlugins` — rewrites that placeholder to the real `file:plugins/<name>-<ver>.tgz`.
 *      Run BEFORE step 2 and the placeholder is never rewritten: a project stuck depending on a
 *      spec npm cannot install. Also run UNCONDITIONALLY, not only when deps changed (#90): it is
 *      idempotent and content-addressed, so an unchanged plugin re-packs nothing, but a plugin whose
 *      CONTENT changed needs a fresh tarball even when no dep was newly added.
 *   4. `npm install`, iff EITHER step 2 or step 3 changed something — a tarball or a new dep spec
 *      is inert until installed, and gating on only one would silently skip the other's install.
 *      The install marker is written only after it succeeds.
 *   5. `verifyInstalledMatchesTarballResult` — UNCONDITIONALLY, after step 4's `if`, never inside
 *      it (#685). Every signal step 4 trusts (the dep spec, both lockfiles, the install marker) can
 *      agree "nothing to do" while `node_modules/<plugin>` still holds a PREVIOUS tarball's bytes;
 *      a check gated on "something changed" could never fire in the one case it exists for. On a
 *      mismatch this REFUSES — no auto-repair: the vendorer knows its tarball is right, but this
 *      check knows only that the two disagree, and one reachable cause is a mis-resolved binary
 *      merge where the committed tarball is the wrong one. Auto-extracting it would install wrong
 *      bytes confidently and erase the only signal.
 *
 *  And one gate before all of them: the caller must HOLD THE BUILD CLAIM on this project
 *  (`holdsBuildClaim`). Every step mutates the project, so a heal running unclaimed lets two
 *  clones write one project at once — a gate that runs after the thing it gates. Enforced here, at
 *  the mutation, rather than as a line-ordering convention each entry point re-argues.
 *
 *  I/O is injected (`log`, `warn`, `install`) — the route streams over SSE and aborts with its
 *  client, the CLI prints and blocks — but nothing about WHICH steps run is. There is no option
 *  that skips a step; a caller that should not heal does not call this. */

import { healNativeConfig } from './healNativeConfig';
import { ensureCapacitorDeps, type NativePlatform } from './addNativeTarget';
import { vendorEnginePlugins, writeVendorMarker, verifyInstalledMatchesTarballResult } from './vendorPlugins';
import { describeUnreadablePackageJsonWarning } from '../scripts/staleNodeModulesWarning.mjs';
import { holdsBuildClaim } from '../scripts/buildClaimsStore.mjs';

export interface HealNativeProjectPorts {
  /** A progress line. */
  log: (line: string) => void;
  /** A warning the build continues past. */
  warn: (line: string) => void;
  /** Run `npm install` in the project, for `why`. Resolves `false` on failure (or abort). */
  install: (why: string) => Promise<boolean>;
}

export type HealNativeProjectResult =
  | { ok: true }
  /** The caller does not hold the build claim — nothing was touched. */
  | { ok: false; reason: 'not-claimed'; message: string }
  /** Step 4 failed. Steps 1-3 have already written; step 5 did not run. */
  | { ok: false; reason: 'install-failed'; why: string }
  /** Step 5 found `node_modules` holding the wrong bytes — `lines` is the full diagnosis + remedy. */
  | { ok: false; reason: 'stale-node-modules'; problems: string[]; lines: string[] };

/** Heal `projectRoot` for a native build of `platforms`, from the engine checkout at `editorRoot`.
 *  `platforms` is an INPUT, not a switch: the route builds one platform, the CLI's `--target
 *  native` covers whichever of `ios/`/`android/` exist. An empty list still runs steps 1, 3, 4, 5. */
export async function healNativeProject(
  projectRoot: string,
  editorRoot: string,
  platforms: readonly NativePlatform[],
  ports: HealNativeProjectPorts,
): Promise<HealNativeProjectResult> {
  if (!holdsBuildClaim(projectRoot)) {
    return {
      ok: false,
      reason: 'not-claimed',
      message: `refusing to heal ${projectRoot}: this process does not hold its build claim. Every heal `
        + 'writes the project, so it must run under the claim a build takes first (#827).',
    };
  }

  // 1.
  for (const n of healNativeConfig(projectRoot).notes) ports.log(`[heal] ${n}`);

  // 2.
  let depsChanged = false;
  for (const platform of platforms) {
    const depHeal = ensureCapacitorDeps(projectRoot, platform, editorRoot);
    for (const n of depHeal.notes) ports.log(`[heal] ${n}`);
    depsChanged = depsChanged || depHeal.changed;
  }

  // 3.
  const v = vendorEnginePlugins(projectRoot, editorRoot);
  if (v.vendored.length) ports.log(`[heal] vendored engine plugin(s): ${v.vendored.join(', ')}`);

  // 4. — an `if`, not an early return: step 5 runs on every call.
  if (depsChanged || v.needsInstall) {
    const why = depsChanged ? 'healed Capacitor plugins' : 'engine plugin changed';
    if (!(await ports.install(why))) return { ok: false, reason: 'install-failed', why };
    writeVendorMarker(projectRoot, v.expectedVendor);
  }

  // 5.
  const { problems, reason } = verifyInstalledMatchesTarballResult(projectRoot);
  if (reason === 'unreadable-package-json') ports.warn(describeUnreadablePackageJsonWarning(projectRoot));
  if (problems.length) {
    return { ok: false, reason: 'stale-node-modules', problems, lines: describeStaleNodeModules(projectRoot, problems) };
  }
  return { ok: true };
}

/** The diagnosis + SAFE remedy for step 5's refusal, as lines — one text for every entry point.
 *
 *  ⚠️ `npm install --package-lock-only` is what CREATES this state (#685, measured 2026-09-05): it
 *  writes the new resolved+integrity into both lockfiles without extracting, and a tree left there
 *  is unrecoverable by any plain install. So its ONLY permitted mention is the warning not to run
 *  it. And the conditional third step must survive: on a tree that remedy already poisoned, "delete
 *  the entry + plain install" reports `up to date` and never re-extracts — only removing the
 *  package dir repairs it (measured, npm 11.12.1 / node v26). */
export function describeStaleNodeModules(projectRoot: string, problems: readonly string[]): string[] {
  return [
    `node_modules is STALE for ${problems.length} vendored plugin(s) — this build would ship the WRONG native code (#685):`,
    ...problems.map((p) => `  • ${p}`),
    '',
    '⚠️ Do NOT reach for `npm install --package-lock-only` — measured (#685): it is what CREATES this state, '
      + 'writing the new resolved+integrity into both lockfiles without extracting, and a tree left there is '
      + 'unrecoverable by any plain install. A bare `npm install` or `--force` will not fix it either.',
    'Repair, in order:',
    `  1. delete the plugin's entry from ${projectRoot}/package-lock.json ("node_modules/<plugin>" under "packages")`,
    `  2. (cd ${projectRoot} && npm install)   # a PLAIN install — it now re-resolves AND extracts`,
    '  3. ONLY if step 2 reported "up to date" and this check still fires — then node_modules/.package-lock.json '
      + 'is ahead of the disk and nothing will re-extract:',
    `     (cd ${projectRoot} && rm -rf node_modules/<plugin> && npm install)`,
  ];
}
