/** A game build's browser-tab title is the game's name, not the engine's (#1583).
 *
 *  `engine/index.html` is shared by the editor and every game, and says `<title>Modoki</title>`.
 *  Nothing rewrote it, so the published web builds of Court and Weaveling both showed "Modoki" in
 *  the tab — and in a bookmark, a history entry and a home-screen shortcut's default name. The
 *  project already authors its display name as `app.appName` (the same value the native pass writes
 *  into Info.plist / strings.xml / capacitor.config.json), so the build reads that one source rather
 *  than growing a second "web title" field that would drift from it.
 *
 *  Build-only, and never for the EDITOR shell — it opens projects at runtime and is "Modoki". A
 *  project with no `appName` keeps the template's title.
 */

import type { Plugin } from 'vite';

const TITLE_RE = /<title>[^<]*<\/title>/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace the document's `<title>` with `appName`. A blank `appName` leaves the HTML unchanged.
 *  ⚠️ THROWS when the HTML has no `<title>` to replace — a template edit that dropped or reshaped
 *  the tag would otherwise turn this into a silent no-op and every game back into "Modoki". */
export function applyDocumentTitle(html: string, appName: string | undefined): string {
  const name = appName?.trim();
  if (!name) return html;
  if (!TITLE_RE.test(html)) {
    throw new Error('[document-title] index.html has no <title>…</title> to set the game name on');
  }
  return html.replace(TITLE_RE, `<title>${escapeHtml(name)}</title>`);
}

export function documentTitlePlugin(appName: string | undefined): Plugin {
  return {
    name: 'modoki:document-title',
    apply: 'build',
    transformIndexHtml(html) {
      return applyDocumentTitle(html, appName);
    },
  };
}
