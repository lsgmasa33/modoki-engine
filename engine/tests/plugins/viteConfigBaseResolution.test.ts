import { describe, it, expect, afterEach, vi } from 'vitest'
import type { UserConfig } from 'vite'

/**
 * Regression guard for #40: a CLI `MODOKI_PROJECT=games/sling npm run build` used to always
 * emit `base: '/'`, ignoring the project's `build.webBasePath` — a blank page when the dist was
 * served from a sub-path. `engine/scripts/build-web.mjs` now requires `--target web|native|
 * playable` and forwards it as MODOKI_BUILD_TARGET; vite.config.ts's `resolvedBase` only honors
 * `build.webBasePath` for a `web` target — `native`/no-target stay `/` (Capacitor serves from the
 * app root; a playable is one self-contained file). An explicit BASE_PATH always wins (the
 * editor's own web-deploy step relies on this).
 */
describe('vite.config base resolution (#40)', () => {
  const ENV_KEYS = ['MODOKI_VITE_CACHEDIR', 'MODOKI_PROJECT', 'MODOKI_BUILD_TARGET', 'BASE_PATH'] as const
  const prevEnv: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k]

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
    process.env.MODOKI_PROJECT = 'games/sling'
    process.env.MODOKI_BUILD_TARGET = 'web'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/sling/')
  })

  it('MODOKI_BUILD_TARGET=native stays "/" regardless of build.webBasePath', async () => {
    process.env.MODOKI_PROJECT = 'games/sling'
    process.env.MODOKI_BUILD_TARGET = 'native'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('no MODOKI_BUILD_TARGET stays "/" (a direct `vite build` — build:editor, build-subgame.mjs)', async () => {
    process.env.MODOKI_PROJECT = 'games/sling'
    delete process.env.MODOKI_BUILD_TARGET
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('an explicit BASE_PATH always wins, even over target=web', async () => {
    process.env.MODOKI_PROJECT = 'games/sling'
    process.env.MODOKI_BUILD_TARGET = 'web'
    process.env.BASE_PATH = '/custom/'
    const config = await buildConfig()
    expect(config.base).toBe('/custom/')
  })

  it('MODOKI_BUILD_TARGET=playable stays "/" — a playable is one self-contained file', async () => {
    process.env.MODOKI_PROJECT = 'games/sling'
    process.env.MODOKI_BUILD_TARGET = 'playable'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })

  it('target=web with build.webBasePath "/" stays "/" (games/timeline-demo)', async () => {
    // Verified games/timeline-demo/project.config.json has build.webBasePath: "/" — exercises
    // the branch where webBasePath is explicitly "/" rather than the `|| '/'` fallback.
    process.env.MODOKI_PROJECT = 'games/timeline-demo'
    process.env.MODOKI_BUILD_TARGET = 'web'
    delete process.env.BASE_PATH
    const config = await buildConfig()
    expect(config.base).toBe('/')
  })
})
