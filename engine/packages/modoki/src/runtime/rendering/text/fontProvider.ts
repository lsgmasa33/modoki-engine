/** FontProvider — the seam that unifies baked (A) and dynamic (B) fonts. Both
 *  produce the same canonical {@link GlyphAtlas} and implement this interface, so
 *  everything downstream (layoutText, the mtsdf mesh/shader, the renderer hookups)
 *  is provider-agnostic. Only WHERE a glyph comes from differs.
 *
 *  A provider is renderer-agnostic: it holds the atlas image as a URL (baked) or a
 *  growing canvas (dynamic); each renderer builds its own GPU texture from that,
 *  keyed on {@link FontProvider.atlasVersion} so a dynamic grow triggers a re-upload.
 */

import type { GlyphAtlas } from './glyphAtlas';
import { kerningKey } from './glyphAtlas';
import type { LayoutFont } from './layoutText';

export interface FontProvider extends LayoutFont {
  /** The font asset GUID — the renderer's texture-cache key. */
  readonly id: string;
  /** Bumps whenever the atlas image bytes change (dynamic growth). Renderers key
   *  their GPU texture on `${id}:${atlasVersion}`. Baked providers keep this at 0. */
  readonly atlasVersion: number;
  /** Number of atlas pages. Baked is always 1 (the whole font is one image);
   *  the dynamic provider spills to further pages once one fills, and each renderer
   *  draws one mesh per page bound to that page's texture. */
  readonly pageCount: number;
  /** Baked: the served `~atlas.png` URL (single page). Dynamic providers leave this
   *  undefined and expose {@link atlasCanvasAt} instead. */
  readonly atlasImageUrl?: string;
  /** Dynamic: the in-memory atlas canvas for `page` (they grow as glyphs generate).
   *  Baked providers leave this undefined (they serve page 0 via {@link atlasImageUrl}).
   *  Returns undefined for an out-of-range page. */
  atlasCanvasAt?(page: number): HTMLCanvasElement | undefined;
  /** Ensure the given codepoints are available. Dynamic providers generate any
   *  misses (async — bumping atlasVersion + marking text dirty when ready); baked
   *  providers are a no-op (a miss stays a miss / fallback box). */
  ensureGlyphs(cps: Iterable<number>): void;
  /** Register a cleanup run when the font is released ({@link dispose}). The
   *  renderers use this to tie the GPU texture they build from the atlas image to
   *  the font's scene-scoped lifetime — WITHOUT the (renderer-agnostic) provider
   *  importing THREE/Pixi. Idempotent across dispose. */
  addDisposable(fn: () => void): void;
  dispose(): void;
}

/** A fixed, fully-baked font: the atlas is the whole font. A codepoint not in the
 *  baked charset simply misses (layout falls back / skips it). Synchronous. */
export class BakedFontProvider implements FontProvider {
  readonly atlasVersion = 0;
  readonly pageCount = 1;
  readonly id: string;
  readonly atlasImageUrl: string;
  protected glyphAtlas: GlyphAtlas;

  constructor(id: string, glyphAtlas: GlyphAtlas, atlasImageUrl: string) {
    this.id = id;
    this.glyphAtlas = glyphAtlas;
    this.atlasImageUrl = atlasImageUrl;
  }

  private disposables: Array<() => void> = [];

  get metrics() { return this.glyphAtlas.metrics; }
  get atlas() { return this.glyphAtlas.atlas; }

  getGlyph(cp: number) { return this.glyphAtlas.glyphs.get(cp); }
  kerning(a: number, b: number) { return this.glyphAtlas.kerning.get(kerningKey(a, b)) ?? 0; }

  ensureGlyphs() { /* baked: nothing to generate */ }

  addDisposable(fn: () => void) { this.disposables.push(fn); }

  dispose() {
    // Renderer-attached GPU resources (the Three/Pixi atlas texture) clean up here.
    for (const fn of this.disposables) { try { fn(); } catch { /* ignore */ } }
    this.disposables = [];
  }
}
