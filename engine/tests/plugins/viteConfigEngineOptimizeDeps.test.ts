import { describe, it, expect, afterEach } from 'vitest'
import type { UserConfig } from 'vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { repoFiles } from '../../scripts/repoCorpus.mjs'
import { hasInternalGames } from '../helpers/repoLayout'
import { readScannedSource } from '@modoki/engine/testing'
import { importsIn, parseSource } from '@modoki/engine/testing/sourceAst'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** #1526 — Vite 8.2's own rule (`OPTIMIZABLE_ENTRY_RE` + `isOptimizable` in
 *  `vite/dist/node/chunks/node.js`): a dep entry is pre-bundled only if it ends in `.js`/`.ts` (and
 *  their `c`/`m` forms), or in one of `optimizeDeps.extensions`. Any other entry is dropped from
 *  `include` with "Cannot optimize dependency" and served as plain source. */
const VITE_OPTIMIZABLE_ENTRY = /\.[cm]?[jt]s$/
const engineExports = JSON.parse(
  readFileSync(path.join(repoRoot, 'engine/packages/modoki/package.json'), 'utf8'),
).exports as Record<string, string>

/** The file an `@modoki/engine` specifier resolves to through the package's `exports`. */
function engineEntryFile(spec: string): string | undefined {
  return engineExports[spec === '@modoki/engine' ? '.' : `./${spec.slice('@modoki/engine/'.length)}`]
}

/** True when the specifier's entry EXISTS and Vite would refuse to pre-bundle it. */
function engineEntryUnoptimizable(spec: string, config: UserConfig): boolean {
  const file = engineEntryFile(spec)
  if (file === undefined) return false
  const extensions = config.optimizeDeps?.extensions ?? []
  return !VITE_OPTIMIZABLE_ENTRY.test(file) && !extensions.some((ext) => file.endsWith(ext))
}

/**
 * Regression guard for the packaged-editor dep-optimize stabilization fix.
 *
 * electron-builder DEREFERENCES the @modoki/engine symlink into a real node_modules dir in a
 * packaged app, so Vite OPTIMIZES it there (in dev it's a symlinked SOURCE dep, never optimized —
 * that's what gives engine code Fast Refresh). Games import `@modoki/engine/runtime/rendering`,
 * which the editor's OWN startup graph does not reach — so opening a project made a packaged
 * editor re-optimize mid-session, rehashing every @modoki_engine_* chunk. The already-loaded
 * `runtime.js?v=<old>` then threw "does not provide an export named …", blanking the renderer
 * (the "Couldn't open this project" screen). The fix
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

  /**
   * #813 — the list above is HAND-MAINTAINED, and the assertions above pin it by literal. That
   * combination cannot notice a game importing a subpath nobody added: the guard stays green while
   * the list goes stale, which is exactly the drift `family/derived-corpus` is about.
   *
   * This derives the requirement instead. Every `@modoki/engine` specifier reachable from a GAME's
   * RUNTIME code (not its tests — those never load in the packaged editor, and `@modoki/engine/testing`
   * is test-only) must appear in the packaged include list, because a specifier first seen when a
   * project opens is precisely the mid-session re-optimize this whole fix exists to prevent.
   *
   * It went red on `@modoki/engine/runtime/core/formatVersion` when wordweave became the first game
   * to import a narrow `runtime/core/*` subpath — every earlier one came from `engine/app/**`, the
   * editor's own startup graph, which is never the trigger.
   */
  // ⚠️ `skipIf` on THIS case only, not the whole describe (#813 review). The public OSS snapshot
  // ships no `games/` and exactly two demos, so `repoFiles`' `floor: 50` would THROW there — and
  // `scripts/publish-engine-oss.sh` does not exclude this file, so both legs of the free public CI
  // would go red on the next push to `main`. The other cases in this file need no game corpus and
  // must keep running on the mirror, which is why the guard is not on the describe.
  it.skipIf(!hasInternalGames())('#813 — every @modoki/engine specifier a GAME\'s runtime imports is in the packaged list', async () => {
    process.env[ENV_KEY] = '/tmp/fake-userdata/vite-cache'
    const config = await buildConfig()
    const include = config.optimizeDeps?.include ?? []

    const sources = repoFiles({
      under: [path.join(repoRoot, 'games'), path.join(repoRoot, 'demos')],
      match: /\.(ts|tsx)$/,
      floor: 50,
    }).filter(({ rel }: { rel: string }) => !rel.includes('/tests/') && !/\.(test|spec)\.tsx?$/.test(rel))

    // Every module edge a game file writes — static, re-exported, dynamic, side-effect — read from the
    // parse (#1193). The regex this replaced (`(?:from|import\s*\(?)\s*['"](@modoki/engine…)['"]`)
    // needed comments stripped first and could not see `import x = require('…')`; it found the same 9
    // subpaths on 2026-09-15. `import type` statements stay IN, as they were: listing one costs a
    // pre-bundle entry, and missing a value import blanks the packaged renderer. A type POSITION
    // (`typeof import('…')`), which its `import\s*\(?` arm also matched, is not an import and is out.
    const found = new Map<string, string>()
    for (const { abs, rel } of sources as { abs: string; rel: string }[]) {
      for (const { spec } of importsIn(parseSource(readScannedSource(abs).code, rel))) {
        if ((spec === '@modoki/engine' || spec.startsWith('@modoki/engine/')) && !found.has(spec)) found.set(spec, rel)
      }
    }

    expect(found.size).toBeGreaterThan(0)
    // #1526 — a subpath whose entry Vite cannot pre-bundle (a `.tsx`, today `runtime/debug/adsTab`) is
    // served as source, so it cannot trigger the mid-session re-optimize either. Listing it would only
    // warn; the guard below keeps it out of the list.
    const missing = [...found].filter(([spec]) => !include.includes(spec) && !engineEntryUnoptimizable(spec, config))
      .map(([spec, rel]) => `${spec}  (first seen in ${rel})`)
    expect(missing, 'a game imports an @modoki/engine subpath the packaged optimize list does not '
      + 'pre-bundle — add it to vite.config.ts optimizeDeps.include').toEqual([])
  })

  /**
   * #1526 — the other direction. #1501 added `runtime/debug/adsTab`, whose entry is a `.tsx`, so Vite
   * dropped it from the pre-bundle and printed "Cannot optimize dependency" on every packaged boot:
   * a line that looked protective and did nothing, and a warning that taught readers to skip that
   * log line. Every `@modoki/engine` entry in the list must be one Vite will actually pre-bundle.
   */
  it('#1526 — every @modoki/engine subpath in the packaged list is one Vite can pre-bundle', async () => {
    process.env[ENV_KEY] = '/tmp/fake-userdata/vite-cache'
    const config = await buildConfig()
    const engineSpecs = (config.optimizeDeps?.include ?? [])
      .filter((spec) => spec === '@modoki/engine' || spec.startsWith('@modoki/engine/'))

    expect(engineSpecs.length).toBeGreaterThan(0)
    const inert = engineSpecs
      .filter((spec) => engineEntryFile(spec) === undefined || engineEntryUnoptimizable(spec, config))
      .map((spec) => `${spec} → ${engineEntryFile(spec) ?? '(no such export)'}`)
    expect(inert, 'these entries are not pre-bundled (Vite warns "Cannot optimize dependency") — '
      + 'drop them from vite.config.ts optimizeDeps.include').toEqual([])
  })

  it('#1526 — the pre-bundle predicate accepts a .ts entry and refuses the .tsx one', async () => {
    process.env[ENV_KEY] = '/tmp/fake-userdata/vite-cache'
    const config = await buildConfig()
    expect(engineEntryFile('@modoki/engine/runtime/core/adDebug')).toMatch(/\.ts$/)
    expect(engineEntryUnoptimizable('@modoki/engine/runtime/core/adDebug', config)).toBe(false)
    expect(engineEntryFile('@modoki/engine/runtime/debug/adsTab')).toMatch(/\.tsx$/)
    expect(engineEntryUnoptimizable('@modoki/engine/runtime/debug/adsTab', config)).toBe(true)
    // An extension the config opts in is optimizable, as it is to Vite.
    expect(engineEntryUnoptimizable('@modoki/engine/runtime/debug/adsTab',
      { optimizeDeps: { extensions: ['.tsx'] } })).toBe(false)
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
