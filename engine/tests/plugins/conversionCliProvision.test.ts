import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  ensureConversionCli, conversionCliBin, conversionCliDir, conversionCliDist, CONVERSION_CLI_PINS, canExpand, ranOk,
  type FetchLike,
} from '../../toolchain'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { loadEnginePluginModuleResult } from '../../scripts/loadVendorPlugins.mjs'

/**
 * Guards the pinned toktx / msdf-atlas-gen provisioner (#1327) WITHOUT the real downloads, which are
 * mocked. The real end-to-end was run before this landed: `npm run toolchain:install -- toktx
 * msdf-atlas-gen` into a scratch dir on an arm64 Mac, then both stagers against it — the installed
 * toktx is byte-identical to KhronosGroup's pkg payload and the msdf-atlas-gen to the published
 * static build. What is locked here is what a test can own: checksum enforcement, the per-host pin,
 * the asset-layout contract, atomicity, and idempotency.
 *
 * The real pins' hashes cannot be matched by a fake download, so the install cases register a TEST
 * host key in the pin table for their duration and remove it after.
 */
const TEST_PLATFORM = 'modoki-test' as NodeJS.Platform
const TEST_ARCH = 'x0'
const TEST_KEY = `${TEST_PLATFORM}-${TEST_ARCH}`

const fakeFetch = (bytes: Buffer, ok = true, status = 200): FetchLike =>
  async () => ({
    ok, status,
    arrayBuffer: async () => {
      const ab = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(ab).set(bytes)
      return ab
    },
  })
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

describe('conversionCliProvision — ensureConversionCli (mocked fetch)', () => {
  let base: string
  beforeEach(() => { base = makeScratchDir('modoki-convcli-') })
  afterEach(() => {
    delete CONVERSION_CLI_PINS.toktx.dist[TEST_KEY]
    delete CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY]
    fs.rmSync(base, { recursive: true, force: true })
  })

  const opts = (fetchImpl: FetchLike, extra: object = {}) => ({ fetchImpl, platform: TEST_PLATFORM, arch: TEST_ARCH, ...extra })
  /** Everything under `<base>/<id>`, so a failed install is proven to leave NOTHING — not the final
   *  dir, and not a stray staging dir the next install would have to step around. */
  const leftovers = (id: string) => (fs.existsSync(path.join(base, id)) ? fs.readdirSync(path.join(base, id)) : [])

  it('REFUSES bytes whose sha256 does not match the pin, and leaves nothing behind', async () => {
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/msdf.tar.gz', sha256: sha(Buffer.from('the real asset')), kind: 'tar.gz',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    await expect(ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(Buffer.from('a tampered asset')))))
      .rejects.toThrow(/checksum mismatch/)
    expect(leftovers('msdf-atlas-gen')).toEqual([])
  })

  it('surfaces a failed download rather than installing anything', async () => {
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = { url: 'https://example.invalid/k.pkg', sha256: '0'.repeat(64), kind: 'macos-pkg', files: [] }
    await expect(ensureConversionCli('toktx', base, opts(fakeFetch(Buffer.from(''), false, 404)))).rejects.toThrow(/HTTP 404/)
  })

  it('a host with no pinned build is refused by name — Intel macOS has no msdf-atlas-gen', async () => {
    expect(conversionCliDist('msdf-atlas-gen', 'darwin', 'x64')).toBeUndefined()
    const neverFetch: FetchLike = async () => { throw new Error('must not download for an unpinned host') }
    await expect(ensureConversionCli('msdf-atlas-gen', base, { fetchImpl: neverFetch, platform: 'darwin', arch: 'x64' }))
      .rejects.toThrow(/No pinned msdf-atlas-gen 1\.4-skia build exists for darwin-x64[\s\S]*MODOKI_MSDF_ATLAS_GEN/)
  })

  it('a present copy that does not RUN is reinstalled, not returned', async () => {
    const bytes = Buffer.from('a good asset')
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: sha(bytes), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const bin = conversionCliBin(base, 'msdf-atlas-gen', TEST_PLATFORM)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, 'broken')
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'msdf-atlas-gen'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'msdf-atlas-gen', 'msdf-atlas-gen'), 'good')
    }
    const probe = (b: string) => fs.readFileSync(b, 'utf8') === 'good'
    expect(await ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes), { expand, probe }))).toBe(bin)
    expect(fs.readFileSync(bin, 'utf8')).toBe('good')
  })

  it('an install that still does not run fails loudly, naming the Windows runtime it needs', async () => {
    const bytes = Buffer.from('an asset whose binary cannot start')
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = {
      url: 'https://example.invalid/k.exe', sha256: sha(bytes), kind: 'zip', files: [['bin/toktx.exe', 'toktx.exe']],
    }
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'bin', 'toktx.exe'), 'needs VCRUNTIME140.dll')
    }
    const winKey = 'win32-' + TEST_ARCH
    CONVERSION_CLI_PINS.toktx.dist[winKey] = CONVERSION_CLI_PINS.toktx.dist[TEST_KEY]
    try {
      await expect(ensureConversionCli('toktx', base, { fetchImpl: fakeFetch(bytes), expand, probe: () => false, platform: 'win32', arch: TEST_ARCH }))
        .rejects.toThrow(/does not run — the Windows toktx needs the Microsoft Visual C\+\+ Redistributable/)
    } finally {
      delete CONVERSION_CLI_PINS.toktx.dist[winKey]
    }
  })

  it("a concurrent install that finished first is kept, and this one succeeds on the winner's copy", async () => {
    // Another editor (one per clone, one machine-wide dir) completes the same install while this one
    // is unpacking. Before the fix this process deleted the winner's dir and/or failed its rename.
    const bytes = Buffer.from('an asset')
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: sha(bytes), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const bin = conversionCliBin(base, 'msdf-atlas-gen', TEST_PLATFORM)
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'msdf-atlas-gen'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'msdf-atlas-gen', 'msdf-atlas-gen'), 'mine')
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.writeFileSync(bin, 'the winner') // the other process's rename lands now
    }
    expect(await ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes), { expand, probe: () => true }))).toBe(bin)
    expect(fs.readFileSync(bin, 'utf8')).toBe('the winner')
    expect(leftovers('msdf-atlas-gen')).toEqual(['1.4-skia'])
  })

  it.skipIf(process.platform === 'win32')('the REAL probe treats a non-executable copy as broken and repairs it', async () => {
    const bytes = Buffer.from('a runnable asset')
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: sha(bytes), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const bin = conversionCliBin(base, 'msdf-atlas-gen', TEST_PLATFORM)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o644 }) // EACCES — a definite "cannot run"
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'msdf-atlas-gen'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'msdf-atlas-gen', 'msdf-atlas-gen'), '#!/bin/sh\necho repaired\n')
    }
    await ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes), { expand }))
    expect(spawnSync(bin, ['-version'], { encoding: 'utf8' }).stdout).toContain('repaired')
    expect(leftovers('msdf-atlas-gen')).toEqual(['1.4-skia'])
  })

  it('a leftover dir WITHOUT the executable is debris: moved aside and replaced', async () => {
    const bytes = Buffer.from('an asset')
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: sha(bytes), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const dir = conversionCliDir(base, 'msdf-atlas-gen')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'half-written'), 'x')
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'msdf-atlas-gen'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'msdf-atlas-gen', 'msdf-atlas-gen'), 'fresh')
    }
    await ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes), { expand, probe: () => true }))
    expect(fs.readdirSync(dir)).toEqual(['msdf-atlas-gen'])
    expect(leftovers('msdf-atlas-gen')).toEqual(['1.4-skia'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a broken copy that cannot be moved aside fails with THAT reason, before any download', async () => {
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: '0'.repeat(64), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const bin = conversionCliBin(base, 'msdf-atlas-gen', TEST_PLATFORM)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, 'broken')
    const held = path.dirname(path.dirname(bin)) // `<base>/msdf-atlas-gen`: its entries cannot be renamed
    fs.chmodSync(held, 0o555)
    const neverFetch: FetchLike = async () => { throw new Error('must not download a replacement it cannot put in place') }
    try {
      await expect(ensureConversionCli('msdf-atlas-gen', base, opts(neverFetch, { probe: () => false })))
        .rejects.toThrow(/does not run and could not be moved aside/)
    } finally {
      fs.chmodSync(held, 0o755)
    }
  })

  it('reinstalls a RUNNING copy that lacks a kept file — a pre-#1351 toktx dir has no ktx', async () => {
    const bytes = Buffer.from('a pkg with ktx')
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = {
      url: 'https://example.invalid/k2.pkg', sha256: sha(bytes), kind: 'macos-pkg',
      files: [['p/toktx', 'toktx'], ['p/ktx', 'ktx']],
    }
    const dir = conversionCliDir(base, 'toktx')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(conversionCliBin(base, 'toktx', TEST_PLATFORM), 'old toktx') // runs, but no ktx
    let fetched = 0
    let oldCopyDuringDownload = ''
    const fetchImpl: FetchLike = async (u) => {
      fetched++
      // Sibling clones still convert with the RUNNING copy — it must not vanish for the download.
      oldCopyDuringDownload = fs.readFileSync(conversionCliBin(base, 'toktx', TEST_PLATFORM), 'utf8')
      return fakeFetch(bytes)(u)
    }
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'p'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'p', 'toktx'), 'new toktx')
      fs.writeFileSync(path.join(dest, 'p', 'ktx'), 'new ktx')
    }
    const logs: string[] = []
    await ensureConversionCli('toktx', base, opts(fetchImpl, { expand, probe: () => true, onLog: (l: string) => logs.push(l) }))
    expect(fetched).toBe(1)
    expect(oldCopyDuringDownload).toBe('old toktx')
    expect(logs.join('\n')).toMatch(/has no ktx — reinstalling/)
    expect(fs.readFileSync(conversionCliBin(base, 'toktx', TEST_PLATFORM), 'utf8')).toBe('new toktx')
    expect(fs.readdirSync(dir).sort()).toEqual(['ktx', 'toktx'])
  })

  it('a repair whose move-in fails puts the old RUNNING copy back instead of leaving no tool', async () => {
    const bytes = Buffer.from('a pkg with ktx, held')
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = {
      url: 'https://example.invalid/k3.pkg', sha256: sha(bytes), kind: 'macos-pkg',
      files: [['p/toktx', 'toktx'], ['p/ktx', 'ktx']],
    }
    const dir = conversionCliDir(base, 'toktx')
    const bin = conversionCliBin(base, 'toktx', TEST_PLATFORM)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(bin, 'old toktx') // runs, but no ktx
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'p'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'p', 'toktx'), 'new toktx')
      fs.writeFileSync(path.join(dest, 'p', 'ktx'), 'new ktx')
    }
    // A scanner holding the freshly staged files: every move of `staged` onto the live dir fails.
    const realRename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith(`${path.sep}staged`) && String(to) === dir) {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      }
      return realRename(from, to)
    })
    try {
      await expect(ensureConversionCli('toktx', base, opts(fakeFetch(bytes), { expand, probe: () => true }))).rejects.toThrow(/EBUSY/)
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(bin, 'utf8')).toBe('old toktx')
    expect(fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.discard-'))).toEqual([])
  })

  it('a held incomplete copy fails with the in-use reason; a held OLD copy after the swap does not fail the repair', async () => {
    const bytes = Buffer.from('a pkg with ktx, held old')
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = {
      url: 'https://example.invalid/k4.pkg', sha256: sha(bytes), kind: 'macos-pkg',
      files: [['p/toktx', 'toktx'], ['p/ktx', 'ktx']],
    }
    const dir = conversionCliDir(base, 'toktx')
    const bin = conversionCliBin(base, 'toktx', TEST_PLATFORM)
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'p'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'p', 'toktx'), 'new toktx')
      fs.writeFileSync(path.join(dest, 'p', 'ktx'), 'new ktx')
    }
    const realRename = fs.renameSync
    const realRm = fs.rmSync
    const busy = () => Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })

    // 1. The old dir cannot be moved aside at all → the friendly reason, and the old copy stays.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(bin, 'old toktx')
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === dir && String(to).includes('.discard-')) throw busy()
      return realRename(from, to)
    })
    try {
      await expect(ensureConversionCli('toktx', base, opts(fakeFetch(bytes), { expand, probe: () => true })))
        .rejects.toThrow(/is incomplete and could not be moved aside/)
    } finally { spy.mockRestore() }
    expect(fs.readFileSync(bin, 'utf8')).toBe('old toktx')

    // 2. The swap succeeds but deleting the old copy fails → the repair still succeeds.
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (String(p).includes('.discard-')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return realRm(p, o)
    })
    try {
      expect(await ensureConversionCli('toktx', base, opts(fakeFetch(bytes), { expand, probe: () => true }))).toBe(bin)
    } finally { rmSpy.mockRestore() }
    expect(fs.readFileSync(bin, 'utf8')).toBe('new toktx')
  })

  it('is idempotent — a present binary is returned without downloading', async () => {
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = { url: 'https://example.invalid/k.pkg', sha256: '0'.repeat(64), kind: 'macos-pkg', files: [] }
    const bin = conversionCliBin(base, 'toktx', TEST_PLATFORM)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '')
    const neverFetch: FetchLike = async () => { throw new Error('fetch must not be called when toktx is present') }
    expect(await ensureConversionCli('toktx', base, opts(neverFetch, { probe: () => true }))).toBe(bin)
  })

  it.skipIf(process.platform === 'win32')('unpacks a real tar.gz into the versioned dir, runnable, with no staging residue', async () => {
    // A real archive through the real extractor — the path `toolchain:install` failed on before
    // loadVendorPlugins stopped bundling into os.tmpdir() (#1327).
    const src = makeScratchDir('modoki-convcli-src-')
    fs.mkdirSync(path.join(src, 'msdf-atlas-gen'))
    fs.writeFileSync(path.join(src, 'msdf-atlas-gen', 'msdf-atlas-gen'), '#!/bin/sh\necho "MSDF-Atlas-Gen v1.4.0"\n', { mode: 0o755 })
    const tarball = path.join(src, 'asset.tar.gz')
    const tar = createRequire(import.meta.url)('tar') as typeof import('tar')
    await tar.c({ gzip: true, file: tarball, cwd: src }, ['msdf-atlas-gen'])
    const bytes = fs.readFileSync(tarball)
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/msdf.tar.gz', sha256: sha(bytes), kind: 'tar.gz',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    try {
      const bin = await ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes)))
      expect(bin).toBe(path.join(base, 'msdf-atlas-gen', '1.4-skia', 'msdf-atlas-gen'))
      expect(spawnSync(bin, ['-version'], { encoding: 'utf8' }).stdout).toContain('v1.4.0')
      expect(leftovers('msdf-atlas-gen')).toEqual(['1.4-skia'])
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')("keeps exactly the pin's files, copying a symlinked dylib as its real bytes (the KTX pkg layout)", async () => {
    // The pkg expander is injected (pkgutil is macOS-only); the FILE MAP is the real darwin-arm64 one.
    const real = CONVERSION_CLI_PINS.toktx.dist['darwin-arm64']
    const bytes = Buffer.from('a pkg')
    CONVERSION_CLI_PINS.toktx.dist[TEST_KEY] = { ...real, sha256: sha(bytes) }
    const expand = async (_kind: string, _archive: string, dest: string) => {
      const from = (to: string) => path.join(dest, real.files.find(([, t]) => t === to)![0])
      for (const [to, bytes] of [['toktx', 'toktx-bytes'], ['ktx', 'ktx-bytes'], ['libktx.4.dylib', 'libktx-bytes']]) {
        fs.mkdirSync(path.dirname(from(to)), { recursive: true })
        fs.writeFileSync(from(to), bytes)
      }
      const lib = from('libktx.4.dylib')
      // What the pkg really ships beside it: symlinks, and payload nobody asked for.
      fs.symlinkSync(path.basename(lib), path.join(path.dirname(lib), 'libktx.4.dylib'))
      fs.writeFileSync(path.join(path.dirname(lib), 'libktx-jni.dylib'), 'unwanted')
    }
    await ensureConversionCli('toktx', base, opts(fakeFetch(bytes), { expand, probe: () => true }))
    const dir = conversionCliDir(base, 'toktx')
    // `ktx` is kept too: gltf-transform encodes rigged KTX2 with it, beside toktx (#1351).
    expect(fs.readdirSync(dir).sort()).toEqual(['ktx', 'libktx.4.dylib', 'toktx'])
    expect(fs.readFileSync(path.join(dir, 'ktx'), 'utf8')).toBe('ktx-bytes')
    expect(fs.lstatSync(path.join(dir, 'libktx.4.dylib')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'libktx.4.dylib'), 'utf8')).toBe('libktx-bytes')
  })

  it('an asset whose layout no longer matches the pin fails loudly and leaves nothing', async () => {
    const bytes = Buffer.from('a renamed layout')
    CONVERSION_CLI_PINS['msdf-atlas-gen'].dist[TEST_KEY] = {
      url: 'https://example.invalid/m.zip', sha256: sha(bytes), kind: 'zip',
      files: [['msdf-atlas-gen/msdf-atlas-gen', 'msdf-atlas-gen']],
    }
    const expand = async (_k: string, _a: string, dest: string) => {
      fs.mkdirSync(path.join(dest, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'bin', 'msdf-atlas-gen'), 'moved')
    }
    await expect(ensureConversionCli('msdf-atlas-gen', base, opts(fakeFetch(bytes), { expand })))
      .rejects.toThrow(/has no msdf-atlas-gen\/msdf-atlas-gen — its layout changed/)
    expect(leftovers('msdf-atlas-gen')).toEqual([])
  })
})

describe('ranOk — which spawn results mean "this copy is broken" (#1327)', () => {
  const err = (code: string) => Object.assign(new Error(code), { code })
  it('a clean exit runs; a non-zero exit (e.g. a missing DLL, 0xC0000135) does not', () => {
    expect(ranOk({ status: 0 })).toBe(true)
    expect(ranOk({ status: 1 })).toBe(false)
    expect(ranOk({ status: null })).toBe(false) // killed by a signal
  })
  for (const code of ['ENOENT', 'EACCES', 'ENOEXEC', 'EFTYPE', 'EPERM', 'EISDIR']) {
    it(`${code} is a definite cannot-execute${code === 'EFTYPE' ? ' (a truncated .exe on Windows)' : ''}`, () => {
      expect(ranOk({ error: err(code), status: null })).toBe(false)
    })
  }
  for (const code of ['EAGAIN', 'EMFILE', 'ENOMEM']) {
    it(`${code} is transient: rethrown, so a working install is never "repaired" away`, () => {
      expect(() => ranOk({ error: err(code), status: null })).toThrow(code)
    })
  }
})

describe('the pin table covers what the editor ships on', () => {
  it('both tools are pinned for arm64 macOS and x64 Windows, each with a real sha256', () => {
    for (const id of ['toktx', 'msdf-atlas-gen'] as const) {
      for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']] as const) {
        const d = conversionCliDist(id, platform, arch)
        expect(d, `${id} ${platform}-${arch}`).toBeDefined()
        expect(d!.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(d!.url).toMatch(/^https:\/\//)
        expect(d!.files.length).toBeGreaterThan(0)
      }
    }
  })

  it('the Windows KTX installer is only auto-unpackable where a 7-Zip exists', () => {
    const saved = { PATH: process.env.PATH, ProgramFiles: process.env.ProgramFiles, ProgramW6432: process.env.ProgramW6432 }
    try {
      process.env.PATH = makeScratchDir('modoki-no7z-')
      delete process.env.ProgramFiles
      delete process.env.ProgramW6432
      expect(canExpand('nsis-exe')).toBe(false)
      for (const k of ['macos-pkg', 'tar.gz', 'zip'] as const) expect(canExpand(k), k).toBe(true)
    } finally {
      fs.rmSync(process.env.PATH!, { recursive: true, force: true })
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('the Windows executable path carries .exe', () => {
    expect(conversionCliBin('/tc', 'toktx', 'win32')).toBe(path.join('/tc', 'toktx', '4.4.2', 'toktx.exe'))
    expect(conversionCliBin('/tc', 'msdf-atlas-gen', 'darwin')).toBe(path.join('/tc', 'msdf-atlas-gen', '1.4-skia', 'msdf-atlas-gen'))
  })
})

/** `npm run toolchain:install` reaches install() through loadVendorPlugins, which esbuilds the
 *  toolchain with packages EXTERNAL — so the bundle's lazy `require('tar')` resolves from wherever
 *  the bundle was written. It was written to os.tmpdir(), where no node_modules exists, and every
 *  archive-shipped install through the CLI failed with "Cannot find module 'tar'" (#1327). */
describe.skipIf(process.platform === 'win32')("toolchain:install's loaded toolchain can unpack an archive (#1327)", () => {
  it("the bundled nodeProvision resolves the repo's tar and extracts with it", async () => {
    const repoRoot = path.resolve(__dirname, '../../..')
    const { module: mod, reason } = await loadEnginePluginModuleResult(repoRoot, path.join('toolchain', 'nodeProvision.ts'))
    expect(reason).toBeNull()
    const src = makeScratchDir('modoki-loader-tar-')
    try {
      fs.writeFileSync(path.join(src, 'payload.txt'), 'unpacked')
      const tarball = path.join(src, 'a.tar.gz')
      await (createRequire(import.meta.url)('tar') as typeof import('tar')).c({ gzip: true, file: tarball, cwd: src }, ['payload.txt'])
      const dest = path.join(src, 'out')
      fs.mkdirSync(dest)
      await (mod as { extractArchive: (a: string, d: string, k: 'tar.gz') => Promise<void> }).extractArchive(tarball, dest, 'tar.gz')
      expect(fs.readFileSync(path.join(dest, 'payload.txt'), 'utf8')).toBe('unpacked')
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })
})
