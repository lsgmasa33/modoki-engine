import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCmdlineTools, sdkmanagerPath, cmdlineToolsKey, PINNED_CMDLINE_TOOLS, ANDROID_SDK_PACKAGES, type FetchLike } from '../../toolchain'

/**
 * Guards the Android SDK cmdline-tools bootstrap (Phase E-3) WITHOUT a real ~150MB download — the
 * fetch is mocked. The sdkmanager package/license step needs a real JDK + Google's package repo, so
 * it's validated manually; here we lock the safety-critical bootstrap: sha1 enforcement, idempotency,
 * the sdkmanager layout path, and the pinned package list matching the games' gradle config.
 */
describe('androidSdkProvision — ensureCmdlineTools (mocked fetch)', () => {
  let sdkRoot: string
  beforeEach(() => { sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-android-')) })
  afterEach(() => { fs.rmSync(sdkRoot, { recursive: true, force: true }) })

  const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
    async () => ({ ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })

  it('REFUSES to install bytes whose sha1 does not match the pin', async () => {
    if (!PINNED_CMDLINE_TOOLS.dist[cmdlineToolsKey()]) return // unsupported platform here
    await expect(ensureCmdlineTools(sdkRoot, { fetchImpl: fakeFetch(Buffer.from('not a real cmdline-tools zip')) }))
      .rejects.toThrow(/checksum mismatch/i)
    // No cmdline-tools dir left behind.
    expect(fs.existsSync(path.join(sdkRoot, 'cmdline-tools'))).toBe(false)
  })

  it('surfaces a failed download (non-200) rather than installing anything', async () => {
    if (!PINNED_CMDLINE_TOOLS.dist[cmdlineToolsKey()]) return
    await expect(ensureCmdlineTools(sdkRoot, { fetchImpl: fakeFetch(Buffer.from(''), false, 404) }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('is idempotent — returns the existing sdkmanager without fetching when present', async () => {
    // Explicit darwin (a pinned host) so this runs on any CI host (linux isn't a pinned
    // cmdline-tools host → ensureCmdlineTools would throw "No pinned" before the idempotency check).
    const sm = sdkmanagerPath(sdkRoot, 'darwin')
    fs.mkdirSync(path.dirname(sm), { recursive: true })
    fs.writeFileSync(sm, '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when cmdline-tools are present') }
    expect(await ensureCmdlineTools(sdkRoot, { fetchImpl: throwingFetch, platform: 'darwin' })).toBe(sm)
  })

  it('sdkmanagerPath uses the required cmdline-tools/latest/bin layout (posix + windows launcher)', () => {
    expect(sdkmanagerPath('/sdk', 'darwin')).toBe(path.join('/sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))
    expect(sdkmanagerPath('/sdk', 'win32')).toBe(path.join('/sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'))
  })

  it('cmdlineToolsKey maps the host to Google\'s os token (mac/win/linux)', () => {
    expect(cmdlineToolsKey('darwin')).toBe('mac')
    expect(cmdlineToolsKey('win32')).toBe('win')
    expect(cmdlineToolsKey('linux')).toBe('linux')
  })

  it('is idempotent for the WINDOWS layout too (sdkmanager.bat, no fetch)', async () => {
    const sm = sdkmanagerPath(sdkRoot, 'win32')
    fs.mkdirSync(path.dirname(sm), { recursive: true })
    fs.writeFileSync(sm, '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when cmdline-tools are present') }
    expect(await ensureCmdlineTools(sdkRoot, { fetchImpl: throwingFetch, platform: 'win32' })).toBe(sm)
  })

  it('pins a cmdline-tools zip for BOTH mac and win (url + sha1), and the games\' package set', () => {
    const mac = PINNED_CMDLINE_TOOLS.dist['mac']
    expect(mac.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(mac.url).toMatch(/commandlinetools-mac-\d+_latest\.zip$/)
    const win = PINNED_CMDLINE_TOOLS.dist['win']
    expect(win.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(win.url).toMatch(/commandlinetools-win-\d+_latest\.zip$/)
    // Same cmdline-tools version across platforms.
    expect(mac.url).toContain(PINNED_CMDLINE_TOOLS.version)
    expect(win.url).toContain(PINNED_CMDLINE_TOOLS.version)
    // compileSdk/targetSdk 36 across every game's android/variables.gradle.
    expect(ANDROID_SDK_PACKAGES).toContain('platform-tools')
    expect(ANDROID_SDK_PACKAGES).toContain('platforms;android-36')
    expect(ANDROID_SDK_PACKAGES).toContain('build-tools;36.0.0')
  })
})
