/**
 * Pinned provisioning for the two NATIVE asset-conversion CLIs — `toktx` (KTX2 textures and
 * atlases) and `msdf-atlas-gen` (MTSDF font atlases) (#1327).
 *
 * ## Why pinned
 *
 * A texture/atlas/font conversion is cached under (source + settings + an in-repo encoder tag), and
 * that key never names the binary that converted. So the binary has to be the same on every
 * machine, or one hash covers different shipped bytes — the #1297 mechanism, fixed there for
 * ffmpeg/ffprobe. Neither of these tools is on npm, so unlike ffmpeg they are pinned here as
 * release assets with a hand-maintained sha256, the same way `goIosProvision.ts` pins go-ios.
 *
 * ## Where each artifact comes from
 *
 * - `toktx`: KhronosGroup's own releases. macOS ships only as a `.pkg`, which is UNPACKED
 *   (`pkgutil --expand-full`, no sudo, no system install) and just `toktx` + `ktx` + `libktx` are
 *   kept — both CLIs carry an `@executable_path` rpath, so the sibling dylib resolves as-is. Windows
 *   ships only as an NSIS installer, which 7-Zip can unpack (the release workflow does the same).
 *   `ktx` is kept because @gltf-transform/cli 4.4 encodes KTX2 with `ktx`, not `toktx`, found on
 *   PATH beside the pinned `toktx` — without it the rigged-model path used whatever `ktx` the
 *   machine had, or none (#1351).
 * - `msdf-atlas-gen`: upstream publishes Windows zips only. The macOS binary is OURS — built once,
 *   statically linked and WITH Skia (as upstream builds Windows), by
 *   `engine/scripts/build-msdf-atlas-gen-macos.sh` and published as the
 *   `toolchain-msdf-atlas-gen-<label>` prerelease on the public modoki-engine repo (a prerelease, so
 *   the editor's auto-updater, which follows `/releases/latest`, never sees it).
 *
 * The pin is per PLATFORM, not across platforms — a Windows and a macOS build are different
 * binaries, exactly as with ffmpeg-static.
 *
 * ## Versioned install dir
 *
 * Each tool lands in `<toolchainDir>/<id>/<version>/`. A pin bump therefore points detection at a
 * directory that does not exist yet, so the old copy simply stops being found and a reinstall is
 * due — no `--version` string matching needed (these CLIs print `v4.4.2` / `v1.4.0`, neither of
 * which is the pin's spelling everywhere).
 *
 * Pure Node (no Electron APIs — the target dir is injected), usable from Electron main, the Vite
 * plugin, `npm run toolchain:install`, or a test with a mocked fetch.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { extractArchive, type FetchLike } from './nodeProvision'

export type ConversionCliId = 'toktx' | 'msdf-atlas-gen'

/** How a pinned asset is unpacked. */
export type PinnedAssetKind = 'macos-pkg' | 'nsis-exe' | 'tar.gz' | 'zip'

export interface PinnedCliAsset {
  url: string
  /** sha256 of the downloaded asset. A stale hash is a hard install failure, never a silent
   *  wrong version — re-hash (`shasum -a 256 <asset>`) whenever `version` is bumped. */
  sha256: string
  kind: PinnedAssetKind
  /** Files to keep, as `[path inside the unpacked asset, file name in the install dir]`. The first
   *  entry is the executable. */
  files: Array<[from: string, to: string]>
}

export interface PinnedCli {
  /** The upstream release version (what the tool's own banner prints). */
  version: string
  /** A label for OUR build choices when they are part of the pin — e.g. `skia` — so that changing
   *  them moves the install dir exactly as a version bump does (every machine reinstalls). */
  build?: string
  /** Keyed by `<platform>-<arch>` (`darwin-arm64`, `win32-x64`). A missing key means no pinned
   *  build exists for that host, so the tool is not installable there. */
  dist: Record<string, PinnedCliAsset>
}

const KTX = 'https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2'
const ktxPkgFiles = (arch: string): PinnedCliAsset['files'] => [
  [`KTX-Software-4.4.2-Darwin-${arch}-tools.pkg/Payload/usr/local/bin/toktx`, 'toktx'],
  [`KTX-Software-4.4.2-Darwin-${arch}-tools.pkg/Payload/usr/local/bin/ktx`, 'ktx'],
  // The real file, not the `libktx.4.dylib` symlink next to it — the install dir keeps no links.
  [`KTX-Software-4.4.2-Darwin-${arch}-library.pkg/Payload/usr/local/lib/libktx.4.4.2.dylib`, 'libktx.4.dylib'],
]

/** ⚠️ `oss/.github/workflows/release-windows.yml` downloads the same win32-x64 assets with its own
 *  copy of these hashes (a CI runner stages before any of this code can run). `conversionToolPin
 *  .test.ts` holds the two copies equal. */
export const CONVERSION_CLI_PINS: Record<ConversionCliId, PinnedCli> = {
  toktx: {
    version: '4.4.2',
    dist: {
      'darwin-arm64': {
        url: `${KTX}/KTX-Software-4.4.2-Darwin-arm64.pkg`,
        sha256: '500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c',
        kind: 'macos-pkg',
        files: ktxPkgFiles('arm64'),
      },
      'darwin-x64': {
        url: `${KTX}/KTX-Software-4.4.2-Darwin-x86_64.pkg`,
        sha256: 'efecc685ab891a6e119a9fdc8cbe038e135f9a367eb2f5d8a059553f947f1fea',
        kind: 'macos-pkg',
        files: ktxPkgFiles('x86_64'),
      },
      'win32-x64': {
        url: `${KTX}/KTX-Software-4.4.2-Windows-x64.exe`,
        sha256: '1f323b0fec19794f5e6c0425a61d4b1da396872a10be862d105f4f4b2d2957fe',
        kind: 'nsis-exe',
        files: [['bin/toktx.exe', 'toktx.exe'], ['bin/ktx.exe', 'ktx.exe'], ['bin/ktx.dll', 'ktx.dll']],
      },
    },
  },
  'msdf-atlas-gen': {
    version: '1.4',
    // Both builds have Skia geometry preprocessing (owner, 2026-09-17): upstream's Windows zip always
    // did; ours did not until this label, and a font with overlapping contours then baked by a
    // different algorithm per platform.
    build: 'skia',
    dist: {
      'darwin-arm64': {
        url: 'https://github.com/lsgmasa33/modoki-engine/releases/download/toolchain-msdf-atlas-gen-1.4-skia/msdf-atlas-gen-1.4-skia-macos-arm64.tar.gz',
        sha256: '1e941151f1d57dfb59b4f4adc262b60022f1e28c386de8d656d007b1ae75d0ea',
        kind: 'tar.gz',
        files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
      },
      'win32-x64': {
        url: 'https://github.com/Chlumsky/msdf-atlas-gen/releases/download/v1.4/msdf-atlas-gen-1.4-win64.zip',
        sha256: '55ab2bef57b9c7bf305b610989fa8eeda812d85bc93e632b8c39ce05b6e64e9d',
        kind: 'zip',
        files: [['msdf-atlas-gen/msdf-atlas-gen.exe', 'msdf-atlas-gen.exe']],
      },
    },
  },
}

/** The pinned asset for this host, or undefined when none exists. */
export function conversionCliDist(
  id: ConversionCliId, platform: NodeJS.Platform = process.platform, arch: string = process.arch,
): PinnedCliAsset | undefined {
  return CONVERSION_CLI_PINS[id].dist[`${platform}-${arch}`]
}

/** `<toolchainDir>/<id>/<pinLabel>` — where the pinned copy lives. */
export function conversionCliDir(toolchainDir: string, id: ConversionCliId): string {
  return path.join(toolchainDir, id, pinLabel(id))
}

/** `<version>` or `<version>-<build>` — the install dir name, and how logs name the pin. */
export function pinLabel(id: ConversionCliId): string {
  const { version, build } = CONVERSION_CLI_PINS[id]
  return build ? `${version}-${build}` : version
}

/** Absolute path to the pinned executable under `toolchainDir`. Platform-injectable so any
 *  target's path is testable from any host. */
export function conversionCliBin(toolchainDir: string, id: ConversionCliId, platform: NodeJS.Platform = process.platform): string {
  return path.join(conversionCliDir(toolchainDir, id), platform === 'win32' ? `${id}.exe` : id)
}

/** The first kept file missing from the pinned install under `toolchainDir`, or undefined when all
 *  are there (or this host has no pin). A dir installed before a file joined the pin (`ktx`, #1351)
 *  has a working executable and is still incomplete — `ensureConversionCli` reinstalls it, and
 *  `isToolStale` reports it so Build Support offers the repair. */
export function missingConversionCliFile(
  toolchainDir: string, id: ConversionCliId, platform: NodeJS.Platform = process.platform, arch: string = process.arch,
): string | undefined {
  const asset = conversionCliDist(id, platform, arch)
  const dir = conversionCliDir(toolchainDir, id)
  return asset?.files.map(([, to]) => to).find((f) => !fs.existsSync(path.join(dir, f)))
}

/** The flag each CLI answers with its version and exit 0 — what `detect()` probes too. */
const VERSION_ARG: Record<ConversionCliId, string> = { toktx: '--version', 'msdf-atlas-gen': '-version' }

/** Whether an installed executable actually RUNS. Presence is not enough: a copy that cannot start
 *  (a missing runtime DLL, a truncated file) reads as "not provisioned" to `detect()`, so an install
 *  that returned early on the file's mere existence could never repair it. Injectable for tests. */
export type RunProbe = (bin: string, versionArg: string) => boolean
const defaultRunProbe: RunProbe = (bin, versionArg) => ranOk(spawnSync(bin, [versionArg], { stdio: 'ignore' }))

/** Spawn errors that mean "this FILE cannot be executed", on either OS: a missing file, no exec
 *  permission, not an executable (`ENOEXEC` on POSIX, `EFTYPE` — ERROR_BAD_EXE_FORMAT — on Windows
 *  for a truncated or non-PE `.exe`), a directory. A missing DLL is not here: the process starts
 *  and exits non-zero. */
const CANNOT_EXECUTE = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EFTYPE', 'EPERM', 'EISDIR'])

/** The probe's verdict on one spawn result. Exported for tests.
 *  Only a DEFINITE failure counts as broken; a transient spawn failure (EAGAIN/EMFILE/ENOMEM on a
 *  loaded machine) must not delete a working install every sibling editor is using, so it throws. */
export function ranOk(r: { error?: Error; status: number | null }): boolean {
  if (!r.error) return r.status === 0
  if (CANNOT_EXECUTE.has((r.error as NodeJS.ErrnoException).code ?? '')) return false
  throw r.error
}

/** Unpacks an asset into `destDir` (which does not exist yet). Injectable for tests. */
export type AssetExpander = (kind: PinnedAssetKind, archive: string, destDir: string) => Promise<void>

/** 7-Zip, for the NSIS installer: PATH (`7z`/`7zz`), then the standard Windows install. */
function find7z(): string | null {
  const names = ['7z', '7zz']
  for (const n of names) {
    const r = spawnSync(n, ['i'], { stdio: 'ignore' })
    if (!r.error) return n
  }
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432]) {
    if (!base) continue
    const p = path.join(base, '7-Zip', '7z.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Whether this host can unpack `kind` without anything the toolchain does not provision. */
export function canExpand(kind: PinnedAssetKind): boolean {
  return kind !== 'nsis-exe' || find7z() !== null
}

const defaultExpander: AssetExpander = async (kind, archive, destDir) => {
  if (kind === 'tar.gz' || kind === 'zip') {
    fs.mkdirSync(destDir, { recursive: true })
    await extractArchive(archive, destDir, kind)
    return
  }
  if (kind === 'macos-pkg') {
    // --expand-full refuses an existing destination, and needs no privileges (it never installs).
    const r = spawnSync('pkgutil', ['--expand-full', archive, destDir], { encoding: 'utf8' })
    if (r.error || r.status !== 0) throw new Error(`pkgutil --expand-full failed: ${r.error?.message ?? r.stderr}`)
    return
  }
  const sevenZip = find7z()
  if (!sevenZip) {
    throw new Error(
      'Unpacking the KTX-Software Windows installer needs 7-Zip, and none was found (7z on PATH, or ' +
      '%ProgramFiles%\\7-Zip). Install it from https://www.7-zip.org/ (or `winget install 7zip.7zip`) and retry.')
  }
  const r = spawnSync(sevenZip, ['x', '-y', archive, `-o${destDir}`], { encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new Error(`7-Zip could not unpack ${path.basename(archive)}: ${r.error?.message ?? r.stdout}`)
}

/** Move a dir out of the way atomically, then delete it. A rename never leaves a half-deleted
 *  tool at the live path — which an in-place recursive delete does while another process reads it. */
function discard(dir: string, stillWanted: () => boolean = () => true): boolean {
  if (!fs.existsSync(dir)) return true
  if (!stillWanted()) return false
  const aside = `${dir}.discard-${process.pid}-${Date.now()}`
  try { fs.renameSync(dir, aside) } catch { return !fs.existsSync(dir) } // gone already = fine; held = not
  fs.rmSync(aside, { recursive: true, force: true })
  return true
}

/**
 * Ensure the pinned `id` is present AND RUNS under `toolchainDir`, downloading + verifying +
 * unpacking it if not. Returns the absolute executable path. Throws when this host has no pinned
 * build, on a checksum mismatch (never installs unverified bytes), when the asset's layout is not
 * what the pin says, or when the installed copy still does not run. Idempotent: a present copy
 * costs one `--version` spawn. A failed download or unpack leaves nothing at the final path; a
 * copy that installs but will not run stays in place (it is the pinned bytes), and the error says so.
 */
export async function ensureConversionCli(
  id: ConversionCliId,
  toolchainDir: string,
  opts: {
    fetchImpl?: FetchLike; onLog?: (line: string) => void; expand?: AssetExpander; probe?: RunProbe
    platform?: NodeJS.Platform; arch?: string
  } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const label = pinLabel(id)
  const asset = conversionCliDist(id, platform, arch)
  if (!asset) {
    throw new Error(
      `No pinned ${id} ${label} build exists for ${platform}-${arch} (#1327). ` +
      `Set ${id === 'toktx' ? 'MODOKI_TOKTX' : 'MODOKI_MSDF_ATLAS_GEN'} to a binary to use one deliberately.`)
  }
  const log = opts.onLog ?? (() => {})
  const dir = conversionCliDir(toolchainDir, id)
  const bin = conversionCliBin(toolchainDir, id, platform)
  const runs = () => (opts.probe ?? defaultRunProbe)(bin, VERSION_ARG[id])
  // Every file the pin keeps, not just the executable (see missingConversionCliFile).
  const missingFile = () => missingConversionCliFile(toolchainDir, id, platform, arch)
  const healthy = () => !missingFile() && runs()
  if (fs.existsSync(bin)) {
    if (healthy()) return bin
    const missing = missingFile()
    log(missing
      ? `${id} ${label} under ${dir} has no ${missing} — reinstalling it.`
      : `${id} ${label} under ${dir} does not run — reinstalling it.`)
    // A copy that RUNS but lacks a file is still what every sibling clone converts with, so it stays
    // in place through the download and is swapped out only once the new one is staged (below).
    // Re-checked at the moment of the move: a sibling may have repaired it since the probe above,
    // and its good copy must not be the one moved aside.
    if (!(missing && runs()) && !discard(dir, () => !healthy())) {
      if (healthy()) return bin
      throw new Error(
        `${id} ${label} under ${dir} ${missing ? `is missing ${missing}` : 'does not run'} and could not be moved ` +
        'aside to replace it (is it in use, or held by antivirus?). Close what uses it and retry.')
    }
  }

  log(`Downloading ${id} ${label}…`)
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(asset.url)
  if (!res.ok) throw new Error(`${id} download failed: ${asset.url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== asset.sha256) {
    throw new Error(`${id} checksum mismatch for ${path.basename(asset.url)}: expected ${asset.sha256}, got ${got} — refusing to install.`)
  }

  const parent = path.dirname(dir)
  fs.mkdirSync(parent, { recursive: true })
  const work = fs.mkdtempSync(path.join(parent, `.${label}-`))
  try {
    const archive = path.join(work, path.basename(asset.url))
    fs.writeFileSync(archive, buf)
    const unpacked = path.join(work, 'unpacked')
    await (opts.expand ?? defaultExpander)(asset.kind, archive, unpacked)
    // Assemble in a staging dir, then rename into place: the final dir exists only when complete.
    const staged = path.join(work, 'staged')
    fs.mkdirSync(staged)
    for (const [from, to] of asset.files) {
      const src = path.join(unpacked, from)
      if (!fs.existsSync(src)) throw new Error(`${id} ${label}: the asset has no ${from} — its layout changed; update the pin.`)
      fs.copyFileSync(src, path.join(staged, to)) // follows symlinks → real bytes
      try { fs.chmodSync(path.join(staged, to), 0o755) } catch { /* best-effort; Windows ignores it */ }
    }
    // The toolchain dir is machine-wide and several editors (one per clone) install into it, so
    // another process can finish the same install while this one downloads. Rename FIRST — it
    // fails when a dir is already there — and a complete dir there is the winner's (same pinned
    // bytes): keep it. Only a dir missing a kept file is debris (or a pre-#1351 install), and it is moved aside
    // atomically before the retry, so no path ever deletes a dir in place that someone may use.
    try {
      fs.renameSync(staged, dir)
    } catch (e) {
      if (missingFile()) {
        discard(dir, () => !!missingFile())
        try { fs.renameSync(staged, dir) } catch (e2) { if (missingFile()) throw e2 }
      } else if (!['ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) {
        throw e
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  const stillMissing = missingFile()
  if (stillMissing) throw new Error(`${id} install incomplete — expected ${path.join(dir, stillMissing)}`)
  if (!runs()) {
    throw new Error(
      `${id} ${label} installed under ${dir} but does not run` +
      (platform === 'win32' && id === 'toktx'
        ? ' — the Windows toktx needs the Microsoft Visual C++ Redistributable (x64).'
        : '.'))
  }
  log(`${id} ${label} → ${dir}`)
  return bin
}
