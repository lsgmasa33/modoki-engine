import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { UserConfig } from 'vite'
import { hasRealProjects } from '../helpers/repoLayout'

/**
 * Regression guard for the packaged-editor "project opens TWICE" bug.
 *
 * A game's `packages/app-services` (AppLovin/Adjust/Firebase native-SDK wrappers, per CLAUDE.md's
 * Native SDK Pattern) is dynamic-imported only from inside the game module, so Vite's cold-start
 * dep-optimize scan never sees those deps — it discovers them mid-session instead, forces a full
 * page reload to re-optimize, and the editor's project-open flow (asset import progress dialog)
 * visibly runs twice. Confirmed live via a packaged Windows install: every boot logged
 * `dependencies optimized: @capacitor-firebase/analytics, @capacitor-firebase/crashlytics` +
 * `optimized dependencies changed. reloading` right after the dev server came up.
 *
 * Two gotchas the fix (and these tests) guard against, both found live on a packaged install:
 *  1. A bare package NAME in optimizeDeps.include resolves relative to Vite's OWN root (engine/),
 *     not the game project — `games/<id>`'s own node_modules (npm workspaces don't hoist these)
 *     is a SIBLING of engine/, not an ancestor, so the bare name silently fails to resolve and
 *     Vite falls back to the exact lazy discovery this was meant to prevent.
 *  2. Handing Vite the resolved ABSOLUTE PATH instead fixes the cold scan, but the game's own
 *     `import … from '@capacitor-firebase/analytics'` still resolves the BARE name from ITS OWN
 *     location at live-import time — a different id than the absolute path, as far as the
 *     optimizer's cache is concerned — so it re-optimizes anyway. Fix: also alias the bare name to
 *     the SAME resolved path, so cold-scan-time and live-import-time resolution agree.
 */
// Requires a real `games/3d-test` project, which the PUBLIC engine snapshot
// (lsgmasa33/modoki-engine) does not ship. NOTE: hasRealProjects() only proves `games/`
// exists in this checkout — it does NOT prove games/3d-test's `node_modules` (in particular
// `@capacitor-firebase/analytics` + `@capacitor-firebase/crashlytics`) are installed. A clone
// that has `games/` but never ran the per-game `npm install` for 3d-test will still fail these
// assertions — that is a real signal (the deps genuinely are not there), not a bug in this gate,
// so the `fs.existsSync` checks below are left as-is rather than weakened to paper over it.
describe.skipIf(!hasRealProjects())('vite.config native-SDK app-services deps (packaged double-reload fix)', () => {
  const ENV_KEYS = ['MODOKI_VITE_CACHEDIR', 'MODOKI_PROJECT'] as const
  const prevEnv: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k]

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k]
      else process.env[k] = prevEnv[k]
    }
  })

  // projectNativeSdkDeps is computed at TRUE MODULE TOP-LEVEL (it depends on MODOKI_PROJECT,
  // read once at first import) — unlike the MODOKI_VITE_CACHEDIR-gated blocks inside the
  // defineConfig(...) factory, which re-read env fresh on every call. So a stale cached import
  // would silently reuse whichever project was open first. vi.resetModules() forces the
  // top-level project resolution to rerun for each test's MODOKI_PROJECT.
  async function buildConfig(): Promise<UserConfig> {
    vi.resetModules()
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    return factory({ command: 'serve', mode: 'development' })
  }

  it('packaged + a project WITH app-services: cold-bundles its resolvable deps and aliases them to the same absolute path', async () => {
    process.env.MODOKI_VITE_CACHEDIR = '/tmp/fake-userdata/vite-cache'
    process.env.MODOKI_PROJECT = 'games/3d-test'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []
    const alias = config.resolve?.alias as Record<string, string> | undefined

    expect(include).toContain('@capacitor-firebase/analytics')
    expect(include).toContain('@capacitor-firebase/crashlytics')

    // The alias must point at the SAME resolved file the cold scan bundled — a real, existing
    // absolute path inside the game's OWN node_modules (not the engine's).
    const analyticsAlias = alias?.['@capacitor-firebase/analytics']
    const crashlyticsAlias = alias?.['@capacitor-firebase/crashlytics']
    expect(analyticsAlias).toBeTruthy()
    expect(crashlyticsAlias).toBeTruthy()
    expect(path.isAbsolute(analyticsAlias!)).toBe(true)
    expect(fs.existsSync(analyticsAlias!)).toBe(true)
    expect(analyticsAlias).toContain(path.join('games', '3d-test', 'node_modules'))
    expect(fs.existsSync(crashlyticsAlias!)).toBe(true)
  })

  it('does not force-include a local/workspace app-services dep (file:/link:/workspace: specifiers)', async () => {
    process.env.MODOKI_VITE_CACHEDIR = '/tmp/fake-userdata/vite-cache'
    process.env.MODOKI_PROJECT = 'games/3d-test'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []
    const alias = config.resolve?.alias as Record<string, string> | undefined

    // capacitor-adjust / capacitor-applovin-max are `file:../…` in app-services/package.json —
    // local source packages, like @modoki/engine, not registry deps. Forcing them into the cold
    // optimizer would fight the same staleness class this fix is meant to resolve.
    expect(include).not.toContain('capacitor-adjust')
    expect(include).not.toContain('capacitor-applovin-max')
    expect(alias?.['capacitor-adjust']).toBeUndefined()
    expect(alias?.['capacitor-applovin-max']).toBeUndefined()
  })

  it('does not throw on an unresolvable app-services dep, and excludes it from include/alias', async () => {
    process.env.MODOKI_VITE_CACHEDIR = '/tmp/fake-userdata/vite-cache'
    process.env.MODOKI_PROJECT = 'games/3d-test'

    // `firebase` is declared in app-services/package.json but is ESM-only with no root `exports`
    // entry reachable via require.resolve (a peer dep of @capacitor-firebase/*, never imported by
    // bare name from game code) — it must be skipped, not crash config evaluation. (The skip logs
    // a console.warn too, but vite.config.ts loads through Vite's own SSR module runner here,
    // which doesn't share a `console` reference with vi.spyOn in this jsdom test env — so this
    // asserts the behavior that actually matters: no throw, cleanly excluded.)
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []
    const alias = config.resolve?.alias as Record<string, string> | undefined
    expect(include).not.toContain('firebase')
    expect(alias?.firebase).toBeUndefined()
  })

  it('a project with no packages/app-services (e.g. games/sling) adds nothing beyond the base @modoki/engine list', async () => {
    process.env.MODOKI_VITE_CACHEDIR = '/tmp/fake-userdata/vite-cache'
    process.env.MODOKI_PROJECT = 'games/sling'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []
    const alias = config.resolve?.alias as Record<string, string> | undefined

    const baseline = new Set([
      '@modoki/engine/runtime',
      '@modoki/engine/runtime/rendering',
      '@modoki/engine/runtime/debug',
      '@modoki/engine/editor',
      '@modoki/engine/editor/rendering',
      '@modoki/engine/three',
    ])
    for (const spec of include) expect(baseline.has(spec)).toBe(true)
    expect(Object.keys(alias ?? {}).some((k) => k.startsWith('@capacitor-firebase'))).toBe(false)
  })

  it('dev (MODOKI_VITE_CACHEDIR unset): does not force app-services deps into optimizeDeps even for a project that has them', async () => {
    delete process.env.MODOKI_VITE_CACHEDIR
    process.env.MODOKI_PROJECT = 'games/3d-test'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []
    const alias = config.resolve?.alias as Record<string, string> | undefined

    expect(include).not.toContain('@capacitor-firebase/analytics')
    expect(include).not.toContain('@capacitor-firebase/crashlytics')
    expect(alias?.['@capacitor-firebase/analytics']).toBeUndefined()
  })
})
