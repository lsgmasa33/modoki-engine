/** The WEB boot splash — the project's splash art, shown from the browser's FIRST PAINT until the
 *  game has rendered a frame (#396 follow-on, owner: *"this splash should be used for the loading
 *  screen as well"*).
 *
 *  ## What the player saw before this
 *
 *  Nothing of the game. `engine/index.html` carries no boot markup, so the first paint is the
 *  browser's white; `App.css` then paints `#0f0f23`; `App.tsx`'s pre-config branch paints `#0a0a1a`
 *  with the word "Loading..."; and `LoadingOverlay` paints `#0a0a1a` with a CSS spinner until the
 *  scene has painted. Four surfaces, all hardcoded dark navy, none of them the game.
 *
 *  On NATIVE that sequence is mostly hidden behind the native splash — but it is the whole boot on
 *  web, and it is also what briefly cross-fades under the native splash as it hides.
 *
 *  ## Why it is injected into the HTML rather than rendered by React
 *
 *  Because the point is to cover the part of boot that React is not alive for. A React component
 *  cannot paint before its own bundle has been fetched, parsed and mounted — which is precisely the
 *  white-then-navy window being closed. The markup is inlined into `index.html` with the image as a
 *  same-origin URL, so the browser starts fetching it from the first bytes of the document.
 *
 *  It sits ABOVE `LoadingOverlay` (z-index 1500 vs 1000), so the existing overlay and its spinner
 *  are simply hidden behind the art rather than needing to be re-themed. `App.tsx` fades it out
 *  when the game is ready — and also whenever something needs to be SEEN underneath it (an OTA
 *  download's progress, a boot error), because a launch image that outranks an error message would
 *  turn a visible failure into a hang.
 *
 *  ## The image is the SAME composition as the native splash
 *
 *  Same master, same title, same badge, same crop-safe placement — `composeWebSplash` and the
 *  native pass share `overlayLayersFor`. It is emitted square and shown with `background-size:
 *  cover`, exactly how iOS shows its own square 2732² splash, so the handoff from native splash to
 *  web boot splash lands on the same pixels rather than jumping.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { composeWebSplash } from '../scripts/splashCompose.mjs';
import type { ProjectConfig } from '../project-config';

/** Emitted at the dist root; referenced from the injected markup. */
export const BOOT_SPLASH_FILE = 'boot-splash.webp';
/** Above LoadingOverlay (1000) and the OTA restart gate (1100) — see the header. */
const BOOT_SPLASH_Z = 1500;
/** Square, and shown with `cover`: the same shape the iOS launch image is. */
const BOOT_SPLASH_SIZE = 1440;

/** The markup injected into `<body>`. Inline styles only — a stylesheet is another round trip, and
 *  this element exists to be painted before anything else has loaded.
 *
 *  `background-color` is painted too, so the element is opaque from the instant it exists rather
 *  than showing white until the image decodes. */
export function bootSplashMarkup(url: string, background: string): string {
  return `<div id="modoki-boot-splash" style="position:fixed;inset:0;z-index:${BOOT_SPLASH_Z};`
    + `background-color:${background};background-image:url('${url}');background-size:cover;`
    + `background-position:center;background-repeat:no-repeat;`
    + `transition:opacity 260ms ease-out;pointer-events:none"></div>`;
}

/** Resolve a project-relative (or absolute) config path, or `undefined` when unset. */
function projectFile(projectRoot: string, raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  return path.isAbsolute(t) ? t : path.join(projectRoot, t);
}

/** Emit the composited boot splash and inject the markup that shows it.
 *
 *  A project with no `app.splashSource` gets NOTHING — no asset, no markup, no behaviour change.
 *  The boot experience of every existing project is therefore byte-identical until it authors a
 *  splash, which is the same opt-in shape the native splash has. */
export function bootSplashPlugin(projectRoot: string, cfg: ProjectConfig, engineRoot: string): Plugin {
  const splashSrc = projectFile(projectRoot, cfg.app.splashSource);
  const titleSrc = projectFile(projectRoot, cfg.app.splashTitleSource);
  let composed: Buffer | null = null;
  let base = '/';

  return {
    name: 'modoki:boot-splash',
    apply: 'build',

    // The resolved base, not the raw config value — a web build can be deployed under a sub-path
    // and the injected URL has to survive that.
    configResolved(resolved) { base = resolved.base || '/'; },

    // ⚠️ Compose in buildStart, NOT in generateBundle. `transformIndexHtml` runs inside the HTML
    // plugin's own generateBundle, and plugin hooks of the same name have no guaranteed order
    // between them — composing there is a race that would inject the markup on some builds and
    // not others, depending on plugin order.
    async buildStart() {
      if (!splashSrc || !fs.existsSync(splashSrc)) return;
      try {
        const { buffer, clamped } = await composeWebSplash({
          srcPath: splashSrc,
          size: BOOT_SPLASH_SIZE,
          orientation: cfg.capacitor.orientation,
          titleSrc: titleSrc && fs.existsSync(titleSrc) ? titleSrc : '',
          titleWidthPct: cfg.app.splashTitleWidthPct,
          titleOffsetPct: cfg.app.splashTitleOffsetPct,
          badge: cfg.app.splashBadge,
          badgeLightArt: path.join(engineRoot, 'engine/assets/splash-badge-light.png'),
          badgeDarkArt: path.join(engineRoot, 'engine/assets/splash-badge-dark.png'),
        });
        composed = buffer;
        for (const what of clamped) {
          this.warn(`[boot-splash] ${what} was clamped into the crop-safe box`);
        }
      } catch (e) {
        // Non-fatal, like the native generator: a game with no boot splash still ships, it just
        // boots onto the old dark screen.
        this.warn(`[boot-splash] skipped (${(e as Error).message})`);
        composed = null;
      }
    },

    generateBundle() {
      if (composed) this.emitFile({ type: 'asset', fileName: BOOT_SPLASH_FILE, source: composed });
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!composed) return html;
        const url = `${base.endsWith('/') ? base : `${base}/`}${BOOT_SPLASH_FILE}`;
        return html.replace('</body>', `${bootSplashMarkup(url, '#0a0a1a')}</body>`);
      },
    },
  };
}
