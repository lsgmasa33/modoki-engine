import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureJdk, discoverJavaHome, jdkVersionDir, PINNED_JDK, jdkDistKey, type FetchLike } from '../../toolchain'

/**
 * Guards the on-demand JDK provisioner (Phase E-3) WITHOUT a real ~180MB download — the fetch is
 * mocked. The real end-to-end download (verify + extract + `java -version`) is validated manually;
 * here we lock the safety-critical behaviors: checksum enforcement, idempotency, and the
 * layout-robust JAVA_HOME discovery (macOS `Contents/Home` vs the plain `bin/java` layout).
 */
describe('jdkProvision — ensureJdk (mocked fetch)', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-jdkprov-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

  const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
    async () => ({ ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })

  it('REFUSES to install bytes whose sha256 does not match the pin', async () => {
    if (!PINNED_JDK.dist[jdkDistKey()]) return // unsupported arch here — nothing to guard
    await expect(ensureJdk(base, { fetchImpl: fakeFetch(Buffer.from('not a real jdk tarball')) }))
      .rejects.toThrow(/checksum mismatch/i)
    expect(fs.readdirSync(base).filter((f) => !f.startsWith('.'))).toEqual([])
  })

  it('surfaces a failed download (non-200) rather than installing anything', async () => {
    if (!PINNED_JDK.dist[jdkDistKey()]) return
    await expect(ensureJdk(base, { fetchImpl: fakeFetch(Buffer.from(''), false, 404) }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('is idempotent — returns the existing JAVA_HOME without fetching when the PINNED version is present', async () => {
    // Pre-seed a macOS-layout JDK under the VERSION-scoped dir: <base>/<version>/jdk-x/Contents/Home.
    const home = path.join(jdkVersionDir(base), 'jdk-21.0.11+10', 'Contents', 'Home')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'java'), '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when the JDK is present') }
    // Explicit darwin-arm64 (a pinned target) so this runs on any CI host (linux-x64 isn't
    // pinned → ensureJdk would throw "No pinned" before the idempotency check).
    const res = await ensureJdk(base, { fetchImpl: throwingFetch, platform: 'darwin', arch: 'arm64' })
    expect(res.javaHome).toBe(home)
  })

  it('a DIFFERENT-version JDK next door is NOT reused — a pin bump re-provisions', async () => {
    // Simulate a stale JDK from a previous pin at <base>/9.9.9/… — ensureJdk must NOT reuse it
    // (it keys on jdkVersionDir(<base>) = <base>/<current pin>), so with a fetch that would run it
    // proves the version-scoping by attempting a download (mocked 404 → throws, not a silent reuse).
    const stale = path.join(base, '9.9.9', 'jdk-9.9.9', 'Contents', 'Home')
    fs.mkdirSync(path.join(stale, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(stale, 'bin', 'java'), '')
    await expect(ensureJdk(base, { fetchImpl: fakeFetch(Buffer.from(''), false, 404), platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow(/HTTP 404/) // reached the download → did NOT reuse the stale version
  })

  it('discoverJavaHome finds the plain <release>/bin/java layout too', () => {
    const home = path.join(base, 'jdk-linuxish')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    // Launcher basename is platform-specific — discoverJavaHome looks for java.exe on Windows.
    fs.writeFileSync(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
    expect(discoverJavaHome(base)).toBe(home)
  })

  it('discoverJavaHome returns null when nothing is provisioned', () => {
    expect(discoverJavaHome(path.join(base, 'does-not-exist'))).toBeNull()
    expect(discoverJavaHome(base)).toBeNull() // empty dir
  })

  it('discoverJavaHome finds the WINDOWS bin/java.exe layout when asked for win32', () => {
    // A win-x64 Temurin extracts to <release>/bin/java.exe (no Contents/Home bundle).
    const home = path.join(base, 'jdk-21.0.11+10')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), '')
    expect(discoverJavaHome(base, 'win32')).toBe(home)
    // ...but the default (posix `java`) launcher is absent, so a posix probe finds nothing.
    expect(discoverJavaHome(base, 'linux')).toBeNull()
  })

  it('is idempotent for the WINDOWS layout too (bin/java.exe, no fetch)', async () => {
    const home = path.join(jdkVersionDir(base), 'jdk-21.0.11+10')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when the JDK is present') }
    const res = await ensureJdk(base, { fetchImpl: throwingFetch, platform: 'win32', arch: 'x64' })
    expect(res.javaHome).toBe(home)
  })

  it('pins a Temurin JDK 21 for arm64-mac (.tar.gz) AND win-x64 (.zip), same version', () => {
    expect(PINNED_JDK.version).toMatch(/^21\./)
    const mac = PINNED_JDK.dist['darwin-arm64']
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mac.url).toMatch(/adoptium.*temurin21.*aarch64_mac.*\.tar\.gz$/)
    expect(mac.archiveKind).toBe('tar.gz')
    const win = PINNED_JDK.dist['win32-x64']
    expect(win.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(win.url).toMatch(/adoptium.*temurin21.*x64_windows.*\.zip$/)
    expect(win.archiveKind).toBe('zip')
    // Same Temurin build across platforms so dev == packaged.
    expect(mac.url).toContain('21.0.11')
    expect(win.url).toContain('21.0.11')
  })
})
