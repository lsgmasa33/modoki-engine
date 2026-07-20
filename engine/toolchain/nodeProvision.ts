/**
 * On-demand Node provisioning (Phase C2) — the "bundle nothing downloadable" governing principle
 * applied to Node itself. Electron's own Node bootstraps this module; it downloads a PINNED Node
 * from nodejs.org into a userData dir on first use, verifies it against the published sha256, and
 * extracts it. `npmSpawnSpec()` then runs npm on this Node, so the packaged editor never needs a
 * user-installed npm. Idempotent: a second call with the Node already present is a cheap stat.
 *
 * Pure Node (no Electron APIs — the target dir is injected), so it's usable from Electron main,
 * headless CI, or a test with a mocked fetch. Platform-parametric (arm64-mac + win-x64) so the
 * Windows layout is unit-testable from any host.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** Pinned Node — 22 LTS, matching the repo's CI (`setup-node` 22) and dev toolchain so dev ==
 *  packaged. sha256 values are from nodejs.org `dist/<version>/SHASUMS256.txt`, keyed by
 *  `<process.platform>-<process.arch>`. arm64-mac + win-x64 today (mac editor is arm64-only per
 *  electron-builder.yml; win editor targets x64); add entries as other targets ship. */
export const PINNED_NODE = {
  version: 'v22.23.1',
  sha256: {
    'darwin-arm64': 'ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953',
    'win32-x64': '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29',
  } as Record<string, string>,
}

export interface ProvisionedNode {
  /** Absolute path to the node binary (node | node.exe). */
  nodeBin: string
  /** Absolute path to npm-cli.js (npm ships inside the Node dist). */
  npmCli: string
  /** The extracted Node dir. */
  dir: string
}

/** A minimal fetch shape so tests can inject a fake without a real download. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

/** `<platform>-<arch>` in the pin-map key form (e.g. `darwin-arm64`, `win32-x64`). */
export function nodeDistKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/** The platform-specific Node dist descriptor — everything that differs between the macOS `.tar.gz`
 *  (`bin/node`, `lib/node_modules/npm`) and the Windows `.zip` (`node.exe` at root, `node_modules/npm`)
 *  layouts. Pure, so any platform's paths are testable from any host. */
export interface NodeDist {
  key: string
  archiveName: string
  archiveKind: 'tar.gz' | 'zip'
  /** The dir the archive extracts to under baseDir, e.g. node-v22.23.1-win-x64. */
  extractName: string
  /** node binary relative to the extract dir. */
  nodeBinRel: string
  /** npm-cli.js relative to the extract dir (its location differs on Windows). */
  npmCliRel: string
  url: string
  sha256: string | undefined
}

export function nodeDistFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NodeDist {
  const key = `${platform}-${arch}`
  const win = platform === 'win32'
  // Node's own dist naming: win / darwin / linux (not win32).
  const nodePlat = win ? 'win' : platform === 'darwin' ? 'darwin' : 'linux'
  const extractName = `node-${PINNED_NODE.version}-${nodePlat}-${arch}`
  const archiveKind: 'tar.gz' | 'zip' = win ? 'zip' : 'tar.gz'
  return {
    key,
    archiveName: `${extractName}.${archiveKind}`,
    archiveKind,
    extractName,
    nodeBinRel: win ? 'node.exe' : path.join('bin', 'node'),
    npmCliRel: win
      ? path.join('node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    url: `https://nodejs.org/dist/${PINNED_NODE.version}/${extractName}.${archiveKind}`,
    sha256: PINNED_NODE.sha256[key],
  }
}

/** Extract a `.tar.gz` or `.zip` into `destDir` using system `tar` — bsdtar handles BOTH formats and
 *  ships on macOS/Linux and Windows 10 1803+, so one code path covers every target (no `unzip`
 *  dependency). Shared by the Node/JDK/Android provisioners. */
export function extractArchive(archivePath: string, destDir: string, kind: 'tar.gz' | 'zip'): void {
  const args = kind === 'zip' ? ['-xf', archivePath, '-C', destDir] : ['-xzf', archivePath, '-C', destDir]
  execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Ensure the pinned Node is present under `baseDir`, downloading + verifying + extracting it if not.
 * Returns absolute paths to the node binary and npm-cli.js. Throws on an unsupported platform, a
 * checksum mismatch (never installs unverified bytes), or a download/extract failure. `platform`/
 * `arch` default to the running process; override them to unit-test another target's layout.
 */
export async function ensureNode(
  baseDir: string,
  opts: { fetchImpl?: FetchLike; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<ProvisionedNode> {
  const dist = nodeDistFor(opts.platform, opts.arch)
  if (!dist.sha256) throw new Error(`No pinned Node for ${dist.key} — this platform/arch isn't supported yet (arm64-mac + win-x64).`)

  const extractDir = path.join(baseDir, dist.extractName)
  const nodeBin = path.join(extractDir, dist.nodeBinRel)
  const npmCli = path.join(extractDir, dist.npmCliRel)
  if (fs.existsSync(nodeBin) && fs.existsSync(npmCli)) return { nodeBin, npmCli, dir: extractDir }

  fs.mkdirSync(baseDir, { recursive: true })
  const tmpArchive = path.join(baseDir, `.${dist.archiveName}.download`)

  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await doFetch(dist.url)
  if (!res.ok) throw new Error(`Node download failed: ${dist.url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== dist.sha256) throw new Error(`Node checksum mismatch for ${dist.archiveName}: expected ${dist.sha256}, got ${got} — refusing to install.`)

  fs.writeFileSync(tmpArchive, buf)
  try {
    extractArchive(tmpArchive, baseDir, dist.archiveKind)
  } finally {
    fs.rmSync(tmpArchive, { force: true })
  }
  if (!fs.existsSync(nodeBin) || !fs.existsSync(npmCli)) {
    throw new Error(`Node extract incomplete — expected ${nodeBin} and ${npmCli}`)
  }
  return { nodeBin, npmCli, dir: extractDir }
}
