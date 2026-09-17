import { describe, it, expect, vi, afterEach } from 'vitest'
import { found } from '@modoki/engine/testing/inOrder'
import fs from 'node:fs'
import path from 'node:path'
import type { UserConfig } from 'vite'
import { aliasFor } from './viteAlias'

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

    const alias = config.resolve?.alias as Parameters<typeof aliasFor>[0]
    const pinned = aliasFor(alias, '@zappar/msdf-generator')

    expect(pinned, 'resolve.alias must pin @zappar/msdf-generator (packaged-editor fix)').toBeTruthy()
    // The alias must point at a REAL package dir (an entry file next to its worker/wasm), else the
    // fix silently aliases to nothing and the packaged renderer breaks again.
    expect(fs.existsSync(path.join(pinned!, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(pinned!, 'dist', 'index.js'))).toBe(true)
  })

  /** The wasm subpath must resolve to a REAL file, and must be matched BEFORE the
   *  package-dir alias above.
   *
   *  This is the production bug, pinned. The runtime imports
   *  `@zappar/msdf-generator/msdfgen_wasm.wasm?url` so Vite emits the wasm as a hashed
   *  asset; the worker's own `new URL(...)` fallback is buried in an emscripten ternary
   *  Vite's static analysis does not match, so without an emitted asset the worker 404s.
   *  And a 404 worker does not reject — comlink simply never replies — so the font acquire
   *  hung and Court's iOS build sat on its splash screen forever with no error logged.
   *
   *  The package-DIR alias would rewrite that subpath to <pkg>/msdfgen_wasm.wasm, which does
   *  not exist (the file is under dist/). A plain STRING find cannot pre-empt it, because
   *  @rollup/plugin-alias will not match an id carrying a `?url` query — hence a regex, and
   *  hence ORDER matters. Both properties are asserted here because either one alone
   *  silently reintroduces the bug. */
  it('resolves the wasm subpath to a real file, ahead of the package-dir alias', async () => {
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    const config = factory({ command: 'serve', mode: 'development' })
    const alias = config.resolve?.alias
    expect(Array.isArray(alias), 'the non-playable alias must be an ARRAY — order is load-bearing').toBe(true)

    const entries = alias as { find: string | RegExp; replacement: string }[]
    const id = '@zappar/msdf-generator/msdfgen_wasm.wasm?url'
    const firstMatch = found(entries.findIndex((e) =>
      typeof e.find === 'string' ? id === e.find || id.startsWith(e.find + '/') : e.find.test(id)),
    'an alias entry matching the wasm subpath (without one Vite will not emit the wasm)')
    const dirIndex = entries.findIndex((e) => e.find === '@zappar/msdf-generator')

    expect(firstMatch, 'the wasm entry must precede the package-dir alias').toBeLessThan(dirIndex)
    expect(fs.existsSync(entries[firstMatch].replacement),
      `the wasm alias must point at a real file, got ${entries[firstMatch].replacement}`).toBe(true)
  })

  /** #1356 — the runtime imports `@zappar/msdf-generator/worker?worker&url` so Vite BUNDLES the
   *  worker (comlink inlined). Without this entry the package-dir alias rewrites the subpath to
   *  <pkg>/worker, which does not exist, and the build fails; with it pointing anywhere but the
   *  real worker, the shipped worker is not the lib's. The regex replaces only the matched
   *  prefix, so the query must SURVIVE — it is what makes Vite build a worker at all. */
  it('resolves the worker subpath to the real worker, query kept, ahead of the package-dir alias', async () => {
    const factory = (await import('../../vite.config')).default as (env: {
      command: 'build' | 'serve'
      mode: string
    }) => UserConfig
    const entries = factory({ command: 'serve', mode: 'development' }).resolve?.alias as AliasEntry[]
    const id = '@zappar/msdf-generator/worker?worker&url'
    const first = found(entries.findIndex((e) => matches(e, id)), 'an alias entry matching the worker subpath')
    expect(first, 'the worker entry must precede the package-dir alias')
      .toBeLessThan(entries.findIndex((e) => e.find === '@zappar/msdf-generator'))

    const rewritten = id.replace(entries[first].find, entries[first].replacement)
    expect(rewritten).toMatch(/[\\/]dist[\\/]worker\.js\?worker&url$/)
    expect(fs.existsSync(rewritten.replace(/\?.*$/, '')), `not a real file: ${rewritten}`).toBe(true)
    // `worker.js` is a different exported subpath; the entry must not turn it into worker.js.js.
    expect(matches(entries[first], '@zappar/msdf-generator/worker.js')).toBe(false)
  })

  describe('playable build', () => {
    // Restored key by key: reassigning `process.env` swaps Node's env object for a plain one.
    const KEYS = ['VITE_PLAYABLE', 'MODOKI_PROJECT', 'MODOKI_PLAYABLE'] as const
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      vi.resetModules()
    })

    /** A playable must not build ANY worker: a worker bundle is a separate .js file, and
     *  inlinePlayable refuses the build over it. So here the entry swallows the query — the id
     *  becomes a plain module — the opposite of the non-playable entry above. Observed: keeping
     *  the query emitted `playable-msdf-stub-*.js` and failed the export. */
    it('maps the worker subpath, query and all, to a plain stub module', async () => {
      process.env.VITE_PLAYABLE = '1'
      process.env.MODOKI_PROJECT = 'games/space-invader'
      vi.resetModules()
      const factory = (await import('../../vite.config')).default as (env: {
        command: 'build' | 'serve'
        mode: string
      }) => UserConfig
      const entries = factory({ command: 'build', mode: 'production' }).resolve?.alias as AliasEntry[]
      const id = '@zappar/msdf-generator/worker?worker&url'
      const first = found(entries.findIndex((e) => matches(e, id)), 'a playable alias entry matching the worker subpath')
      expect(first, 'the worker entry must precede the package stub alias')
        .toBeLessThan(entries.findIndex((e) => e.find === '@zappar/msdf-generator'))

      const rewritten = id.replace(entries[first].find, entries[first].replacement)
      expect(rewritten, 'the ?worker query must be swallowed').not.toContain('?')
      expect(fs.existsSync(rewritten), `not a real file: ${rewritten}`).toBe(true)
      expect(fs.readFileSync(rewritten, 'utf8')).toMatch(/^export default undefined;$/m)
    })
  })
})

type AliasEntry = { find: string | RegExp; replacement: string }

function matches(e: AliasEntry, id: string): boolean {
  return typeof e.find === 'string' ? id === e.find || id.startsWith(e.find + '/') : e.find.test(id)
}
