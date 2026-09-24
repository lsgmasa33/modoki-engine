import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'
import type { UserConfig } from 'vite'
import { hasInternalGames } from '../helpers/repoLayout'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir'
import { DEFAULT_HTML_ENTRIES, projectScanEntries } from '../../plugins/projectScanEntries'

/**
 * #1520 — Vite's cold dependency scan crawls the open project's `game.ts`, so the game's own packages
 * are pre-bundled before the first page load instead of found mid-boot (a full page reload, which
 * killed the recorder's first render, #1518). The no-reload result itself is a live observation on a
 * cold cache (docs/build.md § "Cold dependency scan: the open project's `game.ts` is a scan entry"); this pins that the pattern MATCHES, which a
 * pattern Vite silently globs to nothing would not.
 *
 * Globbed with tinyglobby (Vite's own matcher, imported here though only Vite declares it: if Vite
 * ever drops it, this file breaking is the signal the matcher changed) under Vite's own options (vite 8.2 `globEntries`: `absolute`, `cwd` = the
 * Vite root, `**\/node_modules/**` ignored), so a match here is a match in the scan.
 */
const ENGINE_DIR = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(ENGINE_DIR, '..')

async function viteGlob(patterns: string[]): Promise<string[]> {
  return glob(patterns, { absolute: true, cwd: ENGINE_DIR, ignore: ['**/node_modules/**'] })
}

describe('projectScanEntries (#1520)', () => {
  function projectAt(name: string, entry: 'game.ts' | 'game.tsx' | null = 'game.ts'): string {
    const parent = makeScratchDir('scan-entries-')
    const dir = path.join(parent, name)
    fs.mkdirSync(dir)
    if (entry) fs.writeFileSync(path.join(dir, entry), 'export const game = {}\n')
    return dir
  }

  it.skipIf(!hasInternalGames())('the entry for games/court matches its game.ts', async () => {
    const court = path.join(REPO_ROOT, 'games', 'court')
    const matched = await viteGlob(projectScanEntries(ENGINE_DIR, court).filter((p) => !DEFAULT_HTML_ENTRIES.includes(p)))
    expect(matched.map((f) => fs.realpathSync(f))).toEqual([fs.realpathSync(path.join(court, 'game.ts'))])
  })

  // A project folder is named by the owner, and glob syntax in it must match literally.
  it('a project folder with glob syntax in its name still matches its game.ts', async () => {
    const dir = projectAt('My Game (copy) [2] {a,b} +@!')
    const entry = projectScanEntries(ENGINE_DIR, dir).at(-1)!
    expect(entry).not.toBe('**/*.html')
    const matched = await viteGlob([entry])
    expect(matched.map((f) => fs.realpathSync(f))).toEqual([fs.realpathSync(path.join(dir, 'game.ts'))])
  })

  // The loader (`findGamesEntry`) boots a `game.tsx` too; a scan that looked only for `game.ts`
  // would leave #1520 silently off for that project (review of #1520).
  it('a project whose entry is game.tsx scans game.tsx', async () => {
    const dir = projectAt('tsx-game', 'game.tsx')
    const matched = await viteGlob([projectScanEntries(ENGINE_DIR, dir).at(-1)!])
    expect(matched.map((f) => fs.realpathSync(f))).toEqual([fs.realpathSync(path.join(dir, 'game.tsx'))])
  })

  it('a project with no game entry (the repo root) adds nothing to the default HTML crawl', () => {
    expect(projectScanEntries(ENGINE_DIR, projectAt('not-a-game', null))).toEqual(DEFAULT_HTML_ENTRIES)
  })

  // The explicit list replaces Vite's default crawl, which also ignored these two folders.
  it('keeps the default HTML crawl and its test/coverage ignores', async () => {
    const entries = projectScanEntries(ENGINE_DIR, projectAt('g'))
    expect(entries.slice(0, DEFAULT_HTML_ENTRIES.length)).toEqual(['**/*.html', '!**/__tests__/**', '!**/coverage/**'])
    const html = await viteGlob(DEFAULT_HTML_ENTRIES)
    expect(html).toContain(path.join(ENGINE_DIR, 'index.html'))
  })
})

describe.skipIf(!hasInternalGames())('vite.config wires projectScanEntries into optimizeDeps.entries (#1520)', () => {
  const ENV_KEYS = ['MODOKI_VITE_CACHEDIR', 'MODOKI_PROJECT'] as const
  const prevEnv: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k]
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k]
      else process.env[k] = prevEnv[k]
    }
  })

  // `buildProjectRoot` is read at module top level, so each case re-imports the config.
  async function entriesFor(project: string, packaged: boolean): Promise<unknown> {
    process.env.MODOKI_PROJECT = project
    if (packaged) process.env.MODOKI_VITE_CACHEDIR = '/tmp/fake-userdata/vite-cache'
    else delete process.env.MODOKI_VITE_CACHEDIR
    vi.resetModules()
    const factory = (await import('../../vite.config')).default as (env: { command: 'serve'; mode: string }) => UserConfig
    return factory({ command: 'serve', mode: 'development' }).optimizeDeps?.entries
  }

  // Dev is where #1520 was observed; the packaged editor loads the game the same way.
  it.each([['dev', false], ['packaged', true]])('%s: the open project\'s game.ts is a scan entry', async (_, packaged) => {
    expect(await entriesFor('games/court', packaged)).toEqual(projectScanEntries(ENGINE_DIR, path.join(REPO_ROOT, 'games', 'court')))
    expect(await entriesFor('games/court', packaged)).toContain('../games/court/game.ts')
  })
})
