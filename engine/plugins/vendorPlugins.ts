/** Vendor engine-provided Capacitor plugins into a game project as COPIES — no
 *  symlinks. (User decision: never symlink engine→game; the dmg editor's engine
 *  lives inside a signed, read-only .app that a `file:../../engine` dir dep can't
 *  reach.)
 *
 *  Mechanism — npm tarball extraction:
 *    - `file:` dep → a DIRECTORY  ⇒ npm makes a SYMLINK (what we're avoiding).
 *    - `file:` dep → a `.tgz`     ⇒ npm EXTRACTS a real COPY into node_modules.
 *  So we `npm pack` the engine plugin into `<project>/plugins/<name>-<ver>.tgz`
 *  and point the project's dependency at that tarball. Capacitor then
 *  auto-discovers the copied package in node_modules exactly like a registry dep.
 *
 *  The tarball is CONTENT-ADDRESSED (`<name>-<ver>-<hash>.tgz`) and COMMITTED,
 *  so `npm ci` / CI / a fresh clone consume it directly with matching lockfile
 *  integrity — no build-time regeneration needed. Re-vendoring (heal-on-open) is
 *  a no-op unless the engine plugin's CONTENT changes (new hash → fresh pack →
 *  dep spec + lockfile update together). The editor packs from its OWN engine
 *  (`app.asar.unpacked/engine/packages/...` when packaged), so an EXTERNAL/dmg
 *  project that doesn't ship the tarball still gets one generated on open.
 *
 *  This is the single mechanism for ALL engine-provided native plugins; today
 *  that's `capacitor-game-debug`, and the ad/Adjust plugins can adopt it later. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { npmSpawnSpec } from '../toolchain';

export interface VendorResult {
  /** True if any tarball was (re)generated or any dependency spec was rewritten. */
  changed: boolean;
  /** True if the caller must (re)install so node_modules reflects the vendored
   *  copies. Set when `changed`, OR an engine plugin is missing from
   *  node_modules, OR still installed as the OLD symlink form (migration), OR the
   *  installed copy was extracted from a DIFFERENT tarball than the current one
   *  (e.g. a `git pull` brought a new committed tarball without touching
   *  node_modules — D3). */
  needsInstall: boolean;
  /** Plugin names vendored this pass (for logging). */
  vendored: string[];
  /** name → current `file:plugins/<name>-<ver>-<hash>.tgz` spec for every engine
   *  plugin the project depends on. The caller writes this as the install marker
   *  (writeVendorMarker) AFTER a successful install, so a later open can detect a
   *  stale extraction (D3). */
  expectedVendor: Record<string, string>;
}

/** Records which vendored tarball each engine plugin was last INSTALLED from, so
 *  a stale node_modules extraction (real dir, but from an older tarball) is
 *  detectable on the next open. Lives inside node_modules (regenerated, not
 *  committed). (D3) */
const VENDOR_MARKER = path.join('node_modules', '.modoki-vendored.json');

function readVendorMarker(projectRoot: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, VENDOR_MARKER), 'utf8'));
  } catch {
    return {};
  }
}

/** Write the install marker AFTER a successful install. No-op if node_modules is
 *  absent (nothing was installed to mark). */
export function writeVendorMarker(projectRoot: string, specs: Record<string, string>): void {
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) return;
  try {
    fs.writeFileSync(path.join(projectRoot, VENDOR_MARKER), JSON.stringify(specs, null, 2) + '\n');
  } catch {
    /* best-effort — a missing marker just forces a reinstall next open */
  }
}

/** True if `node_modules/<name>` is absent or a SYMLINK (the old `file:`-dir
 *  form). A vendored tarball extracts to a REAL directory, so a symlink here
 *  means the project hasn't been reinstalled since migration. */
function pluginInstallStale(projectRoot: string, name: string): boolean {
  const nm = path.join(projectRoot, 'node_modules', name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(nm);
  } catch {
    return true; // not installed
  }
  return st.isSymbolicLink();
}

interface EnginePlugin {
  name: string;
  dir: string;
  version: string;
}

/** Engine-provided Capacitor plugins = subdirs of engine/packages whose
 *  package.json declares a `capacitor` field (i.e. they're cap plugins, not
 *  plain libs like @modoki/engine). Discovered dynamically so a new plugin is
 *  picked up without editing this list. */
function listEnginePlugins(engineRoot: string): EnginePlugin[] {
  const pkgDir = path.join(engineRoot, 'engine', 'packages');
  if (!fs.existsSync(pkgDir)) return [];
  const out: EnginePlugin[] = [];
  for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pkgDir, entry.name);
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (pkg && pkg.capacitor && typeof pkg.name === 'string') {
        out.push({ name: pkg.name, dir, version: String(pkg.version ?? '0.0.0') });
      }
    } catch {
      /* skip unreadable package.json */
    }
  }
  return out;
}

/** npm's tarball filename, with the plugin CONTENT hash appended so the file is
 *  content-addressed: `capacitor-game-debug-1.0.0-<hash8>.tgz`. Stable across
 *  machines (hashes the PUBLISHED fileset's bytes, NOT mtimes or dev-only files),
 *  so an unchanged plugin always maps to the SAME committed tarball — `npm ci`
 *  finds it + the integrity matches, and
 *  re-vendoring is a no-op (we never re-pack an existing hash). A content change
 *  yields a new filename → a fresh pack → the dep spec + lockfile update together.
 *  Scoped names drop the @ and turn / into -. */
function tarballName(name: string, version: string, hash: string): string {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}-${hash}.tgz`;
}

/** Files npm ALWAYS excludes from a published tarball, even inside a `files` dir.
 *  Matching npm's default ignore keeps machine-local junk (.DS_Store) and VCS/dev
 *  metadata out of the source-input hash so they never rename the tarball. */
function npmAlwaysExcluded(basename: string): boolean {
  if (basename === 'node_modules' || basename === '.git' || basename === '.svn' || basename === 'CVS' || basename === '.hg') return true;
  if (basename === '.gitignore' || basename === '.npmignore' || basename === '.npmrc') return true;
  if (basename === '.DS_Store' || basename === 'npm-debug.log') return true;
  if (basename === 'package-lock.json' || basename === 'yarn.lock' || basename === 'pnpm-lock.yaml') return true;
  if (basename === 'Package.resolved') return true; // SPM lockfile — gitignored, machine-local (like the *-lock files above)
  if (basename.endsWith('.tgz') || basename.startsWith('._') || /^\..*\.swp$/.test(basename)) return true;
  return false;
}

/** Directories that hold DERIVED build output or tool caches — never source
 *  inputs, so they're excluded from the plugin's identity hash at ANY depth.
 *  `dist` is the JS build (rollup/tsc); `build`/`.gradle` are Android/gradle
 *  output+cache (e.g. android/build, android/.gradle); `.build`/`DerivedData`/
 *  `Pods`/`.cxx` are iOS/SPM/CocoaPods/NDK output; `.swiftpm` is SPM's local
 *  workspace/user-data dir (schemes, xcuserdata — gitignored, per-machine).
 *  Hashing any of these would make the tarball name depend on the exact toolchain
 *  that built them and on whether a native build ran locally — exactly the
 *  non-reproducible churn this hash must avoid. (Mirrors the repo's own "not
 *  source" dir list.) */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', '.gradle', '.build', 'DerivedData', 'Pods', '.cxx', '.swiftpm']);

/** Sorted plugin-relative POSIX paths that feed the identity hash — the plugin's
 *  SOURCE INPUTS: every file EXCEPT derived build-output/cache dirs (see
 *  BUILD_OUTPUT_DIRS) and npm-always-excluded junk.
 *
 *  WHY exclude build output — it is byte-sensitive to the exact tsc/rollup/gradle
 *  versions doing the build, gitignored, and rebuilt on every `npm install`
 *  (root postinstall → build:plugins) or native build. Hashing it made the
 *  tarball NAME drift whenever the toolchain drifted across clones or over time —
 *  the recurring "sync/rebuilt tgz" churn (each install could rename the tarball
 *  with zero source changes). The tarball's identity must answer "did the
 *  plugin's SOURCE change?", NOT "did the build output shift?". So a source edit
 *  (src/ or native ios/android/manifest) still yields a new hash → one fresh pack
 *  (with a freshly-built dist INSIDE it, since packInto builds first); a pure
 *  toolchain/build-artifact drift does not re-pack. The committed tarball is
 *  reused across every clone → `npm ci` integrity stays put.
 *
 *  This supersedes the earlier "published-fileset" scoping, which still hashed
 *  dist/ (and assumed src/ was the volatile input — it's the reverse: src/ is
 *  stable, the build output drifts). We hash ALL inputs and exclude only derived
 *  dirs, so we can't under-hash a real input (over-hashing a stray source file is
 *  safe — a spurious rename at worst, never a hash COLLISION that would break
 *  npm ci). Bonus: the hash no longer depends on whether/what got built locally,
 *  so every clone computes the SAME name before and after its first build.
 *
 *  Exported so a repo-invariant test can assert this set is EXACTLY the committed
 *  source for each real engine plugin (no untracked/gitignored file leaks in →
 *  reproducible across clones — the litter-leak bug the BUILD_OUTPUT_DIRS list
 *  guards against, for whatever dir names a future plugin's build tool emits). */
export function pluginHashInputs(pluginDir: string): string[] {
  const acc: string[] = [];
  const stack = [pluginDir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (npmAlwaysExcluded(e.name)) continue;
      // Skip derived build-output/cache dirs (any depth) — not source inputs.
      if (e.isDirectory() && BUILD_OUTPUT_DIRS.has(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else acc.push(path.relative(pluginDir, p).split(path.sep).join('/'));
    }
  }
  return acc.sort();
}

/** Content hash (8 hex) of the plugin's SOURCE INPUTS (see pluginHashInputs),
 *  by sorted relative path + contents. Deterministic (no mtimes).
 *
 *  A read error is NOT swallowed (D10): a listed file that fails to read would
 *  contribute only its path → a different hash than a clean read → a spurious
 *  re-pack. Let it throw so vendoring fails loudly (the caller logs + continues). */
function pluginContentHash(pluginDir: string): string {
  const h = createHash('sha256');
  for (const rel of pluginHashInputs(pluginDir)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(pluginDir, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 8);
}

/** Build inputs that determine `dist/` — hashed to detect a STALE dist. Excludes
 *  the native dirs (ios/android ship as-is, they don't feed the JS build) and
 *  anything generated. Returns null when the plugin ships WITHOUT sources (the
 *  packaged editor bundles a prebuilt dist and no src/) — there's nothing to
 *  rebuild from, so the shipped dist is authoritative. */
function pluginSourceHash(pluginDir: string): string | null {
  const srcDir = path.join(pluginDir, 'src');
  if (!fs.existsSync(srcDir)) return null; // packaged editor: prebuilt dist, no sources
  const files: string[] = [];
  const stack = [srcDir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (npmAlwaysExcluded(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else files.push(p);
    }
  }
  // Build config counts too: a tsconfig/rollup/package.json change alters output.
  for (const cfg of ['package.json', 'tsconfig.json', 'rollup.config.mjs']) {
    const p = path.join(pluginDir, cfg);
    if (fs.existsSync(p)) files.push(p);
  }
  const h = createHash('sha256');
  for (const abs of files.sort()) {
    h.update(path.relative(pluginDir, abs).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(abs));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** Where the build stamp lives. Deliberately OUTSIDE the packed fileset
 *  (`files: [... "dist/" ...]`): pluginContentHash intentionally hashes only
 *  SHIPPED bytes so a non-shipped dev-file change doesn't cause a spurious
 *  re-pack — putting a source-derived stamp inside dist/ would reintroduce
 *  exactly that bug. node_modules/ is gitignored everywhere, so the stamp is
 *  per-clone (like dist/ itself) and never committed. */
function buildStampPath(pluginDir: string): string {
  return path.join(pluginDir, 'node_modules', '.modoki-buildstamp');
}

function readBuildStamp(pluginDir: string): string | null {
  try { return fs.readFileSync(buildStampPath(pluginDir), 'utf8').trim() || null; } catch { return null; }
}

function writeBuildStamp(pluginDir: string, stamp: string): void {
  try {
    fs.mkdirSync(path.dirname(buildStampPath(pluginDir)), { recursive: true });
    fs.writeFileSync(buildStampPath(pluginDir), stamp);
  } catch { /* best-effort: a missing stamp only costs one extra rebuild */ }
}

/** Ensure the plugin's built `dist/` exists AND is CURRENT for its sources (it
 *  ships JS only from a gitignored dist). In a packaged editor dist is shipped;
 *  in dev it's built by the root `build:plugins` postinstall — but build it on
 *  demand if missing OR STALE so a fresh worktree heals itself.
 *
 *  Staleness is decided by a SOURCE-content stamp, never mtimes: git sets file
 *  mtimes to checkout time, so an mtime compare both spuriously rebuilds after a
 *  branch switch AND silently misses a stale dist whose files happen to be newer.
 *  Missing this check let a clone with an out-of-date dist pack a tarball that
 *  didn't match its own sources — and because the content hash was computed FROM
 *  that stale dist, the name matched the committed tarball, so vendoring was a
 *  permanent no-op that never healed. */
function ensurePluginBuilt(plugin: EnginePlugin): void {
  const srcHash = pluginSourceHash(plugin.dir);
  const distExists = fs.existsSync(path.join(plugin.dir, 'dist'));
  // No sources (packaged editor) ⇒ the shipped dist is authoritative.
  if (srcHash === null && distExists) return;
  if (distExists && srcHash !== null && readBuildStamp(plugin.dir) === srcHash) return;
  // Cross-process lock (atomic mkdir): if two editors / worktrees open projects at
  // once and both find dist missing, only ONE builds — the other waits for dist to
  // appear rather than racing writes into the same dir (a half-built dist would get
  // packed). (D7)
  const lock = path.join(plugin.dir, '.modoki-building');
  let held = false;
  try { fs.mkdirSync(lock); held = true; } catch { /* another process is building */ }
  if (!held) {
    // Steal a STALE lock (a crashed build that never released it) so vendoring
    // doesn't wedge forever; a live build refreshes faster than this threshold.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        held = true;
      }
    } catch { /* lost the race to another process — fall through to wait */ }
  }
  if (!held) {
    // Wait for the concurrent build to produce a dist that is CURRENT for these
    // sources — not merely present. Waiting on existence alone would return the
    // moment a stale dist was on disk (or a half-written one), which is the very
    // staleness this function exists to prevent.
    const fresh = () =>
      fs.existsSync(path.join(plugin.dir, 'dist')) &&
      (srcHash === null || readBuildStamp(plugin.dir) === srcHash);
    const deadline = Date.now() + 120_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fresh() && Date.now() < deadline) {
      Atomics.wait(sleeper, 0, 0, 250); // sync sleep (this whole module runs sync)
    }
    if (!fresh()) {
      throw new Error(`[vendor] timed out waiting for a concurrent build of ${plugin.name} dist`);
    }
    return;
  }
  try {
    console.log(`[vendor] building ${plugin.name} dist…`);
    const npm = npmSpawnSpec();
    execFileSync(npm.command, [...npm.prefixArgs, 'run', 'build'], { cwd: plugin.dir, stdio: 'inherit', shell: npm.shell, env: npm.env });
    // Stamp AFTER a successful build only: if the build throws we leave the old
    // (or absent) stamp so the next pass retries instead of trusting bad output.
    if (srcHash !== null) writeBuildStamp(plugin.dir, srcHash);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Pack `plugin` into `<projectRoot>/plugins/<name>-<ver>-<hash>.tgz` (real copy),
 *  drop stale tarballs for the same plugin (older content hashes), and return the
 *  tarball's project-relative path. */
function packInto(plugin: EnginePlugin, projectRoot: string, hash: string): string {
  ensurePluginBuilt(plugin);
  const pluginsDir = path.join(projectRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const destName = tarballName(plugin.name, plugin.version, hash);

  // npm pack writes <name>-<ver>.tgz to --pack-destination. Pack into a temp dir
  // FIRST and verify it succeeded; only THEN drop stale siblings + publish. If we
  // dropped the old tarball before packing and the pack threw, the project's
  // `file:` spec would point at a now-deleted file → broken `npm install`. (D4)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pack-'));
  try {
    const npm = npmSpawnSpec();
    execFileSync(npm.command, [...npm.prefixArgs, 'pack', '--pack-destination', tmp], { cwd: plugin.dir, stdio: ['ignore', 'pipe', 'pipe'], shell: npm.shell, env: npm.env });
    const produced = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!produced) throw new Error(`npm pack produced no tarball for ${plugin.name}`);

    // Pack succeeded — now safe to drop stale tarballs (other hashes/versions) so
    // plugins/ keeps only the current content-addressed one, then publish atomically.
    const prefix = `${plugin.name.replace(/^@/, '').replace(/\//g, '-')}-`;
    for (const f of fs.readdirSync(pluginsDir)) {
      if (f !== destName && f.startsWith(prefix) && f.endsWith('.tgz')) fs.rmSync(path.join(pluginsDir, f), { force: true });
    }
    fs.copyFileSync(path.join(tmp, produced), path.join(pluginsDir, destName));
    return `plugins/${destName}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Heal a project's engine-plugin deps to the vendored-tarball (copy) form.
 *  For each engine plugin the project depends on:
 *    1. (re)pack it into <project>/plugins/<name>-<ver>.tgz if missing/stale,
 *    2. rewrite the dependency spec to `file:plugins/<name>-<ver>.tgz` (migrating
 *       off any old `file:../../engine/...` directory-symlink spec).
 *  Idempotent: a no-op once the tarball is current and the spec already matches.
 *  Returns {changed} so the caller can decide whether to reinstall. */
export function vendorEnginePlugins(projectRoot: string, engineRoot: string): VendorResult {
  const empty: VendorResult = { changed: false, needsInstall: false, vendored: [], expectedVendor: {} };
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return empty;

  let pkg: { dependencies?: Record<string, string> };
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
    pkg = JSON.parse(raw);
  } catch {
    return empty;
  }
  const deps = pkg.dependencies;
  if (!deps) return empty;

  const plugins = listEnginePlugins(engineRoot);
  const marker = readVendorMarker(projectRoot);
  let changed = false;
  let needsInstall = false;
  const vendored: string[] = [];
  const expectedVendor: Record<string, string> = {};

  for (const plugin of plugins) {
    if (!(plugin.name in deps)) continue; // project doesn't use this plugin
    // Build BEFORE hashing. The hash is taken over the plugin's shipped bytes,
    // so hashing a STALE dist yields the stale tarball's name — which exists, so
    // nothing re-packs and ensurePluginBuilt (called only from packInto, below)
    // is never even reached. That made a stale clone a permanent no-op that
    // silently shipped a tarball not matching its own sources.
    ensurePluginBuilt(plugin);
    const hash = pluginContentHash(plugin.dir);
    const relTgz = `plugins/${tarballName(plugin.name, plugin.version, hash)}`;
    const absTgz = path.join(projectRoot, relTgz);
    expectedVendor[plugin.name] = `file:${relTgz}`;

    // Content-addressed: if the tarball for THIS content already exists (the
    // committed one on a fresh clone, or a prior pack), don't re-pack — that
    // keeps `npm ci` integrity stable. Only a real content change (new hash →
    // absent file) triggers a fresh pack.
    if (!fs.existsSync(absTgz)) {
      packInto(plugin, projectRoot, hash);
      changed = true;
      vendored.push(plugin.name);
    }
    const wantSpec = `file:${relTgz}`;
    if (deps[plugin.name] !== wantSpec) {
      deps[plugin.name] = wantSpec;
      changed = true;
      if (!vendored.includes(plugin.name)) vendored.push(plugin.name);
    }
    // Reinstall if: the copy isn't in node_modules / is the old symlink, OR it's a
    // real dir but was extracted from a DIFFERENT tarball than the current spec
    // (the install marker disagrees — e.g. a git pull updated the committed
    // tarball + package.json without touching node_modules). (D3)
    if (pluginInstallStale(projectRoot, plugin.name) || marker[plugin.name] !== wantSpec) needsInstall = true;
  }

  if (changed) {
    // Preserve the file's trailing newline convention.
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
  return { changed, needsInstall: needsInstall || changed, vendored, expectedVendor };
}
