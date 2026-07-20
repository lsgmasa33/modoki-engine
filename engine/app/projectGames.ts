/** Runtime loader for the open project's games (C4c). The EDITOR loads games at
 *  runtime through this instead of the build-time `virtual:modoki-games` import,
 *  so the open project — and eventually an external folder (C4c-2) — can change
 *  without rebuilding the editor.
 *
 *  C4c-1 scope: only the DEV editor takes the runtime path (it asks the backend
 *  for the project registry's dev URL and dynamically imports it via Vite's
 *  /@fs/). Production builds — the packaged editor and the web game — fall back to
 *  the baked `virtual:modoki-games` (current behaviour preserved). C4c-2 repoints
 *  the runtime path at an external project / a packaged project Vite server. */

import type { GameDefinition } from '@modoki/engine/runtime';

export interface ProjectGames {
  ALL_GAMES: GameDefinition[];
  GAMES: GameDefinition[];
}

export async function loadProjectGames(): Promise<ProjectGames> {
  // Dev editor only: __MODOKI_EDITOR__ is true in both `vite` dev and the editor
  // build, but import.meta.hot is present only under `vite` dev — so the packaged
  // editor + web game keep the baked module.
  if (__MODOKI_EDITOR__ && import.meta.hot) {
    try {
      const { backendFetch } = await import('@modoki/engine/editor');
      const res = await backendFetch('/api/project-games');
      if (res.ok) {
        const { url } = (await res.json()) as { url: string | null };
        if (url) {
          try {
            const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
            // Flat one-game project: the module exports a lone `game`; synthesize
            // the ProjectGames shape from it.
            const game = mod.game as GameDefinition;
            return { ALL_GAMES: [game], GAMES: [game] };
          } catch (importErr) {
            // The backend pointed us at the open project's registry, but Vite
            // refused to serve it — almost always because the project lives
            // OUTSIDE the dev server's fs.allow (an external project opened
            // against a dev server that was started rooted at the repo). Falling
            // back to the baked repo games here would silently load the WRONG
            // project and look like "Open Project did nothing", so make it loud.
            console.error(
              `[modoki] Could NOT load the open project's games from ${url}.\n` +
              `The dev server can't serve code outside its allowed roots. To open an ` +
              `external project, restart the dev server rooted at it:\n` +
              `  npm run dev:stop && MODOKI_PROJECT=<project-dir> npm run dev\n` +
              `(or use scripts/launch-editor.sh <project-dir>). Falling back to the ` +
              `editor's built-in games for now.`,
              importErr,
            );
          }
        }
      }
    } catch (e) {
      console.warn('[modoki] runtime project-games load failed; using baked module', e);
    }
  }
  return import('virtual:modoki-games') as Promise<ProjectGames>;
}
