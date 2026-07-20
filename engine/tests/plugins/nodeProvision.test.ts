import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureNode, nodeDistFor, PINNED_NODE, nodeDistKey, type FetchLike } from '../../toolchain'

/**
 * Guards the on-demand Node provisioner (Phase C2) WITHOUT a real download — the fetch is mocked.
 * The real end-to-end download (verify + extract + run npm) is validated manually; here we lock the
 * safety-critical behaviors: checksum enforcement and idempotency.
 */
describe('nodeProvision — ensureNode (mocked fetch)', () => {
  let base: string
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-nodeprov-'))
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
    async () => ({ ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })

  it('REFUSES to install bytes whose sha256 does not match the pin', async () => {
    // Arbitrary bytes → hash won't equal the pinned checksum → must throw, install nothing.
    // Pin an explicit SUPPORTED platform so the test exercises the checksum path on ANY CI
    // host (linux-x64 isn't a pinned target — there ensureNode throws "No pinned" first).
    await expect(ensureNode(base, { fetchImpl: fakeFetch(Buffer.from('not a real node tarball')), platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow(/checksum mismatch/i)
    // Nothing extracted.
    expect(fs.readdirSync(base).filter((f) => !f.startsWith('.'))).toEqual([])
  })

  it('is idempotent — returns the existing Node without fetching when already present', async () => {
    // Explicit darwin-arm64 (a pinned target) so this runs on any CI host, not just when the
    // process platform happens to be pinned.
    const key = nodeDistKey('darwin', 'arm64')
    const name = `node-${PINNED_NODE.version}-${key}`
    const nodeBin = path.join(base, name, 'bin', 'node')
    const npmCli = path.join(base, name, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true })
    fs.mkdirSync(path.dirname(npmCli), { recursive: true })
    fs.writeFileSync(nodeBin, '')
    fs.writeFileSync(npmCli, '')

    const throwingFetch: FetchLike = async () => {
      throw new Error('fetch must not be called when Node is already present')
    }
    const res = await ensureNode(base, { fetchImpl: throwingFetch, platform: 'darwin', arch: 'arm64' })
    expect(res.nodeBin).toBe(nodeBin)
    expect(res.npmCli).toBe(npmCli)
  })

  it('surfaces a failed download (non-200) rather than installing anything', async () => {
    await expect(ensureNode(base, { fetchImpl: fakeFetch(Buffer.from(''), false, 404), platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('pins a Node 22 version (dev == packaged) with arm64-mac + win-x64 checksums', () => {
    expect(PINNED_NODE.version).toMatch(/^v22\./)
    expect(PINNED_NODE.sha256['darwin-arm64']).toMatch(/^[0-9a-f]{64}$/)
    expect(PINNED_NODE.sha256['win32-x64']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('nodeDistFor describes the mac (.tar.gz, bin/node) and Windows (.zip, node.exe) layouts', () => {
    const mac = nodeDistFor('darwin', 'arm64')
    expect(mac.archiveKind).toBe('tar.gz')
    expect(mac.archiveName).toBe(`node-${PINNED_NODE.version}-darwin-arm64.tar.gz`)
    expect(mac.nodeBinRel).toBe(path.join('bin', 'node'))
    expect(mac.npmCliRel).toBe(path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(mac.url).toContain('nodejs.org/dist')

    const win = nodeDistFor('win32', 'x64')
    expect(win.archiveKind).toBe('zip')
    expect(win.archiveName).toBe(`node-${PINNED_NODE.version}-win-x64.zip`) // node's dist token is `win`, not win32
    expect(win.nodeBinRel).toBe('node.exe')
    expect(win.npmCliRel).toBe(path.join('node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(win.sha256).toBe(PINNED_NODE.sha256['win32-x64'])
  })

  it('is idempotent for the WINDOWS layout too (node.exe at root, npm under node_modules)', async () => {
    const dist = nodeDistFor('win32', 'x64')
    const nodeBin = path.join(base, dist.extractName, dist.nodeBinRel) // .../node-vX-win-x64/node.exe
    const npmCli = path.join(base, dist.extractName, dist.npmCliRel)
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true })
    fs.mkdirSync(path.dirname(npmCli), { recursive: true })
    fs.writeFileSync(nodeBin, '')
    fs.writeFileSync(npmCli, '')
    const throwingFetch: FetchLike = async () => { throw new Error('fetch must not be called when Node is already present') }
    const res = await ensureNode(base, { fetchImpl: throwingFetch, platform: 'win32', arch: 'x64' })
    expect(res.nodeBin).toBe(nodeBin)
    expect(res.npmCli).toBe(npmCli)
  })
})
