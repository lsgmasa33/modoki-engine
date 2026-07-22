/**
 * @modoki/toolchain — the single place the editor RESOLVES an external CLI tool.
 *
 * Phase 2 of the editor-shipping plan (docs/plans/editor-toolchain-layer-plan.md). Today "how do I
 * find/run tool X" is answered inline at ~30 spawn sites, each with its own strategy — including a
 * real bug: rigged-model-optimize.ts spawned bare `toktx`, ignoring the bundled MODOKI_TOKTX path,
 * so KTX2 compression of rigged GLBs silently failed in the packaged editor. This module collapses
 * resolution into one registry + cache so every spawn resolves a tool the same way.
 *
 * Lives at engine/toolchain/ (a relative-imported source module), NOT a @modoki/* npm package:
 * build-electron.mjs marks packages `external` but BUNDLES relative imports, so a relative module
 * ships inside main.cjs with no dist step, and Vite/vitest compile it as source. It reads only env
 * vars (never Electron APIs), so it's usable from the Vite plugins, Electron main, and headless CI
 * alike. Governing principle: bundle nothing downloadable — a tool is resolved from an env override
 * or PATH now; on-demand DOWNLOAD into a userData dir (kind:'installable') lands in a later phase.
 *
 * Phase A scope: `toktx` only (the bug). The registry is built to grow — gltfpack,
 * gltf-transform-cli, node/npm, and the Android/iOS tools are added as their touchpoints migrate.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureJdk, discoverJavaHome, jdkVersionDir } from './jdkProvision'
import { ensureCmdlineTools, runSdkmanager, ANDROID_SDK_PACKAGES } from './androidSdkProvision'
import { ensureRuby, rubyDirFor } from './rubyProvision'

export type ToolId = 'toktx' | 'android-sdk' | 'npm' | 'java' | 'xcodebuild' | 'gltf-transform-cli' | 'gltfpack' | 'cocoapods' | 'ffmpeg' | 'ffprobe' | 'msdf-atlas-gen'

/** How a resolved tool is located. `env` = an env override; `path` = a bare binary found on PATH;
 *  `probe` = a candidate directory that exists (directory tools like the Android SDK). */
export type ToolSource = 'env' | 'path' | 'probe'

export interface DetectResult {
  id: ToolId
  present: boolean
  /** Binary tools: the command to spawn (absolute env override, or the bare name found on PATH). */
  command?: string
  /** The resolved primary location: a binary's absolute path, or a directory tool's root dir. */
  path?: string
  /** Trimmed `--version` output, for cache keys / diagnostics (binary tools). */
  version?: string
  /** A binary's containing directory (absolute) — used by `withToolOnPath`. */
  dir?: string
  source: ToolSource | 'missing'
}

/** Editor toolchain preference: whether tool resolution may fall through to
 *  SYSTEM-installed SDKs, or use ONLY the bundled (userData) ones. Persisted as a
 *  small JSON in the toolchain dir so BOTH processes that resolve tools — Electron
 *  main (the `/api/toolchain` status) and the Vite plugin (preflight/build) — read
 *  the same LIVE value without env propagation (each `detect()` re-probes). */
export interface ToolchainSettings { allowSystemToolchain: boolean }

function toolchainSettingsPath(): string | null {
  const dir = process.env.MODOKI_TOOLCHAIN_DIR
  return dir ? path.join(dir, 'settings.json') : null
}

export function readToolchainSettings(): ToolchainSettings {
  const p = toolchainSettingsPath()
  if (p) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ToolchainSettings>
      return { allowSystemToolchain: !!j.allowSystemToolchain }
    } catch { /* no file / unreadable → default below */ }
  }
  return { allowSystemToolchain: false }
}

export function writeToolchainSettings(patch: Partial<ToolchainSettings>): ToolchainSettings {
  const p = toolchainSettingsPath()
  if (!p) throw new Error('no toolchain dir configured — cannot persist toolchain settings (dev editor)')
  const next = { ...readToolchainSettings(), ...patch }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(next, null, 2))
  return next
}

/** Whether SDK resolution may fall through to SYSTEM installs (Homebrew, Android
 *  Studio, java_home, Adoptium) AFTER the bundled userData install. In a DEV editor
 *  (no toolchain dir) we always use the machine's SDKs — that IS the dev setup. In a
 *  PACKAGED editor we default to BUNDLED-ONLY (Unity-style: use the editor's own
 *  provisioned SDKs so a build is reproducible and independent of whatever's on the
 *  user's machine); the "Use system-installed SDKs" toggle (settings.json, or
 *  MODOKI_ALLOW_SYSTEM_TOOLCHAIN=1) opts back into the fallback. Gates only the SDKs
 *  (`java`, `android-sdk`); bundled toktx/npm and the model CLIs resolve normally. */
export function systemToolchainAllowed(): boolean {
  if (!process.env.MODOKI_TOOLCHAIN_DIR) return true // dev editor — use the machine's SDKs
  if (process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN === '1') return true
  return readToolchainSettings().allowSystemToolchain
}

/** Whether the EDITOR itself can supply this tool in the CURRENT environment — because the packaged
 *  app bundles it (toktx, msdf-atlas-gen), provisions it (Node/npm), or can `install()` it into the
 *  toolchain dir. Only such a tool has its system fallback gated by the toggle: refusing to fall back
 *  for a tool we cannot provide would report a perfectly good one as missing with no way to fix it.
 *   - `xcodebuild` — Apple-supplied, never bundled ⇒ always resolved from the system.
 *   - `npm` — gated only where we actually download Node (packaged, or MODOKI_PROVISION_NODE=1);
 *     a plain dev checkout has no provisioned Node, so its PATH npm stays usable.
 *   - bundled binaries — gated only when the host set their env var (i.e. the bundle is present). */
function editorCanProvide(id: ToolId): boolean {
  switch (id) {
    case 'xcodebuild': return false
    case 'npm': return process.env.MODOKI_PROVISION_NODE === '1'
    case 'toktx': return !!process.env.MODOKI_TOKTX
    case 'msdf-atlas-gen': return !!process.env.MODOKI_MSDF_ATLAS_GEN
    default: return !!process.env.MODOKI_TOOLCHAIN_DIR && isInstallable(id)
  }
}

/** Whether resolving `id` may fall through to a SYSTEM install — a PATH binary, a user-set
 *  JAVA_HOME/ANDROID_HOME, or a well-known Android-Studio/Homebrew dir. With "Use system-installed
 *  SDKs" OFF this is false for every tool the editor can provide itself, so a packaged editor builds
 *  ONLY with its own toolchain and never silently picks up whatever is on the machine. */
function systemFallbackAllowed(id: ToolId): boolean {
  return systemToolchainAllowed() || !editorCanProvide(id)
}

/** A binary tool: resolved from an env override or PATH, validated by a `--version` probe. */
interface BinaryDescriptor {
  kind: 'binary'
  /** Env var carrying an explicit absolute path (set by the packaged Electron host, e.g. MODOKI_TOKTX). */
  envVar?: string
  /** Absolute candidate paths tried BETWEEN the env override and PATH — e.g. a userData install
   *  location for an `install()`-able tool. Evaluated per call (may read MODOKI_TOOLCHAIN_DIR). */
  extraCandidates?: () => string[]
  /** Bare binary name, tried on PATH after the env override + extra candidates. */
  bin: string
  versionArgs: string[]
  missingMsg: string
}

/** A directory-located tool (e.g. the Android SDK): resolved from env vars then well-known dirs,
 *  validated by the presence of a `marker` sub-path. This is the SINGLE candidate list — it
 *  replaces the two previously divergent Android-SDK probes (healNativeConfig + vite-asset-scanner). */
interface DirectoryDescriptor {
  kind: 'directory'
  /** OUR provisioned install(s) under MODOKI_TOOLCHAIN_DIR. Always tried, and tried FIRST — the
   *  editor's own SDK outranks a system one even with the toggle on, so a build stays reproducible
   *  once you've installed it here. (Previously the env vars won, so a stray JAVA_HOME shadowed the
   *  JDK the user had just installed from this very dialog.) */
  bundled?: () => string[]
  /** SYSTEM env vars carrying the root dir (JAVA_HOME, ANDROID_HOME), tried in order — gated by
   *  `systemFallbackAllowed`: these point at the machine's SDKs, not ours. */
  envVars?: string[]
  /** Well-known SYSTEM install dirs, tried after the env vars — gated the same way. */
  candidates: () => string[]
  /** A sub-path that must exist under a candidate for it to count (e.g. `platform-tools`). */
  marker: string
  /** Optional post-marker check: a candidate whose marker exists but that FAILS this is skipped
   *  (e.g. a JDK whose `java -version` isn't 21). Lets a wrong-but-present tool fall through to the
   *  next candidate, or to "missing" (→ Install the right one) rather than being wrongly accepted. */
  validate?: (dir: string) => boolean
  missingMsg: string
}

type ToolDescriptor = BinaryDescriptor | DirectoryDescriptor

const REGISTRY: Record<ToolId, ToolDescriptor> = {
  toktx: {
    kind: 'binary',
    envVar: 'MODOKI_TOKTX',
    bin: 'toktx',
    versionArgs: ['--version'],
    missingMsg:
      'toktx (KTX-Software CLI) not found. Set MODOKI_TOKTX to the binary path, or install the ' +
      'macOS package from https://github.com/KhronosGroup/KTX-Software/releases',
  },
  'msdf-atlas-gen': {
    kind: 'binary',
    // Bundled like toktx (no npm distribution), so it's registered here for VISIBILITY in
    // Build Support (not INSTALLABLE): macOS relocates a Homebrew build (stage-msdf.cjs),
    // Windows ships Chlumsky's prebuilt win64 exe (release-windows.yml). resolveBundled sets
    // MODOKI_MSDF_ATLAS_GEN → Contents/Resources/bin. font-convert.ts bakes MTSDF atlases with it.
    envVar: 'MODOKI_MSDF_ATLAS_GEN',
    bin: 'msdf-atlas-gen',
    versionArgs: ['-version'], // prints "MSDF-Atlas-Gen v1.4.0", exit 0 (NOT --version-only)
    missingMsg:
      'msdf-atlas-gen not found — needed to bake MTSDF font atlases (dynamic / CJK text). The ' +
      'packaged editor bundles it; in a dev checkout set MODOKI_MSDF_ATLAS_GEN, or install it ' +
      '(macOS: `brew install msdf-atlas-gen`; https://github.com/Chlumsky/msdf-atlas-gen).',
  },
  npm: {
    kind: 'binary',
    // C1: resolves system npm on PATH (behaviour-preserving). A later phase points MODOKI_NPM at a
    // downloaded Node's npm-cli.js so the packaged editor never needs a user-installed npm.
    envVar: 'MODOKI_NPM',
    bin: 'npm',
    versionArgs: ['--version'],
    missingMsg: 'npm not found. Set MODOKI_NPM, or install Node.js (which bundles npm).',
  },
  'android-sdk': {
    kind: 'directory',
    // A userData SDK from `install('android-sdk')` wins first — in a packaged editor it's the ONLY
    // SDK. It only counts once platform-tools is installed (the marker), so a half-provisioned dir
    // is skipped and dev machines fall through to the system dirs below.
    bundled: () => (process.env.MODOKI_TOOLCHAIN_DIR ? [path.join(process.env.MODOKI_TOOLCHAIN_DIR, 'android-sdk')] : []),
    // Then the env overrides (both Google-standard names), then the well-known install dirs — the
    // UNION of the two former probes' candidate lists (Homebrew command-line-tools, the macOS
    // Android Studio location, and the Linux $HOME/Android/Sdk that only healNativeConfig had).
    envVars: ['ANDROID_HOME', 'ANDROID_SDK_ROOT'],
    candidates: () => {
      const home = os.homedir()
      const list: string[] = []
      if (process.platform === 'win32') {
        // Android Studio's default SDK location, plus the other spellings that show up on Windows
        // boxes (a machine-wide install under Program Files, and the bare C:\Android\Sdk people
        // pick to dodge the space in "Program Files").
        for (const b of [process.env.LOCALAPPDATA, path.join(home, 'AppData', 'Local')]) {
          if (b) list.push(path.join(b, 'Android', 'Sdk'))
        }
        for (const b of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
          if (b) list.push(path.join(b, 'Android', 'android-sdk'), path.join(b, 'Android', 'Sdk'))
        }
        list.push('C:\\Android\\Sdk', 'C:\\Android\\android-sdk')
      } else {
        list.push(
          '/opt/homebrew/share/android-commandlinetools',
          '/usr/local/share/android-commandlinetools',
          path.join(home, 'Library/Android/sdk'),
          path.join(home, 'Android/Sdk'),
        )
      }
      // Last resort: derive the SDK root from an `adb` the user already has on PATH
      // (<sdk>/platform-tools/adb). Catches every non-standard install location for free.
      const adb = whichSync(process.platform === 'win32' ? 'adb.exe' : 'adb')
      if (adb) list.push(path.dirname(path.dirname(adb)))
      return list
    },
    // Consistent existence check: a USABLE SDK has platform-tools (adb lives here). This is
    // vite-asset-scanner's stricter check, now applied to healNativeConfig too — a bare dir
    // without platform-tools is not a usable SDK, so requiring it kills the two probes' divergence.
    marker: 'platform-tools',
    missingMsg:
      'Android SDK not found. Set ANDROID_HOME to an SDK dir (with platform-tools), or install the ' +
      'Android command-line tools.',
  },
  java: {
    kind: 'directory',
    // Our provisioned Temurin first, then JAVA_HOME, then the well-known system JDK locations
    // (on macOS the same ones the former build-time `javaPrefix` bash probed: VERSIONED Homebrew
    // openjdk@21 → unversioned openjdk → `/usr/libexec/java_home -v 21`).
    bundled: provisionedJavaHomes,
    envVars: ['JAVA_HOME'],
    candidates: systemJavaHomeCandidates,
    marker: path.join('bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    // Version-strict: Android/AGP is JDK-21-specific (Gradle can't read newer bytecode), so a
    // present-but-wrong JDK (unversioned brew openjdk 25, a JAVA_HOME pointing at 17, `java_home -v
    // 21` misreporting) must NOT be accepted — it'd be a works-on-my-machine trap. A candidate whose
    // `java -version` isn't 21 is skipped; if none match, detect('java') is absent → the dialog
    // offers to install the pinned Temurin 21.
    validate: (dir) => javaMajorMatches(dir, REQUIRED_JAVA_MAJOR),
    missingMsg:
      'A Java 21 JDK is required for Android builds (JDK 17/25/etc. are rejected). Set JAVA_HOME to a ' +
      'JDK 21, install one (`brew install openjdk@21`), or use the Build Support dialog to install it.',
  },
  xcodebuild: {
    kind: 'binary',
    bin: 'xcodebuild',
    versionArgs: ['-version'],
    missingMsg:
      'Xcode not found (xcodebuild). iOS builds require Xcode — install it from the Mac App Store, ' +
      'then run `xcode-select --switch` and accept the license.',
  },
  cocoapods: {
    kind: 'binary',
    // Only needed for iOS games with AppLovin MEDIATION ADAPTERS (no SPM support) — most iOS games
    // are SPM-only and never touch it, so it's NOT a preflight blocker, just a dialog row. On macOS
    // it's one-click installable: install('cocoapods') provisions a portable Ruby + the CocoaPods
    // gem into the editor toolchain (detect resolves it via cocoapodsEnv), so NO Homebrew / system
    // Ruby is needed. A bare-PATH `pod` (dev machine) is still honoured as a fallback.
    bin: 'pod',
    versionArgs: ['--version'],
    missingMsg:
      'CocoaPods (pod) not found — needed ONLY for iOS mediation-adapter games. On macOS, install it ' +
      'from the Build Support dialog (the editor provisions its own Ruby + CocoaPods; no Homebrew needed).',
  },
  'gltf-transform-cli': {
    kind: 'binary',
    // An `install()`-able npm CLI (model reimport/optimize). Resolved from an explicit override,
    // then the userData install location (where `install('gltf-transform-cli')` puts it — this is
    // how a packaged editor gets it, since the bundle strips the devDependency), then PATH.
    envVar: 'MODOKI_GLTF_TRANSFORM',
    extraCandidates: () => (process.env.MODOKI_TOOLCHAIN_DIR ? [npmToolBin(process.env.MODOKI_TOOLCHAIN_DIR, 'gltf-transform')] : []),
    bin: 'gltf-transform',
    versionArgs: ['--version'],
    missingMsg:
      "@gltf-transform/cli not found — needed for model reimport/optimize. Install it from the " +
      "Build Support dialog, or run `install('gltf-transform-cli')`.",
  },
  gltfpack: {
    kind: 'binary',
    // The other `install()`-able model CLI (single-pass LOD simplification + meshopt). The npm
    // `gltfpack` package is a WASM CLI (no native binary), so it installs into the same shared
    // userData `npm-tools` package as gltf-transform-cli. `-v` prints "gltfpack <ver>" and exits 0.
    envVar: 'MODOKI_GLTFPACK',
    extraCandidates: () => (process.env.MODOKI_TOOLCHAIN_DIR ? [npmToolBin(process.env.MODOKI_TOOLCHAIN_DIR, 'gltfpack')] : []),
    bin: 'gltfpack',
    versionArgs: ['-v'],
    missingMsg:
      'gltfpack not found — needed for single-pass model LOD/meshopt. Install it from the Build ' +
      "Support dialog, or run `install('gltfpack')`.",
  },
  ffmpeg: {
    kind: 'binary',
    // An `install()`-able npm-provisioned binary (audio import transcode). ffmpeg-static ships a
    // self-contained arm64 static binary — no `.bin` symlink, so resolve it at its in-package path.
    envVar: 'MODOKI_FFMPEG',
    extraCandidates: () => (process.env.MODOKI_TOOLCHAIN_DIR ? [ffmpegToolBin(process.env.MODOKI_TOOLCHAIN_DIR)] : []),
    bin: 'ffmpeg',
    versionArgs: ['-version'],
    missingMsg:
      'ffmpeg not found — needed for audio import (transcode). Install it from the Build Support ' +
      "dialog, or run `install('ffmpeg')`.",
  },
  ffprobe: {
    kind: 'binary',
    // The audio-import stats probe (cosmetic duration/channels). @ffprobe-installer resolves to a
    // REAL arm64 binary (ffprobe-static ships x86_64 in its arm64 slot). No `.bin` symlink either.
    envVar: 'MODOKI_FFPROBE',
    extraCandidates: () => (process.env.MODOKI_TOOLCHAIN_DIR ? [ffprobeToolBin(process.env.MODOKI_TOOLCHAIN_DIR)] : []),
    bin: 'ffprobe',
    versionArgs: ['-version'],
    missingMsg:
      'ffprobe not found — needed for audio import stats. Install it from the Build Support ' +
      "dialog, or run `install('ffprobe')`.",
  },
}

/** A resolved tool command that Windows cannot spawn/execFile without a shell: a `.cmd`/`.bat`
 *  batch shim (npm's `.bin/<name>.cmd`, `sdkmanager.bat`, …). Since CVE-2024-27980 (Node ≥18.20)
 *  spawning one WITHOUT `shell:true` throws `spawn EINVAL` on Windows; probing it with a
 *  no-shell `execFileSync` fails the same way (which read as a just-installed tool being "not
 *  found"). Every spawn/execFile of a resolved tool path must pass `{ shell: needsWinShell(cmd) }`.
 *  (Pure/platform-injectable for host-agnostic tests.) */
export function needsWinShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

/** Make a resolved command + args safely spawnable: whether a shell is required (a Windows
 *  `.cmd`/`.bat` shim — see needsWinShell) and, when it is, the command/args QUOTED. Node
 *  concatenates argv into one command line for `shell:true`, so an unquoted path with a space
 *  (`C:\Users\Jane Doe\…\gltf-transform.cmd`, or a project under `My Games\`) is split by the
 *  shell and the spawn fails with a baffling "is not recognized as an internal or external
 *  command". Every spawn/execFile of a toolchain-resolved command should go through this. */
export function spawnable(
  command: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  const shell = needsWinShell(command, platform)
  if (!shell) return { command, args, shell }
  const q = (s: string) => (/[\s&|<>^()]/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s)
  return { command: q(command), args: args.map(q), shell }
}

/** Resolve a BARE binary name to an absolute path the way a shell would, or null if it isn't on PATH.
 *
 *  This exists because `execFile`/`spawn` WITHOUT a shell do no PATHEXT resolution on Windows: the OS
 *  looks for a file named exactly `npm`, and npm ships `npm.cmd` / `npm.ps1` / a `npm` bash script.
 *  So probing a PATH tool by bare name threw ENOENT and the Build-Support dialog reported a perfectly
 *  installed npm (and toktx, gltfpack, …) as "not found" even with "Use system-installed SDKs" ON.
 *  Resolving here also gives every PATH-found tool an absolute `path`/`dir`, which is what
 *  `withToolOnPath` and the spawn sites need.
 *
 *  Windows tries only the PATHEXT extensions (never the extension-less file — that's the bash shim,
 *  which Windows cannot run); POSIX requires the execute bit. Pure/injectable for host-agnostic tests. */
export function whichSync(
  bin: string,
  opts: {
    platform?: NodeJS.Platform
    pathEnv?: string
    pathExt?: string
  } = {},
): string | null {
  const platform = opts.platform ?? process.platform
  const win = platform === 'win32'
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''
  // PATHEXT is conventionally UPPER-CASE (".COM;.EXE;…"); lower-case it so a resolved path reads
  // `npm.cmd`, not `npm.CMD`, in the Build-Support UI and logs. Windows paths are case-insensitive,
  // so this never changes what resolves.
  const exts = win
    ? (opts.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : ['']
  const runnable = (p: string): boolean => {
    try {
      if (!fs.statSync(p).isFile()) return false
      if (!win) fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  for (const dir of pathEnv.split(win ? ';' : ':')) {
    if (!dir) continue
    // Strip the quotes Windows PATH entries sometimes carry ("C:\Program Files\x";…).
    const base = path.join(dir.replace(/^"|"$/g, ''), bin)
    for (const ext of exts) {
      const cand = base + ext
      if (runnable(cand)) return cand
    }
  }
  return null
}

/** A candidate command → the absolute path to spawn, or null when it can't be found. A candidate that
 *  already carries a directory is taken as-is (the caller built it); a BARE name is resolved on PATH. */
function resolveCommand(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd
  return whichSync(cmd)
}

/** Where `install()` puts an npm-CLI tool's executable in the userData toolchain dir. One shared
 *  `npm-tools` package holds all such CLIs (installed as deps), exposing their `.bin/<name>`. */
function npmToolsDir(toolchainDir: string): string {
  return path.join(toolchainDir, 'npm-tools')
}
/** On Windows npm writes THREE `.bin` shims — `<name>` (bash, unspawnable on Windows), `<name>.cmd`,
 *  `<name>.ps1`. Resolve the `.cmd`: it's the one Windows can run, and the extension-less bash shim
 *  would pass an existence check yet fail every spawn/probe. (platform-injectable for tests.) */
export function npmToolBin(toolchainDir: string, name: string, platform: NodeJS.Platform = process.platform): string {
  const shim = platform === 'win32' ? `${name}.cmd` : name
  return path.join(npmToolsDir(toolchainDir), 'node_modules', '.bin', shim)
}

/** ffmpeg-static and @ffprobe-installer are npm-installable like the model CLIs, but they expose NO
 *  `.bin/<name>` symlink (their binary is the package payload, reached via `require()`). So resolve
 *  their executable at its known in-package path instead of via npmToolBin. ffmpeg-static keeps its
 *  binary at the package root; @ffprobe-installer resolves to a per-platform sub-package.
 *  On Windows BOTH ship a `.exe` (ffmpeg.exe / ffprobe.exe) — omitting the suffix resolves to a
 *  non-existent path, so the post-install existence check throws "executable is missing" even though
 *  the npm install succeeded.
 *  Pure (platform/arch injectable, defaulting to the running process) so any target's path is
 *  testable from any host — same pattern as nodeDistFor. */
const toolExeSuffix = (platform: NodeJS.Platform): string => (platform === 'win32' ? '.exe' : '');
export function ffmpegToolBin(toolchainDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(npmToolsDir(toolchainDir), 'node_modules', 'ffmpeg-static', `ffmpeg${toolExeSuffix(platform)}`)
}
export function ffprobeToolBin(
  toolchainDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(npmToolsDir(toolchainDir), 'node_modules', '@ffprobe-installer', `${platform}-${arch}`, `ffprobe${toolExeSuffix(platform)}`)
}

/** The JDK major version Android/AGP requires (Gradle can't read newer bytecode). detect('java')
 *  rejects any resolved JDK that isn't this, and install('java') provisions this (pinned Temurin). */
export const REQUIRED_JAVA_MAJOR = 21

/** Extract a JDK major from a version STRING (e.g. from the `release` file's JAVA_VERSION): `21.0.11`
 *  → 21, `21` → 21, legacy `1.8.0_412` → 8 (pre-9 `1.N` naming). Null if unparseable. */
export function javaMajorFromVersion(version: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!m) return null
  const first = Number(m[1])
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first
}

/** Parse the major from `java -version` OUTPUT (the version is quoted), e.g.
 *  `openjdk version "21.0.11" 2024-04-16` → 21. Null if unparseable. Used only as the fallback when a
 *  JDK has no `release` file. Exported for unit testing independent of a real JDK. */
export function parseJavaMajor(versionOutput: string): number | null {
  const m = /version "([^"]+)"/.exec(versionOutput)
  return m ? javaMajorFromVersion(m[1]) : null
}

/** Read a JDK's major from its `release` file (`JAVA_VERSION="21.0.11"`) — the canonical, fast, and
 *  robust source: a structured key-value file every JDK since Java 9 ships at the JDK home, so we
 *  never spawn a JVM or parse `java -version`'s human-readable, distribution-varying output. Null if
 *  the file is absent/unparseable (→ caller falls back to the spawn). */
function readReleaseJavaMajor(home: string): number | null {
  try {
    const rel = fs.readFileSync(path.join(home, 'release'), 'utf8')
    const m = /^JAVA_VERSION="([^"]+)"/m.exec(rel)
    return m ? javaMajorFromVersion(m[1]) : null
  } catch {
    return null
  }
}

// A JDK dir's version is stable — cache the resolved major per dir so repeated detect('java') calls
// (status reads, build gating) don't re-read/re-spawn. Cleared by resetToolchainCache (which
// toolchainStatus calls, so a swapped JDK is re-probed on the next read).
const javaVersionCache = new Map<string, number | null>()

/** True iff the JDK at `home` is major `want`. Reads the structured `release` file first (fast, no
 *  JVM); only when that's missing (a pre-9 JDK, or an odd distribution) does it fall back to spawning
 *  `<home>/bin/java -version`. A non-JDK / unreadable dir → false (skipped, not accepted). */
function javaMajorMatches(home: string, want: number): boolean {
  let major = javaVersionCache.get(home)
  if (major === undefined) {
    major = readReleaseJavaMajor(home)
    if (major === null) {
      try {
        const javaBin = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
        const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8' })
        // `java -version` prints to stderr and exits 0; read both to be safe.
        if (!r.error) major = parseJavaMajor(`${r.stderr ?? ''}${r.stdout ?? ''}`)
      } catch {
        major = null
      }
    }
    javaVersionCache.set(home, major)
  }
  return major === want
}

/** OUR provisioned JDK (`install('java')` → Temurin), or [] when it isn't provisioned here. Uses the
 *  VERSION-scoped dir (jdkVersionDir) so detect resolves the CURRENTLY pinned JDK, not a stale one
 *  from a previous pin left orphaned next to it. */
function provisionedJavaHomes(): string[] {
  if (!process.env.MODOKI_TOOLCHAIN_DIR) return []
  const userJdk = discoverJavaHome(jdkVersionDir(path.join(process.env.MODOKI_TOOLCHAIN_DIR, 'jdk')))
  return userJdk ? [userJdk] : []
}

/** Absolute paths of `base`'s immediate sub-dirs whose name starts with `prefix` ([] if base is
 *  absent). JDK vendors version-suffix their install dirs (`jdk-21.0.7+6-hotspot`, `zulu-21.36`), so
 *  the only way to find them is to enumerate. `validate` still version-gates every hit, so a stray
 *  non-21 dir listed here is harmless. */
function dirsStartingWith(base: string, prefix: string): string[] {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((e) => path.join(base, e.name))
  } catch {
    return []
  }
}

/** Well-known SYSTEM JAVA_HOME candidates for `detect('java')`. On macOS these SPAWN brew/java_home,
 *  which is why `java` is a directory tool (uncached, re-probed per call). Gated by the "Use
 *  system-installed SDKs" toggle — see systemFallbackAllowed. */
function systemJavaHomeCandidates(): string[] {
  const out: string[] = []
  const home = os.homedir()
  /** A JDK reachable as `<home>/bin/java` on PATH — the catch-all for any install layout (Chocolatey,
   *  Scoop, winget, SDKMAN, a hand-unzipped JDK) we don't enumerate explicitly. */
  const javaOnPath = whichSync(process.platform === 'win32' ? 'java.exe' : 'java')
  if (process.platform === 'win32') {
    // The vendors that ship a Windows installer, each of which version-suffixes its dir. Adoptium's
    // MSI lands in `%ProgramFiles%\Eclipse Adoptium\jdk-21.x.y-hotspot`; the rest follow the same
    // shape. Android Studio's bundled JetBrains Runtime (`jbr`) is the JDK most Android devs
    // actually have — it was previously invisible, so "I have Java" still read as ✗ not found.
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(home, 'AppData', 'Local', 'Programs')]) {
      if (!base) continue
      out.push(
        ...dirsStartingWith(path.join(base, 'Eclipse Adoptium'), 'jdk-21'),
        ...dirsStartingWith(path.join(base, 'Microsoft'), 'jdk-21'),
        ...dirsStartingWith(path.join(base, 'Java'), 'jdk-21'),
        ...dirsStartingWith(path.join(base, 'Zulu'), 'zulu-21'),
        ...dirsStartingWith(path.join(base, 'Amazon Corretto'), 'jdk21'),
        ...dirsStartingWith(path.join(base, 'BellSoft'), 'LibericaJDK-21'),
        path.join(base, 'Android', 'Android Studio', 'jbr'),
        path.join(base, 'Android Studio', 'jbr'),
      )
    }
    if (javaOnPath) out.push(path.dirname(path.dirname(javaOnPath)))
    return out
  }
  const brewPrefix = (formula: string): string | null => {
    try {
      const p = execFileSync('brew', ['--prefix', formula], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
      return p || null
    } catch {
      return null
    }
  }
  for (const formula of ['openjdk@21', 'openjdk']) {
    const p = brewPrefix(formula)
    if (p) out.push(path.join(p, 'libexec', 'openjdk.jdk', 'Contents', 'Home'))
  }
  try {
    const h = execFileSync('/usr/libexec/java_home', ['-v', '21'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    if (h) out.push(h)
  } catch {
    /* not macOS, or no JDK 21 */
  }
  // Android Studio's bundled JetBrains Runtime + the standard macOS JVM dirs — the JDKs an Android
  // dev is most likely to already have when Homebrew/java_home come up empty.
  out.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
  for (const jvms of ['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines')]) {
    for (const jdk of dirsStartingWith(jvms, '')) out.push(path.join(jdk, 'Contents', 'Home'))
  }
  if (javaOnPath) out.push(path.dirname(path.dirname(javaOnPath)))
  return out
}

const cache = new Map<ToolId, DetectResult>()

function probeVersion(cmd: string, versionArgs: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    // A `.cmd`/`.bat` shim (npm .bin on Windows, sdkmanager.bat) needs a shell or execFile throws
    // EINVAL — which otherwise reads as a just-installed tool being "not found" in Build Support.
    const { command, args, shell } = spawnable(cmd, versionArgs)
    const out = execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell, ...(env ? { env } : {}) })
    return out.toString().trim()
  } catch {
    return null
  }
}

function detectBinary(id: ToolId, d: BinaryDescriptor): DetectResult {
  const candidates: Array<{ cmd: string; source: ToolSource }> = []
  const override = d.envVar ? process.env[d.envVar] : undefined
  if (override) candidates.push({ cmd: override, source: 'env' }) // our own env (bundled/provisioned)
  for (const c of d.extraCandidates?.() ?? []) candidates.push({ cmd: c, source: 'probe' }) // our toolchain install
  // System-PATH fallback: allowed only when system tools are permitted (dev, or the "Use system SDKs"
  // toggle), OR the tool isn't one the editor can supply here (e.g. xcodebuild — a legit system
  // tool). In bundled-only mode we NEVER resolve a tool the editor provides from the machine's PATH:
  // it must come from the editor's own install/bundle (else it reads as "not found", prompting an
  // install), so a build never silently depends on whatever version happens to be on the box.
  if (systemFallbackAllowed(id)) candidates.push({ cmd: d.bin, source: 'path' })

  for (const c of candidates) {
    // A bare name is resolved on PATH FIRST — Windows `execFile` does no PATHEXT lookup, so probing
    // `npm` (really npm.cmd) by name threw ENOENT and reported an installed tool as missing.
    const cmd = resolveCommand(c.cmd)
    if (!cmd) continue
    const version = probeVersion(cmd, d.versionArgs)
    if (version !== null) {
      const abs = path.isAbsolute(cmd)
      return {
        id,
        present: true,
        command: cmd,
        path: abs ? cmd : undefined,
        version,
        dir: abs ? path.dirname(cmd) : undefined,
        source: c.source,
      }
    }
  }
  return { id, present: false, source: 'missing' }
}

function detectDirectory(id: ToolId, d: DirectoryDescriptor): DetectResult {
  const candidates: Array<{ dir: string; source: ToolSource }> = []
  // OUR provisioned install first — always, so the SDK you installed from this dialog outranks a
  // stray JAVA_HOME/ANDROID_HOME. The system sources below are gated by the toggle.
  for (const c of d.bundled?.() ?? []) candidates.push({ dir: c, source: 'probe' })
  if (systemFallbackAllowed(id)) {
    for (const ev of d.envVars ?? []) {
      const v = process.env[ev]
      if (v) candidates.push({ dir: v, source: 'env' })
    }
    for (const c of d.candidates()) candidates.push({ dir: c, source: 'probe' })
  }

  for (const c of candidates) {
    // Marker existence (file OR dir): the Android SDK's `platform-tools` is a dir; a JDK home's
    // `bin/java` is an executable file. `existsSync` accepts both — `isDir` would miss the file.
    if (c.dir && fs.existsSync(path.join(c.dir, d.marker)) && (!d.validate || d.validate(c.dir))) {
      return { id, present: true, path: c.dir, dir: c.dir, source: c.source }
    }
  }
  return { id, present: false, source: 'missing' }
}

/**
 * Locate a tool WITHOUT throwing. Binary tools resolve from an env override then PATH (probed via
 * `--version`); directory tools resolve from env vars then well-known dirs (validated by a marker
 * sub-path).
 *
 * Caching: only BINARY results are cached (the `--version` spawn is expensive and its inputs —
 * MODOKI_TOKTX, PATH — are set once at startup). Directory detection is NOT cached: it's cheap
 * (a few statSync) and its inputs (ANDROID_HOME/…) legitimately differ between projects, so a
 * stale cache would resolve the wrong SDK. Call `resetToolchainCache()` to clear the binary cache.
 */
/** `npm` is special: a PROVISIONED Node (C2) makes it available as `<node> <npm-cli.js>`
 *  even with no system npm on PATH — and npmSpawnSpec uses exactly that. detect('npm')
 *  MUST report it present in that case, else a packaged editor (no PATH npm) shows Core
 *  "not found" while npm actually works fine. Falls back to the normal binary probe
 *  (MODOKI_NPM env → PATH `npm`) when Node isn't provisioned (dev / pre-provision). */
function detectNpm(): DetectResult {
  const nodeBin = process.env.MODOKI_NODE
  const npmCli = process.env.MODOKI_NPM_CLI
  if (nodeBin && npmCli && fs.existsSync(nodeBin) && fs.existsSync(npmCli)) {
    const version = probeVersion(nodeBin, [npmCli, '--version'])
    if (version !== null) {
      return { id: 'npm', present: true, command: nodeBin, path: npmCli, version, dir: path.dirname(nodeBin), source: 'env' }
    }
  }
  return detectBinary('npm', REGISTRY.npm as BinaryDescriptor)
}

/** Where install('cocoapods') provisions the isolated CocoaPods gem home. */
function cocoapodsGemHome(): string | null {
  return process.env.MODOKI_TOOLCHAIN_DIR ? path.join(process.env.MODOKI_TOOLCHAIN_DIR, 'cocoapods-gems') : null
}
/** The provisioned portable-Ruby bin dir, or null if Ruby isn't provisioned here. */
function provisionedRubyBinDir(): string | null {
  const tc = process.env.MODOKI_TOOLCHAIN_DIR
  if (!tc) return null
  const binDir = path.join(rubyDirFor(path.join(tc, 'ruby')), 'bin')
  return fs.existsSync(path.join(binDir, 'ruby')) ? binDir : null
}
/** Env pieces for running the PROVISIONED `pod` — and for `npx cap sync ios`, which shells out to
 *  `pod install`: the isolated GEM_HOME + `binPath` (the portable Ruby's & the gems' bin dirs, as a
 *  PATH prefix to prepend onto whatever base PATH the caller uses — the build prepends it onto the
 *  Node-bearing build PATH, detect onto process.env.PATH). Null when CocoaPods isn't provisioned
 *  in this toolchain (callers then use whatever `pod` is on PATH). */
export function cocoapodsEnv(): { GEM_HOME: string; GEM_PATH: string; binPath: string } | null {
  const gemHome = cocoapodsGemHome()
  const rubyBinDir = provisionedRubyBinDir()
  if (!gemHome || !rubyBinDir || !fs.existsSync(path.join(gemHome, 'bin', 'pod'))) return null
  const sep = process.platform === 'win32' ? ';' : ':'
  return { GEM_HOME: gemHome, GEM_PATH: gemHome, binPath: `${rubyBinDir}${sep}${path.join(gemHome, 'bin')}` }
}
/** `pod` is special: the PROVISIONED CocoaPods runs as the portable Ruby's `pod` with an isolated
 *  GEM_HOME, so a bare `pod --version` on PATH wouldn't find it. Probe it with that env; fall back
 *  to a system `pod` on PATH otherwise. */
function detectCocoapods(): DetectResult {
  const cpEnv = cocoapodsEnv()
  if (cpEnv) {
    const sep = process.platform === 'win32' ? ';' : ':'
    const podBin = path.join(cocoapodsGemHome()!, 'bin', 'pod')
    const env = { ...process.env, GEM_HOME: cpEnv.GEM_HOME, GEM_PATH: cpEnv.GEM_PATH, PATH: `${cpEnv.binPath}${sep}${process.env.PATH ?? ''}` }
    const version = probeVersion(podBin, ['--version'], env)
    if (version !== null) return { id: 'cocoapods', present: true, command: podBin, path: podBin, version, dir: path.dirname(podBin), source: 'probe' }
  }
  return detectBinary('cocoapods', REGISTRY.cocoapods as BinaryDescriptor)
}

export function detect(id: ToolId): DetectResult {
  const d = REGISTRY[id]
  if (d.kind === 'directory') return detectDirectory(id, d)
  const cached = cache.get(id)
  if (cached) return cached
  const res = id === 'npm' ? detectNpm() : id === 'cocoapods' ? detectCocoapods() : detectBinary(id, d)
  cache.set(id, res)
  return res
}

/** Like `detect` but throws the tool's actionable install message when it's absent. */
export function resolve(id: ToolId): DetectResult & { present: true } {
  const d = detect(id)
  if (!d.present) throw new Error(REGISTRY[id].missingMsg)
  return d as DetectResult & { present: true }
}

/**
 * Return `env` with a resolved tool's DIRECTORY prepended to PATH, so a child process that spawns
 * the tool by BARE NAME finds our resolved copy. This is the fix for tools invoked indirectly:
 * @gltf-transform/cli calls `toktx` on PATH internally, so a packaged build (where toktx lives at
 * MODOKI_TOKTX, not on PATH) must inject that dir. No-op when the tool is already on PATH or absent.
 */
export function withToolOnPath(id: ToolId, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const d = detect(id)
  if (!d.dir) return env
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...env, PATH: `${d.dir}${sep}${env.PATH ?? ''}` }
}

/**
 * How to spawn a resolved binary tool: a spec so call sites stay agnostic to WHERE the tool comes
 * from. In C1 `npmSpawnSpec()` resolves system npm (bin on PATH); a later phase swaps in a
 * downloaded Node's npm-cli.js (command=<node>, prefixArgs=[npm-cli.js], env with the node dir on
 * PATH) WITHOUT touching the call sites in main.ts / vendorPlugins.ts.
 */
export interface SpawnSpec {
  /** The executable to spawn. */
  command: string
  /** Args prepended before the caller's args (e.g. [npm-cli.js] when running npm on bundled node). */
  prefixArgs: string[]
  /** Whether to spawn through a shell (npm is a `.cmd` on Windows). */
  shell: boolean
  /** Environment for the child (base process.env in C1; gains the bundled-node dir on PATH later). */
  env: NodeJS.ProcessEnv
}

/**
 * Spawn spec for `npm` — resolved via the toolchain so the source is swappable in one place.
 * Prefers a PROVISIONED Node (C2): when MODOKI_NODE + MODOKI_NPM_CLI point at a downloaded Node,
 * npm runs as `<node> npm-cli.js …` with that node's dir prepended to PATH (so npm's own child
 * `node`/gyp/lifecycle spawns resolve to it too). Otherwise falls back to system npm on PATH (C1
 * / dev). Call sites (main.ts runNpm, vendorPlugins) never change between these.
 */
export function npmSpawnSpec(): SpawnSpec {
  const nodeBin = process.env.MODOKI_NODE
  const npmCli = process.env.MODOKI_NPM_CLI
  if (nodeBin && npmCli) {
    const sep = process.platform === 'win32' ? ';' : ':'
    return {
      command: nodeBin,
      prefixArgs: [npmCli],
      shell: false,
      env: { ...process.env, PATH: `${path.dirname(nodeBin)}${sep}${process.env.PATH ?? ''}` },
    }
  }
  const d = detect('npm')
  // detect resolves a PATH npm to its absolute shim (npm.cmd on Windows) — `spawnable` decides
  // whether that needs a shell and quotes it, so a Program Files path survives the shell.
  if (d.command) {
    const { command, shell } = spawnable(d.command)
    return { command, prefixArgs: [], shell, env: process.env }
  }
  // Last resort: a bare `npm`, which on Windows needs a shell for PATHEXT to find npm.cmd.
  return { command: 'npm', prefixArgs: [], shell: process.platform === 'win32', env: process.env }
}

/** How to invoke a model CLI as `{command, prefixArgs}` — callers append the tool's own args. Prefers
 *  the RESOLVED binary (env override → userData install → PATH), so a packaged editor uses the
 *  `install()`-ed copy. In dev the devDependency isn't on PATH, so gltf-transform falls back to
 *  `npx --no-install @gltf-transform/cli` (byte-identical to the old call) and gltfpack to a bare
 *  PATH `gltfpack` (its old behavior). This is the model-tool seam: call sites resolve WHERE the CLI
 *  comes from here, not inline. */
export interface CliInvocation {
  command: string
  prefixArgs: string[]
}

export function gltfTransformInvocation(): CliInvocation {
  const d = detect('gltf-transform-cli')
  if (d.present && d.command) return { command: d.command, prefixArgs: [] }
  // `npx` is the machine's npm — a SYSTEM tool, so it's off-limits in bundled-only mode. Throwing
  // the actionable "install it from Build Support" message beats silently running a system copy.
  if (!systemFallbackAllowed('gltf-transform-cli')) throw new Error(REGISTRY['gltf-transform-cli'].missingMsg)
  return { command: 'npx', prefixArgs: ['--no-install', '@gltf-transform/cli'] }
}

export function gltfpackInvocation(): CliInvocation {
  const d = detect('gltfpack')
  if (d.present && d.command) return { command: d.command, prefixArgs: [] }
  if (!systemFallbackAllowed('gltfpack')) throw new Error(REGISTRY.gltfpack.missingMsg)
  return { command: 'gltfpack', prefixArgs: [] }
}

/** Locate `adb` — DERIVED from the Android SDK (`<sdk>/platform-tools/adb`), not a standalone
 *  tool. Returns its absolute path when the SDK (and adb within it) is present. */
export function detectAdb(): { present: boolean; path?: string } {
  const sdk = detect('android-sdk')
  if (!sdk.path) return { present: false }
  const adb = path.join(sdk.path, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
  return isFile(adb) ? { present: true, path: adb } : { present: false }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** One tool's readiness for a build target. */
export interface PreflightTool {
  id: string
  present: boolean
  /** Actionable "how to get it" message when absent. */
  message?: string
}

/** Whether a build target's REQUIRED external toolchain is present, so the build handler can fail
 *  FRIENDLY before running any step (today a missing xcodebuild/java/adb surfaces as a raw
 *  mid-stream command-not-found). npm/node are NOT checked here — they're provisioned on demand. */
export interface PreflightReport {
  target: BuildTarget
  ready: boolean
  tools: PreflightTool[]
}

export type BuildTarget = 'web' | 'android' | 'ios'

export function preflight(target: BuildTarget): PreflightReport {
  const tools: PreflightTool[] = []
  const add = (id: ToolId) => {
    const d = detect(id)
    tools.push({ id, present: d.present, message: d.present ? undefined : REGISTRY[id].missingMsg })
  }

  if (target === 'android') {
    add('java')
    add('android-sdk')
    const adb = detectAdb()
    tools.push({
      id: 'adb',
      present: adb.present,
      message: adb.present ? undefined : 'adb not found. It ships with the Android SDK platform-tools — install the Android SDK.',
    })
  } else if (target === 'ios') {
    // iOS is macOS-only. On other platforms it can't be built at all.
    if (process.platform !== 'darwin') {
      tools.push({ id: 'xcodebuild', present: false, message: 'iOS builds require macOS + Xcode — not available on this platform.' })
    } else {
      add('xcodebuild')
    }
  }
  // web: nothing native to preflight (its `npm run build` uses the provisioned/system Node).

  return { target, ready: tools.every((t) => t.present), tools }
}

/** Every registered tool id, in registry order — the canonical list the Build-Support dialog and
 *  the `/api/toolchain` status endpoint enumerate (so a new tool shows up in both automatically). */
export const TOOL_IDS = Object.keys(REGISTRY) as ToolId[]

/** Tools that `install()` can provision automatically (vs `guide()`-only, like Xcode). Grows as
 *  more installers land (gltfpack, android-sdk, java/jdk, cocoapods). */
export const INSTALLABLE: ReadonlySet<ToolId> = new Set<ToolId>(['gltf-transform-cli', 'gltfpack', 'java', 'android-sdk', 'ffmpeg', 'ffprobe'])

/** PINNED versions for the CLI/gem tools we install by name (unlike Node/JDK/Ruby, whose version is
 *  in the download URL). Pinning makes installs reproducible (dev == packaged) AND lets a pin bump
 *  in a new editor RE-INSTALL the tool: detect compares the installed version to the pin and flags a
 *  mismatch as STALE (isToolStale), so the Build-Support onboarding auto-updates it. Bump a value
 *  here to roll everyone forward on the next launch. */
export const PINNED_TOOL_VERSIONS: Partial<Record<ToolId, string>> = {
  'gltf-transform-cli': '4.4.1',
  gltfpack: '1.2.0',
  cocoapods: '1.17.0',
}

/** Whether `version` (a tool's raw `--version` output) reports the pinned release. Matching is
 *  substring-based but ANCHORED — `1.2` must not match `1.20` — and accepts the pin's trailing-zero-
 *  trimmed forms, because a tool needn't print its npm version verbatim: gltfpack@1.2.0's `-v` prints
 *  `gltfpack 1.2`. A plain `includes(pin)` therefore never matched, so gltfpack was flagged STALE
 *  forever — the dialog showed a permanent "⟳ (update)" and re-installed it on every open. */
export function versionMatchesPin(version: string, pin: string): boolean {
  const forms = [pin]
  for (let v = pin; /\.0$/.test(v); ) {
    v = v.replace(/\.0$/, '')
    forms.push(v)
  }
  return forms.some((f) => new RegExp(`(?<![\\d.])${f.replace(/\./g, '\\.')}(?![\\d.])`).test(version))
}

/** True ⇒ this tool is version-pinned AND its OUR-toolchain install is a different version than the
 *  pin — a reinstall/update is due (e.g. after an editor pin bump). Only considers the userData
 *  install (resolved path under MODOKI_TOOLCHAIN_DIR); a system/PATH tool a dev installed is left
 *  alone. */
export function isToolStale(id: ToolId, d: DetectResult): boolean {
  const pin = PINNED_TOOL_VERSIONS[id]
  if (!pin || !d.present || !d.version) return false
  const tc = process.env.MODOKI_TOOLCHAIN_DIR
  if (!tc || !d.path || !d.path.startsWith(tc)) return false // not our install → don't touch it
  return !versionMatchesPin(d.version, pin)
}

export interface GuideLink {
  label: string
  url: string
}
export interface GuideDoc {
  id: ToolId
  title: string
  steps: string[]
  links?: GuideLink[]
  /** True when `install(id)` can do it automatically; false = manual (the user must follow steps). */
  canAutoInstall: boolean
}

/** Human guidance for setting up a tool. For `guided` tools (Xcode) it's the ONLY path — they
 *  can't be auto-installed; for installable tools it's a fallback describing the install. */
export function guide(id: ToolId): GuideDoc {
  if (id === 'xcodebuild') {
    return {
      id,
      title: 'Install Xcode (required for iOS builds)',
      canAutoInstall: false,
      steps: [
        'Install Xcode from the Mac App Store (several GB — it cannot be auto-installed).',
        'Open Xcode ONCE and let it finish installing additional components (do this before installing CocoaPods — CocoaPods builds native gems against Xcode’s toolchain).',
        'Point the command-line tools at it: sudo xcode-select --switch /Applications/Xcode.app',
        'Accept the licence: sudo xcodebuild -license accept',
        'Sign in with your Apple ID under Xcode → Settings → Accounts.',
        'Set your Team in Modoki → Project Settings → iOS → Signing (a signed-in Xcode account, not just a keychain cert).',
        'Set up signing ONCE: the FIRST Build → iOS creates the native Xcode project and will FAIL on signing (no provisioning profile yet). Open the generated project (games/<id>/ios/App/App.xcodeproj) in Xcode → App target → Signing & Capabilities → tick “Automatically manage signing” + pick your Team so Xcode mints the profile, then run Build → iOS again.',
      ],
      links: [{ label: 'Xcode on the Mac App Store', url: 'https://apps.apple.com/app/xcode/id497799835' }],
    }
  }
  if (id === 'cocoapods') {
    return {
      id,
      title: 'Install CocoaPods (only for iOS mediation-adapter games)',
      canAutoInstall: isInstallable(id), // one-click on macOS — provisioned into the editor toolchain
      steps: [
        'Most iOS games are SPM-only and DO NOT need CocoaPods — you only need it to add AppLovin mediation adapters.',
        'Install Xcode AND open it once FIRST (see the Xcode step above): CocoaPods compiles native gems against Xcode’s clang, so it can’t install without Xcode present.',
        'Then use the one-click Install button above — the editor provisions its own Ruby + CocoaPods into its toolchain (no Homebrew, no system Ruby needed).',
        'CocoaPods / iOS builds are macOS-only; this tool is not available on other platforms.',
      ],
      links: [{ label: 'CocoaPods getting-started guide', url: 'https://guides.cocoapods.org/using/getting-started.html' }],
    }
  }
  return { id, title: `Set up ${id}`, canAutoInstall: isInstallable(id), steps: [REGISTRY[id].missingMsg] }
}

/** One tool's row in the `/api/toolchain` status report — everything the Build-Support dialog
 *  renders per row: detection result + whether `install()` can provision it + its setup guide. */
export interface ToolStatus {
  id: ToolId
  present: boolean
  source: ToolSource | 'missing'
  version?: string
  path?: string
  /** True ⇒ the dialog shows an Install button (drives the SSE install stream); false ⇒ a Guide link. */
  installable: boolean
  /** True ⇒ present, but our-toolchain install is a different version than the current pin — an
   *  Update is due (the dialog shows "Update" + auto-updates it). */
  stale: boolean
  guide: GuideDoc
}

/** Full toolchain status: every tool's detection + install/guide affordance, `adb` (derived from the
 *  Android SDK), and a preflight per build target. Drives the Build-Support dialog and is served
 *  verbatim by `GET /api/toolchain`. Pure over env + the filesystem — no HTTP/Electron coupling, so
 *  it runs identically in the Vite-plugin process and the Electron main backend. */
export interface ToolchainStatus {
  platform: NodeJS.Platform
  /** The userData toolchain dir installs land in, or null in a dev editor with no provisioning. */
  toolchainDir: string | null
  /** Whether SDK resolution may fall back to system installs (the "Use system SDKs" toggle).
   *  false ⇒ bundled-only (packaged default): only the editor's provisioned SDKs are used. */
  allowSystemToolchain: boolean
  tools: ToolStatus[]
  /** `adb` is not a first-class registry tool (it's derived from the SDK) — surfaced separately. */
  adb: { present: boolean; path?: string }
  preflight: Record<BuildTarget, PreflightReport>
}

export function toolchainStatus(): ToolchainStatus {
  // Always re-probe: a status read is a "current truth" request, and it's the ONLY
  // safe answer to the process split. An `install()` runs in the Vite-plugin process
  // (the SSE handler) and resets ITS cache — but the status endpoint is served by the
  // Electron main process, whose binary-detect cache still holds the pre-install
  // "missing". Without this reset the Build-Support dialog's post-install refresh would
  // keep showing the just-installed tool as absent. Status is a low-frequency call
  // (dialog open / Re-check), so re-running the `--version` probes is cheap enough.
  resetToolchainCache()
  const tools: ToolStatus[] = TOOL_IDS.map((id) => {
    const d = detect(id)
    return { id, present: d.present, source: d.source, version: d.version, path: d.path, installable: isInstallable(id), stale: isToolStale(id, d), guide: guide(id) }
  })
  return {
    platform: process.platform,
    toolchainDir: process.env.MODOKI_TOOLCHAIN_DIR ?? null,
    allowSystemToolchain: systemToolchainAllowed(),
    tools,
    adb: detectAdb(),
    preflight: { web: preflight('web'), android: preflight('android'), ios: preflight('ios') },
  }
}

export interface InstallResult {
  /** Absolute path to the installed tool. */
  path: string
}

/** Auto-install an `INSTALLABLE` tool into the userData toolchain dir, streaming progress via
 *  `onLog`. Idempotent-ish (npm install is safe to re-run). Throws for tools that aren't
 *  auto-installable (use `guide()`) or aren't implemented yet. */
/** Whether a tool can be auto-installed RIGHT NOW. Static for the userData-provisioned tools
 *  (INSTALLABLE); dynamic for CocoaPods — we provision it into the toolchain via a downloaded
 *  portable Ruby (no brew, no system Ruby), which is macOS-only (portable-ruby is arm64-mac and
 *  iOS/CocoaPods is macOS-only). So it's installable on darwin, guided elsewhere. */
export function isInstallable(id: ToolId): boolean {
  if (id === 'cocoapods') return process.platform === 'darwin'
  return INSTALLABLE.has(id)
}

/** Install CocoaPods into the editor's OWN toolchain — no Homebrew, no system Ruby. Provisions a
 *  pinned portable Ruby into <toolchainDir>/ruby, then `gem install cocoapods` into an isolated
 *  GEM_HOME (<toolchainDir>/cocoapods-gems) on that Ruby, streaming progress. `pod` then resolves
 *  from there via detect('cocoapods') + cocoapodsEnv(). Native gem extensions compile against the
 *  system clang, which ships with Xcode — already required for any iOS build. */
async function installCocoapods(opts: { toolchainDir: string; onLog?: (line: string) => void }): Promise<InstallResult> {
  const log = opts.onLog ?? (() => {})
  const { rubyBin, gemBin, binDir } = await ensureRuby(path.join(opts.toolchainDir, 'ruby'), { onLog: log })
  const gemHome = path.join(opts.toolchainDir, 'cocoapods-gems')
  const podBin = path.join(gemHome, 'bin', 'pod')
  fs.mkdirSync(gemHome, { recursive: true })
  const sep = process.platform === 'win32' ? ';' : ':'
  const env = { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemHome, PATH: `${binDir}${sep}${process.env.PATH ?? ''}` }
  const podVersionArgs = PINNED_TOOL_VERSIONS.cocoapods ? ['-v', PINNED_TOOL_VERSIONS.cocoapods] : []
  log('Installing CocoaPods (gem) into the editor toolchain — this can take a few minutes…')
  await new Promise<void>((resolve, reject) => {
    const p = spawn(rubyBin, [gemBin, 'install', 'cocoapods', ...podVersionArgs, '--no-document', '--bindir', path.join(gemHome, 'bin')], { env, shell: false })
    p.stdout?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
    p.stderr?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`gem install cocoapods exited with code ${code}`))))
    p.on('error', reject)
  })
  resetToolchainCache()
  if (!fs.existsSync(podBin)) throw new Error('Installed cocoapods but the `pod` executable is missing.')
  return { path: podBin }
}

export async function install(id: ToolId, opts: { toolchainDir: string; onLog?: (line: string) => void }): Promise<InstallResult> {
  if (id === 'gltf-transform-cli') return installNpmTool(id, '@gltf-transform/cli', 'gltf-transform', PINNED_TOOL_VERSIONS['gltf-transform-cli'], opts)
  if (id === 'gltfpack') return installNpmTool(id, 'gltfpack', 'gltfpack', PINNED_TOOL_VERSIONS.gltfpack, opts)
  // ffmpeg/ffprobe: npm packages whose PAYLOAD is the binary (no `.bin` symlink). The npm package
  // version differs from the CLI's own version (ffmpeg-static@5.3.0 ships ffmpeg 6.0), so they're
  // pinned here as the npm spec — NOT in PINNED_TOOL_VERSIONS (whose values are matched against
  // `--version` output for the stale check, which would never match).
  if (id === 'ffmpeg') return installNpmBinaryTool('ffmpeg-static', FFMPEG_NPM_VERSION, ffmpegToolBin, opts)
  if (id === 'ffprobe') return installNpmBinaryTool('@ffprobe-installer/ffprobe', FFPROBE_NPM_VERSION, ffprobeToolBin, opts)
  if (id === 'cocoapods') return installCocoapods(opts)
  if (id === 'java') {
    // Download a pinned Temurin JDK 21 into <toolchainDir>/jdk. detect('java') then finds this
    // JAVA_HOME (userData candidate). Also the bootstrap for install('android-sdk') (sdkmanager needs Java).
    const { javaHome } = await ensureJdk(path.join(opts.toolchainDir, 'jdk'), { onLog: opts.onLog })
    resetToolchainCache()
    return { path: javaHome }
  }
  if (id === 'android-sdk') {
    // Two-step: bootstrap cmdline-tools (sha1-verified), then sdkmanager the packages + licenses.
    // sdkmanager is a Java program → ensure the JDK first (the chicken-and-egg). Use the PINNED
    // Temurin 21 unconditionally (ensureJdk is idempotent — reuses the userData JDK when already
    // downloaded, else fetches once). We deliberately do NOT reuse whatever `detect('java')` finds:
    // that resolves to an arbitrary system/brew JDK whose version varies per machine (unversioned
    // brew `openjdk` can be 25, `java_home -v 21` misreports on some boxes), which is a
    // works-on-my-machine hazard — Android/AGP is JDK-21-specific (Gradle can't read newer
    // bytecode). Pinning it here keeps the SDK provisioning (and any Gradle run on this JDK)
    // reproducible dev == packaged, the same way Node is pinned.
    const sdkRoot = path.join(opts.toolchainDir, 'android-sdk')
    const { javaHome } = await ensureJdk(path.join(opts.toolchainDir, 'jdk'), { onLog: opts.onLog })
    await ensureCmdlineTools(sdkRoot, { onLog: opts.onLog })
    await runSdkmanager(sdkRoot, ANDROID_SDK_PACKAGES, { javaHome, onLog: opts.onLog })
    resetToolchainCache()
    return { path: sdkRoot }
  }
  if (!INSTALLABLE.has(id)) throw new Error(`${id} can't be auto-installed — see guide('${id}').`)
  throw new Error(`install('${id}') is not implemented yet.`)
}

/** The userData dir(s) a provisioned tool owns — removed to uninstall it. (The npm-CLI model tools
 *  share `npm-tools/`, so they're uninstalled per-package via npm, not by removing a dir — see
 *  uninstall(). `cocoapods` owns both its gems AND the portable Ruby it was installed on.) */
function toolOwnedDirs(id: ToolId, toolchainDir: string): string[] {
  switch (id) {
    case 'npm': return [path.join(toolchainDir, 'node')]
    case 'java': return [path.join(toolchainDir, 'jdk')]
    case 'android-sdk': return [path.join(toolchainDir, 'android-sdk')]
    case 'cocoapods': return [path.join(toolchainDir, 'cocoapods-gems'), path.join(toolchainDir, 'ruby')]
    default: return []
  }
}

/** Whether a tool's files can be removed from THIS toolchain (it was provisioned here). Guided tools
 *  (Xcode) and system-only tools own nothing here. */
export function isRemovable(id: ToolId): boolean {
  if (!process.env.MODOKI_TOOLCHAIN_DIR) return false
  const d = detect(id)
  if (!d.present) return false
  if (id === 'gltf-transform-cli' || id === 'gltfpack' || id === 'ffmpeg' || id === 'ffprobe') return !!d.path?.includes('npm-tools')
  if (id === 'cocoapods') return d.source === 'probe' // our provisioned pod (not a system one)
  return toolOwnedDirs(id, process.env.MODOKI_TOOLCHAIN_DIR).length > 0
}

/** Remove a directory robustly, tolerating Windows file locks. `force+recursive` clears read-only
 *  files but NOT OPEN HANDLES: a lingering Gradle build daemon (a `java.exe` running from the
 *  provisioned JDK) keeps the dir locked, so a naive rmSync bails half-way → a "half-deleted" tool
 *  the user can't clean up. On Windows we first best-effort kill any process whose executable lives
 *  UNDER `dir` (scoped to the path — our own provisioned binaries, never the user's other apps),
 *  then rmSync WITH retries (Node retries EBUSY/EPERM/ENOTEMPTY on Windows). A persistent lock gets
 *  an actionable error instead of a silent partial delete. No-op on POSIX (no exec, plain retries). */
function forceRemoveDir(dir: string): void {
  if (!fs.existsSync(dir)) return
  if (process.platform === 'win32') {
    try {
      const esc = dir.replace(/'/g, "''")
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${esc}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' })
    } catch { /* best-effort: no PowerShell / nothing to kill */ }
  }
  try {
    // Generous retry budget (≈8s): on Windows a just-written dir is often briefly locked by
    // Defender/indexing, so a short window spuriously trips the "still in use" error below.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 400 })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
      throw new Error(
        `Could not fully remove ${dir} — some files are still in use (a Gradle build daemon may be ` +
        `running). Close any running build and try again; if it persists, quit the editor (or restart ` +
        `the machine) and retry.`)
    }
    throw e
  }
}

/** Remove a provisioned tool from the toolchain. The npm-CLI model tools are `npm uninstall`'d
 *  (they share npm-tools/, so we can't just delete a dir); everything else has its owned dir(s)
 *  removed. Idempotent — a no-op when nothing is installed. */
export async function uninstall(id: ToolId, opts: { toolchainDir: string; onLog?: (line: string) => void }): Promise<void> {
  const log = opts.onLog ?? (() => {})
  const NPM_TOOL_PKGS: Partial<Record<ToolId, string>> = {
    'gltf-transform-cli': '@gltf-transform/cli', gltfpack: 'gltfpack',
    ffmpeg: 'ffmpeg-static', ffprobe: '@ffprobe-installer/ffprobe',
  }
  if (NPM_TOOL_PKGS[id]) {
    const pkg = NPM_TOOL_PKGS[id]!
    const dir = npmToolsDir(opts.toolchainDir)
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const spec = npmSpawnSpec()
      log(`Removing ${pkg}…`)
      await new Promise<void>((resolve) => {
        const p = spawn(spec.command, [...spec.prefixArgs, 'uninstall', pkg, '--no-audit', '--no-fund'], { cwd: dir, shell: spec.shell, env: spec.env })
        p.stdout?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
        p.stderr?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
        p.on('close', () => resolve())
        p.on('error', () => resolve()) // best-effort removal
      })
    }
    resetToolchainCache()
    return
  }
  for (const dir of toolOwnedDirs(id, opts.toolchainDir)) {
    log(`Removing ${dir}…`)
    forceRemoveDir(dir)
  }
  resetToolchainCache()
}

/** Remove the ENTIRE toolchain folder — a hard reset. Everything (including settings.json) is wiped;
 *  Node re-provisions eagerly on next launch, the rest via Build Support. Guarded to only ever delete
 *  a dir literally named `toolchain` (the userData toolchain root), never an arbitrary path. */
export function uninstallAll(toolchainDir: string): void {
  if (path.basename(toolchainDir) !== 'toolchain') {
    throw new Error(`refusing to delete ${toolchainDir} — not a 'toolchain' dir`)
  }
  forceRemoveDir(toolchainDir)
  resetToolchainCache()
}

/** Ensure the shared userData `npm-tools` package exists, and `npm install <specPkg>` into it. Runs
 *  npm via `npmSpawnSpec` so it uses the provisioned Node (no system npm). */
async function npmToolsInstall(toolchainDir: string, specPkg: string, log: (line: string) => void): Promise<string> {
  const dir = npmToolsDir(toolchainDir)
  fs.mkdirSync(dir, { recursive: true })
  const pkgJson = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'modoki-toolchain-tools', private: true, version: '0.0.0' }, null, 2) + '\n')
  }
  const spec = npmSpawnSpec()
  log(`Installing ${specPkg}…`)
  await new Promise<void>((resolve, reject) => {
    const p = spawn(spec.command, [...spec.prefixArgs, 'install', specPkg, '--no-audit', '--no-fund'], { cwd: dir, shell: spec.shell, env: spec.env })
    p.stdout?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
    p.stderr?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install ${specPkg} exited with code ${code}`))))
    p.on('error', reject)
  })
  return dir
}

/**
 * Install an npm-CLI tool into the shared `npm-tools` package, then PROVE it runs — and self-heal if
 * it doesn't.
 *
 * An interrupted install leaves a half-written tree (seen in the wild: `@gltf-transform/core` present
 * but with no package.json, so the CLI died with ERR_MODULE_NOT_FOUND). The old check was
 * `existsSync(bin)` — the `.bin` shim IS there, so the install "succeeded" while `detect()` reported
 * the tool missing. Clicking Install again was a no-op, because npm saw the dependency already
 * satisfied: an unbreakable "not found" loop. So we verify with the same `--version` probe detect
 * uses, and on failure wipe `node_modules` + the lockfile and install once more from scratch.
 */
async function installNpmTool(
  id: ToolId, pkg: string, binName: string, version: string | undefined,
  opts: { toolchainDir: string; onLog?: (line: string) => void },
): Promise<InstallResult> {
  const specPkg = version ? `${pkg}@${version}` : pkg
  const log = opts.onLog ?? (() => {})
  const bin = npmToolBin(opts.toolchainDir, binName)
  const runs = () => {
    resetToolchainCache()
    return fs.existsSync(bin) && detect(id).present
  }

  const dir = await npmToolsInstall(opts.toolchainDir, specPkg, log)
  if (runs()) return { path: bin }

  log(`${pkg} installed but does not run — its dependency tree looks damaged. Reinstalling from scratch…`)
  forceRemoveDir(path.join(dir, 'node_modules'))
  try { fs.rmSync(path.join(dir, 'package-lock.json'), { force: true }) } catch { /* best-effort */ }
  await npmToolsInstall(opts.toolchainDir, specPkg, log)
  if (!runs()) {
    throw new Error(
      `Installed ${specPkg} but it still doesn't run (expected ${bin}). Try "Remove all tools" in ` +
      `Build Support to reset the toolchain, then install again.`)
  }
  return { path: bin }
}

/** npm spec versions for ffmpeg/ffprobe (the package version, distinct from the CLI's own version —
 *  see install()). Kept as consts (not PINNED_TOOL_VERSIONS) so the stale-check never mis-fires. */
const FFMPEG_NPM_VERSION = '5.3.0'
const FFPROBE_NPM_VERSION = '2.1.2'

/** Like installNpmTool, but for npm packages whose executable is the package PAYLOAD (no `.bin/<name>`
 *  symlink) — ffmpeg-static, @ffprobe-installer. `resolveBin(toolchainDir)` returns the in-package
 *  binary path. Marks it executable (npm may not preserve the +x bit through the tarball). */
async function installNpmBinaryTool(
  pkg: string, version: string, resolveBin: (toolchainDir: string) => string,
  opts: { toolchainDir: string; onLog?: (line: string) => void },
): Promise<InstallResult> {
  const log = opts.onLog ?? (() => {})
  const specPkg = `${pkg}@${version}`
  const dir = await npmToolsInstall(opts.toolchainDir, specPkg, log)
  let bin = resolveBin(opts.toolchainDir)
  if (!fs.existsSync(bin)) {
    // Same self-heal as installNpmTool: a half-written tree can leave the payload binary absent even
    // though npm exited 0. Wipe and reinstall once before giving up.
    log(`${pkg} installed but its executable is missing — reinstalling from scratch…`)
    forceRemoveDir(path.join(dir, 'node_modules'))
    try { fs.rmSync(path.join(dir, 'package-lock.json'), { force: true }) } catch { /* best-effort */ }
    await npmToolsInstall(opts.toolchainDir, specPkg, log)
    bin = resolveBin(opts.toolchainDir)
    if (!fs.existsSync(bin)) throw new Error(`Installed ${pkg} but its executable is missing at ${bin}.`)
  }
  try { fs.chmodSync(bin, 0o755) } catch { /* best-effort */ }
  resetToolchainCache() // it's now detectable
  return { path: bin }
}

/** Forget cached detection — for tests, or after a provisioning install changes availability. */
export function resetToolchainCache(): void {
  cache.clear()
  javaVersionCache.clear()
}

// On-demand Node provisioning (C2): download a pinned Node so the packaged editor needs no user npm.
export { ensureNode, extractArchive, nodeDistFor, PINNED_NODE, nodeDistKey, type ProvisionedNode, type NodeDist, type FetchLike } from './nodeProvision'
// On-demand JDK provisioning (E-3): download a pinned Temurin JDK 21 for Android builds (+ sdkmanager).
export { ensureJdk, discoverJavaHome, javaBinName, jdkVersionDir, PINNED_JDK, jdkDistKey, type ProvisionedJdk } from './jdkProvision'
// On-demand portable-Ruby provisioning: the brew-free CocoaPods path (gem-installs CocoaPods on it).
export { ensureRuby, rubyDistKey, rubyDirFor, PINNED_RUBY, type ProvisionedRuby } from './rubyProvision'
// On-demand Android SDK provisioning (E-3): cmdline-tools bootstrap + sdkmanager packages/licenses.
export {
  ensureCmdlineTools, runSdkmanager, sdkmanagerPath, cmdlineToolsKey,
  PINNED_CMDLINE_TOOLS, ANDROID_SDK_PACKAGES, type ProvisionedAndroidSdk,
} from './androidSdkProvision'
