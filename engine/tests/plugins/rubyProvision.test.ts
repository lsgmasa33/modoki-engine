import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureRuby, rubyDistKey, rubyDirFor, PINNED_RUBY, type FetchLike } from '../../toolchain'

/**
 * Guards the on-demand portable-Ruby provisioner (the CocoaPods brew-free path) WITHOUT a real
 * ~12MB download — the fetch is mocked. The real end-to-end (download → extract → gem install
 * cocoapods → `pod --version`) is validated manually; here we lock the safety-critical behaviors:
 * checksum enforcement, the arm64-mac-only pin, and idempotency.
 */
describe('rubyProvision — ensureRuby (mocked fetch)', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ruby-')) })
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

  const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
    async () => ({ ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })

  it('REFUSES to install bytes whose sha256 does not match the pin', async () => {
    if (!PINNED_RUBY.dist[rubyDistKey()]) return // non-mac host — nothing to guard
    await expect(ensureRuby(base, { fetchImpl: fakeFetch(Buffer.from('not a real ruby bottle')) }))
      .rejects.toThrow(/checksum mismatch/i)
    expect(fs.readdirSync(base).filter((f) => !f.startsWith('.'))).toEqual([])
  })

  it('surfaces a failed download (non-200) rather than installing anything', async () => {
    if (!PINNED_RUBY.dist[rubyDistKey()]) return
    await expect(ensureRuby(base, { fetchImpl: fakeFetch(Buffer.from(''), false, 404) }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('throws a clear message on an unsupported (non-arm64-mac) platform', async () => {
    await expect(ensureRuby(base, { fetchImpl: fakeFetch(Buffer.from('x')), platform: 'linux', arch: 'x64' }))
      .rejects.toThrow(/arm64-mac only/i)
  })

  it('is idempotent — returns the existing Ruby without fetching when already present', async () => {
    // Pre-seed the extracted layout: <base>/portable-ruby/<ver>/bin/{ruby,gem}.
    const binDir = path.join(rubyDirFor(base), 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'ruby'), '')
    fs.writeFileSync(path.join(binDir, 'gem'), '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when Ruby is present') }
    const res = await ensureRuby(base, { fetchImpl: throwingFetch, platform: 'darwin', arch: 'arm64' })
    expect(res.rubyBin).toBe(path.join(binDir, 'ruby'))
    expect(res.gemBin).toBe(path.join(binDir, 'gem'))
    expect(res.binDir).toBe(binDir)
  })

  it('pins a portable Ruby 3.x bottle for arm64-mac (asset token + sha256)', () => {
    expect(PINNED_RUBY.version).toMatch(/^3\./)
    const mac = PINNED_RUBY.dist['darwin-arm64']
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mac.asset).toMatch(/arm64/)
  })
})
