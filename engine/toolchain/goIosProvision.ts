/**
 * On-demand go-ios provisioning — the tool that removes the ⌘R handoff from an iOS ≤16 deploy.
 *
 * `xcrun devicectl` is CoreDevice-only (iOS 17+) and **cannot see an older device at all**, so
 * `Build → iOS Device` targeting e.g. an iPhone 8 built the app and then stopped: it opened the
 * Xcode project and a human pressed Run. go-ios (MIT, github.com/danielpaulus/go-ios) talks to a
 * device over usbmuxd directly and installs + launches on 12–16 with no tunnel, no sudo, and no
 * Homebrew — which turns that last step back into something the build can do itself.
 *
 * ## Why the GitHub release zip and not the npm package
 *
 * go-ios also publishes to npm, which would have reused `installNpmBinaryTool` (the ffmpeg/ffprobe
 * path) and inherited registry integrity for free. It ships EVERY platform's binary in one tarball:
 * 60 MB down, 159 MB on disk, four fifths of it binaries this machine can never run. The release
 * zip is a single **universal** (x86_64 + arm64) Mach-O — 16.8 MB down, 45 MB on disk — so it is
 * pinned + sha256-verified here instead, exactly like the portable Ruby in `rubyProvision.ts`. The
 * cost of that choice is a hash we maintain by hand on every bump; `PINNED_GO_IOS` is the one place
 * to change.
 *
 * macOS-only, and not because go-ios is: it builds for Linux and Windows too. Modoki's iOS builds
 * are macOS-only (they need xcodebuild to compile and sign — go-ios replaces the INSTALL, never the
 * signing), so a provisioned go-ios anywhere else could not be used for anything.
 *
 * Pure Node (no Electron APIs — the target dir is injected), so it's usable from Electron main, the
 * Vite plugin, headless CI, or a test with a mocked fetch. Same contract as its siblings.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractArchive, type FetchLike } from './nodeProvision'

/** The pinned go-ios release. `asset` is the GitHub release asset name; `sha256` is that asset's
 *  digest — re-hash it when bumping `version` (`shasum -a 256 go-ios-mac.zip`), because a stale hash
 *  is a hard install failure rather than a silent wrong version, which is the point. */
export const PINNED_GO_IOS = {
  version: '1.3.2',
  dist: {
    darwin: {
      asset: 'go-ios-mac.zip',
      sha256: '100f225bfdd039081bcbdaf45029df3e67032673f3e0ca1fa3c050898c230c57',
    },
  } as Record<string, { asset: string; sha256: string }>,
}

export interface ProvisionedGoIos {
  /** Absolute path to the `ios` binary. */
  bin: string
  /** The `<base>/<version>` dir it was extracted into. */
  dir: string
}

/** VERSION-scoped install root — `<baseDir>/<version>`. A pin bump lands in a fresh dir and
 *  re-downloads instead of reusing the old binary (same reasoning as `jdkVersionDir`). */
export function goIosDirFor(baseDir: string, version: string = PINNED_GO_IOS.version): string {
  return path.join(baseDir, version)
}

/** Absolute path to the provisioned `ios` binary under `baseDir`. Pure + platform-injectable so any
 *  target's path is testable from any host — the same shape as `ffmpegToolBin`. */
export function goIosBinFor(baseDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(goIosDirFor(baseDir), platform === 'win32' ? 'ios.exe' : 'ios')
}

/**
 * Ensure the pinned go-ios is present under `baseDir`, downloading + verifying + extracting it if
 * not. Returns the absolute binary path. Throws on an unsupported platform, a checksum mismatch
 * (never installs unverified bytes), or a download/extract failure. Idempotent — a second call with
 * the binary present is a cheap stat.
 */
export async function ensureGoIos(
  baseDir: string,
  opts: { fetchImpl?: FetchLike; onLog?: (line: string) => void; platform?: NodeJS.Platform } = {},
): Promise<ProvisionedGoIos> {
  const platform = opts.platform ?? process.platform
  const d = PINNED_GO_IOS.dist[platform]
  if (!d) throw new Error(`No pinned go-ios for ${platform} — iOS device deploy is macOS-only.`)
  const log = opts.onLog ?? (() => {})

  const dir = goIosDirFor(baseDir)
  const bin = goIosBinFor(baseDir, platform)
  if (fs.existsSync(bin)) return { bin, dir }

  fs.mkdirSync(dir, { recursive: true })
  const url = `https://github.com/danielpaulus/go-ios/releases/download/v${PINNED_GO_IOS.version}/${d.asset}`
  log(`Downloading go-ios ${PINNED_GO_IOS.version}…`)
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(url)
  if (!res.ok) throw new Error(`go-ios download failed: ${url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== d.sha256) {
    throw new Error(
      `go-ios checksum mismatch for ${d.asset} ${PINNED_GO_IOS.version}: expected ${d.sha256}, got ${got} — refusing to install.`)
  }

  const tmp = path.join(baseDir, `.go-ios-${PINNED_GO_IOS.version}.download`)
  fs.writeFileSync(tmp, buf)
  try {
    await extractArchive(tmp, dir, 'zip')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  if (!fs.existsSync(bin)) throw new Error(`go-ios extract incomplete — expected ${bin}`)
  // The release zip is written on a Unix host so yauzl restores the exec bit, but a re-packed or
  // DOS-written asset would not — and a non-executable binary fails at SPAWN time, one layer away
  // from anything that could explain it. Cheap insurance.
  try { fs.chmodSync(bin, 0o755) } catch { /* best-effort */ }
  return { bin, dir }
}
