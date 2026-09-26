/** The page's favicon: the GAME's app icon on a game build, the engine's Modoki icon in the editor.
 *
 *  `engine/index.html` links `%BASE_URL%favicon.png`. With publicDir off there is no public/ dir, so
 *  something has to emit that file or it 404s. It used to be the engine's Modoki bear for every
 *  build, which put the engine's icon on a published game's browser tab (owner, 2026-09-26: "save
 *  favicon to the game icons"). A game build now emits its own `app.iconSource` — the same 1024²
 *  master the native icon pass reads — downscaled; the editor shell (dev server and the packaged
 *  `build:editor`) keeps the Modoki icon, since it is the engine's own page.
 *
 *  Resized in `buildStart`, not `generateBundle`, so the bytes are ready before anything asks — the
 *  same ordering rule `bootSplash.ts` documents.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Plugin } from 'vite';

/** What the page links: `favicon.png?v=<content hash>`. The file keeps its fixed name across deploys,
 *  and the CDN in front of the published games caches unhashed files for a day (Google Storage for an
 *  hour behind it): after Court's icon changed on 2026-09-26 the live tab kept the engine bear through
 *  a purge. The query makes a changed icon a new URL — the engine's own cache-bust convention, the one
 *  textures, fonts and the boot splash (`bootSplashUrl`) carry — and `index.html` is no-cache. */
export function versionedFaviconRef(bytes: Buffer): string {
  return `favicon.png?v=${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

/** Point the page's `<link rel="icon">` at the versioned ref. Only the `favicon.png` in an href is
 *  touched; a page with none is returned unchanged. */
export function linkVersionedFavicon(html: string, ref: string): string {
  return html.replace(/(<link\b[^>]*\brel="icon"[^>]*\bhref="[^"]*?)favicon\.png"/, `$1${ref}"`);
}

/** A tab draws 16-32 CSS px, so 128 covers 4x displays; at 256 Court's painted icon was 168 KB on every
 *  page load (a 1024² master would be ~1 MB). */
export const FAVICON_SIZE = 128;

/** The icon a build's favicon comes from: the project's `app.iconSource` on a game build when that
 *  file exists, otherwise the engine's own. */
export function faviconSourceFor(opts: {
  engineIcon: string; projectRoot: string; iconSource: string | undefined; isEditorBuild: boolean;
}): { path: string; isGameIcon: boolean; missing?: string } {
  const raw = opts.iconSource?.trim();
  if (!opts.isEditorBuild && raw) {
    const abs = path.isAbsolute(raw) ? raw : path.join(opts.projectRoot, raw);
    if (fs.existsSync(abs)) return { path: abs, isGameIcon: true };
    // A set-but-unreadable icon is an authoring error. The native icon pass fails the build on it
    // (#1011); here the page still works, so fall back — but `missing` makes the plugin say so.
    return { path: opts.engineIcon, isGameIcon: false, missing: abs };
  }
  return { path: opts.engineIcon, isGameIcon: false };
}

export function faviconPlugin(opts: {
  engineIcon: string; projectRoot: string; iconSource: string | undefined; isEditorBuild: boolean;
  /** A playable ad strips the `<link rel=icon>` and inlines every dist file under a byte cap, so a
   *  favicon there is dead weight counted against that cap. */
  isPlayable?: boolean;
}): Plugin {
  const src = faviconSourceFor(opts);
  let bytes: Buffer | null = null;
  let isBuild = false;
  return {
    name: 'modoki:favicon',
    configResolved(config) { isBuild = config.command === 'build'; },
    async buildStart() {
      if (!isBuild) return;
      if (opts.isPlayable) return;
      if (src.missing) this.warn(`[favicon] app.iconSource ${src.missing} does not exist — the tab shows the engine icon`);
      try {
        bytes = src.isGameIcon
          ? await sharp(src.path).resize(FAVICON_SIZE, FAVICON_SIZE, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer()
          : fs.readFileSync(src.path);
      } catch (e) {
        // Not fatal — a page without a favicon still works — but say so rather than ship the tab blank.
        this.warn(`[favicon] skipped (${(e as Error).message})`);
        bytes = null;
      }
    },
    generateBundle() {
      if (bytes) this.emitFile({ type: 'asset', fileName: 'favicon.png', source: bytes });
    },
    // bytes are ready here: buildStart has finished before any HTML is transformed.
    transformIndexHtml(html) {
      return bytes ? linkVersionedFavicon(html, versionedFaviconRef(bytes)) : html;
    },
    // The dev server is the editor: it always serves the engine's icon.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reqUrl = (req.url || '').split('?')[0];
        if (reqUrl !== '/favicon.png' && reqUrl !== `${server.config.base}favicon.png`) { next(); return; }
        try {
          res.setHeader('Content-Type', 'image/png');
          res.end(fs.readFileSync(opts.engineIcon));
        } catch { next(); }
      });
    },
  };
}
