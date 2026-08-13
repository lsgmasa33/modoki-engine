import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureGoIos, goIosBinFor, goIosDirFor, PINNED_GO_IOS, type FetchLike } from '../../toolchain'

/**
 * Guards the on-demand go-ios provisioner — the tool that removes the ⌘R handoff from an iOS ≤16
 * deploy (#217) — WITHOUT the real ~17MB download, which is mocked. The real end-to-end (download →
 * extract → `ios install --path` → `ios launch`) was measured against an iPhone 8 / iOS 16.7.16
 * before this landed, with a kill-first baseline so the check could actually fail: killed pid 605,
 * confirmed no App process, installed, launched, saw a NEW pid outlive the tool. What's locked here
 * is what a test CAN own — checksum enforcement, the macOS-only pin, and idempotency.
 */
describe('goIosProvision — ensureGoIos (mocked fetch)', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-goios-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

  const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
    async () => ({
      ok, status,
      // A real ArrayBuffer copy — Buffer's backing store is ArrayBufferLike, wider than
      // FetchLike's `arrayBuffer(): Promise<ArrayBuffer>` (same note as rubyProvision.test.ts).
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(ab).set(bytes)
        return ab
      },
    })

  it('REFUSES to install bytes whose sha256 does not match the pin', async () => {
    // The pin is a hash WE maintain (the release zip has no registry integrity behind it), so this
    // is the only thing standing between a bumped version and unverified bytes running against the
    // developer's phone. It must leave nothing behind, either — a half-installed binary would be
    // found by the next `detect()` and spawned.
    await expect(ensureGoIos(base, { fetchImpl: fakeFetch(Buffer.from('not a go-ios release')), platform: 'darwin' }))
      .rejects.toThrow(/checksum mismatch/i)
    expect(fs.existsSync(goIosBinFor(base, 'darwin'))).toBe(false)
  })

  it('surfaces a failed download (non-200) rather than installing anything', async () => {
    await expect(ensureGoIos(base, { fetchImpl: fakeFetch(Buffer.from(''), false, 404), platform: 'darwin' }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('throws a clear message on a non-macOS platform', async () => {
    // go-ios itself builds for Linux/Windows; Modoki's iOS builds are macOS-only (xcodebuild does
    // the compile + signing), so a provisioned binary elsewhere could not be used for anything.
    await expect(ensureGoIos(base, { fetchImpl: fakeFetch(Buffer.from('x')), platform: 'linux' }))
      .rejects.toThrow(/macOS-only/i)
  })

  it('is idempotent — returns the existing binary without fetching when already present', async () => {
    const bin = goIosBinFor(base, 'darwin')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when go-ios is present') }
    const res = await ensureGoIos(base, { fetchImpl: throwingFetch, platform: 'darwin' })
    expect(res.bin).toBe(bin)
    expect(res.dir).toBe(goIosDirFor(base))
  })

  it('scopes the install dir by VERSION so a pin bump re-downloads instead of reusing the old binary', () => {
    expect(goIosDirFor(base)).toBe(path.join(base, PINNED_GO_IOS.version))
    expect(goIosDirFor(base, '9.9.9')).toBe(path.join(base, '9.9.9'))
  })

  it('pins a macOS release asset with a well-formed sha256', () => {
    const mac = PINNED_GO_IOS.dist.darwin
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mac.asset).toMatch(/\.zip$/)
    expect(PINNED_GO_IOS.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('names the binary `ios` (`ios.exe` on Windows) — the name the build steps spawn', () => {
    expect(path.basename(goIosBinFor(base, 'darwin'))).toBe('ios')
    expect(path.basename(goIosBinFor(base, 'win32'))).toBe('ios.exe')
  })
})
