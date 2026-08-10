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

/** Ask the dev server serving this page which project it is rooted at. null = it didn't say
 *  (an older build without the route, or the SPA fallback answering with HTML). Never throws. */
async function devServerProjectRoot(): Promise<string | null> {
  try {
    // NOT backendFetch: that routes to the ELECTRON backend, and the whole question here is
    // whether the server ON THIS ORIGIN is the one the Electron host thinks it is. Asking the
    // host would just echo back the project it intended to open — the answer we already have,
    // and the one that is wrong. This has to be a same-origin fetch at the Vite server.
    // eslint-disable-next-line no-restricted-syntax -- must interrogate the origin serving this page, not the backend
    const res = await fetch('/api/dev-server-identity');
    if (!res.ok) return null;
    const j = (await res.json()) as { modoki?: unknown; projectRoot?: unknown };
    return j.modoki === true && typeof j.projectRoot === 'string' ? j.projectRoot : null;
  } catch {
    return null;
  }
}

/** Explain a failed game-code import — the two causes are indistinguishable from the
 *  exception, which is why this used to assert the wrong one.
 *
 *  The browser says `Failed to fetch dynamically imported module` both when Vite REFUSED the
 *  path (outside `server.fs.allow`) and when Vite happily answered its SPA fallback because
 *  the path isn't under the root it was started at — and in the field it was overwhelmingly
 *  the second (#190): a stale dev server kept the port across a project switch, so the editor
 *  showed project B while every module and asset came from project A. Telling that user to
 *  re-root a dev server they never started sent them looking in the wrong place entirely.
 *
 *  Pure + exported so both branches are testable without a dev server. */
export function gameLoadFailureMessage(url: string, devServerRoot: string | null): string {
  // Normalise BOTH sides to the same shape: forward slashes, no leading or trailing slash,
  // case-folded. The leading slash is the subtle one — `/@fs/` is followed directly by the
  // drive letter on Windows (`/@fs/E:/…`) but by a rooted path on posix (`/@fs/home/…`), while
  // the identity always carries a native absolute path. Comparing them raw reports a mismatch
  // for the project that IS open, i.e. cries "stale server" at a perfectly healthy editor.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  const filePath = norm(url.replace(/^\/@fs\//, ''));
  const rooted = devServerRoot !== null && filePath.startsWith(`${norm(devServerRoot)}/`);
  if (devServerRoot !== null && !rooted) {
    return (
      `[modoki] Could NOT load the open project's games from ${url}.\n` +
      `The dev server on this origin is rooted at a DIFFERENT project (${devServerRoot}), so it ` +
      `answered with the editor's HTML page instead of that module — and every asset you see is ` +
      `coming from that other project too. It did not re-root when the project changed (a stale ` +
      `server is holding the port). Quit and relaunch the editor.`
    );
  }
  return (
    `[modoki] Could NOT load the open project's games from ${url}.\n` +
    `The dev server can't serve code outside its allowed roots. To open an external project, ` +
    `restart the dev server rooted at it:\n` +
    `  npm run dev:stop && MODOKI_PROJECT=<project-dir> npm run dev\n` +
    `(or use scripts/launch-editor.sh <project-dir>). Falling back to the editor's built-in ` +
    `games for now.`
  );
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
            // The backend pointed us at the open project's game code and the import failed.
            // Falling back to the baked repo games here would silently load the WRONG project
            // and look like "Open Project did nothing", so make it loud — and ask the dev
            // server WHY before blaming a cause (see gameLoadFailureMessage).
            console.error(gameLoadFailureMessage(url, await devServerProjectRoot()), importErr);
          }
        }
      }
    } catch (e) {
      console.warn('[modoki] runtime project-games load failed; using baked module', e);
    }
  }
  return import('virtual:modoki-games') as Promise<ProjectGames>;
}
