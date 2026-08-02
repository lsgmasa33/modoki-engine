import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UserConfig } from 'vite'

/**
 * Regression guard for #40: a CLI `MODOKI_PROJECT=games/sling npm run build` used to always
 * emit `base: '/'`, ignoring the project's `build.webBasePath` — a blank page when the dist was
 * served from a sub-path. `engine/scripts/build-web.mjs` now requires `--target web|native|
 * playable` and forwards it as MODOKI_BUILD_TARGET; vite.config.ts's `resolvedBase` only honors
 * `build.webBasePath` for a `web` target — `native`/no-target stay `/` (Capacitor serves from the
 * app root; a playable is one self-contained file). An explicit BASE_PATH always wins (the
 * editor's own web-deploy step relies on this).
 *
 * This is a pure config-resolution unit test — it needs only a `project.config.json` with a
 * known `build.webBasePath`, not real game content — so it mints its OWN throwaway project dirs
 * (outside the repo, via os.tmpdir()) instead of pointing at `games/sling` / `games/timeline-demo`,
 * neither of which the PUBLIC engine snapshot (lsgmasa33/modoki-engine) ships. vite.config.ts's
 * `externalProject` handling (see the top of that file) resolves an out-of-repo MODOKI_PROJECT
 * fine — verified live by this file.
 */
describe('vite.config base resolution (#40)', () => {
  const ENV_KEYS = ['MODOKI_VITE_CACHEDIR', 'MODOKI_PROJECT', 'MODOKI_BUILD_TARGET', 'BASE_PATH'] as const
  const prevEnv: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k]

  // Two throwaway projects: one with a distinctive non-root webBasePath (stands in for
  // games/sling's '/sling/'), one with '/' (stands in for games/timeline-demo's explicit '/' —
  // exercises the branch where webBasePath is explicitly '/' rather than the `|| '/'` fallback).
  let subpathProjectDir: string
  let rootProjectDir: string

  beforeAll(() => {
    subpathProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-basepath-'))
    fs.writeFileSync(
      path.join(subpathProjectDir, 'project.config.json'),
      JSON.stringify({ build: { webBasePath: '/subpath-fixture/' } }, null, 2),
    )
    rootProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-basepath-'))
    fs.writeFileSync(
      path.join(rootProjectDir, 'project.config.json'),
      JSON.stringify({ build: { webBasePath: '/' } }, null, 2),
    )
  })

  afterAll(() => {
    fs.rmSync(subpathProjectDir, { recursive: true, force: true })
    fs.rmSync(rootProjectDir, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k]
      else process.env[k] = prevEnv[k]
    }
  })

  // Mirrors viteConfigNativeSdkDeps.test.ts's pattern: MODOKI_PROJECT is read at true module
  // top-level, so vi.resetModules() is required for each test's project/env to take effect.
  async function buildConfig(command: 'build' | 'serve' = 'build'): Promise<UserConfig> {
    vi.resetModules()
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    return factory({ command, mode: 'production' })
  }

  it('MODOKI_BUILD_TARGET=web honors build.webBasePath', async () => {
    process.env.MODOKI_PROJECT = subpathProjectDir
    process.env.MODOKI_BUILD_TARGET = 'web'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/subpath-fixture/')
  })

  it('MODOKI_BUILD_TARGET=native stays "/" regardless of build.webBasePath', async () => {
    process.env.MODOKI_PROJECT = subpathProjectDir
    process.env.MODOKI_BUILD_TARGET = 'native'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('no MODOKI_BUILD_TARGET stays "/" (a direct `vite build` — build:editor, build-subgame.mjs)', async () => {
    process.env.MODOKI_PROJECT = subpathProjectDir
    delete process.env.MODOKI_BUILD_TARGET
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('an explicit BASE_PATH always wins, even over target=web', async () => {
    process.env.MODOKI_PROJECT = subpathProjectDir
    process.env.MODOKI_BUILD_TARGET = 'web'
    process.env.BASE_PATH = '/custom/'
    const config = await buildConfig()
    expect(config.base).toBe('/custom/')
  })

  it('MODOKI_BUILD_TARGET=playable stays "/" — a playable is one self-contained file', async () => {
    process.env.MODOKI_PROJECT = subpathProjectDir
    process.env.MODOKI_BUILD_TARGET = 'playable'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('target=web with build.webBasePath "/" stays "/"', async () => {
    // Exercises the branch where webBasePath is explicitly "/" rather than the `|| '/'` fallback.
    process.env.MODOKI_PROJECT = rootProjectDir
    process.env.MODOKI_BUILD_TARGET = 'web'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })
})
