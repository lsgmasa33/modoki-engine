import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildStepEnv, resolveGcloudDir } from '../../plugins/vite-asset-scanner'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

// Only the provisioned-branch tests reach ensureNode; a fake keeps them offline.
vi.mock('../../toolchain', async (orig) => ({
  ...(await orig<typeof import('../../toolchain')>()),
  ensureNode: vi.fn(async (d: string) => ({ nodeBin: path.join(d, 'bin', 'node'), npmCli: path.join(d, 'npm-cli.js') })),
}))

/**
 * Guards the /api/build step-env helper's NO-PROVISION branches (dev / not opted in), which are
 * deterministic and need no network. The provisioning branch (downloads a real Node, prepends its
 * bin dir to PATH) is validated manually end-to-end — see the toolchain-layer plan's Phase D note.
 */
describe('buildStepEnv — no-provision branches', () => {
  let savedProvision: string | undefined
  let savedDir: string | undefined
  beforeEach(() => {
    savedProvision = process.env.MODOKI_PROVISION_NODE
    savedDir = process.env.MODOKI_TOOLCHAIN_DIR
  })
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    restore('MODOKI_PROVISION_NODE', savedProvision)
    restore('MODOKI_TOOLCHAIN_DIR', savedDir)
  })

  it('is a no-op (system Node) when provisioning is not requested — dev', async () => {
    delete process.env.MODOKI_PROVISION_NODE
    process.env.MODOKI_TOOLCHAIN_DIR = '/tmp/whatever'
    const env = await buildStepEnv({ MODOKI_PROJECT: '/p' })
    expect(env.MODOKI_NODE).toBeUndefined()
    expect(env.MODOKI_PROJECT).toBe('/p') // extra merged
    expect(env.PATH).toBe(process.env.PATH) // PATH untouched
  })

  it('is a no-op when opted in but no toolchain dir is set', async () => {
    process.env.MODOKI_PROVISION_NODE = '1'
    delete process.env.MODOKI_TOOLCHAIN_DIR
    const env = await buildStepEnv()
    expect(env.MODOKI_NODE).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
  })
})

// The packaged editor's branch (#1444 close-out): the provisioned node dir goes FIRST and the rest
// of PATH survives. On win32 the parent's env is keyed `Path` when the editor was launched from
// Explorer/PowerShell; a `base.PATH` read off the spread then saw undefined and the build steps
// lost every system tool. The test re-keys process.env to `Path` to be that parent.
describe('buildStepEnv — provisioned branch', () => {
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = { MODOKI_PROVISION_NODE: process.env.MODOKI_PROVISION_NODE, MODOKI_TOOLCHAIN_DIR: process.env.MODOKI_TOOLCHAIN_DIR, PATH: process.env.PATH }
    process.env.MODOKI_PROVISION_NODE = '1'
    process.env.MODOKI_TOOLCHAIN_DIR = path.join('/tc')
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'PATH') delete process.env[k]
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  it('puts the provisioned node dir first and keeps the system PATH', async () => {
    const sys = saved.PATH ?? ''
    const env = await buildStepEnv({ MODOKI_PROJECT: '/p' })
    expect(env.PATH).toBe(`${path.join('/tc', 'node', 'bin')}${path.delimiter}${sys}`)
    expect(env.MODOKI_NODE).toBe(path.join('/tc', 'node', 'bin', 'node'))
    expect(env.MODOKI_PROJECT).toBe('/p')
  })

  it.runIf(process.platform === 'win32')('reads a `Path`-keyed parent env and leaves ONE PATH key', async () => {
    const sys = saved.PATH ?? ''
    delete process.env.PATH
    process.env.Path = sys
    expect(Object.keys({ ...process.env }).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    const env = await buildStepEnv()
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH'])
    expect(env.PATH).toBe(`${path.join('/tc', 'node', 'bin')};${sys}`)
  })
})

describe('resolveGcloudDir — gcloud resolution for web deploy', () => {
  let tmp: string
  beforeEach(() => { tmp = makeScratchDir('modoki-gcloud-') })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('an override pointing at the gcloud BINARY returns its dir', () => {
    const bin = path.join(tmp, 'gcloud')
    fs.writeFileSync(bin, '#!/bin/sh\n'); fs.chmodSync(bin, 0o755)
    expect(resolveGcloudDir(bin)).toBe(tmp)
  })

  it('an override pointing at a bin DIR containing gcloud returns that dir', () => {
    fs.writeFileSync(path.join(tmp, 'gcloud'), '#!/bin/sh\n')
    expect(resolveGcloudDir(tmp)).toBe(tmp)
  })

  it('an override that does not resolve falls through (does not return the bad path)', () => {
    // A non-existent override must NOT be returned as-is — it falls back to detection.
    const bogus = path.join(tmp, 'nope', 'gcloud')
    expect(resolveGcloudDir(bogus)).not.toBe(path.dirname(bogus))
  })
})
