import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { ensureNode, extractArchive, nodeDistFor, PINNED_NODE, nodeDistKey, type FetchLike } from '../../toolchain'

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
    async () => ({
      ok, status,
      // A real ArrayBuffer copy, not `.buffer.slice(...)` — Buffer's backing store is typed
      // ArrayBufferLike (ArrayBuffer | SharedArrayBuffer) in current @types/node, which is
      // wider than FetchLike's `arrayBuffer(): Promise<ArrayBuffer>`.
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(ab).set(bytes)
        return ab
      },
    })

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

  // 24 is Active LTS (supported to 2028-04-30); 22 went maintenance-only on 2025-10-21. The pin
  // must stay in lockstep with `@types/node` and the workflows' `node-version` — types above the
  // runtime typecheck clean and fail at RUNTIME in the packaged editor.
  it('pins a Node 24 version (dev == packaged) with arm64-mac + win-x64 checksums', () => {
    expect(PINNED_NODE.version).toMatch(/^v24\./)
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

/** Real extractions (no mock) through the in-process extractor every provisioner shares.
 *
 *  History this pins: `extractArchive` used to shell out to `tar`, which made the extractor the one
 *  OS dependency in the whole provisioning chain. On Windows that resolved by PATH order to Git's
 *  GNU tar, which (a) reads an archive arg containing a colon as a remote `host:path`, failing on
 *  every drive letter, and (b) cannot read a zip at all. The packaged editor therefore provisioned
 *  NOTHING — while `smoke:packaged` reported PASS, because `ensureNodeProvisioned()` catches and
 *  degrades to system npm. Extraction is in-process now (`tar` + `yauzl`), so there is no binary to
 *  shadow and behaviour is identical on every machine.
 *
 *  These assert OUTCOMES on disk — bytes, and the Unix mode — not implementation details. */
describe('extractArchive — in-process, no subprocess', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-extract-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('extracts a .tar.gz from an ABSOLUTE archive path, preserving the exec bit', async () => {
    const src = path.join(dir, 'src'); fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o755)
    await tar.c({ file: path.join(dir, 'a.tar.gz'), cwd: src, gzip: true }, ['run.sh'])

    const dest = path.join(dir, 'out'); fs.mkdirSync(dest)
    await extractArchive(path.join(dir, 'a.tar.gz'), dest, 'tar.gz')
    expect(fs.readFileSync(path.join(dest, 'run.sh'), 'utf8')).toContain('#!/bin/sh')
    // The mac Node/JDK tarballs rely on this — every `bin/*` must stay executable. Windows has no
    // exec bit, so only assert it where it means something.
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dest, 'run.sh')).mode & 0o111).toBeGreaterThan(0)
    }
  })

  /** The fixture is a hand-built zip, NOT one produced by the extractor's own libraries.
   *
   *  An earlier version of this test built the fixture with `tar -a -cf x.zip`, which under GNU tar
   *  writes a TAR wearing a `.zip` extension — it extracted happily and proved nothing while
   *  production was broken. A fixture built by the tool under test cannot test the tool. This
   *  writes the bytes directly (stored/uncompressed, one entry), sets the Unix mode in the high 16
   *  bits of `externalFileAttributes` the way a Unix-written zip does, and asserts the `PK` magic. */
  it('extracts a REAL .zip and restores the Unix mode from externalFileAttributes', async () => {
    const zipPath = path.join(dir, 'a.zip')
    fs.writeFileSync(zipPath, storedZip('run.sh', '#!/bin/sh\n', 0o755))
    expect(fs.readFileSync(zipPath).subarray(0, 2).toString('latin1')).toBe('PK')

    const dest = path.join(dir, 'out'); fs.mkdirSync(dest)
    await extractArchive(zipPath, dest, 'zip')
    expect(fs.readFileSync(path.join(dest, 'run.sh'), 'utf8')).toBe('#!/bin/sh\n')
    // Google's cmdline-tools zip carries `sdkmanager` as an executable shell script; losing the bit
    // here fails the Android SDK bootstrap later, far from the cause.
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dest, 'run.sh')).mode & 0o111).toBeGreaterThan(0)
    }
  })

  // Asserts the OUTCOME (rejected, nothing written outside dest), not the message: yauzl validates
  // entry names itself and rejects `../escaped.txt` with "invalid relative path" BEFORE our own
  // check runs. Ours is therefore a second line of defence, not the only one — worth keeping (it
  // covers a future yauzl option change or a different reader) but it is not what fires here.
  it('refuses a zip entry that escapes the destination (path traversal)', async () => {
    const zipPath = path.join(dir, 'evil.zip')
    fs.writeFileSync(zipPath, storedZip('../escaped.txt', 'pwned', 0o644))
    const dest = path.join(dir, 'out'); fs.mkdirSync(dest)
    await expect(extractArchive(zipPath, dest, 'zip')).rejects.toThrow(/escapes destination|invalid relative path/)
    expect(fs.existsSync(path.join(dir, 'escaped.txt'))).toBe(false)
  })
})

/** Minimal single-entry ZIP writer (stored, no compression) so a fixture never depends on the
 *  extractor's own libraries. `mode` goes in the high 16 bits of externalFileAttributes, which is
 *  where a Unix-written zip puts it and what `extractZip` reads back. */
function storedZip(name: string, content: string, mode: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const data = Buffer.from(content, 'utf8')
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)              // local file header magic ("PK\x03\x04")
  local.writeUInt16LE(20, 4)                       // version needed
  local.writeUInt16LE(0, 8)                        // method: stored
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)             // central directory header magic
  central.writeUInt16LE(0x0314, 4)                 // version made by: Unix
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 10)                     // method: stored
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE((mode << 16) >>> 0, 38)    // externalFileAttributes ← the Unix mode
  central.writeUInt32LE(0, 42)                     // offset of local header

  const centralStart = local.length + nameBuf.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)                 // end of central directory
  end.writeUInt16LE(1, 8)                          // entries on this disk
  end.writeUInt16LE(1, 10)                         // total entries
  end.writeUInt32LE(central.length + nameBuf.length, 12)
  end.writeUInt32LE(centralStart, 16)

  return Buffer.concat([local, nameBuf, data, central, nameBuf, end])
}
