import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { UserConfig } from 'vite'

/**
 * Regression guard for the packaged-editor @zappar/msdf-generator resolution fix.
 *
 * @zappar/msdf-generator is optimizeDeps.exclude'd (it self-resolves its WASM + worker via
 * `new URL(..., import.meta.url)`), so its bare import survives inside OTHER optimized dep chunks
 * (e.g. SceneManager). A packaged editor relocates Vite's dep-optimize cache OUT of the tree
 * (userData/vite-cache, since the signed bundle is read-only), where the node_modules walk can't
 * reach app.asar.unpacked/node_modules — so that surviving bare import fails and the whole editor
 * renderer blanks. vite.config.ts fixes it with resolve.alias pinning the specifier to an absolute
 * package dir. That bug is NON-DETERMINISTIC (the optimizer only sometimes pre-bundles the
 * dangling import), so the packaged smoke test can't reliably catch its ABSENCE — this fast,
 * deterministic test guards the fix's presence directly. See docs/plans/editor-shipping-plan.md.
 */
describe('vite.config @zappar/msdf-generator resolve.alias (packaged-editor fix)', () => {
  it('aliases the bare specifier to its real absolute package dir', async () => {
    // defineConfig(fn) returns fn; the factory synchronously assembles the config object.
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    // 'serve' = the running editor path (a bare 'build' without MODOKI_PROJECT trips the
    // #29 "repo root is not a buildable game" guard). The alias is command-independent.
    const config = factory({ command: 'serve', mode: 'development' })

    const alias = config.resolve?.alias as Record<string, string> | undefined
    const pinned = alias?.['@zappar/msdf-generator']

    expect(pinned, 'resolve.alias must pin @zappar/msdf-generator (packaged-editor fix)').toBeTruthy()
    // The alias must point at a REAL package dir (an entry file next to its worker/wasm), else the
    // fix silently aliases to nothing and the packaged renderer breaks again.
    expect(fs.existsSync(path.join(pinned!, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(pinned!, 'dist', 'index.js'))).toBe(true)
  })
})
