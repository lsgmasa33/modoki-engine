import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildStepEnv, resolveGcloudDir } from '../../plugins/vite-asset-scanner'

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

describe('resolveGcloudDir — gcloud resolution for web deploy', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-gcloud-')) })
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
