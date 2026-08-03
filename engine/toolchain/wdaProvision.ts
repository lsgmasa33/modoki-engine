/**
 * On-demand WebDriverAgent provisioning (#32 Phase 2) — the Build Support item that makes TRUSTED
 * iOS input possible. WDA is Appium's XCUITest agent; running it on a device is what lets
 * `device_tap`/`drag`/`press_key`/`hover`/`scroll` deliver real `isTrusted` input on iOS instead of
 * the synthetic DOM events the bridge falls back to (see docs/trusted-device-input.md).
 *
 * This module ONLY builds and signs it. Actually running `xcodebuild test-without-building` against
 * a device is a per-lease, per-device lifecycle (plan Decisions 1-2: lazy auto-launch, torn down
 * with the lease) and lives in the device-lease code, NOT here. Every other toolchain item conflates
 * "provisioned" with "usable"; WDA genuinely has two lifecycles and keeping them apart is the point.
 *
 * ## Why this one breaks the toolchain's governing principle, deliberately
 *
 * Every other provisioned item downloads a PINNED artifact and verifies it against a checksum, so
 * `dev == packaged` byte for byte. WDA cannot: it must be compiled and code-signed on the user's
 * machine with their Apple team, so two developers' builds are never identical and there is no hash
 * to pin. What IS pinned is the SOURCE — a fixed `appium-webdriveragent` npm version, fetched
 * through npm's own registry integrity, the same way ffmpeg/gltfpack are pinned by npm version
 * rather than by a sha we maintain. That is the strongest reproducibility available here, and the
 * gap is called out rather than papered over.
 *
 * ## Signed PER MACHINE, not per project
 *
 * WDA is a separate app from the game under test and only needs *a* valid signing identity to
 * install on the phone — it does NOT have to share the game's team. So one build under the
 * toolchain dir serves every project, `install()` keeps the same signature every other installer
 * has (no project context threaded through the toolchain contract), and switching projects never
 * triggers a rebuild. This AMENDS plan Decision 3 ("signed with the project's own
 * `build.appleTeamId`"), which was recorded before that consequence was weighed — the team is now
 * a machine-level toolchain setting seeded from the project's team on first install.
 *
 * ## "Present" is not enough — a signed build EXPIRES
 *
 * A provisioning profile has a hard expiry (a year on a paid team, a week on a free one). An expired
 * WDA is present on disk and simply fails to install on the device, so a plain existence check would
 * report it healthy while iOS input silently fell back to synthetic — the exact class of lie this
 * whole phase exists to remove. `wdaBuildStatus` therefore reads the embedded profile's
 * `ExpirationDate` and reports it, which no other toolchain item needs.
 *
 * Pure Node (no Electron APIs, no import from ./index — the target dir, the npm spec and the command
 * runner are all injected), like nodeProvision.ts and jdkProvision.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractArchive } from './nodeProvision'

/** The pinned WebDriverAgent source. Appium publishes WDA to npm as `appium-webdriveragent`, so the
 *  source is version-pinned and registry-integrity-checked without us maintaining a sha — the same
 *  pattern install('ffmpeg')/install('gltfpack') already use. Bumping this lands in a fresh version
 *  dir (see `wdaVersionDir`) and rebuilds, rather than silently reusing the old build. */
export const PINNED_WDA = {
  version: '16.1.1',
  npmPackage: 'appium-webdriveragent',
}

/** WDA ships its targets under `com.facebook.*` bundle ids, which no other team can sign — a build
 *  fails with a provisioning error until they are re-namespaced. Every target must keep a DISTINCT
 *  id, so this is a source rewrite rather than an `xcodebuild PRODUCT_BUNDLE_IDENTIFIER=` override
 *  (one CLI value would collapse all targets onto the same id). The signing TEAM is passed on the
 *  command line instead, precisely so the extracted source stays team-agnostic. */
export const WDA_BUNDLE_ID_FROM = 'com.facebook.'
export const WDA_BUNDLE_ID_TO = 'com.modokiengine.'

/** The Xcode scheme that produces the runner + its `.xctestrun`. */
export const WDA_SCHEME = 'WebDriverAgentRunner'

/** Warn this far ahead of expiry. A profile that dies mid-session turns every iOS input op into a
 *  silent synthetic fallback, and a rebuild needs Xcode + the device, so surfacing it while it still
 *  works is worth more than an exact-day answer. */
export const WDA_EXPIRY_WARN_DAYS = 14

/** Runs a command to completion, streaming output. Injected so the npm fetch and the xcodebuild are
 *  both drivable in tests without a network or an Xcode. Resolves on exit 0, rejects otherwise. */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; onLog?: (line: string) => void },
) => Promise<void>

/** How to invoke npm (mirrors index.ts's SpawnSpec without importing it — index imports THIS module,
 *  so the dependency has to point one way). */
export interface NpmInvocation {
  command: string
  prefixArgs: string[]
  shell: boolean
  env: NodeJS.ProcessEnv
}

/** VERSION-scoped install root — `<baseDir>/<version>`. A pin bump lands in a fresh dir and
 *  rebuilds, instead of reusing a build of the old source (same reasoning as `jdkVersionDir`). */
export function wdaVersionDir(baseDir: string): string {
  return path.join(baseDir, PINNED_WDA.version)
}

/** Where the extracted npm tarball's `package/` contents live (the Xcode project root). */
export function wdaSourceDir(baseDir: string): string {
  return path.join(wdaVersionDir(baseDir), 'src')
}

/** DerivedData for our build. Kept inside the toolchain dir rather than the user's shared
 *  `~/Library/Developer/Xcode/DerivedData` so "Remove all tools" actually removes it, and so a user
 *  cleaning DerivedData does not silently un-provision the editor. */
export function wdaDerivedDataDir(baseDir: string): string {
  return path.join(wdaVersionDir(baseDir), 'build')
}

/** The `.xctestrun` xcodebuild emits for a `build-for-testing`, which is what the later
 *  `test-without-building` launch consumes. Its name embeds the SDK version
 *  (`WebDriverAgentRunner_iphoneos26.5-arm64.xctestrun`), so it is discovered, not constructed. */
export function findXctestrun(derivedDataDir: string): string | null {
  const productsDir = path.join(derivedDataDir, 'Build', 'Products')
  let entries: string[]
  try { entries = fs.readdirSync(productsDir) } catch { return null }
  const hit = entries.filter((e) => e.endsWith('.xctestrun')).sort()[0]
  return hit ? path.join(productsDir, hit) : null
}

/** The built runner app bundle (`WebDriverAgentRunner-Runner.app`), which carries the embedded
 *  provisioning profile the expiry check reads. Searched rather than hardcoded because the
 *  configuration dir is SDK-dependent (`Debug-iphoneos`). */
export function findRunnerApp(derivedDataDir: string): string | null {
  const productsDir = path.join(derivedDataDir, 'Build', 'Products')
  let configs: string[]
  try { configs = fs.readdirSync(productsDir) } catch { return null }
  for (const config of configs.sort()) {
    const dir = path.join(productsDir, config)
    let apps: string[]
    try { apps = fs.readdirSync(dir) } catch { continue }
    const app = apps.find((a) => a.endsWith('-Runner.app'))
    if (app) return path.join(dir, app)
  }
  return null
}

/** Rewrite WDA's `com.facebook.*` bundle ids to our namespace. PURE — the whole reason the rewrite
 *  is a named function rather than inline sed is that it is the one transform that silently breaks
 *  signing when wrong, so it is unit-testable in isolation.
 *
 *  Deliberately scoped to `PRODUCT_BUNDLE_IDENTIFIER` assignments rather than a blanket replace of
 *  every `com.facebook.` in the file: the project also references Facebook-namespaced things that
 *  are NOT ours to rename, and a blanket rewrite would corrupt them. */
export function renamespaceBundleIds(pbxproj: string): string {
  return pbxproj.replace(
    /(PRODUCT_BUNDLE_IDENTIFIER\s*=\s*)([^;\n]+)/g,
    (whole, prefix: string, value: string) =>
      value.includes(WDA_BUNDLE_ID_FROM) ? `${prefix}${value.replace(WDA_BUNDLE_ID_FROM, WDA_BUNDLE_ID_TO)}` : whole,
  )
}

/** Read `ExpirationDate` out of an `embedded.mobileprovision`. PURE (takes the bytes).
 *
 *  The file is a CMS-signed blob wrapping an XML plist. We slice the plist out and read the one key
 *  we need rather than shelling out to `security cms -D` — that keeps the check dependency-free and,
 *  more importantly, testable from a fixture. Returns null when the blob has no parseable plist or
 *  no date, which callers must treat as "unknown", never as "valid". */
export function parseProvisioningExpiry(profile: Buffer): Date | null {
  const text = profile.toString('latin1')
  const start = text.indexOf('<?xml')
  const end = text.indexOf('</plist>')
  if (start < 0 || end <= start) return null
  const plist = text.slice(start, end)
  const m = plist.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/)
  if (!m) return null
  const date = new Date(m[1])
  return Number.isNaN(date.getTime()) ? null : date
}

export interface WdaBuildStatus {
  /** A built runner + `.xctestrun` exist for the pinned version. */
  present: boolean
  xctestrun: string | null
  runnerApp: string | null
  /** Null when absent, or present but with no readable profile (treat as unknown, not valid). */
  expiresAt: Date | null
  /** The signature is known to have expired — present but unusable on a device. */
  expired: boolean
  /** Expires within `WDA_EXPIRY_WARN_DAYS`. */
  expiringSoon: boolean
}

/** Inspect a provisioned WDA: is it built, and is its signature still good?
 *
 *  `now` is injected so the expiry branches are testable without waiting a year. */
export function wdaBuildStatus(baseDir: string, now: Date = new Date()): WdaBuildStatus {
  const derived = wdaDerivedDataDir(baseDir)
  const xctestrun = findXctestrun(derived)
  const runnerApp = findRunnerApp(derived)
  const present = !!xctestrun && !!runnerApp
  let expiresAt: Date | null = null
  if (runnerApp) {
    try {
      expiresAt = parseProvisioningExpiry(fs.readFileSync(path.join(runnerApp, 'embedded.mobileprovision')))
    } catch { expiresAt = null }
  }
  const msLeft = expiresAt ? expiresAt.getTime() - now.getTime() : null
  return {
    present,
    xctestrun,
    runnerApp,
    expiresAt,
    expired: msLeft !== null && msLeft <= 0,
    expiringSoon: msLeft !== null && msLeft > 0 && msLeft <= WDA_EXPIRY_WARN_DAYS * 86_400_000,
  }
}

export interface EnsureWdaOptions {
  /** The Apple Team ID that signs WDA. Machine-level, seeded from the project's team on first use. */
  teamId: string
  npm: NpmInvocation
  run: CommandRunner
  onLog?: (line: string) => void
  /** Injected for tests; defaults to the real clock (drives the expiry-triggered rebuild). */
  now?: Date
  /** Force a rebuild even if a valid build is present (used by an explicit re-sign). */
  force?: boolean
}

export interface ProvisionedWda {
  xctestrun: string
  runnerApp: string
  expiresAt: Date | null
}

/** Fetch the pinned WDA source (if absent), re-namespace its bundle ids, and build + sign it.
 *
 *  Idempotent: a present, unexpired build short-circuits with no npm and no xcodebuild. An EXPIRED
 *  build rebuilds rather than being reported healthy — see the module header. */
export async function ensureWda(baseDir: string, opts: EnsureWdaOptions): Promise<ProvisionedWda> {
  const log = opts.onLog ?? (() => {})
  const now = opts.now ?? new Date()
  if (!opts.teamId) {
    throw new Error(
      'WebDriverAgent needs an Apple Team ID to sign with. Set one in Project Settings → iOS → Signing, ' +
      'or pick a team in Build Support.')
  }

  const existing = wdaBuildStatus(baseDir, now)
  if (existing.present && !existing.expired && !opts.force) {
    return { xctestrun: existing.xctestrun!, runnerApp: existing.runnerApp!, expiresAt: existing.expiresAt }
  }
  if (existing.present && existing.expired) {
    log(`The provisioned WebDriverAgent's signature expired ${existing.expiresAt?.toISOString()} — rebuilding.`)
  }

  const srcDir = wdaSourceDir(baseDir)
  if (!fs.existsSync(path.join(srcDir, 'WebDriverAgent.xcodeproj'))) {
    await fetchWdaSource(baseDir, opts.npm, opts.run, log)
  }

  // Re-namespace before building. Idempotent: the replace is a no-op once the ids are ours, so a
  // rebuild (expiry, force) does not need a clean re-fetch.
  const pbxproj = path.join(srcDir, 'WebDriverAgent.xcodeproj', 'project.pbxproj')
  const before = fs.readFileSync(pbxproj, 'utf8')
  const after = renamespaceBundleIds(before)
  if (after !== before) {
    fs.writeFileSync(pbxproj, after)
    log(`Re-namespaced bundle ids ${WDA_BUNDLE_ID_FROM}* → ${WDA_BUNDLE_ID_TO}* (they cannot be signed otherwise).`)
  }

  const derived = wdaDerivedDataDir(baseDir)
  fs.mkdirSync(derived, { recursive: true })
  log(`Building WebDriverAgent ${PINNED_WDA.version} for team ${opts.teamId} — this takes a few minutes…`)
  await opts.run('xcodebuild', [
    'build-for-testing',
    '-project', path.join(srcDir, 'WebDriverAgent.xcodeproj'),
    '-scheme', WDA_SCHEME,
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derived,
    `DEVELOPMENT_TEAM=${opts.teamId}`,
    '-allowProvisioningUpdates',
  ], { onLog: log })

  const built = wdaBuildStatus(baseDir, now)
  if (!built.present) {
    throw new Error(
      `xcodebuild reported success but produced no .xctestrun under ${derived}. ` +
      'Check the build log above for a signing failure.')
  }
  return { xctestrun: built.xctestrun!, runnerApp: built.runnerApp!, expiresAt: built.expiresAt }
}

/** Download the pinned WDA source via `npm pack` and extract it.
 *
 *  `npm pack` rather than `npm install`: we want the SOURCE TREE to compile, not a runnable package,
 *  so pulling WDA's whole dependency tree into the shared toolchain node_modules would be cost with
 *  no benefit. npm still resolves the pinned version through the registry with its own integrity
 *  check, which is the reproducibility guarantee we are relying on. */
async function fetchWdaSource(baseDir: string, npm: NpmInvocation, run: CommandRunner, log: (line: string) => void): Promise<void> {
  const versionDir = wdaVersionDir(baseDir)
  const srcDir = wdaSourceDir(baseDir)
  fs.mkdirSync(versionDir, { recursive: true })

  const spec = `${PINNED_WDA.npmPackage}@${PINNED_WDA.version}`
  log(`Downloading ${spec}…`)
  await run(npm.command, [...npm.prefixArgs, 'pack', spec, '--pack-destination', versionDir, '--no-audit', '--no-fund'], {
    cwd: versionDir, env: npm.env, shell: npm.shell, onLog: log,
  })

  const tarball = fs.readdirSync(versionDir).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error(`npm pack ${spec} produced no tarball in ${versionDir}`)

  // Extract into a staging dir first: the tarball unpacks to `package/`, and moving that into place
  // only after a successful extract means a failure never leaves a half-populated `src` that the
  // "already fetched" check would accept.
  const staging = path.join(versionDir, '.unpack')
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    log('Extracting…')
    await extractArchive(path.join(versionDir, tarball), staging, 'tar.gz')
    const unpacked = path.join(staging, 'package')
    if (!fs.existsSync(path.join(unpacked, 'WebDriverAgent.xcodeproj'))) {
      throw new Error(`${spec} does not contain WebDriverAgent.xcodeproj — the package layout changed.`)
    }
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.renameSync(unpacked, srcDir)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.rmSync(path.join(versionDir, tarball), { force: true })
  }
}
