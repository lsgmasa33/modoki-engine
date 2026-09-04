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
import { gunzipSync } from 'node:zlib';
import { npmSpawnSpec } from '../toolchain';

export interface VendorOptions {
  /** May this process BUILD a plugin whose dist/ is missing or stale? True in a
   *  developer checkout (the default). The PACKAGED editor must pass false: it ships
   *  each plugin's src/ and dist/ but none of the devDependencies a build needs, so
   *  attempting one blocks the main thread and then fails. See ensurePluginBuilt. */
  canBuild?: boolean;
}

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

export interface EnginePlugin {
  name: string;
  dir: string;
  version: string;
}

/** Strip a semver PRERELEASE suffix (`-<prerelease>`), e.g. `1.0.0-9ff1f461` → `1.0.0`. The
 *  committed engine plugin package.json never carries one — packInto appends the content hash
 *  as a prerelease ONLY inside the packed tarball, then restores the original file (#685) — so
 *  this only ever does real work in two places: on a `plugin.dir/package.json` a killed pack
 *  process left mid-rewrite (defensive self-heal), and when normalizing a PACKED tarball's
 *  package.json back to the source's bare version for comparison. */
function baseVersion(version: string): string {
  const i = version.indexOf('-');
  return i === -1 ? version : version.slice(0, i);
}

/** The VERSION `packInto` writes into the PACKED package.json (#685): `base` plus the plugin's
 *  content hash as a semver prerelease, prefixed with a literal `h` so the prerelease identifier
 *  can never be all-digits.
 *
 *  That prefix matters: SemVer forbids a LEADING ZERO on a numeric prerelease identifier
 *  (`1.0.0-01234567` is invalid; `semver.valid()` returns null), and a bare hex hash slice is
 *  all-digits — so subject to that rule — about 1 time in 40, and actually invalid (leading zero
 *  AND all-digits) about 1 time in 400. Without the prefix, roughly one content hash in 400 would
 *  mint a version npm refuses, and the failure would be STICKY: that plugin stays unbuildable
 *  until its content changes again (a new hash), with an error that names the version, not this
 *  function. `h` guarantees a non-numeric identifier for every possible hash.
 *
 *  Deliberately NOT used by `tarballName` — the committed, content-addressed FILENAME never
 *  carries the `h`; only the version written inside the packed tarball does. Callers that need
 *  the hash back out of a committed filename (the re-pack trigger below, the freshness guard)
 *  read it from the filename (plain hex) and pass it in here to get the version to compare
 *  against — never the other way around. */
export function packedVersion(base: string, hash: string): string {
  return `${base}-h${hash}`;
}

/** `buf` — a plugin's top-level `package.json` bytes — with `version` normalized to its semver
 *  BASE and re-serialized in the exact canonical form `packInto` writes
 *  (`JSON.stringify(pkg, null, 2) + '\n'`, which is also how every committed engine plugin's
 *  package.json is already formatted, so this is a no-op on the steady-state/unsuffixed case).
 *
 *  Shared by two callers that both need "the same content, whatever VERSION happens to be on
 *  disk right now":
 *   - `pluginContentHash` — package.json is one of the hashed inputs, and packInto briefly
 *     writes a hash-suffixed version into it before `npm pack`. Hashing that RAW would feed the
 *     hash back into the value it's computing (the packed version IS `packedVersion(base, hash)`,
 *     itself derived from the hash) — a circularity where the hash could never stabilize.
 *     Normalizing the version out breaks it.
 *   - `compareTarballToSource` — a correctly packed tarball's package.json legitimately differs
 *     from source by exactly this suffix; normalizing both sides lets it still compare equal. */
function normalizedPackageJsonBytes(buf: Buffer): Buffer {
  const pkg = JSON.parse(buf.toString('utf8'));
  if (typeof pkg.version === 'string') pkg.version = baseVersion(pkg.version);
  return Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
}

/** Engine-provided Capacitor plugins = subdirs of engine/packages whose
 *  package.json declares a `capacitor` field (i.e. they're cap plugins, not
 *  plain libs like @modoki/engine). Discovered dynamically so a new plugin is
 *  picked up without editing this list. */
export function listEnginePlugins(engineRoot: string): EnginePlugin[] {
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
        // baseVersion is defensive, not routine: the committed version is always bare (#685),
        // but a killed packInto could leave a hash-suffixed one on disk mid-rewrite, and
        // stripping it here keeps that from compounding into a double-suffixed tarball name.
        out.push({ name: pkg.name, dir, version: baseVersion(String(pkg.version ?? '0.0.0')) });
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

/** npm ALWAYS ships these plugin-ROOT files regardless of the `files` allowlist —
 *  package.json plus npm-packlist's force-keep set (README, COPYING, LICENSE/LICENCE) —
 *  so they're part of the shipped fileset for hashing: a change to a shipped README
 *  genuinely changes the tarball bytes. Root only (no `/`). (NOTE current npm-packlist
 *  does NOT force-keep NOTICE/CHANGELOG/HISTORY — that was old fstream-npm behavior — so
 *  they're only shipped when listed in `files`, and are covered there.) */
function isAlwaysShipped(rel: string): boolean {
  if (rel.includes('/')) return false;
  if (rel === 'package.json') return true;
  return /^(readme|copying|licen[sc]e)(\.|$)/i.test(rel);
}

/** Filenames (plugin-root) that, with src/, determine the built `dist/`. ONE source
 *  for both the identity hash (pluginHashInputs, part B) and the stale-dist stamp
 *  (pluginSourceHash), so the two can't drift on what counts as a build input. */
const DIST_BUILD_CONFIG_FILES = ['package.json', 'tsconfig.json', 'rollup.config.mjs'];

/** A dist BUILD INPUT — everything under src/ plus the build config. Keeping these in
 *  the identity hash preserves the contract that a src/ edit re-packs so the rebuilt
 *  dist ships under a new tarball name (a shipped-files-only scope would drop src/ and
 *  break it — vendorPlugins.test.ts "DOES re-pack when a SOURCE input changes"). */
function isDistBuildInput(rel: string): boolean {
  return rel === 'src' || rel.startsWith('src/') || DIST_BUILD_CONFIG_FILES.includes(rel);
}

/** True if `rel` is covered by the plugin's `files` allowlist. Entries here are simple
 *  `dir/`+file paths (no globs), so a normalized prefix match is enough — do NOT pull in
 *  npm-packlist/minimatch (not deps). The `dist` entry is intentionally never matched:
 *  dist/ is derived + volatile and excluded from the hash (its INPUTS are covered by
 *  isDistBuildInput instead), so a toolchain-only drift can't rename the tarball. */
function matchesFilesEntry(rel: string, filesEntries: string[]): boolean {
  for (const raw of filesEntries) {
    const e = raw.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!e || e === 'dist') continue;
    if (rel === e || rel.startsWith(e + '/')) return true;
  }
  return false;
}

/** A `files` entry that the literal prefix matcher CANNOT resolve — an npm glob
 *  (contains *, ?, [, ], {, }) or a whole-package "." / "./". A plugin with any such
 *  entry can ship files a prefix match would miss, so pluginHashInputs falls back to the
 *  safe wide scope (hash all inputs) rather than silently under-hashing a shipped file. */
function hasGlobMeta(entry: string): boolean {
  const e = entry.replace(/^\.?\//, '').replace(/\/+$/, '');
  return e === '' || e === '.' || /[*?[\]{}]/.test(e);
}

/** The plugin's `files` allowlist (strings only), or null when absent/empty/invalid —
 *  which triggers the "hash all source inputs" fallback in pluginHashInputs. */
function readPackageFiles(pluginDir: string): string[] | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    if (!Array.isArray(pkg.files)) return null;
    const files = pkg.files.filter((f: unknown): f is string => typeof f === 'string');
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/** Every non-derived, non-junk file under the plugin, as sorted plugin-relative POSIX
 *  paths. Excludes BUILD_OUTPUT_DIRS (dist/build/.gradle/…) at any depth and
 *  npm-always-excluded junk. The raw candidate set pluginHashInputs narrows. */
function allSourceInputs(pluginDir: string): string[] {
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
  return acc;
}

/** Sorted plugin-relative POSIX paths that feed the identity hash. The tarball name
 *  must answer "did the plugin's SHIPPED bytes, or the inputs that BUILD them, change?"
 *  — nothing more. So the hashed set is the union of:
 *
 *    A. the SHIPPED fileset minus the volatile dist/ — files matched by package.json
 *       `files` (matchesFilesEntry) PLUS npm's always-shipped manifest files
 *       (isAlwaysShipped: README/LICENSE/package.json). dist/ is excluded here because
 *       it's derived + toolchain-sensitive; its INPUTS live in B, so a real source
 *       change still re-packs while a pure build-output drift does not.
 *    B. the dist BUILD INPUTS — src/ + build config (isDistBuildInput), so a src/ edit
 *       re-packs the rebuilt dist under a new name (the contract a files-only scope
 *       would break).
 *
 *  Files in NEITHER set — the plugin's OWN unit tests (android/src/test, ios/Tests),
 *  test-vectors, and other non-shipped dev files — do NOT feed the hash, so editing them
 *  no longer renames every vendoring game's committed tarball (the recurring spurious
 *  re-pin this scoping fixes). Over-hashing only ever costs a spurious rename, never an
 *  npm-ci integrity break; UNDER-hashing a genuinely-shipped file would, which is why A
 *  keeps npm's always-shipped set even though it's outside `files`.
 *
 *  Fallback: a plugin with NO `files` field can't be scoped to a shipped set, so it
 *  hashes ALL source inputs (dist/ still excluded) — the prior behavior, preserved.
 *
 *  Exported so a repo-invariant test can assert this set is EXACTLY the committed
 *  source for each real engine plugin (no untracked/gitignored file leaks in →
 *  reproducible across clones — the litter-leak bug the BUILD_OUTPUT_DIRS list
 *  guards against, for whatever dir names a future plugin's build tool emits). */
export function pluginHashInputs(pluginDir: string): string[] {
  const all = allSourceInputs(pluginDir);
  const files = readPackageFiles(pluginDir);
  // No `files`, OR any entry we can't resolve by literal prefix (an npm glob, or a
  // whole-package "." / "./"): hash ALL source inputs. Over-hashing only costs a spurious
  // rename; UNDER-hashing a globbed shipped file would ship stale bytes under an unchanged
  // name — so a glob plugin gets the safe wide scope. Only literal `files` entries get the
  // narrowed (shipped ∪ dist-build-inputs) scope.
  if (!files || files.some(hasGlobMeta)) return all.sort();
  return all
    .filter((rel) => isDistBuildInput(rel) || isAlwaysShipped(rel) || matchesFilesEntry(rel, files))
    .sort();
}

/** Content hash (8 hex) of the plugin's SOURCE INPUTS (see pluginHashInputs),
 *  by sorted relative path + contents. Deterministic (no mtimes).
 *
 *  A read error is NOT swallowed (D10): a listed file that fails to read would
 *  contribute only its path → a different hash than a clean read → a spurious
 *  re-pack. Let it throw so vendoring fails loudly (the caller logs + continues).
 *
 *  The plugin's own top-level `package.json` is special-cased through
 *  normalizedPackageJsonBytes (#685) rather than hashed raw: packInto briefly writes a
 *  hash-suffixed `version` into that file before `npm pack`, and hashing it raw would feed
 *  that written hash back into the value THIS function computes — the hash could never
 *  stabilize. Normalizing the version out of the hash input makes the hash invariant to
 *  whatever version string currently sits on disk, which also makes the scheme self-healing:
 *  a killed pack process that leaves a hash-suffixed version behind doesn't corrupt the next
 *  hash either. */
export function pluginContentHash(pluginDir: string): string {
  const h = createHash('sha256');
  for (const rel of pluginHashInputs(pluginDir)) {
    h.update(rel);
    h.update('\0');
    const raw = fs.readFileSync(path.join(pluginDir, rel));
    h.update(rel === 'package.json' ? normalizedPackageJsonBytes(raw) : raw);
    h.update('\0');
  }
  return h.digest('hex').slice(0, 8);
}

/** ─── Tarball BYTES verification (#375) ────────────────────────────────────────────────
 *
 *  `pluginContentHash` answers "what SHOULD the committed tarball be called". It says nothing
 *  about what the tarball CONTAINS: it reads the source directory, and nothing in the repo ever
 *  opened the `.tgz`. So a tarball whose NAME is current and whose BYTES are stale passed every
 *  check — and that is precisely the state #90 exists to prevent, the one where "the gradle build
 *  succeeds, the APK installs, the app launches, and it silently contains the PREVIOUS native
 *  code". Reachable without malice: an interrupted `vendor-plugins.mjs` that rewrote the dep spec
 *  before the pack landed, a merge that took the new package.json and the old plugins/*.tgz, a
 *  `git checkout <old-sha> -- <project>/plugins/`.
 *
 *  This opens the tarball and compares it to the source, file by file. */

/** One way a committed tarball disagrees with the plugin source. */
export interface TarballDrift {
  /** Plugin-relative POSIX path (the tar entry minus its `package/` prefix). For a read/parse
   *  failure that prevented any real comparison (#685 FIX 6), the tarball's own basename. */
  path: string;
  kind: 'missing-from-tarball' | 'not-in-source' | 'bytes-differ';
  /** Set only for a read/parse failure reported as `bytes-differ` (#685 FIX 6) — a corrupt/
   *  truncated tarball, or a tar entry whose bytes don't parse as the JSON they claim to be. */
  reason?: string;
}

export interface TarballComparison {
  drift: TarballDrift[];
  /** Plugin-relative paths in the tarball that were NOT compared, and why. Surfaced rather than
   *  swallowed so a caller can report what the run did not cover — a check that quietly skips
   *  part of its subject is the failure mode this whole guard is about. Today that is `dist/`
   *  (see compareTarballToSource). */
  skipped: { path: string; reason: string }[];
}

/** Read a `.tgz` into `plugin-relative path → bytes`, dropping the leading `package/` component
 *  npm pack adds. Directories and non-file entries are skipped.
 *
 *  Hand-rolled rather than `import 'tar'`, which IS a root dependency but must not appear here:
 *  this module is esbuild-bundled to a TEMP FILE with `packages: 'external'` (loadVendorPlugins.mjs)
 *  so `vendor-plugins.mjs` and `build-web.mjs` can run it from plain Node — and from /tmp a
 *  third-party specifier does not resolve. A `tar` import compiles, typechecks and passes every unit
 *  test, then kills the CLI vendoring path with ERR_MODULE_NOT_FOUND. (Measured: it did, and
 *  vendorPluginsIntegration's CLI smoke test is what said so.) node: builtins only, therefore. */
function readTarball(tarballPath: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const buf = gunzipSync(fs.readFileSync(tarballPath));
  const BLOCK = 512;
  /** A pax/GNU-longname override for the NEXT file entry, if one preceded it. */
  let pendingName: string | null = null;

  for (let off = 0; off + BLOCK <= buf.length; ) {
    const header = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop reading.
    if (header.every((b) => b === 0)) break;

    const cstr = (start: number, len: number) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
    };
    const octal = (start: number, len: number) => {
      // A size field with the high bit set is GNU base-256 (binary), not octal — parseInt would
      // return NaN → 0, and the reader would then walk into file DATA and desync, silently
      // returning wrong entries. npm pack never produces one (it needs an 8GB+ member), so this
      // is a landmine rather than a bug: make it loud instead of leaving it silent.
      if (header[start] & 0x80) throw new Error(`${tarballPath}: base-256 tar header field at ${start} is unsupported`);
      return parseInt(cstr(start, len).trim() || '0', 8) || 0;
    };

    const name = cstr(0, 100);
    const size = octal(124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = cstr(345, 155);
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') { // GNU long name — applies to the following entry
      pendingName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'X') { // pax extended header — "<len> path=<value>\n"
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) pendingName = m[1];
      continue;
    }
    if (type === 'g') continue; // global pax header — not per-entry

    const full = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;
    // Regular files only — '0' is the ustar typeflag, and an old-style NUL flag was normalized to
    // it when `type` was read. A directory/symlink/hardlink entry has nothing to compare.
    if (type !== '0') continue;
    const rel = full.replace(/^\.?\//, '').replace(/^package\//, '');
    if (!rel || rel.endsWith('/')) continue;
    out.set(rel, Buffer.from(data));
  }
  return out;
}

/** Compare a committed tarball's CONTENTS against the plugin source directory (#375).
 *
 *  Scope — the shipped fileset MINUS `dist/`, which is exactly the set the tarball's NAME is
 *  computed over (pluginHashInputs). Both directions where the shipped set is exactly
 *  enumerable: a missing entry and a differing entry are both drift. This is the set that
 *  carries the native code, and it is what #375's scenarios move — an interrupted re-vendor, a
 *  merge taking the new package.json with the old tarball, a checkout of an old plugins/ dir.
 *
 *  ⚠️ **`dist/` is deliberately NOT compared, and this cost two attempts to get right.**
 *  Comparing it looks obviously correct — dist IS shipped, and a stale dist IS stale bytes. But
 *  the repo has already decided the opposite, deliberately and with a test: `matchesFilesEntry`
 *  excludes dist from the identity hash so "a toolchain-only drift can't rename the tarball",
 *  and `vendorPlugins.test.ts`'s "does NOT re-pack when ONLY the built dist/ changes
 *  (toolchain-drift churn killer)" pins it. dist/ is gitignored and rebuilt per clone, so a
 *  patch bump of tsc or rollup changes its bytes with no source change and no rename. A guard
 *  that failed on that would demand a re-vendor of all 21 tarballs plus 21 lockfiles — the exact
 *  churn the vendorer refuses to cause. Two components of one system cannot hold opposite
 *  positions on the same input, so this one yields.
 *
 *  A plugin whose `files` cannot be resolved by literal prefix (a glob, or no `files` at all)
 *  gets the one-way check only: every tarball entry must match source. Claiming a file is
 *  "missing from the tarball" needs an exact expected set, and we do not have one — mirroring
 *  the conservative fallback pluginHashInputs takes. */
export function compareTarballToSource(tarballPath: string, pluginDir: string): TarballComparison {
  let entries: Map<string, Buffer>;
  try {
    entries = readTarball(tarballPath);
  } catch (e) {
    // A corrupt/truncated committed tarball (bad gzip, a base-256 tar header — see readTarball)
    // must be reported as a MISMATCH like everything else this function finds, never thrown —
    // that would take the whole freshness guard down instead of naming the plugin (#685 FIX 6).
    // Mirrors verifyInstalledMatchesTarball's own try/catch around this same readTarball call.
    return {
      drift: [{ path: path.basename(tarballPath), kind: 'bytes-differ', reason: e instanceof Error ? e.message : String(e) }],
      skipped: [],
    };
  }
  const files = readPackageFiles(pluginDir);
  const canEnumerateExpected = !!files && !files.some(hasGlobMeta);
  const isDistPath = (rel: string) => rel === 'dist' || rel.startsWith('dist/');
  const drift: TarballDrift[] = [];
  const skipped: { path: string; reason: string }[] = [];

  // tarball → source
  for (const [rel, bytes] of entries) {
    if (isDistPath(rel)) { skipped.push({ path: rel, reason: 'dist/ is derived — see the header' }); continue; }
    const abs = path.join(pluginDir, rel);
    if (!fs.existsSync(abs)) { drift.push({ path: rel, kind: 'not-in-source' }); continue; }
    const sourceBytes = fs.readFileSync(abs);
    // package.json is allowed to differ from source in exactly ONE field: the packed
    // PRERELEASE version hash suffix packInto writes (#685). Normalize that field out of BOTH
    // sides before comparing so a correctly packed tarball still reads as a match — every
    // other file, and every other field of package.json, still gets the exact-bytes check: no
    // newline normalization either, since `.gitattributes` pins `eol=lf` for every extension
    // the plugins ship, so a Windows checkout has the same bytes a macOS one packed.
    if (rel === 'package.json') {
      let tarCmp: Buffer;
      let srcCmp: Buffer;
      try {
        tarCmp = normalizedPackageJsonBytes(bytes);
        srcCmp = normalizedPackageJsonBytes(sourceBytes);
      } catch (e) {
        // A truncated/corrupt package.json entry fails to JSON.parse — report it as a MISMATCH
        // rather than letting it crash the whole comparison (#685 FIX 6): a broken committed
        // tarball is exactly the state this function exists to catch.
        drift.push({ path: rel, kind: 'bytes-differ', reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!tarCmp.equals(srcCmp)) drift.push({ path: rel, kind: 'bytes-differ' });
      continue;
    }
    if (!bytes.equals(sourceBytes)) drift.push({ path: rel, kind: 'bytes-differ' });
  }

  // source → tarball (only when the shipped set is exactly enumerable)
  if (canEnumerateExpected) {
    const expected = allSourceInputs(pluginDir)
      .filter((rel) => !isDistPath(rel) && (isAlwaysShipped(rel) || matchesFilesEntry(rel, files)));
    for (const rel of expected) {
      if (entries.has(rel)) continue;
      // A symlink is a file to allSourceInputs but a type-'2' tar entry readTarball skips, so it
      // would read as missing. No engine plugin ships one today; this keeps that from becoming a
      // mystery red the day one does.
      if (fs.lstatSync(path.join(pluginDir, rel)).isSymbolicLink()) continue;
      drift.push({ path: rel, kind: 'missing-from-tarball' });
    }
  }

  drift.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { drift, skipped };
}

/** ─── Installed-copy verification (#685) ─────────────────────────────────────────────────
 *
 *  `compareTarballToSource` (above) answers "does the COMMITTED tarball match the plugin
 *  SOURCE" — it never opens `node_modules`. #685 found a state where every signal that answer
 *  relies on — the project's `file:` dep spec, `package-lock.json`, the `resolved`/`integrity`
 *  npm recorded in `node_modules/.package-lock.json` — agreed the CURRENT tarball was installed,
 *  while `node_modules/<plugin>` on disk still held the bytes of a PREVIOUS one. `npm install`
 *  reported "up to date"; a native build shipped the stale plugin silently, with nothing wrong to
 *  point at. The mechanism IS now characterized — `npm install --package-lock-only` on a tree whose
 *  extraction is stale advances BOTH lockfiles without extracting, and every later install then
 *  reports "up to date" forever (#685, closed; see docs/build.md). This stays a detector for the
 *  STATE rather than for that one cause: a mis-resolved `.tgz` merge conflict and a hand-edit reach
 *  the same place, so it must catch it regardless of the sequence that produced it. */

/** "First few" differing paths reported per stale plugin — enough to start a `diff`, not a full
 *  dump of every mismatched file. */
const MAX_REPORTED_DIFF_PATHS = 5;

/** Verify every engine plugin the project vendors has an INSTALLED `node_modules` copy matching
 *  the tarball its `package.json` currently points to. Returns human-readable problems (empty
 *  list = OK) — one entry per plugin with a missing tarball or a mismatched install.
 *
 *  Vendored plugins are found the same way `vendorEnginePlugins` marks them, without needing an
 *  `engineRoot`: a dependency whose spec is `file:plugins/<name>-<ver>-<hash>.tgz` — the only
 *  spec shape that function ever writes (see its own header) — names both the plugin (the dep
 *  key) and its tarball (the spec's path).
 *
 *  `node_modules/<plugin>` absent is NOT a problem: the project may simply not be installed yet,
 *  and the caller's own install step handles that (build-web.mjs's `healNativeProject` runs `npm
 *  install` before this check — see there for why the check must run unconditionally afterward).
 *
 *  Scope, and why it's WIDER than `compareTarballToSource`: that one compares tarball vs SOURCE,
 *  where `dist/` legitimately differs (gitignored, rebuilt per clone, so a toolchain patch bump
 *  changes its bytes with no source change). This one compares tarball vs INSTALLED, and the
 *  installed copy was extracted FROM the tarball by npm itself — there is no toolchain in
 *  between, so `dist/` is expected to match too and is deliberately NOT excluded here.
 *
 *  Nothing is excluded, full stop — verified empirically rather than assumed. Every shipped path
 *  of three real vendored plugins in `games/court` (a live `npm install`, not a synthetic
 *  fixture), INCLUDING `package.json`'s `version` field, came back byte-identical between the
 *  committed tarball and its extracted `node_modules` copy: a plain `file:` tarball install does
 *  not rewrite anything on extract. (A transient mismatch was seen once mid-measurement, while an
 *  editor running against the same checkout was concurrently re-vendoring/reinstalling the same
 *  project — re-measuring after it settled showed a clean match; that is a live-process race, not
 *  an npm normalization to design around.) */
export function verifyInstalledMatchesTarball(projectRoot: string): string[] {
  const problems: string[] = [];
  const pkgPath = path.join(projectRoot, 'package.json');
  let deps: Record<string, string> | undefined;
  try {
    deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies;
  } catch {
    return problems; // no readable package.json — nothing to check
  }
  if (!deps) return problems;

  // The only spec shape vendorEnginePlugins ever writes (see its header) — matching it is how we
  // recognize "an engine plugin this project vendors" without needing engineRoot/listEnginePlugins.
  const VENDORED_SPEC = /^file:(plugins\/.+\.tgz)$/;
  for (const [name, spec] of Object.entries(deps)) {
    const m = typeof spec === 'string' ? VENDORED_SPEC.exec(spec) : null;
    if (!m) continue; // not a vendored engine plugin
    const relTgz = m[1];
    const tarballPath = path.join(projectRoot, relTgz);
    if (!fs.existsSync(tarballPath)) {
      problems.push(`${name}: vendored tarball is missing — ${relTgz}`);
      continue;
    }

    const installedDir = path.join(projectRoot, 'node_modules', name);
    if (!fs.existsSync(installedDir)) continue; // not installed yet — the caller's install step handles it

    let entries: Map<string, Buffer>;
    try {
      entries = readTarball(tarballPath);
    } catch (e) {
      problems.push(`${name}: could not read ${relTgz} (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }

    const diffPaths: string[] = [];
    for (const [rel, tarBytes] of entries) {
      let installedBytes: Buffer;
      try {
        installedBytes = fs.readFileSync(path.join(installedDir, rel));
      } catch {
        diffPaths.push(`${rel} (missing from installed copy)`);
        continue;
      }
      if (!tarBytes.equals(installedBytes)) diffPaths.push(rel);
    }
    if (diffPaths.length) {
      diffPaths.sort();
      const shown = diffPaths.slice(0, MAX_REPORTED_DIFF_PATHS);
      const more = diffPaths.length > shown.length ? ` (+${diffPaths.length - shown.length} more)` : '';
      problems.push(`${name}: node_modules/${name} does not match ${relTgz} — ${shown.join(', ')}${more}`);
    }
  }
  return problems;
}

/** The packed `package/package.json`'s `version` field inside a committed tarball, or `null` if
 *  the tarball can't be opened/parsed, or has no package.json entry — either way callers must
 *  treat that as STALE (an unreadable tarball is never "up to date"), never let it throw.
 *
 *  Cheap by design: reuses `readTarball` (the same reader `compareTarballToSource` opens the
 *  tarball with) but reads back only the ONE entry it needs, rather than diffing every entry
 *  against plugin source the way `compareTarballToSource` does — this runs on every vendoring
 *  pass, not just the freshness guard. */
export function readPackedVersion(tarballPath: string): string | null {
  try {
    const pj = readTarball(tarballPath).get('package.json');
    if (!pj) return null;
    const pkg = JSON.parse(pj.toString('utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
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
  // Shared with the identity hash (isDistBuildInput) so they can't disagree.
  for (const cfg of DIST_BUILD_CONFIG_FILES) {
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

/** Stamp `pluginDir`'s already-built `dist/` as CURRENT for its sources.
 *
 *  The root `build:plugins` postinstall builds every engine plugin's dist directly
 *  (`npm run build --workspace ...`) and, before #395, wrote no stamp. So the FIRST
 *  thing to call ensurePluginBuilt after an install always judged a perfectly current
 *  dist stale and rebuilt it — deleting and recreating dist/ in the repo while other
 *  processes were importing it. In `npm run verify` that raced the app lane's
 *  `await import('capacitor-game-debug')` and failed the suite with a module-resolution
 *  error that never reproduced on a second run (the rebuild had written a stamp by then).
 *
 *  This is the ONLY other writer of the stamp, and it deliberately reuses
 *  pluginSourceHash + writeBuildStamp rather than recomputing the hash: a second
 *  implementation that drifted from ensurePluginBuilt's would vouch for a stale dist,
 *  which is a quiet wrong build in place of a loud flake.
 *
 *  Returns false (and stamps nothing) when there is no dist to vouch for, or no sources
 *  to hash (a packaged editor, where the shipped dist is authoritative anyway). */
export function stampPluginBuild(pluginDir: string): boolean {
  if (!fs.existsSync(path.join(pluginDir, 'dist'))) return false;
  const srcHash = pluginSourceHash(pluginDir);
  if (srcHash === null) return false;
  writeBuildStamp(pluginDir, srcHash);
  // writeBuildStamp is best-effort and SWALLOWS its errors (read-only node_modules, ENOSPC),
  // so `true` must mean "a stamp is on disk and reads back correctly", not "a write was
  // attempted". Otherwise the postinstall reports work it did not do, and the only signal
  // anyone has that #395 is fixed is a lie.
  return readBuildStamp(pluginDir) === srcHash;
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
function ensurePluginBuilt(plugin: EnginePlugin, canBuild: boolean): void {
  const srcHash = pluginSourceHash(plugin.dir);
  const distExists = fs.existsSync(path.join(plugin.dir, 'dist'));
  // No sources (packaged editor) ⇒ the shipped dist is authoritative.
  if (srcHash === null && distExists) return;
  // A PACKAGED editor must never try to build: it ships src/ AND dist/ but none of the
  // plugin's devDependencies (rollup/tsc), so `npm run build` blocks the main thread for
  // seconds and then fails. The `srcHash === null` check above was meant to cover this,
  // but the packaged app DOES ship src/, so it doesn't. Nor can this be sniffed from disk
  // — under npm workspaces a legitimate dev checkout also has no per-package node_modules
  // (deps hoist to the root), so absence of it does NOT imply "packaged". The caller knows
  // (app.isPackaged); it must say so. The shipped dist IS that build's output — trust it.
  //
  // Without this, only a Program Files install is safe, and then only by accident (it's
  // unwritable, so the lock below fails and we bail). electron-builder's NSIS default is
  // perMachine:false → a PER-USER install under %LOCALAPPDATA%\Programs, which IS
  // writable and would take the doomed build path.
  if (!canBuild && distExists) return;
  if (distExists && srcHash !== null && readBuildStamp(plugin.dir) === srcHash) return;
  if (!canBuild) {
    throw new Error(`[vendor] cannot build ${plugin.name}: this editor ships no toolchain and the plugin ships no dist/`);
  }
  // Cross-process lock (atomic mkdir): if two editors / worktrees open projects at
  // once and both find dist missing, only ONE builds — the other waits for dist to
  // appear rather than racing writes into the same dir (a half-built dist would get
  // packed). (D7)
  const lock = path.join(plugin.dir, '.modoki-building');
  let held = false;
  let lockErr: NodeJS.ErrnoException | null = null;
  try { fs.mkdirSync(lock); held = true; } catch (e) { lockErr = e as NodeJS.ErrnoException; }
  // ONLY EEXIST means "another process is building" — the case the wait below exists for.
  // Any other failure (EPERM/EACCES/EROFS) means this plugin dir is NOT WRITABLE, so no
  // build can ever happen here and no other process can be building either: waiting is
  // guaranteed to burn the full deadline and then throw. That is exactly what happened in
  // the packaged Windows editor, installed under Program Files: it ships src/ (so srcHash
  // is non-null and the "no sources" early-return above is skipped) but NOT the stamp
  // (which lives under node_modules, unpackaged), so it reached this lock, mkdir failed
  // EPERM, and the loop below sync-slept `Atomics.wait` for 120s ON ELECTRON'S MAIN THREAD
  // — freezing the whole app (HTTP backend + CDP dead, window "not responding") on every
  // open of a project that depends on an engine plugin. Trust the shipped dist instead.
  if (!held && lockErr && lockErr.code !== 'EEXIST') {
    if (distExists) {
      // Reaching here means the stamp said this dist is STALE (a current one returns
      // above), so we're knowingly proceeding with out-of-date plugin output. In a
      // packaged editor that's correct and silent — canBuild:false already returned
      // long before this. But canBuild is TRUE here, i.e. a developer checkout whose
      // plugin dir happens to be unwritable, and silently shipping a stale dist is
      // exactly the failure this function's header calls out: "a permanent no-op that
      // never healed", which silently packed a tarball not matching its own sources.
      // Not fatal (far better than the 120s hang this replaced) — but it must be VISIBLE.
      console.warn(
        `[vendor] ${plugin.name}: dist/ is STALE and ${plugin.dir} is not writable (${lockErr.code}) — ` +
          `using the existing dist as-is. Fix the directory permissions, or rebuild it with ` +
          `\`npm run build --workspace ${plugin.dir}\`.`,
      );
      return;
    }
    throw new Error(
      `[vendor] cannot build ${plugin.name}: ${plugin.dir} is not writable (${lockErr.code}) and ships no dist/`,
    );
  }
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

/** #685 FIX 1a — prevent the state, not just detect it. `packInto` can overwrite an EXISTING
 *  tarball IN PLACE (same content-addressed filename, new bytes) — this happens whenever a
 *  same-named tarball's packed version doesn't match what's wanted (see the call site: a tarball
 *  packed before the hash-suffix scheme existed, or anything else that lands in that branch).
 *  Because the project's `file:` spec text doesn't change, npm's lockfile-driven resolver has no
 *  signal to re-resolve: `node_modules/<name>` keeps whatever it last extracted, and
 *  `package-lock.json` keeps pointing at the OLD tarball's integrity for the SAME path. Measured
 *  (#685): neither `npm install` nor `npm install --force` nor `rm -rf node_modules/<plugin> &&
 *  npm install` repairs this — npm serves the stale content straight out of its own cache while
 *  the lockfile still pins the old integrity, so nothing ever asks it to look again.
 *
 *  Deleting the plugin's own lockfile entries removes the ONLY thing making npm believe it already
 *  knows the answer, so the `npm install` that the caller's `needsInstall` flag already triggers
 *  is forced to genuinely re-resolve version + integrity from the new bytes on disk.
 *
 *  Best-effort and silent on failure by design: an unreadable/unparseable lockfile is left alone
 *  rather than risking a bad rewrite — `needsInstall` still fires the install either way, and a
 *  project with a broken lockfile has bigger problems than this. */
function invalidateLockfileEntry(projectRoot: string, name: string): void {
  const lockPath = path.join(projectRoot, 'package-lock.json');
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return; // no committed lockfile — nothing to invalidate
  }
  let lock: { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    lock = JSON.parse(raw);
  } catch {
    return; // unparseable — don't risk writing back garbage
  }
  let touched = false;
  const nmKey = `node_modules/${name}`;
  if (lock.packages && nmKey in lock.packages) {
    delete lock.packages[nmKey];
    touched = true;
  }
  // Legacy lockfileVersion 1/2 shape — no project in this repo carries one today (all are v3),
  // but a stray one shouldn't be left half-fixed.
  if (lock.dependencies && name in lock.dependencies) {
    delete lock.dependencies[name];
    touched = true;
  }
  if (!touched) return;
  try {
    // Matches npm's own lockfile formatting (verified against a real committed lockfile).
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch {
    /* best-effort — a failed write just means the manual remedy is still needed */
  }
}

/** Pack `plugin` into `<projectRoot>/plugins/<name>-<ver>-<hash>.tgz` (real copy),
 *  drop stale tarballs for the same plugin (older content hashes), and return the
 *  tarball's project-relative path. */
function packInto(plugin: EnginePlugin, projectRoot: string, hash: string, canBuild: boolean): string {
  ensurePluginBuilt(plugin, canBuild);
  const pluginsDir = path.join(projectRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const destName = tarballName(plugin.name, plugin.version, hash);

  // npm pack writes <name>-<ver>.tgz to --pack-destination. Pack into a temp dir
  // FIRST and verify it succeeded; only THEN drop stale siblings + publish. If we
  // dropped the old tarball before packing and the pack threw, the project's
  // `file:` spec would point at a now-deleted file → broken `npm install`. (D4)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pack-'));
  // Give the PACKED package a version npm's `file:` resolver can actually see change (#685):
  // append the content hash as a semver PRERELEASE (packedVersion — `1.0.0-h<hash>`) to
  // plugin.dir's OWN package.json for the duration of the pack, then restore the exact original
  // bytes in the finally below. The committed engine plugin package.json stays on its bare base
  // version — it is source and must not churn — and pluginContentHash normalizes this suffix
  // back out (see normalizedPackageJsonBytes) so the rewrite doesn't feed back into the hash
  // that names the tarball.
  //
  // Measured (#685 FIX 2), correcting an earlier claim here that a spec/filename change alone
  // was what kept npm's resolver honest: npm's `file:` extraction decision is LOCKFILE-driven and
  // it never opens the committed tarball. A lockfile entry only gets refreshed when npm
  // RE-RESOLVES — which a spec/filename change triggers and a bytes-change under a STABLE
  // filename does not (reproduced directly: two tarballs both packed `1.0.0`, same filename,
  // different bytes — `npm install` reported "up to date" and left the old extraction in place).
  // What this hash suffix actually buys is IDENTIFIABILITY, not prevention by itself: every prior
  // tarball packed the same bare `1.0.0` regardless of content, so the lockfile could never say
  // which generation was installed. With the hash suffix it does — which is what makes the
  // tarball-vs-installed comparison below (and `verifyInstalledMatchesTarball`) meaningful, and
  // what makes the lockfile-entry invalidation in the loop below (FIX 1a) able to target the
  // right entry when an in-place re-pack needs to force a genuine re-resolve.
  //
  // ⚠️ `npm pack` names its OWN output from the package version, so it emits
  // `<name>-1.0.0-h<hash>.tgz` here — NOT `destName` (which never carries the `h`, see
  // packedVersion). That's fine: the "find whatever .tgz was produced" read below doesn't
  // assume a name, and the copyFileSync further down publishes it under `destName` regardless
  // of what npm called it.
  const pkgJsonPath = path.join(plugin.dir, 'package.json');
  const originalBytes = fs.readFileSync(pkgJsonPath);
  try {
    const pkg = JSON.parse(originalBytes.toString('utf8'));
    // Defensive: a killed process may have left a hash-suffixed version on disk from a pack
    // that never reached the restore below. Treat its BASE as the truth rather than
    // compounding it into a double-suffixed version.
    const base = baseVersion(String(pkg.version ?? plugin.version));
    pkg.version = packedVersion(base, hash);
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');

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
    // Restore the plugin's OWN package.json exactly — byte-identical, not a re-serialization —
    // so its formatting/trailing newline survive and the committed file never churns.
    fs.writeFileSync(pkgJsonPath, originalBytes);
  }
}

/** Heal a project's engine-plugin deps to the vendored-tarball (copy) form.
 *  For each engine plugin the project depends on:
 *    1. (re)pack it into <project>/plugins/<name>-<ver>.tgz if missing/stale,
 *    2. rewrite the dependency spec to `file:plugins/<name>-<ver>.tgz` (migrating
 *       off any old `file:../../engine/...` directory-symlink spec).
 *  Idempotent: a no-op once the tarball is current and the spec already matches.
 *  Returns {changed} so the caller can decide whether to reinstall. */
export function vendorEnginePlugins(
  projectRoot: string,
  engineRoot: string,
  opts: VendorOptions = {},
): VendorResult {
  // Default: build unless we are demonstrably inside a PACKAGED editor.
  //
  // ⚠️ This used to default to a bare `true`, on the premise that "every other caller (Vite
  // plugins, the scaffolder, tests) runs from a developer checkout". That premise is FALSE for
  // two of them, and it shipped: `vite-asset-scanner`'s native-build path and `addNativeTarget`'s
  // auto-scaffold BOTH run inside the packaged editor's own Vite dev-server process. Only
  // `main.ts` passed `canBuild` explicitly, so the guard in `ensurePluginBuilt` — written for
  // precisely this case, with a comment saying "the caller knows (app.isPackaged); it must say
  // so" — was simply never reached from the path that needed it.
  //
  // What that cost: the first iOS/Android build in a packaged editor shelled out to
  // `npm run build` on an engine plugin, which runs `rimraf` — and packaging strips every
  // binary shim (root `node_modules/.bin/` ships EMPTY), so it exited 127 and killed the Vite
  // dev server. The editor stayed up (the Electron backend is a different process) and every
  // subsequent build failed instantly with "Connection lost", which reads as a network fault
  // rather than a dead server. Found cutting v0.5.0, building demos/forest-camp.
  //
  // So the default now derives from the ENVIRONMENT rather than from each call site remembering:
  // `main.ts` exports MODOKI_PACKAGED=1 into its own process env when `app.isPackaged`, which
  // every child it spawns (the Vite dev server, and `build-web.mjs` under it) inherits. An
  // explicit `opts.canBuild` still wins. A dev checkout never sets the var, so it is unaffected.
  // Fixing the DEFAULT rather than the two call sites is deliberate: a third call site added
  // later is correct without knowing any of this.
  const canBuild = opts.canBuild ?? (process.env.MODOKI_PACKAGED !== '1');
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
    ensurePluginBuilt(plugin, canBuild);
    const hash = pluginContentHash(plugin.dir);
    const relTgz = `plugins/${tarballName(plugin.name, plugin.version, hash)}`;
    const absTgz = path.join(projectRoot, relTgz);
    expectedVendor[plugin.name] = `file:${relTgz}`;

    // Content-addressed: if the tarball for THIS content already exists (the
    // committed one on a fresh clone, or a prior pack), don't re-pack — that
    // keeps `npm ci` integrity stable. Only a real content change (new hash →
    // absent file) triggers a fresh pack.
    //
    // ⚠️ #685 follow-up: filename matching is not enough on its own. Every tarball committed
    // before packInto started writing packedVersion into the PACKED package.json still has the
    // right filename (the hash always matched its own content) but the WRONG packed version
    // (a bare base, e.g. `1.0.0`). Measured (#685 FIX 2), correcting an earlier claim here: npm's
    // `file:` resolver does NOT key re-vendoring on this field — it never opens the tarball, and
    // re-resolution is LOCKFILE-driven, not read off anything inside the packed package.json.
    // What the packed version buys is IDENTIFIABILITY — it's what lets THIS function tell
    // "already current" from "packed before the hash suffix existed" without opening and
    // re-hashing every tarball. So a same-named tarball whose packed version isn't
    // `packedVersion(plugin.version, hash)` is treated as stale here too: this makes the fix
    // self-migrating (a project heals on its very next vendor run, no separate migration step
    // needed for the mechanism itself) and self-healing (a tarball packed by a stale toolchain,
    // or one that failed to read at all, gets corrected here rather than living forever).
    // readPackedVersion never throws — an unreadable tarball reads as `null`, which never
    // equals a real wanted version, so it's stale too.
    const wantPackedVersion = packedVersion(plugin.version, hash);
    // Was there ALREADY a tarball at this exact (content-addressed) path? If so, and it's about
    // to be re-packed below, `packInto` overwrites it IN PLACE — same filename, new bytes — which
    // is exactly the state a plain `npm install` cannot repair (#685 FIX 1): the dep spec doesn't
    // change, so nothing tells npm's lockfile-driven resolver to re-resolve, and it happily keeps
    // serving the OLD extraction. Captured before the call so the branch below can tell "packed a
    // brand-new filename" (nothing to invalidate — the changed spec will force a resolve on its
    // own) from "overwrote an existing one" (the lockfile entry for the OLD bytes must be
    // invalidated by hand, since npm has no other reason to look again).
    const wasInPlaceRepack = fs.existsSync(absTgz);
    if (!wasInPlaceRepack || readPackedVersion(absTgz) !== wantPackedVersion) {
      packInto(plugin, projectRoot, hash, canBuild);
      changed = true;
      vendored.push(plugin.name);
      if (wasInPlaceRepack) invalidateLockfileEntry(projectRoot, plugin.name);
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
