/**
 * On-demand JDK provisioning (Phase E-3) — the "bundle nothing downloadable" principle applied to
 * the Java 21 JDK that Android/Gradle builds require. Downloads a PINNED Eclipse Temurin (Adoptium)
 * JDK 21 into a userData dir on first use, verifies it against the release's sha256, and extracts it.
 * `detect('java')` then finds this JAVA_HOME (a userData candidate in the registry), so the packaged
 * editor can build Android with zero user-installed Java. Idempotent: a second call with the JDK
 * already present is a cheap directory scan.
 *
 * The JDK is ALSO the bootstrap for `install('android-sdk')` — `sdkmanager` is a Java program, so a
 * JDK must exist before the Android SDK can be provisioned (chicken-and-egg noted in the plan).
 *
 * Pure Node (no Electron APIs — the target dir is injected), like nodeProvision.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractArchive, type FetchLike } from './nodeProvision'

/** Pinned Temurin JDK 21 (LTS) — matches the repo's Android/AGP requirement (JDK 21 specifically;
 *  Gradle can't read newer bytecode) and the versioned `brew openjdk@21` dev candidate. sha256 +
 *  URL come from the Adoptium assets API (`/v3/assets/latest/21/hotspot?os=…&architecture=…`).
 *  arm64-mac (`.tar.gz`) + win-x64 (`.zip`) today (matches the arm64-mac / x64-win editor targets);
 *  add entries as targets ship. Same Temurin version across platforms so dev == packaged. */
export const PINNED_JDK = {
  version: '21.0.11+10',
  dist: {
    'darwin-arm64': {
      url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.11_10.tar.gz',
      sha256: '6ebcf221c9b41507b14c098e93c6ead6440b8d9bd154f8ec666c4c73abbdb201',
      archiveKind: 'tar.gz',
    },
    'win32-x64': {
      url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_x64_windows_hotspot_21.0.11_10.zip',
      sha256: 'd3625e7cadf23787ea540229544b6e2ab494b3b54da1801879e583e1dfee0a64',
      archiveKind: 'zip',
    },
  } as Record<string, { url: string; sha256: string; archiveKind: 'tar.gz' | 'zip' }>,
}

export interface ProvisionedJdk {
  /** Absolute JAVA_HOME (the dir with `bin/java`) — what detect('java') resolves + JAVA_HOME points at. */
  javaHome: string
}

/** `<platform>-<arch>` in the dist map's key form (e.g. `darwin-arm64`). */
export function jdkDistKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/** The VERSION-scoped install dir under `<toolchainDir>/jdk` — e.g. `<jdk>/21.0.11+10`. Keying the
 *  install (and detect) on this means a pin BUMP lands in a fresh dir and downloads the new JDK,
 *  instead of `discoverJavaHome`'s old "reuse ANY jdk-* here" behaviour silently keeping the old one
 *  (mirrors Node/Ruby's version-in-path idempotency). Same-pin editor updates reuse it (no download). */
export function jdkVersionDir(baseDir: string): string {
  return path.join(baseDir, PINNED_JDK.version)
}

/** The `java` launcher's basename for a platform (`java.exe` on Windows). */
export function javaBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'java.exe' : 'java'
}

/**
 * Find a JAVA_HOME (a dir containing `bin/<java launcher>`) at most one level under `root`, handling
 * BOTH the Windows/Linux layout (`<release>/bin/java[.exe]`) and the macOS bundle layout
 * (`<release>/Contents/Home/bin/java`). Layout-robust so we don't hardcode the release-dir name into
 * a path. `platform` selects the launcher name (`java.exe` vs `java`) so a Windows layout is
 * discoverable from any host. Returns null when nothing is found (JDK not provisioned yet).
 */
export function discoverJavaHome(root: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!fs.existsSync(root)) return null
  let entries: string[]
  try { entries = fs.readdirSync(root) } catch { return null }
  const bin = javaBinName(platform)
  for (const entry of entries) {
    const rel = path.join(root, entry)
    for (const home of [rel, path.join(rel, 'Contents', 'Home')]) {
      if (fs.existsSync(path.join(home, 'bin', bin))) return home
    }
  }
  return null
}

/**
 * Ensure the pinned Temurin JDK is present under `baseDir`, downloading + verifying + extracting it
 * if not. Returns the JAVA_HOME. Throws on an unsupported platform, a checksum mismatch (never
 * installs unverified bytes), or a download/extract failure.
 */
export async function ensureJdk(baseDir: string, opts: { fetchImpl?: FetchLike; onLog?: (line: string) => void; platform?: NodeJS.Platform; arch?: string } = {}): Promise<ProvisionedJdk> {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const key = jdkDistKey(platform, arch)
  const dist = PINNED_JDK.dist[key]
  if (!dist) throw new Error(`No pinned JDK for ${key} — this platform/arch isn't supported yet (arm64-mac + win-x64).`)
  const log = opts.onLog ?? (() => {})

  // Version-scoped: reuse ONLY a JDK provisioned for the CURRENTLY pinned version. A pin bump →
  // fresh version dir → download the new JDK (the old version dir is simply left orphaned).
  const versionDir = jdkVersionDir(baseDir)
  const existing = discoverJavaHome(versionDir, platform)
  if (existing) return { javaHome: existing }

  fs.mkdirSync(baseDir, { recursive: true })
  // Download + verify BEFORE creating the version dir, so a checksum failure leaves nothing behind
  // (only a dotfile temp, which is cleaned) — never an empty version dir masquerading as installed.
  const tmpArchive = path.join(baseDir, `.jdk-${PINNED_JDK.version.replace(/\W+/g, '_')}.${dist.archiveKind}.download`)

  log(`Downloading Temurin JDK ${PINNED_JDK.version}…`)
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(dist.url)
  if (!res.ok) throw new Error(`JDK download failed: ${dist.url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  log('Verifying checksum…')
  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== dist.sha256) throw new Error(`JDK checksum mismatch: expected ${dist.sha256}, got ${got} — refusing to install.`)

  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(tmpArchive, buf)
  try {
    log('Extracting…')
    extractArchive(tmpArchive, versionDir, dist.archiveKind)
  } finally {
    fs.rmSync(tmpArchive, { force: true })
  }
  const javaHome = discoverJavaHome(versionDir, platform)
  if (!javaHome) throw new Error(`JDK extract incomplete — no bin/${javaBinName(platform)} found under ${versionDir}`)
  return { javaHome }
}
