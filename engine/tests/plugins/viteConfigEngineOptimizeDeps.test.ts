import { describe, it, expect, afterEach } from 'vitest'
import type { UserConfig } from 'vite'

/**
 * Regression guard for the packaged-editor dep-optimize stabilization fix.
 *
 * electron-builder DEREFERENCES the @modoki/engine symlink into a real node_modules dir in a
 * packaged app, so Vite OPTIMIZES it there (in dev it's a symlinked SOURCE dep, never optimized —
 * that's what gives engine code Fast Refresh). Games import `@modoki/engine/runtime/rendering`,
 * which the editor's OWN startup graph does not reach — so opening a project made a packaged
 * editor re-optimize mid-session, rehashing every @modoki_engine_* chunk. The already-loaded
 * `runtime.js?v=<old>` then threw "does not provide an export named …", blanking the renderer
 * (see texture-load-bug.md's follow-up / the "Couldn't open this project" screen). The fix
 * pre-bundles those subpaths via optimizeDeps.include, gated on MODOKI_VITE_CACHEDIR (set ONLY
 * when packaged — see electron/main.ts) so dev keeps engine HMR.
 */
describe('vite.config @modoki/engine optimizeDeps.include (packaged dep-optimize fix)', () => {
  const ENV_KEY = 'MODOKI_VITE_CACHEDIR'
  const prevEnv = process.env[ENV_KEY]

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevEnv
  })

  async function buildConfig(): Promise<UserConfig> {
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    // 'serve' = the running editor path (matches the msdf-alias test's convention).
    return factory({ command: 'serve', mode: 'development' })
  }

  it('packaged (MODOKI_VITE_CACHEDIR set): pre-bundles the game-only @modoki/engine subpaths', async () => {
    process.env[ENV_KEY] = '/tmp/fake-userdata/vite-cache'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []

    // runtime/rendering is the specific subpath the editor's startup graph never imports (only
    // games do) — its absence from a cold-start optimize is the exact trigger for the bug.
    expect(include).toContain('@modoki/engine/runtime/rendering')
    // The rest of the editor's own @modoki/engine specifiers, pinned too so the WHOLE package's
    // optimize hash is stable before any game module loads.
    expect(include).toContain('@modoki/engine/runtime')
    expect(include).toContain('@modoki/engine/runtime/debug')
    expect(include).toContain('@modoki/engine/editor')
    expect(include).toContain('@modoki/engine/editor/rendering')
    expect(include).toContain('@modoki/engine/three')
  })

  it('dev (MODOKI_VITE_CACHEDIR unset): does NOT force @modoki/engine into optimizeDeps', async () => {
    delete process.env[ENV_KEY]
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []

    // @modoki/engine must stay OFF the optimize list in dev — it's a symlinked source dep there,
    // and forcing it in would replace engine Fast Refresh with full page reloads on every edit.
    expect(include.some((spec) => spec.startsWith('@modoki/engine'))).toBe(false)
  })

  it('still excludes @zappar/msdf-generator regardless of packaged state', async () => {
    process.env[ENV_KEY] = '/tmp/fake-userdata/vite-cache'
    const packaged = await buildConfig()
    delete process.env[ENV_KEY]
    const dev = await buildConfig()

    expect(packaged.optimizeDeps?.exclude).toContain('@zappar/msdf-generator')
    expect(dev.optimizeDeps?.exclude).toContain('@zappar/msdf-generator')
  })
})
