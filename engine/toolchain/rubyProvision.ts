/**
 * On-demand Ruby provisioning — the "bundle nothing downloadable / don't depend on system tools"
 * principle applied to CocoaPods. CocoaPods is a Ruby gem, and macOS ships an ancient system Ruby
 * (2.6) that modern CocoaPods (needs 3.0+) can't use. Rather than depend on Homebrew or the system
 * Ruby, we download a PINNED, relocatable portable Ruby (the same prebuilt bottle Homebrew itself
 * uses to bootstrap) into a userData dir, verify its sha256, and extract it. `install('cocoapods')`
 * then `gem install`s CocoaPods into an ISOLATED GEM_HOME on this Ruby, so `pod` is fully
 * self-contained in the editor's toolchain — no brew, no system Ruby. (Native gem extensions still
 * compile against the system clang, which ships with Xcode — already required for any iOS build.)
 *
 * Pure Node (no Electron APIs — the target dir is injected), so it's usable from Electron main,
 * headless CI, or a test with a mocked fetch. macOS/arm64 only: the mac editor is arm64-only and
 * CocoaPods/iOS is macOS-only, so no other target is meaningful.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractArchive, type FetchLike } from './nodeProvision'

/** Pinned portable Ruby — a Homebrew portable-ruby bottle (relocatable; runs standalone from any
 *  extracted dir). arm64-mac only. sha256 from the GitHub release asset. */
export const PINNED_RUBY = {
  version: '3.4.5',
  dist: {
    'darwin-arm64': {
      asset: 'arm64_big_sur',
      sha256: '20fa657858e44a4b39171d6e4111f8a9716eb62a78ebbd1491d94f90bb7b830a',
    },
  } as Record<string, { asset: string; sha256: string }>,
}

export interface ProvisionedRuby {
  /** Absolute path to the ruby binary. */
  rubyBin: string
  /** Absolute path to the gem binary. */
  gemBin: string
  /** The bin/ dir holding ruby + gem — prepend to PATH so gems' shebangs resolve this ruby. */
  binDir: string
  /** The extracted `<base>/portable-ruby/<version>` dir. */
  dir: string
}

/** `<platform>-<arch>` pin-map key (e.g. `darwin-arm64`). */
export function rubyDistKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/** The extracted portable-ruby dir under baseDir (the bottle's top dir is `portable-ruby/<version>`). */
export function rubyDirFor(baseDir: string): string {
  return path.join(baseDir, 'portable-ruby', PINNED_RUBY.version)
}

/**
 * Ensure the pinned portable Ruby is present under `baseDir`, downloading + verifying + extracting
 * it if not. Returns absolute paths to ruby/gem. Throws on an unsupported platform, a checksum
 * mismatch (never installs unverified bytes), or a download/extract failure. Idempotent (a second
 * call with Ruby present is a cheap stat). `platform`/`arch` default to the running process.
 */
export async function ensureRuby(
  baseDir: string,
  opts: { fetchImpl?: FetchLike; onLog?: (line: string) => void; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<ProvisionedRuby> {
  const key = rubyDistKey(opts.platform, opts.arch)
  const d = PINNED_RUBY.dist[key]
  if (!d) throw new Error(`No pinned portable Ruby for ${key} — CocoaPods provisioning is arm64-mac only.`)
  const log = opts.onLog ?? (() => {})

  const dir = rubyDirFor(baseDir)
  const binDir = path.join(dir, 'bin')
  const rubyBin = path.join(binDir, 'ruby')
  const gemBin = path.join(binDir, 'gem')
  if (fs.existsSync(rubyBin) && fs.existsSync(gemBin)) return { rubyBin, gemBin, binDir, dir }

  fs.mkdirSync(baseDir, { recursive: true })
  const url = `https://github.com/Homebrew/homebrew-portable-ruby/releases/download/${PINNED_RUBY.version}/portable-ruby-${PINNED_RUBY.version}.${d.asset}.bottle.tar.gz`
  log(`Downloading portable Ruby ${PINNED_RUBY.version}…`)
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(url)
  if (!res.ok) throw new Error(`Ruby download failed: ${url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== d.sha256) throw new Error(`Ruby checksum mismatch for portable-ruby ${PINNED_RUBY.version}: expected ${d.sha256}, got ${got} — refusing to install.`)

  const tmp = path.join(baseDir, `.portable-ruby-${PINNED_RUBY.version}.download`)
  fs.writeFileSync(tmp, buf)
  try {
    extractArchive(tmp, baseDir, 'tar.gz')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  if (!fs.existsSync(rubyBin) || !fs.existsSync(gemBin)) throw new Error(`Ruby extract incomplete — expected ${rubyBin}`)
  return { rubyBin, gemBin, binDir, dir }
}
