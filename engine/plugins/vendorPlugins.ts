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
 *  Matching npm's default ignore keeps the hash over exactly the shipped bytes so
 *  machine-local junk (.DS_Store) or VCS/dev metadata never renames the tarball. */
function npmAlwaysExcluded(basename: string): boolean {
  if (basename === 'node_modules' || basename === '.git' || basename === '.svn' || basename === 'CVS' || basename === '.hg') return true;
  if (basename === '.gitignore' || basename === '.npmignore' || basename === '.npmrc') return true;
  if (basename === '.DS_Store' || basename === 'npm-debug.log') return true;
  if (basename === 'package-lock.json' || basename === 'yarn.lock' || basename === 'pnpm-lock.yaml') return true;
  if (basename.endsWith('.tgz') || basename.startsWith('._') || /^\..*\.swp$/.test(basename)) return true;
  return false;
}

/** Whether a `files` entry is a glob pattern (vs a literal path/dir). */
function isGlob(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

/** The set of plugin-relative POSIX paths `npm pack` would ship, sorted. Mirrors
 *  npm's rules for the subset our engine plugins use: the package.json `files`
 *  allowlist (literal paths + directories, recursed) PLUS npm's always-included
 *  manifest files (package.json, README, LICENSE/LICENCE, NOTICE). Returns null —
 *  "can't determine the exact shipped set, hash the whole dir instead" — when the
 *  plugin has no `files` field or uses a glob entry we don't expand (over-hashing
 *  is safe: it may cause a spurious rename but NEVER a hash COLLISION between two
 *  different contents, which would break `npm ci` integrity). */
function packedFiles(pluginDir: string): string[] | null {
  let pkg: { files?: unknown };
  try { pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')); }
  catch { return null; }
  const filesField = pkg.files;
  if (!Array.isArray(filesField) || filesField.some((e) => typeof e === 'string' && isGlob(e))) return null;

  const out = new Set<string>();
  const add = (abs: string) => out.add(path.relative(pluginDir, abs).split(path.sep).join('/'));
  const walk = (absDir: string): void => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (npmAlwaysExcluded(e.name)) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) walk(abs);
      else add(abs);
    }
  };

  // npm always ships these top-level manifest files if present, regardless of `files`.
  for (const name of fs.readdirSync(pluginDir)) {
    if (name === 'package.json' || /^(README|LICEN[SC]E|NOTICE)(\..*)?$/i.test(name)) {
      const abs = path.join(pluginDir, name);
      try { if (fs.statSync(abs).isFile()) add(abs); } catch { /* skip */ }
    }
  }
  // Then each `files` allowlist entry (dir → recurse; file → include; missing → skip, as npm does).
  for (const entry of filesField as string[]) {
    const abs = path.join(pluginDir, entry.replace(/\/+$/, ''));
    let st: fs.Stats | null = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (st?.isDirectory()) walk(abs);
    else if (st?.isFile() && !npmAlwaysExcluded(path.basename(abs))) add(abs);
  }
  return [...out].sort();
}

/** Content hash (8 hex) of the plugin's PUBLISHED bytes — the exact fileset
 *  `npm pack` ships (see packedFiles), by sorted relative path + contents.
 *  Deterministic (no mtimes) AND scoped to shipped files, so the tarball name is
 *  stable across machines AND doesn't drift when a NON-shipped dev file changes
 *  (src/, tsconfig, rollup config, lockfile) while the shipped dist/ios/android
 *  bytes are identical — the spurious-re-pack bug this scoping fixes. Falls back
 *  to the whole-dir walk when the shipped set can't be determined exactly
 *  (no `files` field / a glob entry): over-hashing is safe (a spurious rename at
 *  worst; never a collision), under-hashing would not be. */
function pluginContentHash(pluginDir: string): string {
  const h = createHash('sha256');
  let files = packedFiles(pluginDir);
  if (!files) {
    // Fallback: whole-dir walk (minus always-excluded), same guarantee as before.
    const acc: string[] = [];
    const stack = [pluginDir];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (npmAlwaysExcluded(e.name)) continue;
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else acc.push(path.relative(pluginDir, p).split(path.sep).join('/'));
      }
    }
    files = acc.sort();
  }
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    // Do NOT swallow a read error: a listed file that fails to read would
    // otherwise contribute only its path → a DIFFERENT hash than a clean read of
    // the same bytes → a spurious re-pack + lockfile churn. Let it throw so
    // vendoring fails loudly (the caller logs + continues). (D10)
    h.update(fs.readFileSync(path.join(pluginDir, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 8);
}

/** Ensure the plugin's built `dist/` exists (it ships JS only from a gitignored
 *  dist). In a packaged editor dist is shipped; in dev it's built by the root
 *  `build:plugins` postinstall — but build it on demand if missing so a fresh
 *  worktree heals itself. */
function ensurePluginBuilt(plugin: EnginePlugin): void {
  if (fs.existsSync(path.join(plugin.dir, 'dist'))) return;
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
    const deadline = Date.now() + 120_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(plugin.dir, 'dist')) && Date.now() < deadline) {
      Atomics.wait(sleeper, 0, 0, 250); // sync sleep (this whole module runs sync)
    }
    if (!fs.existsSync(path.join(plugin.dir, 'dist'))) {
      throw new Error(`[vendor] timed out waiting for a concurrent build of ${plugin.name} dist`);
    }
    return;
  }
  try {
    console.log(`[vendor] building ${plugin.name} dist…`);
    const npm = npmSpawnSpec();
    execFileSync(npm.command, [...npm.prefixArgs, 'run', 'build'], { cwd: plugin.dir, stdio: 'inherit', shell: npm.shell, env: npm.env });
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
