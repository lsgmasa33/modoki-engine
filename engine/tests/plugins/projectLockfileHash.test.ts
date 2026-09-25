/** #1502 — a project's own lockfile must key Vite's dep-optimizer cache.
 *
 *  Vite hashes only the repo-root lockfile, so `projectLockfilesHash` folds every project's
 *  `package-lock.json` into a value `vite.config.ts` puts in `optimizeDeps.rolldownOptions` (which
 *  Vite's `getConfigHash` serialises). These pin the three properties the fix rests on, against a
 *  temp repo: a game's lockfile bytes move the hash, the open project outside the repo counts, and
 *  the wiring in the real config carries the helper's value — and that the INSTALLED Vite still keys
 *  its cache on that option. The fix rests on Vite's PRIVATE `getConfigHash` serialising
 *  `rolldownOptions`, and `"vite": "^8.x"` lets a lockfile refresh move it; that last test is what
 *  goes red if a bump stops hashing it, rather than #1502 silently coming back. */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir'
import { createServer } from 'vite'
import viteConfig from '../../vite.config'
import { projectLockfilesHash } from '../../plugins/projectLockfileHash'

let tmp: string
let repo: string

function writeLock(dir: string, deps: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: deps } } }))
}

beforeEach(() => {
  tmp = makeScratchDir('modoki-lockhash-')
  repo = path.join(tmp, 'repo')
  writeLock(path.join(repo, 'games', 'weave'), { '@capacitor-community/admob': '^6.0.0' })
  writeLock(path.join(repo, 'demos', 'orbit'), { three: '0.185.1' })
})

describe('projectLockfilesHash', () => {
  it('changes when a game drops a dependency (the #1502 repro), and is stable when nothing changed', () => {
    const before = projectLockfilesHash(repo)
    expect(projectLockfilesHash(repo)).toBe(before)
    writeLock(path.join(repo, 'games', 'weave'), { 'capacitor-applovin-max': 'file:packages/capacitor-applovin-max' })
    expect(projectLockfilesHash(repo)).not.toBe(before)
  })

  it('reads the demos root too — every PROJECT_ROOT_DIRS entry, not just games/', () => {
    const before = projectLockfilesHash(repo)
    writeLock(path.join(repo, 'demos', 'orbit'), { three: '0.185.2' })
    expect(projectLockfilesHash(repo)).not.toBe(before)
  })

  it('counts the open project when it lives OUTSIDE the repo (packaged editor, external MODOKI_PROJECT)', () => {
    const external = path.join(tmp, 'elsewhere', 'mygame')
    writeLock(external, { a: '1.0.0' })
    const withIt = projectLockfilesHash(repo, external)
    expect(withIt).not.toBe(projectLockfilesHash(repo))
    writeLock(external, { a: '2.0.0' })
    expect(projectLockfilesHash(repo, external)).not.toBe(withIt)
  })

  it('skips a project with no lockfile, and notices one appearing', () => {
    const before = projectLockfilesHash(repo)
    fs.mkdirSync(path.join(repo, 'games', 'fresh'), { recursive: true })
    expect(projectLockfilesHash(repo)).toBe(before)
    writeLock(path.join(repo, 'games', 'fresh'), {})
    expect(projectLockfilesHash(repo)).not.toBe(before)
  })
})

describe('vite.config wiring', () => {
  it("puts this repo's project-lockfile hash into optimizeDeps.rolldownOptions, where Vite's dep hash reads it", async () => {
    const resolved = typeof viteConfig === 'function'
      ? await (viteConfig as (env: { command: 'serve'; mode: string }) => unknown)({ command: 'serve', mode: 'development' })
      : viteConfig
    const define = (resolved as { optimizeDeps?: { rolldownOptions?: { transform?: { define?: Record<string, string> } } } })
      .optimizeDeps?.rolldownOptions?.transform?.define
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    const openProject = process.env.MODOKI_PROJECT ? path.resolve(process.env.MODOKI_PROJECT) : repoRoot
    expect(define?.__MODOKI_PROJECT_LOCKFILES__).toBe(JSON.stringify(projectLockfilesHash(repoRoot, openProject)))
  })
})

describe("the installed Vite's dep-cache key", () => {
  // Skipped on win32: the only test in the suite that boots a real dev server with rolldown's native
  // dep optimizer, and the Windows CI worker running the suite has exited unexpectedly — every file
  // green, one unhandled "Worker exited unexpectedly" — in every run since it landed (#1529). The
  // property is Vite's own JS hashing, identical on every platform, so macOS and Linux keep it covered.
  // Attribution confirmed by CI (4 red with it, 5 green without); NOT reproducible on a local Windows 11
  // box, so un-skipping is a CI experiment — docs/windows.md § Tests, gates and timings.
  it.skipIf(process.platform === 'win32')('moves with optimizeDeps.rolldownOptions.transform.define, and ONLY with a changed value', async () => {
    // A real dev server over a one-dep fixture: the metadata hash IS Vite's cache key (getDepHash),
    // so this asks Vite itself rather than pattern-matching its bundled source.
    const root = makeScratchDir('modoki-vite-dephash-')
    const dep = path.join(root, 'node_modules', 'fake-dep')
    fs.mkdirSync(dep, { recursive: true })
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'fake-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
    fs.writeFileSync(path.join(dep, 'index.js'), 'export const x = 1\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
    const depHash = async (lockfiles: string) => {
      fs.rmSync(path.join(root, '.vite'), { recursive: true, force: true })
      const server = await createServer({
        root, configFile: false, logLevel: 'silent', cacheDir: path.join(root, '.vite'),
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: ['fake-dep'], rolldownOptions: { transform: { define: { __MODOKI_PROJECT_LOCKFILES__: JSON.stringify(lockfiles) } } } },
      })
      try {
        const optimizer = server.environments.client.depsOptimizer
        await optimizer?.init()
        return optimizer?.metadata.hash
      } finally { await server.close() }
    }
    const a = await depHash('aaaa')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(await depHash('aaaa')).toBe(a)
    expect(await depHash('bbbb')).not.toBe(a)
  })
})
