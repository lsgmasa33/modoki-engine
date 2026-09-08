/** OTA Phase 4 — builds a project's `game.ts` as an independently-loadable sub-game
 *  bundle instead of the normal shell app: one IIFE chunk (`subgame.js`) with the
 *  SHARED set (three, koota, react, `@modoki/engine/runtime`, …) externalized to
 *  `__MODOKI_SHARED__.modules['<key>']` rather than bundled — so a sub-game shares
 *  the shell's already-loaded singleton instances instead of duplicating them.
 *  Design: docs/ota-subgame-modules.md §2. Activated by `engine/scripts/
 *  build-subgame.mjs` (MODOKI_SUBGAME=1), NOT part of a normal `vite build`.
 *
 *  Externalization here is done via `resolveId` returning `{ id, external: true }`
 *  for any SUBGAME_SHARED_KEYS id — NOT via `build.rollupOptions.external`, so this
 *  plugin can also RECORD which of those ids the sub-game's code actually imports
 *  (via the same hook) and stamp only those into `subgame.json`'s `sharedDeps`. A
 *  sub-game that only imports `three` shouldn't force the shell's `ensure()` to
 *  eager-load `pixi.js` too.
 *
 *  `enforce: 'pre'` is required: without it, Vite's own bare-specifier resolution
 *  (or `hostSharedDeps()` in vite.config.ts) would resolve `three`/`koota`/etc to
 *  their real file paths before this plugin ever sees the id, and externalizing an
 *  absolute path instead of the bare specifier would produce a `globals` key that
 *  never matches the registry's specifier-keyed `modules` map. */

import type { Plugin } from 'vite';
import path from 'node:path';
import { findGamesEntry } from './findGamesEntry';
import { SUBGAME_SHARED_KEYS } from '../app/sharedRegistryKeys';
import { SUBGAME_MANIFEST_SCHEMA_VERSION } from '../packages/modoki/src/runtime/core/version';

const SUBGAME_ENTRY_VIRTUAL_ID = 'virtual:modoki-subgame-entry';
const SUBGAME_ENTRY_RESOLVED_ID = '\0' + SUBGAME_ENTRY_VIRTUAL_ID;

const SHARED_KEY_SET = new Set(SUBGAME_SHARED_KEYS);

export interface SubgameManifest {
  schema: 1;
  /** Stamped from ENGINE_API_VERSION at build time — the shell checks this for
   *  EXACT equality (never `>=`) before registering the game. */
  engineApi: number;
  /** The SHARED ids this specific bundle actually imports — NOT the full
   *  SUBGAME_SHARED_KEYS list, so the shell's ensure() doesn't eager-load a
   *  renderer this sub-game never uses. */
  sharedDeps: string[];
  entry: 'subgame.js';
}

export interface SubgameBuildOptions {
  /** The project root whose game.ts is being built as a sub-game bundle. */
  projectRoot: string;
  /** Stamped into subgame.json — must equal ENGINE_API_VERSION (checked by the
   *  caller; this plugin just carries the value through). */
  engineApi: number;
}

/** `virtual:modoki-subgame-entry`'s source — assigns the project's `game` plus a
 *  build-stamped `engineApi` onto `globalThis.__MODOKI_SUBGAME__`, so the shell can
 *  check BOTH that AND `subgame.json.engineApi` — the design's belt-and-suspenders
 *  check, which covers `engineApi` specifically (not `subgame.json` as a whole) —
 *  without trusting a single hand-editable value. `subgame.json.schema` is a
 *  separate, earlier FORMAT gate: see `SUBGAME_MANIFEST_SCHEMA_VERSION`.
 *
 *  A plain `export` does NOT work here: this Vite's bundler is Rolldown, which does
 *  not expose IIFE named exports the way classic Rollup does — measured, an
 *  `export const` with no other reference was silently dropped from the bundle
 *  (0 bytes emitted) regardless of `treeshake`/`minify` settings. A `globalThis`
 *  assignment is a genuine side-effect statement rather than a named export, so it
 *  survives. */
function subgameEntrySource(gameTsPath: string, engineApi: number): string {
  const noExt = gameTsPath.replace(/\.tsx?$/, '').replace(/\\/g, '/');
  return `import { game as __modokiGame } from ${JSON.stringify(noExt)};\nglobalThis.__MODOKI_SUBGAME__ = { game: __modokiGame, engineApi: ${engineApi} };\n`;
}

export function subgameBuildPlugin(opts: SubgameBuildOptions): Plugin {
  const entry = findGamesEntry(opts.projectRoot);
  const usedSharedDeps = new Set<string>();

  return {
    name: 'modoki:subgame-build',
    enforce: 'pre',

    resolveId(id) {
      if (id === SUBGAME_ENTRY_VIRTUAL_ID) return SUBGAME_ENTRY_RESOLVED_ID;
      if (SHARED_KEY_SET.has(id)) {
        usedSharedDeps.add(id);
        return { id, external: true };
      }
      return null;
    },

    load(id) {
      if (id !== SUBGAME_ENTRY_RESOLVED_ID) return null;
      if (!entry) {
        throw new Error(`[modoki:subgame-build] no game.ts/game.tsx found at ${opts.projectRoot}`);
      }
      return subgameEntrySource(entry.path, opts.engineApi);
    },

    generateBundle() {
      const manifest: SubgameManifest = {
        schema: SUBGAME_MANIFEST_SCHEMA_VERSION,
        engineApi: opts.engineApi,
        sharedDeps: [...usedSharedDeps].sort(),
        entry: 'subgame.js',
      };
      this.emitFile({
        type: 'asset',
        fileName: 'subgame.json',
        source: JSON.stringify(manifest, null, 2) + '\n',
      });
    },
  };
}

export { SUBGAME_ENTRY_VIRTUAL_ID };
export const SUBGAME_DIST_DIRNAME = 'subgame-dist';

/** The output directory for a project's sub-game build — a THIRD build output next
 *  to `dist/` (normal web) and `ads/` (playable), so building a sub-game bundle never
 *  clobbers either. */
export function subgameOutDir(projectRoot: string): string {
  return path.join(projectRoot, SUBGAME_DIST_DIRNAME);
}
