/**
 * On-demand Android SDK provisioning (Phase E-3) — the "bundle nothing downloadable" principle
 * applied to the Android SDK that Gradle builds require. Two steps, both scriptable:
 *
 *   1. Bootstrap: download the PINNED `cmdline-tools;latest` zip (sha1-verified against Google's
 *      repository2-3.xml manifest) into `<sdkRoot>/cmdline-tools/latest` — that gives us `sdkmanager`.
 *   2. Provision: run `sdkmanager` (a JAVA program — needs the Temurin JDK from jdkProvision, the
 *      chicken-and-egg the plan flags) to install platform-tools + the platform/build-tools the
 *      games need, then accept licenses non-interactively.
 *
 * detect('android-sdk') then finds `<sdkRoot>` (a userData candidate in the registry, marker
 * `platform-tools`), so a packaged editor can build Android with zero user-installed SDK. The
 * sdkmanager step needs first-run network (Google's package repo); the cmdline-tools bootstrap is
 * the only piece WE checksum — sdkmanager verifies everything it downloads itself.
 *
 * Pure Node (no Electron APIs — dirs injected), like nodeProvision.ts / jdkProvision.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { extractArchive, type FetchLike } from './nodeProvision'

/** Pinned `cmdline-tools;latest` — each host's zip is a universal Java bundle (not arch-specific). url
 *  + sha1 come from Google's `repository2-3.xml` (`<remotePackage path="cmdline-tools;latest">`, one
 *  `<archive>` per host-os). Bump by re-reading that manifest. mac + win today (matches the
 *  arm64-mac / x64-win editor targets). */
export const PINNED_CMDLINE_TOOLS = {
  version: '15641748',
  dist: {
    mac: {
      url: 'https://dl.google.com/android/repository/commandlinetools-mac-15641748_latest.zip',
      sha1: 'b62a5d8cf63ded173b47be867be4ee058ceda6df',
    },
    win: {
      url: 'https://dl.google.com/android/repository/commandlinetools-win-15641748_latest.zip',
      sha1: '2bea1388b8a248040a340a08ca0638138633f687',
    },
  } as Record<string, { url: string; sha1: string }>,
}

/** The SDK packages Modoki games build against — compileSdk/targetSdk 36, minSdk 24 (from every
 *  game's `android/variables.gradle`). Keep in sync with that gradle config. */
export const ANDROID_SDK_PACKAGES = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0']

/** Google's cmdline-tools host key from the Node platform. */
export function cmdlineToolsKey(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
}

export interface ProvisionedAndroidSdk {
  /** ANDROID_HOME / --sdk_root — the dir detect('android-sdk') resolves (marker: platform-tools). */
  sdkRoot: string
  /** Absolute path to the sdkmanager launcher. */
  sdkmanager: string
}

/** Absolute path to sdkmanager under a provisioned SDK's `cmdline-tools/latest`. */
export function sdkmanagerPath(sdkRoot: string, platform: NodeJS.Platform = process.platform): string {
  const bin = platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'
  return path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', bin)
}

/**
 * Bootstrap `cmdline-tools/latest` under `sdkRoot`: download the pinned zip, verify its sha1 (never
 * install unverified bytes), and place it at the sdkmanager-required `cmdline-tools/latest/` layout.
 * Idempotent — returns immediately when sdkmanager already exists. Uses system `unzip` (present on
 * macOS/Linux). Exported so tests can drive it with a mocked fetch.
 */
export async function ensureCmdlineTools(sdkRoot: string, opts: { fetchImpl?: FetchLike; onLog?: (line: string) => void; platform?: NodeJS.Platform } = {}): Promise<string> {
  const platform = opts.platform ?? process.platform
  const key = cmdlineToolsKey(platform)
  const dist = PINNED_CMDLINE_TOOLS.dist[key]
  if (!dist) throw new Error(`No pinned Android cmdline-tools for ${key} — unsupported platform (mac + win).`)
  const log = opts.onLog ?? (() => {})
  const sdkmanager = sdkmanagerPath(sdkRoot, platform)
  if (fs.existsSync(sdkmanager)) return sdkmanager

  fs.mkdirSync(sdkRoot, { recursive: true })
  const tmpZip = path.join(sdkRoot, `.cmdline-tools-${PINNED_CMDLINE_TOOLS.version}.zip.download`)
  const stage = path.join(sdkRoot, `.cmdline-tools-stage-${PINNED_CMDLINE_TOOLS.version}`)

  log(`Downloading Android command-line tools ${PINNED_CMDLINE_TOOLS.version}…`)
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(dist.url)
  if (!res.ok) throw new Error(`cmdline-tools download failed: ${dist.url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  log('Verifying checksum…')
  const got = crypto.createHash('sha1').update(buf).digest('hex')
  if (got !== dist.sha1) throw new Error(`cmdline-tools checksum mismatch: expected ${dist.sha1}, got ${got} — refusing to install.`)

  fs.writeFileSync(tmpZip, buf)
  try {
    log('Extracting…')
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    // The zip contains a top-level `cmdline-tools/` dir; sdkmanager wants it at
    // `<sdkRoot>/cmdline-tools/latest/`. Extract to a stage, then move that dir into place.
    // `extractArchive` uses system `tar` (bsdtar), which unzips on macOS/Linux/Windows alike.
    extractArchive(tmpZip, stage, 'zip')
    const extracted = path.join(stage, 'cmdline-tools')
    if (!fs.existsSync(extracted)) throw new Error('cmdline-tools zip layout unexpected — no cmdline-tools/ dir')
    const destParent = path.join(sdkRoot, 'cmdline-tools')
    fs.mkdirSync(destParent, { recursive: true })
    const latest = path.join(destParent, 'latest')
    fs.rmSync(latest, { recursive: true, force: true })
    fs.renameSync(extracted, latest)
  } finally {
    fs.rmSync(tmpZip, { force: true })
    fs.rmSync(stage, { recursive: true, force: true })
  }
  if (!fs.existsSync(sdkmanager)) throw new Error(`cmdline-tools extract incomplete — no sdkmanager at ${sdkmanager}`)
  return sdkmanager
}

/**
 * Run `sdkmanager` to install `packages` into `sdkRoot`, accepting all licenses non-interactively.
 * `javaHome` must point at a JDK (sdkmanager is a Java program). Streams sdkmanager output via
 * `onLog`. Throws on a non-zero exit.
 */
export async function runSdkmanager(sdkRoot: string, packages: string[], opts: { javaHome: string; onLog?: (line: string) => void }): Promise<void> {
  const sdkmanager = sdkmanagerPath(sdkRoot)
  if (!fs.existsSync(sdkmanager)) throw new Error(`sdkmanager not found at ${sdkmanager} — bootstrap cmdline-tools first.`)
  const log = opts.onLog ?? (() => {})
  const env = { ...process.env, JAVA_HOME: opts.javaHome, PATH: `${path.join(opts.javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` }

  // Accept licenses first (idempotent). sdkmanager --licenses prompts y/N repeatedly; feed 'y'.
  log('Accepting Android SDK licenses…')
  await spawnAnswering(sdkmanager, [`--sdk_root=${sdkRoot}`, '--licenses'], env, log)

  log(`Installing ${packages.join(', ')}…`)
  await spawnAnswering(sdkmanager, [`--sdk_root=${sdkRoot}`, ...packages], env, log)
}

/** Spawn a process, streaming stdout/stderr to `log`, feeding 'y\n' to every prompt (license /
 *  install confirmations) and resolving on exit 0. Rejects on non-zero exit or spawn error. */
function spawnAnswering(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // sdkmanager is `sdkmanager.bat` on Windows — spawning a .bat without a shell throws
    // `spawn EINVAL` since Node ≥18.20 (CVE-2024-27980). Route it through the shell there.
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const p = spawn(shell ? `"${cmd}"` : cmd, args, { env, shell })
    const feed = () => { try { p.stdin.write('y\n') } catch { /* stream closed */ } }
    // sdkmanager prompts on stdout; answer each prompt, and prime a few up front for the
    // license batch (it asks once per unaccepted license before printing anything parseable).
    for (let i = 0; i < 200; i++) feed()
    p.stdout?.on('data', (d: Buffer) => { const s = d.toString(); log(s.trimEnd()); if (/\?|\(y\/N\)|Accept/i.test(s)) feed() })
    p.stderr?.on('data', (d: Buffer) => log(d.toString().trimEnd()))
    p.on('close', (code) => {
      try { p.stdin.end() } catch { /* already closed */ }
      if (code === 0) resolve()
      else reject(new Error(`sdkmanager exited with code ${code}`))
    })
    p.on('error', reject)
  })
}
