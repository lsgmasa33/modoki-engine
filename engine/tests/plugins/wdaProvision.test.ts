import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureWda, wdaBuildStatus, wdaSourceDir, wdaDerivedDataDir, wdaVersionDir,
  renamespaceBundleIds, parseProvisioningExpiry, findXctestrun, findRunnerApp,
  PINNED_WDA, WDA_BUNDLE_ID_FROM, WDA_BUNDLE_ID_TO, WDA_EXPIRY_WARN_DAYS,
  type CommandRunner, type NpmInvocation,
} from '../../toolchain/wdaProvision'

/**
 * Guards the WebDriverAgent provisioner (#32 Phase 2) WITHOUT an Xcode or a network — both the npm
 * fetch and the xcodebuild are injected `CommandRunner`s.
 *
 * WDA is the one toolchain item that is BUILT rather than downloaded, so the usual provisioner
 * guards (checksum refusal, no-partial-install) do not apply and different ones do. The two that
 * matter, because both fail SILENTLY in production:
 *   - the bundle-id rewrite: get it wrong and signing fails, or worse, a blanket replace corrupts
 *     unrelated project references;
 *   - expiry: an expired build is still present on disk, and reporting it healthy would send every
 *     iOS input op back to a synthetic fallback while Build Support claimed WDA was installed.
 */

const NPM: NpmInvocation = { command: 'npm', prefixArgs: [], shell: false, env: {} }

/** An `embedded.mobileprovision`-shaped blob: binary CMS noise wrapped around an XML plist, which
 *  is what the real file is. The noise matters — parsing must survive it. */
function fakeProfile(expiresAt: Date | null): Buffer {
  const body = expiresAt
    ? `<key>ExpirationDate</key>\n\t<date>${expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`
    : '<key>Name</key>\n\t<string>no expiry here</string>'
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t${body}\n</dict>\n</plist>`
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x00]), Buffer.from(plist, 'latin1'), Buffer.from([0x00, 0x01])])
}

/** Lay down what a successful `build-for-testing` leaves behind. */
function seedBuild(base: string, opts: { expiresAt?: Date | null; profile?: Buffer } = {}) {
  const products = path.join(wdaDerivedDataDir(base), 'Build', 'Products')
  fs.mkdirSync(products, { recursive: true })
  fs.writeFileSync(path.join(products, 'WebDriverAgentRunner_iphoneos26.5-arm64.xctestrun'), '<plist/>')
  const app = path.join(products, 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app')
  fs.mkdirSync(app, { recursive: true })
  const profile = opts.profile ?? fakeProfile(opts.expiresAt === undefined ? new Date('2030-01-01') : opts.expiresAt)
  fs.writeFileSync(path.join(app, 'embedded.mobileprovision'), profile)
}

/** Seed an extracted source tree so `ensureWda` skips the fetch. */
function seedSource(base: string, pbxproj = 'PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;\n') {
  const proj = path.join(wdaSourceDir(base), 'WebDriverAgent.xcodeproj')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'project.pbxproj'), pbxproj)
}

describe('renamespaceBundleIds — the rewrite that makes WDA signable', () => {
  it('re-namespaces every PRODUCT_BUNDLE_IDENTIFIER, keeping the targets DISTINCT', () => {
    // Distinctness is the reason this is a source rewrite instead of one `xcodebuild
    // PRODUCT_BUNDLE_IDENTIFIER=` override — a single CLI value collapses all targets onto one id.
    const out = renamespaceBundleIds([
      '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;',
      '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentLib;',
    ].join('\n'))
    expect(out).toContain(`${WDA_BUNDLE_ID_TO}WebDriverAgentRunner`)
    expect(out).toContain(`${WDA_BUNDLE_ID_TO}WebDriverAgentLib`)
    expect(out).not.toContain(WDA_BUNDLE_ID_FROM)
  })

  it('does NOT blanket-replace com.facebook elsewhere in the project', () => {
    // A naive global replace corrupts references that are not ours to rename. Scoping to the
    // assignment is the whole point of the function.
    const src = [
      'PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;',
      'FRAMEWORK_SEARCH_PATHS = "$(SRCROOT)/com.facebook.SomeVendoredThing";',
    ].join('\n')
    const out = renamespaceBundleIds(src)
    expect(out).toContain(`${WDA_BUNDLE_ID_TO}WebDriverAgentRunner`)
    expect(out).toContain('com.facebook.SomeVendoredThing')   // untouched
  })

  it('is IDEMPOTENT — a rebuild re-runs it over already-renamed source', () => {
    const once = renamespaceBundleIds('PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;')
    expect(renamespaceBundleIds(once)).toBe(once)
  })
})

describe('parseProvisioningExpiry', () => {
  it('reads ExpirationDate out of a CMS-wrapped plist', () => {
    const when = new Date('2027-07-29T10:01:32Z')
    expect(parseProvisioningExpiry(fakeProfile(when))?.toISOString()).toBe(when.toISOString())
  })

  it('returns null for a blob with no plist, and for a plist with no date', () => {
    // Both must read as UNKNOWN. A caller that treated null as "valid" would report an unsignable
    // build as healthy — the exact failure this check exists to prevent.
    expect(parseProvisioningExpiry(Buffer.from([0x30, 0x82, 0x00]))).toBeNull()
    expect(parseProvisioningExpiry(fakeProfile(null))).toBeNull()
  })
})

describe('wdaBuildStatus — present is not the same as usable', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wda-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

  it('reports absent when nothing is built', () => {
    const s = wdaBuildStatus(base)
    expect(s.present).toBe(false)
    expect(s.xctestrun).toBeNull()
    expect(s.expired).toBe(false)     // absent is not "expired"
  })

  it('finds the .xctestrun and the runner app of a real build layout', () => {
    seedBuild(base)
    const s = wdaBuildStatus(base)
    expect(s.present).toBe(true)
    expect(s.xctestrun).toMatch(/\.xctestrun$/)
    expect(s.runnerApp).toMatch(/-Runner\.app$/)
    expect(s.expired).toBe(false)
  })

  it('flags an EXPIRED signature — present on disk, unusable on a device', () => {
    seedBuild(base, { expiresAt: new Date('2020-01-01') })
    const s = wdaBuildStatus(base, new Date('2026-08-02'))
    expect(s.present).toBe(true)      // still present…
    expect(s.expired).toBe(true)      // …and still broken
  })

  it('warns BEFORE expiry, while a rebuild is still convenient', () => {
    const now = new Date('2026-08-02T00:00:00Z')
    const soon = new Date(now.getTime() + (WDA_EXPIRY_WARN_DAYS - 1) * 86_400_000)
    const later = new Date(now.getTime() + (WDA_EXPIRY_WARN_DAYS + 10) * 86_400_000)
    expect(wdaBuildStatus(base, now).expiringSoon).toBe(false)   // absent
    seedBuild(base, { expiresAt: soon })
    expect(wdaBuildStatus(base, now).expiringSoon).toBe(true)
    fs.rmSync(wdaDerivedDataDir(base), { recursive: true, force: true })
    seedBuild(base, { expiresAt: later })
    expect(wdaBuildStatus(base, now).expiringSoon).toBe(false)
  })

  it('an unreadable profile is UNKNOWN, never "valid"', () => {
    seedBuild(base, { profile: Buffer.from('not a profile') })
    const s = wdaBuildStatus(base)
    expect(s.expiresAt).toBeNull()
    expect(s.expired).toBe(false)      // unknown — we do not claim it is dead either
    expect(s.expiringSoon).toBe(false)
  })
})

describe('ensureWda', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wda-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

  /** A runner that satisfies the xcodebuild step by laying down build products. */
  const buildingRunner = (expiresAt: Date = new Date('2030-01-01')): CommandRunner =>
    vi.fn(async (command: string) => { if (command === 'xcodebuild') seedBuild(base, { expiresAt }) })

  it('REFUSES without a team ID rather than starting a build that cannot be signed', async () => {
    await expect(ensureWda(base, { teamId: '', npm: NPM, run: buildingRunner() }))
      .rejects.toThrow(/Apple Team ID/i)
  })

  it('is IDEMPOTENT — a present, unexpired build runs no npm and no xcodebuild', async () => {
    seedBuild(base)
    const run = vi.fn<CommandRunner>(async () => { throw new Error('must not run anything') })
    const r = await ensureWda(base, { teamId: 'ABCDE12345', npm: NPM, run })
    expect(run).not.toHaveBeenCalled()
    expect(r.xctestrun).toMatch(/\.xctestrun$/)
  })

  it('REBUILDS an expired build instead of returning it', async () => {
    // The behaviour that keeps `present` from meaning `usable`. Without this, iOS input silently
    // degrades to synthetic while Build Support shows WDA installed.
    seedSource(base)
    seedBuild(base, { expiresAt: new Date('2020-01-01') })
    const run = buildingRunner()
    await ensureWda(base, { teamId: 'ABCDE12345', npm: NPM, run, now: new Date('2026-08-02') })
    expect(run).toHaveBeenCalledWith('xcodebuild', expect.anything(), expect.anything())
  })

  it('passes the team to xcodebuild and does NOT bake it into the source', async () => {
    // Team on the command line, bundle ids in the source: the extracted tree stays team-agnostic, so
    // one checkout serves any signing identity (WDA is per-machine, not per-project).
    seedSource(base)
    const run = buildingRunner()
    await ensureWda(base, { teamId: 'ABCDE12345', npm: NPM, run })
    const args = (run as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'xcodebuild')![1] as string[]
    expect(args).toContain('DEVELOPMENT_TEAM=ABCDE12345')
    expect(args).toContain('-allowProvisioningUpdates')
    expect(args).toContain('build-for-testing')
    expect(fs.readFileSync(path.join(wdaSourceDir(base), 'WebDriverAgent.xcodeproj', 'project.pbxproj'), 'utf8'))
      .not.toContain('ABCDE12345')
  })

  it('rewrites the bundle ids before building', async () => {
    seedSource(base)
    await ensureWda(base, { teamId: 'T', npm: NPM, run: buildingRunner() })
    const pbx = fs.readFileSync(path.join(wdaSourceDir(base), 'WebDriverAgent.xcodeproj', 'project.pbxproj'), 'utf8')
    expect(pbx).toContain(`${WDA_BUNDLE_ID_TO}WebDriverAgentRunner`)
    expect(pbx).not.toContain(WDA_BUNDLE_ID_FROM)
  })

  it('does not report success when xcodebuild exits 0 but produces no .xctestrun', async () => {
    // A signing failure can leave xcodebuild exiting 0 with nothing built. Trusting the exit code
    // would hand back a path that does not exist.
    seedSource(base)
    const run: CommandRunner = vi.fn(async () => {})
    await expect(ensureWda(base, { teamId: 'T', npm: NPM, run }))
      .rejects.toThrow(/produced no \.xctestrun/i)
  })

  it('fetches the PINNED version when no source is present', async () => {
    const run = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'npm') throw new Error('stop here — the pin is what this asserts')
      if (command === 'xcodebuild') seedBuild(base)
      void args
    })
    await expect(ensureWda(base, { teamId: 'T', npm: NPM, run })).rejects.toThrow(/stop here/)
    const args = (run as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(args).toContain('pack')
    expect(args).toContain(`${PINNED_WDA.npmPackage}@${PINNED_WDA.version}`)
  })

  it('fails loudly when npm pack leaves no tarball', async () => {
    const run: CommandRunner = vi.fn(async () => {})   // exits 0, produces nothing
    await expect(ensureWda(base, { teamId: 'T', npm: NPM, run })).rejects.toThrow(/produced no tarball/i)
  })
})

describe('registry wiring — the seam production actually takes', () => {
  // The tests above drive wdaProvision directly. Build Support reaches it through the toolchain
  // REGISTRY instead, and that indirection is exactly where a new tool silently fails to appear.
  let base: string
  let prevDir: string | undefined
  let prevTeam: string | undefined
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wda-tc-'))
    prevDir = process.env.MODOKI_TOOLCHAIN_DIR
    prevTeam = process.env.MODOKI_WDA_TEAM_ID
    process.env.MODOKI_TOOLCHAIN_DIR = base
  })
  afterEach(() => {
    if (prevDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR; else process.env.MODOKI_TOOLCHAIN_DIR = prevDir
    if (prevTeam === undefined) delete process.env.MODOKI_WDA_TEAM_ID; else process.env.MODOKI_WDA_TEAM_ID = prevTeam
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('is enumerated by TOOL_IDS, so the dialog and /api/toolchain list it automatically', async () => {
    const { TOOL_IDS } = await import('../../toolchain')
    expect(TOOL_IDS).toContain('webdriveragent')
  })

  it('detect() reports ABSENT before install, and PRESENT once built', async () => {
    const { detect } = await import('../../toolchain')
    expect(detect('webdriveragent').present).toBe(false)
    seedBuild(path.join(base, 'wda'))
    expect(detect('webdriveragent').present).toBe(true)
  })

  it('detect() reports an EXPIRED build as ABSENT — present on disk is not usable', async () => {
    // The whole reason detection is custom. If this regressed, Build Support would show WDA
    // installed while every iOS input op fell back to synthetic.
    const { detect } = await import('../../toolchain')
    seedBuild(path.join(base, 'wda'), { expiresAt: new Date('2020-01-01') })
    expect(detect('webdriveragent').present).toBe(false)
  })

  it('install() REFUSES with an actionable message when no team is configured', async () => {
    // install() takes no project context by design, so the team has to come from env/settings —
    // and a missing one must not start a multi-minute build that cannot possibly be signed.
    const { install } = await import('../../toolchain')
    delete process.env.MODOKI_WDA_TEAM_ID
    await expect(install('webdriveragent', { toolchainDir: base }))
      .rejects.toThrow(/Apple Team ID/i)
  })

  it('AUTO-INSTALLS only when it can actually succeed', async () => {
    // The owner's call: auto-install, but never unprompted on a machine that would just fail.
    // `installable` (the user may click it) and `autoInstall` (we do it unasked) are deliberately
    // different questions — WDA is the case that forced them apart.
    const { autoInstallable, detect } = await import('../../toolchain')
    if (process.platform !== 'darwin') {
      expect(autoInstallable('webdriveragent', { wdaTeamAvailable: true })).toBe(false)
      return
    }
    // No team anywhere ⇒ refuse, even though the row is installable.
    delete process.env.MODOKI_WDA_TEAM_ID
    expect(autoInstallable('webdriveragent')).toBe(false)
    // A team from the OPEN PROJECT is enough — otherwise a fresh machine could never auto-install,
    // since the machine-level setting only exists after the first manual install seeds it.
    expect(autoInstallable('webdriveragent', { wdaTeamAvailable: true })).toBe(detect('xcodebuild').present)
    // A machine-level team is equally sufficient.
    process.env.MODOKI_WDA_TEAM_ID = 'ABCDE12345'
    expect(autoInstallable('webdriveragent')).toBe(detect('xcodebuild').present)
  })

  it('the four dependency-free CLIs still auto-install unconditionally', async () => {
    // Moving the list server-side must not change the existing four's behaviour.
    const { autoInstallable } = await import('../../toolchain')
    for (const id of ['gltf-transform-cli', 'gltfpack', 'ffmpeg', 'ffprobe'] as const) {
      expect(autoInstallable(id)).toBe(true)
    }
    // …and a guided-only tool is never auto-installed.
    expect(autoInstallable('xcodebuild')).toBe(false)
  })

  it('its guide names the ONE step no CLI can do for you', async () => {
    // The on-device UI Automation authorization. It belongs where the user is looking when they
    // install, not in a doc they would have to know to open.
    const { guide } = await import('../../toolchain')
    expect(guide('webdriveragent').steps.join(' ')).toMatch(/UI Automation/i)
  })
})

describe('layout helpers are version-scoped', () => {
  it('a pin bump lands in a fresh dir rather than reusing the old build', () => {
    // Same guarantee jdkVersionDir gives: reusing a build of different source is the silent-staleness
    // bug class this repo has already been bitten by (#90).
    expect(wdaVersionDir('/tc/wda')).toContain(PINNED_WDA.version)
    expect(wdaSourceDir('/tc/wda')).toContain(PINNED_WDA.version)
    expect(wdaDerivedDataDir('/tc/wda')).toContain(PINNED_WDA.version)
  })

  it('discovery tolerates an absent products dir', () => {
    expect(findXctestrun('/nope')).toBeNull()
    expect(findRunnerApp('/nope')).toBeNull()
  })
})
