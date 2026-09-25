/**
 * `optimizeDeps.entries` for the open project (#1520): Vite's cold dependency scan crawls the
 * project's game entry (`game.ts`/`game.tsx`) as well as the HTML, so every package the game imports is pre-bundled
 * BEFORE the first page load.
 *
 * Without it the scan never sees the game. The dev editor loads the game at runtime from the
 * project registry, by URL, so the only static entry is `index.html`, and nothing reachable from
 * it imports the game's own packages (its native-SDK wrappers: Firebase, AppLovin, AppsFlyer,
 * `@capacitor/dialog`, …). Vite found them while the game booted, re-optimised, and reloaded the
 * page. Observed on Court with `node_modules/.vite` moved aside: `dependencies optimized:
 * @capacitor-firebase/analytics, … capacitor-modoki-system` then `optimized dependencies changed.
 * reloading`. The dev editor opened the project twice, and the gameplay recorder's first render
 * died at boot (#1518). With this entry, the same cold boot optimises all of them at startup
 * and never reloads.
 *
 * A scan follows the game's own imports and resolves each from the importing file, exactly as
 * the live import will. That is the difference from the `projectNativeSdkDeps` include list in
 * `vite.config.ts`, which has to hand-resolve package names and alias them to agree (its GOTCHA #2),
 * reads only `packages/app-services`, and covers only the packaged editor.
 *
 * The default crawl when `entries` is unset is `**\/*.html` minus `**\/__tests__/**` and
 * `**\/coverage/**` (vite 8.2 `globEntries`), and an explicit list drops those two ignores, so they
 * come back as negations.
 *
 * ⚠️ Windows: when the project sits on a different drive from the engine, `path.relative` returns
 * an absolute path. It still becomes a forward-slash pattern, but this case has not been run. If
 * the glob fails to match, the scan misses the game and it reloads once, which is today's behaviour
 * rather than a crash.
 */
import path from 'node:path'
import { findGamesEntry } from './findGamesEntry'

/** The HTML crawl Vite does by default, restated because an explicit `entries` replaces it. */
export const DEFAULT_HTML_ENTRIES = ['**/*.html', '!**/__tests__/**', '!**/coverage/**']

/** Escape glob syntax in a literal path, so a folder named `My Game (copy) [2]` matches itself.
 *  The same rule as tinyglobby's `escapePath`, which Vite globs `entries` with; restated because
 *  tinyglobby is Vite's dependency, not ours, and the config must not import an undeclared package. */
export function escapeGlobPath(p: string): string {
  return p.replace(/[\\()[\]{}*?|]|^!|[!+@](?=\()/g, '\\$&')
}

/** The scan entry for the project at `projectRoot`, as a glob relative to Vite's `root`, or `null`
 *  when it has no game entry (the repo root, which is not a game). The entry is whatever
 *  `findGamesEntry` boots, `game.ts` or `game.tsx`, so the scan cannot disagree with the loader. */
export function projectScanEntry(viteRoot: string, projectRoot: string): string | null {
  const gameEntry = findGamesEntry(projectRoot)?.path
  if (!gameEntry) return null
  return escapeGlobPath(path.relative(viteRoot, gameEntry).split(path.sep).join('/'))
}

/** The full `optimizeDeps.entries`: the default HTML crawl plus the open project's game. */
export function projectScanEntries(viteRoot: string, projectRoot: string): string[] {
  const game = projectScanEntry(viteRoot, projectRoot)
  return game ? [...DEFAULT_HTML_ENTRIES, game] : [...DEFAULT_HTML_ENTRIES]
}
