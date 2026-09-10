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
// The ONE path-identity normalisation (#869) — see engine/scripts/pathIdentity.mjs. Until #899
// this file hand-rolled it twice, and neither copy resolved symlinks.
import { canonicalPath, pathCaseKey, samePath } from '../scripts/pathIdentity.mjs';

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
 *  clone silently hands the user an empty profile (prefs "randomly" reset).
 *
 *  ⚠️ **Until #899 the normalisation was hand-rolled here and resolved no SYMLINKS**, so the
 *  drift it warns about was reachable by the most ordinary means there is: open the clone through
 *  a symlinked path and it is a different clone, with a different profile. Driven, two ids for one
 *  directory. It goes through the SSOT now.
 *
 *  ⚠️ **On POSIX the only production caller cannot actually produce a symlinked `repoRoot`, and
 *  this docblock overstated the fix** (close-out review). `main.ts` derives dev `REPO_ROOT` from
 *  `path.resolve(__dirname, …)`, and Node realpaths the MAIN MODULE before setting `__dirname` —
 *  measured: a script run through a symlinked ancestor reports the resolved dir. So the reachable
 *  half of this fix is the WINDOWS half: Node's main-module resolution uses the JS `fs.realpathSync`,
 *  which resolves neither a `subst` mapping nor drive-letter case, and `.native` does. That half is
 *  not driven — see docs/windows.md § Paths. `multiProfileKey` below is NOT subject to this caveat:
 *  it takes `MODOKI_PROJECT`, a raw human-typed string that genuinely can carry a symlink.
 *
 *  ⚠️ **THIS ID MOVES for a symlink-reached clone, and that is deliberate — there is no migration,
 *  and one was tried and rejected.** Measured 2026-09-08: the id is byte-identical under the old
 *  and new recipes for every real clone path on a developer machine; the ONLY paths that move are
 *  the ones traversing a symlink, i.e. exactly the ones that were already split across two
 *  profiles. Such a user loses prefs ONCE and is consistent afterwards.
 *
 *  A fallback ("use the old dir if it still exists") was written and then deleted, because both
 *  ways of keying it are broken and the measurement says so:
 *    - keyed on the RAW spelling, it adopts a different old dir per spelling — so the two
 *      profiles never converge and the fix does nothing for the only people who need it;
 *    - keyed on the CANONICAL spelling, it is byte-identical to the new id (measured
 *      `legacy(canonical) === next`), i.e. dead code that can never fire.
 *  Renaming the dir instead is worse: it is a live Chromium profile holding a LevelDB lock. */
function cloneId(repoRoot: string): string {
  return createHash('sha256').update(pathCaseKey(canonicalPath(repoRoot))).digest('hex').slice(0, 8);
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
  // #899: canonicalPath, so a symlinked MODOKI_PROJECT is the same sub-profile — and so that the
  // readable slug is the PROJECT's name rather than the link's. Same no-migration call as cloneId.
  const abs = canonicalPath(project.trim());
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const hash = createHash('sha256').update(pathCaseKey(abs)).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * The userData dir for THIS editor: `<appData>/<flavour>/<editor-id>[/<subKey>]`.
 *
 *  - dev      → `<appData>/Modoki Editor (dev)/<clone-id>` — per CLONE, because clones are
 *               independent checkouts that run SIMULTANEOUSLY (RULE 2) and a shared
 *               Chromium profile makes them fight over one LevelDB lock.
 *  - packaged → `<appData>/Modoki Editor/<install-id>` — per INSTALL, for the same reason.
 *  - either, + `subKey` → `…/<editor-id>/<subKey>` — one project's own sub-profile, so
 *               co-running editors stop fighting over the LevelDB lock (§14.4).
 *
 * ⚠️ **The packaged branch used to be `<appData>/Modoki Editor` flat, with `repoRoot` and
 * `subKey` both thrown away** — the comment justified it as *"one shipped app, one profile"*
 * and *"the packaged app is single-instance, so it never needs sub-profiles"*. Neither held
 * (#1036). Nothing calls `requestSingleInstanceLock`, so the app is single-instance only by
 * macOS convention for a Finder launch — every packaged launch path in this repo starts the
 * binary directly. And a machine can carry several packaged builds: each clone's
 * `smoke-packaged.sh` produces its own under `modoki-pkg-smoke-$CLONE`. The flat dir was not
 * a decision about shipped apps, it was §14.2's fix never being applied to this branch — and
 * it was invisible because a real end user has exactly one install, for whom "all installs
 * share one dir" and "each install gets its own dir" name the same directory.
 *
 * So there is no flavour branch left: both are `<flavour>/<id-of-what-varies>`, where the id
 * hashes `repoRoot` — the clone path in dev, the unpacked bundle dir when packaged. Deleting
 * the special case is the point; this file's history is a list of special cases going wrong.
 *
 * Keyed by PATH (not branch/version), so switching branches or rebuilding keeps a profile —
 * matching how projects.ts scopes recents.
 */
/* ⚠️ #899 made this (and `multiProfileKey`) do FILESYSTEM I/O where they were pure string ops —
 * `canonicalPath` calls `fs.realpathSync.native`. `main.ts` calls both at module load, ABOVE
 * `initFileLog()`, because the userData decision must precede the first `app.getPath('userData')`
 * read. So a `MODOKI_PROJECT` or repo root on a hung SMB/SSHFS mount now blocks the main process
 * before any log file exists: no window, no log. `canonicalPath` catches throws but does not bound
 * time. Accepted (the ordering constraint is not negotiable and a timeout here would need its own
 * fallback identity), recorded so it is not re-diagnosed as a hang of unknown origin. */
export function resolveUserDataDir(opts: { appData: string; isPackaged: boolean; repoRoot: string; subKey?: string | null }): string {
  const base = path.join(opts.appData, opts.isPackaged ? PACKAGED_DIR : DEV_DIR, cloneId(opts.repoRoot));
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

/**
 * One-time ADOPT of the editor's OWN state files into the keyed profile dir (#1041).
 *
 * `3c61ce6fe` (#1036) moved the packaged profile from `<appData>/Modoki Editor` to
 * `<appData>/Modoki Editor/<install-id>` — so the legacy home is precisely the PARENT of the new
 * one. It moved where we LOOK, not the data, and **every reader keyed off `editorStateDir()` reads
 * "file absent" as "the user never chose"**. For an existing install that is wrong exactly once, and
 * one of those readers is a security opt-out that fails OPEN: `readCdpEnabled` returns true for an
 * absent `cdp.json`, so a 127.0.0.1 remote-debugging port the user deliberately unchecked silently
 * comes back on the first launch after upgrade. It is the one item in #1036's reset list a user
 * cannot notice by looking — the AI panel's checkbox reads the same missing file, so it agrees with
 * the wrong answer. (Measured 2026-09-10: the shipped v0.6.0 install on the author's machine still
 * has `backend-port.json`, `cdp-port.json` and `instance-tokens.json` sitting flat in the legacy dir.)
 *
 * ⚠️ **Matched by EXTENSION, not by a list of names.** Enumerating the state files was the first
 * draft and it was already wrong: `ui-prefs.json` is a bare literal in `zoom.ts` rather than an
 * exported constant, so a hand-maintained set would have shipped missing one, invisibly — the same
 * "bind the whole thing rather than enumerate fields" call CLAUDE.md makes for authored prefabs. A
 * `*.json` file directly in the profile root is ours by construction: Chromium's own files there are
 * extension-less (`Preferences`, `Local State`, `Cookies`, `DIPS`, `Network Persistent State`) or
 * directories. Verified against a real pre-#1036 profile — the only `*.json` at that root were the
 * three above.
 *
 * ⚠️ **COPY, not rename** (owner, 2026-09-10) — the one place this deliberately departs from
 * `adoptLegacyToolchain` above. A toolchain is 1.2GB and single-owner, so moving it is right. These
 * are small JSON files under a dir shared by EVERY packaged install on the machine (each clone's
 * `smoke-packaged.sh` builds its own), and a rename would let the first upgraded install strip the
 * opt-out from the others — reintroducing this very bug, rarer and harder to spot. The cost accepted
 * in exchange is that the legacy files linger; cleaning them up is a separate, deliberate step.
 *
 * ⚠️ **The two DOTFILES in that directory are deliberately NOT adopted, and this is not an
 * oversight of the `*.json` rule.** `.updaterId` (electron-updater's staged-rollout id) and
 * `.vite-cache-build` (the signature pairing with `vite-cache`) are both read from
 * `app.getPath('userData')` — which is the possibly SUB-KEYED dir — while everything here is read
 * from `editorStateDir()`, which is deliberately the subKey-less `base`. They live in a different
 * directory by design, so copying them into `base` would not put them where their readers look.
 * The cost of leaving them is a fresh rollout bucket and one cache rebuild after an upgrade.
 *
 * Non-recursive, best-effort per file, and **never clobbers**: a file already present in the new
 * profile is a choice made THERE and always wins, which is also what makes this idempotent and safe
 * to run on every launch. Returns the basenames adopted (for the launch log), or `[]`.
 */
export function adoptLegacyEditorState(
  appData: string,
  target: string,
  fsLike: {
    readdirSync(p: string): string[];
    statSync(p: string): { isFile(): boolean };
    existsSync(p: string): boolean;
    mkdirSync(p: string, o: { recursive: true }): void;
    copyFileSync(a: string, b: string): void;
  },
): string[] {
  const legacy = path.join(appData, PACKAGED_DIR);
  // Nothing to do when the profile IS the legacy dir (a pre-#1036 layout, or a caller that passed
  // the unkeyed path) — copying a directory onto itself would be a no-op at best.
  if (samePath(legacy, target)) return [];
  let names: string[];
  try { names = fsLike.readdirSync(legacy); } catch { return []; } // no legacy profile — a clean install
  const adopted: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // …which also skips the keyed subdir itself
    try {
      if (!fsLike.statSync(path.join(legacy, name)).isFile()) continue;
      if (fsLike.existsSync(path.join(target, name))) continue; // the new profile's own choice wins
      fsLike.mkdirSync(target, { recursive: true });
      fsLike.copyFileSync(path.join(legacy, name), path.join(target, name));
      adopted.push(name);
    } catch { /* best-effort per file: one unreadable pref must not strand the others */ }
  }
  return adopted;
}
