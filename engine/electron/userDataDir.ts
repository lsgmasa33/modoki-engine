// WHERE the editor keeps its state. Pure resolvers so the layout is unit-testable — the
// real thing is only observable on a packaged launch, and this repo has now been wrong
// about it three times in a row.
//
// THE HISTORY THAT MOTIVATES THIS (all measured, not assumed):
//   - Electron RESOLVES AND CACHES userData on the FIRST read, so whoever reads first wins.
//     `app.setName('Modoki Editor')` sat 240 lines below `initFileLog()` — which reads
//     userData — so the rename was silently demoted to a no-op the day initFileLog landed
//     (ff364b47, a Windows crash fix). The shipped editor's 1.2GB toolchain and prefs moved
//     from `Modoki Editor` to `modoki-app`; a Jul-16 build still used the former. Nothing
//     threw, nothing logged. The fix is ORDER (decide userData above the first reader) plus
//     `setPath`, which overrides the resolved entry rather than hoping to precede it.
//   - EVERY dev clone resolved userData to the SAME `appData/Electron` (dev runs
//     `electron main.cjs`), so the several editors CLAUDE.md RULE 2 runs at once shared one
//     Chromium profile. Measured consequences: the FIRST editor takes the Local Storage
//     LevelDB lock and later ones silently get none (sceneViewMode / last-scene /
//     buildSupportDismissed stop persisting, with no error anywhere); they share one
//     `logs/main.log`; and they hold one GPU/shader cache open concurrently, which
//     Chromium's disk_cache does not expect.
//
// So: userData is scoped per EDITOR IDENTITY, and the toolchain is deliberately NOT.

import path from 'node:path';
import { createHash } from 'node:crypto';

/** Product dir for the shipped editor — what `setName` was supposed to give us. */
export const PACKAGED_DIR = 'Modoki Editor';
/** Parent for per-clone dev profiles. Prefixed the same way so both sort together and a
 *  user can see at a glance which dirs are Modoki's. */
export const DEV_DIR = 'Modoki Editor (dev)';
/** MACHINE-level dir for the provisioned toolchain — see resolveToolchainDir. */
export const SHARED_DIR = 'Modoki';

/** Short, stable, filesystem-safe id for a clone path. Not security — just a folder name
 *  that can't collide and doesn't leak a giant path into the UI.
 *
 *  NORMALISE FIRST: this id IS the profile's identity, so any spelling drift of the same
 *  clone silently hands the user an empty profile (prefs "randomly" reset). Resolve, drop a
 *  trailing separator, and case-fold on the case-insensitive platforms — the same
 *  normalisation instanceToken.rootKey does, and for the same reason. */
function cloneId(repoRoot: string): string {
  const abs = path.resolve(repoRoot);
  const trimmed = abs.length > 1 && (abs.endsWith('/') || abs.endsWith('\\')) ? abs.slice(0, -1) : abs;
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
  return createHash('sha256').update(norm).digest('hex').slice(0, 8);
}

/**
 * A stable, filesystem-safe sub-profile key for a `MODOKI_MULTI` editor, derived from the
 * project it opened (§14.4). Null when there's no project to key on.
 *
 * WHY project, not pid/port: §14.2's fix keys dev userData on the CLONE path, which fixed
 * clone-vs-clone — but SEVERAL editors can run inside ONE clone (`MODOKI_MULTI`), and they
 * still shared that one clone profile, so the LevelDB single-writer fight persisted. The
 * obvious keys are all wrong: a per-LAUNCH id (pid/port) hands each launch a fresh EMPTY
 * profile (worse than sharing — prefs reset every time). A MULTI editor is launched to open
 * a SPECIFIC project, so the project is the one discriminator that is BOTH stable across
 * relaunches AND distinct between co-running editors (they open different games). A short
 * hash of the resolved path disambiguates same-named projects in different locations; the
 * readable slug prefix keeps the on-disk dir debuggable.
 */
export function multiProfileKey(project: string | undefined | null): string | null {
  if (!project || !project.trim()) return null;
  const abs = path.resolve(project.trim());
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * The userData dir for THIS editor.
 *  - packaged → `<appData>/Modoki Editor` — one shipped app, one profile.
 *  - dev      → `<appData>/Modoki Editor (dev)/<clone-id>` — per CLONE, because clones are
 *               independent checkouts that run SIMULTANEOUSLY (RULE 2) and a shared
 *               Chromium profile makes them fight over one LevelDB lock.
 *  - dev + `subKey` → `…/<clone-id>/<subKey>` — a `MODOKI_MULTI` editor's own sub-profile,
 *               so co-running editors in ONE clone stop fighting over the LevelDB lock (§14.4).
 *
 * Keyed by the clone's PATH (not branch/version), so switching branches or rebuilding keeps
 * a clone's profile — matching how projects.ts scopes recents. `subKey` is applied ONLY for
 * dev (the packaged app is single-instance, so it never needs sub-profiles) and only when the
 * caller passes one (MULTI + a known project), so the common single-editor case is unchanged.
 */
export function resolveUserDataDir(opts: { appData: string; isPackaged: boolean; repoRoot: string; subKey?: string | null }): string {
  if (opts.isPackaged) return path.join(opts.appData, PACKAGED_DIR);
  const base = path.join(opts.appData, DEV_DIR, cloneId(opts.repoRoot));
  return opts.subKey ? path.join(base, opts.subKey) : base;
}

/**
 * Should main override userData at all?
 *
 * NO when the launcher passed Chromium's own `--user-data-dir` — that switch exists to
 * isolate a profile, and our setPath would silently defeat it. Not hypothetical: the CSP
 * smoke (`engine/scripts/assert-app-csp.mjs`) spawns the packaged app with
 * `--user-data-dir=<temp>` precisely to avoid touching the real profile, and an
 * unconditional setPath made that flag a no-op — which is the SAME "a later write wins over
 * an earlier decision" bug this whole module exists to fix, just pointed the other way.
 *
 * Takes the raw argv so the decision is testable without an Electron app object.
 */
export function shouldOverrideUserData(argv: readonly string[]): boolean {
  return !argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
}

/**
 * The provisioned toolchain (Node, JDK, Android SDK, Ruby, CocoaPods, npm-tools).
 *
 * MACHINE-level, and deliberately OUTSIDE userData: a JDK is a JDK. `projects.ts` already
 * documents this intent ("the toolchain is machine-shared") — it just wasn't true, because
 * hanging it off userData silently gave each FLAVOUR its own copy (measured: `npm-tools`
 * duplicated across dev and packaged, and a full 1.2GB set that a userData move would have
 * re-downloaded). Pinning it here makes the existing claim true, de-dupes it, and lets
 * userData be scoped freely without billing anyone a re-download.
 *
 * Sharing is safe because provisioning is idempotent (each tool installs under its own
 * subdir and is skipped when present); it is NOT a lock, so two editors provisioning the
 * same tool at the exact same moment is still a race — pre-existing, not introduced here.
 */
export function resolveToolchainDir(appData: string): string {
  return path.join(appData, SHARED_DIR, 'toolchain');
}

/** Legacy toolchain homes, newest-intent first. Both are `<old userData>/toolchain`:
 *  `modoki-app` is where the PACKAGED app kept it (it has the full set — JDK, Android SDK),
 *  `Electron` is dev's. */
export const LEGACY_TOOLCHAIN_DIRS = ['modoki-app', 'Electron'] as const;

/**
 * One-time ADOPT of a pre-existing toolchain into the machine-level dir.
 *
 * Pinning `resolveToolchainDir` moved WHERE we look, not the DATA — so without this the
 * shipped editor silently re-downloads ~1.2GB (JDK 336M + Android SDK 527M + Node + Ruby +
 * CocoaPods), and **Android/iOS builds fail until it finishes**. I claimed the opposite
 * ("not re-downloaded") while my own smoke log said `provisioned Node v22.23.1 → …/Modoki/
 * toolchain/node`. A rename is instant and atomic within one volume, and both the old and
 * new homes are under appData — so adopt instead of re-fetch.
 *
 * Best-effort and idempotent: no-op once the new dir exists (so it runs once, and a second
 * editor racing us just finds it present or loses the rename harmlessly). Returns the dir
 * adopted from, or null.
 */
export function adoptLegacyToolchain(
  appData: string,
  fsLike: { existsSync(p: string): boolean; renameSync(a: string, b: string): void; mkdirSync(p: string, o: { recursive: true }): void },
): string | null {
  const target = resolveToolchainDir(appData);
  if (fsLike.existsSync(target)) return null; // already adopted/provisioned — never merge
  for (const legacy of LEGACY_TOOLCHAIN_DIRS) {
    const from = path.join(appData, legacy, 'toolchain');
    if (!fsLike.existsSync(from)) continue;
    try {
      fsLike.mkdirSync(path.dirname(target), { recursive: true });
      fsLike.renameSync(from, target);
      return from;
    } catch {
      return null; // lost a race, or cross-device → provisioning re-fetches; never fatal
    }
  }
  return null;
}
