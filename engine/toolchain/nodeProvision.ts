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
import { createRequire } from 'node:module'

/** `tar`/`yauzl` are pulled in through **`createRequire`, at call time** — not a static import, and
 *  deliberately NOT `await import()` either. Both alternatives are broken here, in opposite ways:
 *
 *  - **Static `import tar from 'tar'`** kills `engine/scripts/vendor-plugins.mjs`, which is
 *    esbuild-bundled into a standalone .mjs and run from a TEMP dir with node_modules external. It
 *    reaches this module via the toolchain barrel and never extracts anything, but a module-scope
 *    import still has to resolve → ERR_MODULE_NOT_FOUND. Caught by vendorPluginsIntegration.test.ts.
 *  - **`await import('tar')`** dies in the PACKAGED editor with `Vite module runner has been
 *    closed`. The toolchain runs under Vite's module runner, and a dynamic import is re-entered
 *    through that runner at call time — fine during startup (which is why Node provisioning
 *    succeeded), fatal for anything provisioned LATER from the Build Support dialog. Measured
 *    2026-08-02 on the installed Windows editor: `Extracting…` → `FAILED:Vite module runner has
 *    been closed`, JDK never installed.
 *
 *  `createRequire` resolves through NODE's resolver, so it is invisible to both: no build-time
 *  resolution for esbuild to fail on, and no module-runner round trip at runtime. Both packages
 *  publish a CJS entry (`tar` is dual ESM/CJS via exports, `yauzl` is CJS), so `require` is a
 *  supported path, not a hack.
 *
 *  ⚠️ Called LAZILY, and it must resolve its referrer at call time. This module runs in TWO
 *  contexts and `import.meta.url` is only real in one of them — the same split
 *  `engine/plugins/native-dynamic-import.ts` documents at length:
 *    1. the Vite dev-server child (`--configLoader runner`) — `import.meta.url` is a real file URL;
 *    2. the esbuild-bundled Electron main (`main.cjs`) — esbuild emits `var import_meta = {}`, so
 *       `import.meta.url` is **undefined**, and `createRequire(undefined)` THROWS
 *       `ERR_INVALID_ARG_VALUE`. At module scope that would crash main on load — strictly worse
 *       than the bug this replaces. `__filename` is the correct referrer there.
 *
 *  Related but deliberately NOT reused: `nativeDynamicImport()` in
 *  engine/plugins/native-dynamic-import.ts solves the same runner-closed problem for packages that
 *  need a genuine ESM `import()` (sharp, three). `tar`/`yauzl` both publish CJS entries, so plain
 *  `require` is simpler (synchronous, no `new Function`, no Vitest carve-out) — and `engine/toolchain/`
 *  does not otherwise import from `engine/plugins/`, a boundary not worth breaching for this. */
function loadDep<T>(specifier: string): T {
  const metaUrl: string | undefined = import.meta.url
  const referrer = metaUrl || (typeof __filename !== 'undefined' ? __filename : undefined)
  if (!referrer) throw new Error(`cannot resolve ${specifier}: no module referrer in this context`)
  return createRequire(referrer)(specifier) as T
}

/** Pinned Node — 24 LTS ("Krypton"), matching the repo's CI (`setup-node` 24), `@types/node`, and
 *  the dev toolchain so dev == packaged. sha256 values are from nodejs.org
 *  `dist/<version>/SHASUMS256.txt`, keyed by `<process.platform>-<process.arch>`. arm64-mac +
 *  win-x64 today (mac editor is arm64-only per electron-builder.yml; win editor targets x64); add
 *  entries as other targets ship.
 *
 *  WHY 24 and not 22: 22 entered MAINTENANCE on 2025-10-21 and goes EOL 2027-04-30, so the shipped
 *  editor was provisioning a security-fixes-only runtime while dev machines ran Active LTS. 24 is
 *  Active LTS until 2026-10-20 and supported to 2028-04-30. Keep this in lockstep with
 *  `@types/node` and the `node-version` in all three workflows — a types major above the runtime
 *  typechecks clean and then fails at RUNTIME in the packaged editor, which nothing else catches.
 *  Bumping the version means fetching new sha256s; a wrong hash fails the download, not silently. */
export const PINNED_NODE = {
  version: 'v24.18.1',
  sha256: {
    'darwin-arm64': 'eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941',
    'win32-x64': 'ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765',
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
  /** The dir the archive extracts to under baseDir, e.g. node-v24.18.1-win-x64. */
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

/** Extract a `.tar.gz` or `.zip` into `destDir`. Shared by the Node/JDK/Android/Ruby provisioners —
 *  the four things the editor DOWNLOADS rather than bundles (JDK 336M, Android SDK 527M, …).
 *
 *  ⚠️ **No subprocess. Never shell out to `tar` here.** This used to be `execFileSync('tar', …)`,
 *  which made the extractor the single OS dependency in the whole provisioning chain — and it was
 *  broken on Windows in two independent ways, silently, for an unknown length of time:
 *    1. GNU tar reads an archive argument containing a colon as a remote `host:path`, so any
 *       absolute Windows path died with `Cannot connect to E: resolve failed` — every drive letter.
 *    2. GNU tar cannot read a `.zip` at all (`This does not look like a tar archive`). The one-code-
 *       path design silently assumed **bsdtar**, the only implementation reading both formats.
 *  Windows ships bsdtar at `System32\tar.exe`, but Git for Windows ships GNU tar at `/usr/bin/tar`,
 *  so which binary answered was decided by **PATH order**. Where Git won, the packaged editor
 *  provisioned NOTHING and fell back to a system npm that the no-toolchain user it targets does not
 *  have. It never reproduced on macOS, and `smoke:packaged` reported PASS throughout, because
 *  `ensureNodeProvisioned()` catches the failure and degrades. Measured 2026-08-02.
 *
 *  Extracting in-process removes that class entirely: identical behaviour on every machine, nothing
 *  to shadow, and no native binary to sign/notarize/patch. `tar` and `yauzl` are the same libraries
 *  npm itself uses to unpack packages. This is NOT a violation of the "bundle nothing downloadable"
 *  principle — the unpacker is the one thing that cannot be downloaded-and-unpacked, so it ships as
 *  ~100KB of ordinary app code instead of a borrowed system binary.
 *
 *  Async because zip entries must be streamed to preserve their Unix mode bits (see below), and
 *  every caller already sits in an `async` provisioner. */
export async function extractArchive(archivePath: string, destDir: string, kind: 'tar.gz' | 'zip'): Promise<void> {
  if (kind === 'tar.gz') {
    // node-tar preserves modes AND symlinks — both load-bearing: the macOS Node tarball symlinks
    // `bin/npm` into `lib/node_modules/npm`, and every `bin/*` needs its exec bit.
    const tar = loadDep<typeof import('tar')>('tar')
    await tar.x({ file: archivePath, cwd: destDir })
    return
  }
  await extractZip(archivePath, destDir)
}

/** Zip extraction with Unix mode preservation.
 *
 *  The mode bits are NOT decoration: Google's `cmdline-tools` zip is what the Android SDK is
 *  bootstrapped from on macOS too, and `sdkmanager` is a shell script that must stay executable.
 *  A naive `unzipSync`-style extractor that only writes bytes loses that and fails later, far from
 *  the cause. yauzl exposes `externalFileAttributes`, whose high 16 bits carry the Unix mode for
 *  zips written on a Unix host; when it is absent (a DOS-written zip) fall back to the default.
 *  Windows ignores the mode either way, so this costs nothing there. */
function extractZip(archivePath: string, destDir: string): Promise<void> {
  const yauzl = loadDep<typeof import('yauzl')>('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`could not open ${archivePath}`))
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry) => {
        // Reject path traversal before touching the filesystem — an entry may say `../../etc`.
        const out = path.join(destDir, entry.fileName)
        const rel = path.relative(destDir, out)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return reject(new Error(`zip entry escapes destination: ${entry.fileName}`))
        }
        if (entry.fileName.endsWith('/')) {           // directory entry
          fs.mkdirSync(out, { recursive: true })
          return zip.readEntry()
        }
        zip.openReadStream(entry, (rsErr, rs) => {
          if (rsErr || !rs) return reject(rsErr ?? new Error(`could not read ${entry.fileName}`))
          fs.mkdirSync(path.dirname(out), { recursive: true })
          const ws = fs.createWriteStream(out)
          ws.on('error', reject)
          ws.on('close', () => {
            const mode = (entry.externalFileAttributes >>> 16) & 0o7777
            if (mode && process.platform !== 'win32') {
              try { fs.chmodSync(out, mode) } catch { /* best-effort; a lost bit beats a failed unpack */ }
            }
            zip.readEntry()
          })
          rs.pipe(ws)
        })
      })
      zip.readEntry()
    })
  })
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
    await extractArchive(tmpArchive, baseDir, dist.archiveKind)
  } finally {
    fs.rmSync(tmpArchive, { force: true })
  }
  if (!fs.existsSync(nodeBin) || !fs.existsSync(npmCli)) {
    throw new Error(`Node extract incomplete — expected ${nodeBin} and ${npmCli}`)
  }
  return { nodeBin, npmCli, dir: extractDir }
}
