/**
 * One hash over every Modoki project's own `package-lock.json`, so a dependency change inside a
 * `games/<id>` or `demos/<id>` invalidates Vite's dep-optimizer cache (#1502).
 *
 * Vite keys that cache (`node_modules/.vite/deps/_metadata.json`) on `getLockfileHash` +
 * `getConfigHash` (vite 8.2.0, `node.js` `getDepHash`). The lockfile half reads ONE file — the
 * first lockfile found walking up from Vite's root (`engine/`), i.e. the repo root's — and a
 * project's lockfile is never an ancestor of that root. So a game that DROPS a dependency Vite had
 * pre-bundled leaves the cache valid in Vite's eyes; the next re-optimize (the first time a new dep
 * is discovered) rebuilds the cached list, hits the removed package's missing source, fails, and
 * the game boots DEGRADED with 504s on the new dep's chunk. Observed on work-ai when #1495 dropped
 * `@capacitor-community/admob` from `games/wordweave`.
 *
 * The caller feeds the result into `optimizeDeps.rolldownOptions`, which `getConfigHash`
 * serialises — so the same value also moves `browserHash`, and a re-optimized chunk gets a new
 * `?v=` rather than a URL Chromium replays from its HTTP cache (the #110 trap, docs/build.md).
 *
 * Content, not mtime: a checkout or `npm install` that rewrites identical bytes must not force a
 * cold optimize (docs/build.md § "Packaged editor loop (test the DMG faithfully, fast)" learned it the
 * hard way: fabricated asar `fs.stat` times wiped the packaged dep cache on every boot).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { discoverProjects } from '../scripts/projectRoots.mjs'

/** Every project under the repo's project roots, plus `openProjectDir` when it is set — the
 *  packaged editor and an external `MODOKI_PROJECT` open a project that lives outside `repoRoot`,
 *  and that is the one whose deps get optimized. A project without a lockfile contributes nothing. */
export function projectLockfilesHash(repoRoot: string, openProjectDir?: string | null): string {
  const dirs = new Set(discoverProjects(repoRoot).map(p => path.resolve(p.dir)))
  if (openProjectDir) dirs.add(path.resolve(openProjectDir))
  const hash = createHash('sha256')
  for (const dir of [...dirs].sort()) {
    let bytes: Buffer
    try { bytes = fs.readFileSync(path.join(dir, 'package-lock.json')) } catch { continue }
    // The path goes in too: two projects with byte-identical lockfiles are still two entries, and a
    // lockfile appearing in (or vanishing from) a project must change the hash.
    hash.update(dir).update('\0').update(bytes).update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
