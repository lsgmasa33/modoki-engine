/** PixiJS atlas-texture cache for SDF fonts — the 2D twin of {@link getFontTexture}
 *  (the Three version). One Pixi Texture per `${fontId}:image` (the immutable baked
 *  atlas) plus one per `${fontId}:canvas:${page}` (generated pages), freed when the font
 *  is released
 *  (provider.addDisposable) — so the GPU texture tracks the font's scene-scoped life
 *  without the renderer-agnostic provider importing Pixi.
 *
 *  MTSDF atlases are DATA (distance fields), not colour: NO premultiply (that would
 *  corrupt the RGB median where alpha is low), linear filtering, no mipmaps. The
 *  `-yorigin top` bake gives top-origin UVs, which is Pixi-native (no flip).
 */

import { Assets, Texture, CanvasSource } from 'pixi.js';
import { loadPixiTexture } from '../pixiTextureLoad';
import type { FontProvider } from './fontProvider';

const cache = new Map<string, Texture>();
/** In-flight atlas loads → every caller waiting to be woken when one lands.
 *
 *  ⚠️ **A Set of waiters, not a bare `loading` flag, and that IS the bug this replaces.** The cache
 *  is module-level and SHARED by every `Scene2DRenderer`, and the editor always runs two of them
 *  (the Game panel and the Scene panel). Both ask for the same atlas in the same frame; the first
 *  starts the load, and the second used to hit a `loading.has(key)` early-return that dropped its
 *  `onReady` on the floor. So when the texture landed only ONE renderer was marked dirty — the
 *  other kept its last frame, which had every primitive (those are synchronous) and no TEXT, until
 *  some unrelated repaint. Reported as "the texts are not rendered when I open the prefab; I have
 *  to click on the entity to see the text": clicking changes the selection, which marks the panel
 *  dirty, and the now-cached atlas draws.
 *
 *  Bounded by the settle: the set is cleared on resolve AND on reject. A renderer that re-renders
 *  several times during one load adds one closure per frame (they are fresh arrows, so identity
 *  cannot dedupe them) — a handful, all idempotent `markDirty` calls, all dropped on settle. */
const waiters = new Map<string, Set<() => void>>();

/** Register `fn` to be woken when `key`'s load settles. Returns true if a load is ALREADY in
 *  flight — i.e. the caller must not start a second one. */
function addWaiter(key: string, fn?: () => void): boolean {
  const existing = waiters.get(key);
  if (existing) { if (fn) existing.add(fn); return true; }
  waiters.set(key, fn ? new Set([fn]) : new Set());
  return false;
}

/** Settle `key`: wake everyone waiting on it exactly once, then drop the set. */
function settleWaiters(key: string, wake: boolean): void {
  const set = waiters.get(key);
  waiters.delete(key);
  if (!wake || !set) return;
  for (const fn of set) fn();
}
/** Last atlasVersion uploaded into each dynamic canvas-backed Texture. */
const uploadedVersion = new WeakMap<Texture, number>();

/** Dynamic (path B): build ONE Texture from a page's growing canvas and call
 *  `source.update()` whenever atlasVersion bumps (a new glyph batch was blitted). */
function getDynamicFontTexturePixi(provider: FontProvider, page: number): Texture | null {
  const canvas = provider.atlasCanvasAt?.(page);
  if (!canvas) return null;
  const key = `${provider.id}:canvas:${page}`;
  let tex = cache.get(key);
  // Defense-in-depth: the disposer below always evicts BEFORE destroying, so a cache hit should
  // never be destroyed — but make this function total rather than trust that ordering forever.
  if (tex?.destroyed) {
    cache.delete(key);
    tex = undefined;
  }
  if (!tex) {
    const source = new CanvasSource({ resource: canvas, scaleMode: 'linear', alphaMode: 'no-premultiply-alpha' });
    const created = new Texture({ source });
    cache.set(key, created);
    provider.addDisposable(() => {
      cache.delete(key);
      created.destroy(true);
    });
    // ⚠️ addDisposable on an ALREADY-disposed provider runs `fn` NOW, not later — documented,
    // deliberate (fontProvider.ts). So by this line the texture minted three lines up can
    // already be destroyed and evicted, and returning it would hand Scene2D a corpse it binds
    // and renders in the same pass. Latent today (no disposed provider has a route to here),
    // so this closes the contract hole rather than a reproduced failure. (#481)
    if (created.destroyed) return null;
    tex = created;
  }
  if (uploadedVersion.get(tex) !== provider.atlasVersion) {
    tex.source.update();
    uploadedVersion.set(tex, provider.atlasVersion);
  }
  return tex;
}

/** Get (or kick off loading of) the atlas texture for a font provider's `page`
 *  (default 0). Returns the cached Texture, or null while it loads / for a page with
 *  no image yet; `onReady` fires once a load completes so the caller can re-render.
 *  Baked fonts are single-page (page 0 → the image URL). */
export function getFontTexturePixi(provider: FontProvider, page = 0, onReady?: () => void): Texture | null {
  // Ask for a CANVAS first, and fall through when there isn't one — do NOT branch on the
  // method merely existing. A baked-seeded dynamic font has both: page 0 is the baked
  // IMAGE and generated pages follow it, so branching on `atlasCanvasAt` being defined
  // would send page 0 down the canvas path and return null forever (no text at all).
  // Matches getFontTexture (the Three twin), which already did it this way.
  if (provider.atlasCanvasAt?.(page)) return getDynamicFontTexturePixi(provider, page);
  if (page !== 0 || !provider.atlasImageUrl) return null; // only page 0 has an image
  /** Page 0's IMAGE is IMMUTABLE, so its key must NOT carry atlasVersion.
   *
   *  ⚠️ A baked-seeded dynamic font bumps `atlasVersion` on EVERY generated glyph batch, and
   *  its page 0 is the baked atlas image. Keyed by version, each batch minted a fresh key:
   *  the cache missed, `getFontTexture*` returned null while a redundant load of the SAME url
   *  started, and every baked glyph vanished for those frames — so typing CJK made the Latin
   *  text flicker. The superseded Texture also stayed in the map under its old key until the
   *  font was released. Harmless before this existed, because a provider was either all-image
   *  (version pinned 0) or all-canvas (this path unreachable); the hybrid made both live. */
  const key = `${provider.id}:image`;
  const existing = cache.get(key);
  // Same destroyed-but-truthy hazard as the dynamic path above (#481). This branch has it too,
  // and "the producer side is closed" is only true if BOTH paths are — a fix applied to one
  // branch of two reads as complete and is not.
  if (existing?.destroyed) cache.delete(key);
  else if (existing) return existing;
  // Queue behind an in-flight load rather than dropping this caller's wake-up (see `waiters`).
  if (addWaiter(key, onReady)) return null;

  const url = provider.atlasImageUrl;
  loadPixiTexture(url)
    .then((tex: Texture) => {
      // Distance-field data: linear filter, NO premultiply (RGB median must stay
      // intact under low alpha). Set before first GPU upload (lazy on first render).
      tex.source.scaleMode = 'linear';
      tex.source.alphaMode = 'no-premultiply-alpha';
      tex.source.update();
      cache.set(key, tex);
      provider.addDisposable(() => {
        cache.delete(key);
        Assets.unload(url).catch(() => { /* already gone */ });
      });
      // ⚠️ ON AN ALREADY-DISPOSED PROVIDER the disposer above just ran SYNCHRONOUSLY (#481), so
      // the entry cached one line up is already gone and this texture is being unloaded — and the
      // wake below is STILL CORRECT. Do not "fix" this into an early return or a `wake:false`;
      // that was tried during #481's close-out and is a regression, twice over:
      //
      //  · `waiters` is keyed by the font GUID, so it OUTLIVES the provider INSTANCE while the
      //    cache entry does not. The set can legitimately hold a waiter belonging to the live
      //    SUCCESSOR — `invalidateFont` disposes P1 and re-acquires P2 under the same guid, and a
      //    repaint in that window queues P2's `markDirty` behind P1's still-in-flight load
      //    (`addWaiter` returns true). Not waking strands exactly that renderer, which is verbatim
      //    the "texts are not rendered until I click the entity" bug this set exists to prevent.
      //  · The feared load/unload storm cannot happen. A woken repaint resolves its provider
      //    through `getLoadedFont(guid)`, and every disposal path deletes from `providers` in the
      //    same synchronous block — so the retry gets the LIVE P2 or no provider at all, never the
      //    disposed P1 that landed here. Bounded at one iteration.
      //
      // The `.catch` below may settle without waking only because no successor is stranded there;
      // the analogy between the two paths is false.
      //
      // Cache FIRST, then wake — a waiter re-renders synchronously inside markDirty in some
      // hosts, and it must find the texture rather than kick a second load.
      settleWaiters(key, true);
    })
    .catch((e: unknown) => {
      // Drop the waiters without waking them: there is nothing to draw, and the next call
      // re-attempts the load (the key is free again). Leaving them queued would strand a later
      // successful load's wake-ups behind closures from a dead attempt.
      settleWaiters(key, false);
      console.warn(`[fontTexturePixi] atlas load failed: ${url}`, e);
    });
  return null;
}
