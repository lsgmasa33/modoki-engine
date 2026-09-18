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

import { Texture, CanvasSource } from 'pixi.js';
import { loadMtsdfAtlasTexture } from '../pixiTextureLoad';
import type { FontProvider } from './fontProvider';
import { markTextDirty } from './textDirty';
import { createLoadFailureMemo } from '../../core/loadFailureMemo';
import { absentIfBundled } from '../../core/assetLoadErrors';

const cache = new Map<string, Texture>();
/** In-flight atlas loads, keyed like `cache` — a dedupe marker so a second caller does not
 *  start a second load of the same atlas.
 *
 *  ⚠️ **This used to be a map of per-caller `onReady` waiters, and that channel is gone on
 *  purpose (#1368 B).** The editor always runs two `Scene2DRenderer`s (Game + Scene panel) on this
 *  one module-level cache, and an earlier `loading` flag dropped the second renderer's wake — text
 *  missing until you clicked the entity. The waiter set fixed that for the renderers that passed a
 *  callback, and only for them. The load now settles into the font family's SHARED hub,
 *  `markTextDirty(fontId)`, which every idle-gated surface subscribes to (Scene2D, Scene3D,
 *  SceneView) and which also bumps that font's text version, so the woken frame re-lays out
 *  exactly this font's text. Same hub `fontAtlasLoader` and `dynamicFontProvider` already use. */
const inFlight = new Set<string>();
/** What a FAILED atlas load left behind (#1397). Before it, nothing: the `.catch` freed the key
 *  and "the next call re-attempts" — and the next call is the next Scene2D text pass, every
 *  running frame. A 404 or the SPA fallback is now remembered; a dropped connection or a 5xx backs
 *  off, and `onRetryDue` repaints that font's text when the retry is due (an idle Scene2D would not
 *  ask again on its own). `unknownIs: 'transient'` for the no-`createImageBitmap` fallback, whose
 *  Pixi loader reports every failure the same opaque way. Keyed `fontId + '\n' + url`: the url
 *  carries the content hash, so a re-bake arrives under a fresh key, and the font id is what the
 *  wake needs. Forgotten when the provider is disposed. */
const atlasFailures = createLoadFailureMemo({
  label: 'fontTexturePixi',
  unknownIs: 'transient',
  onRetryDue: (key) => markTextDirty(key.slice(0, key.indexOf('\n'))),
});
/** Providers already watched for disposal, and the ones that have been disposed (#1397 review). */
const watchedProviders = new WeakSet<FontProvider>();
const disposedProviders = new WeakSet<FontProvider>();
function watchDisposal(provider: FontProvider): void {
  if (watchedProviders.has(provider)) return;
  watchedProviders.add(provider);
  provider.addDisposable(() => { disposedProviders.add(provider); });
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
 *  no image yet; a completed load fires `markTextDirty(provider.id)` so every surface re-renders.
 *  Baked fonts are single-page (page 0 → the image URL). */
export function getFontTexturePixi(provider: FontProvider, page = 0): Texture | null {
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
  // Already loading — its settle wakes every surface, this caller included (see `inFlight`).
  if (inFlight.has(key)) return null;
  const url = provider.atlasImageUrl;
  const failureKey = `${provider.id}\n${url}`;
  if (atlasFailures.blocked(failureKey)) return null;
  inFlight.add(key);
  watchDisposal(provider);

  // ⚠️ NOT `loadPixiTexture` (#1045): `Assets.load` decodes via a bare `createImageBitmap(blob)`,
  // and on iOS 16 the UA default for that is PREMULTIPLY — which destroys the distance field and
  // makes every glyph invisible. The three lines below cannot repair it, because the WebGL unpack
  // flag is ignored for ImageBitmap sources. `loadMtsdfAtlasTexture` decodes unpremultiplied.
  loadMtsdfAtlasTexture(url)
    .then((tex: Texture) => {
      // Distance-field data: linear filter, NO premultiply (RGB median must stay
      // intact under low alpha). Set before first GPU upload (lazy on first render).
      // Redundant with the source the loader builds, and kept: the no-createImageBitmap
      // fallback path returns an Assets-loaded texture that has NOT been styled.
      tex.source.scaleMode = 'linear';
      tex.source.alphaMode = 'no-premultiply-alpha';
      tex.source.update();
      cache.set(key, tex);
      atlasFailures.forget(failureKey);
      provider.addDisposable(() => {
        cache.delete(key);
        // This texture is normally OURS — `loadMtsdfAtlasTexture` builds it outside Pixi's
        // `Assets`, so `Assets.unload` would be a silent no-op and leak the atlas (8 MB for a
        // 2048x1024 page). Destroy it directly, source and all, as the dynamic canvas path does.
        //
        // ⚠️ ONE path returns an Assets-MANAGED texture instead: the no-`createImageBitmap`
        // fallback. Destroying that one logs Pixi's "A Texture managed by Assets was destroyed
        // instead of unloaded!" and then unloads it itself, so it self-heals — cosmetic, and
        // unreachable on every shipping target (iOS 16.4+ / Android 12+ all have
        // `createImageBitmap`). Not worth branching on a `destroy` vs `unload` decision that
        // no supported device can take.
        //
        // The backing `ImageBitmap` is NOT `.close()`d, which matches the old `Assets.unload`
        // path exactly — not a regression. It cannot be closed at LOAD time either: `ImageSource`
        // forces `autoGarbageCollect`, and Pixi's texture GC re-uploads from `source.resource`
        // after an idle unload. If Font-Inspector churn (`invalidateFont` fires per re-bake and
        // per axis flip) is ever MEASURED to grow memory, the one safe place is capturing
        // `tex.source.resource` here, before the destroy below.
        tex.destroy(true);
      });
      // ⚠️ ON AN ALREADY-DISPOSED PROVIDER the disposer above just ran SYNCHRONOUSLY (#481), so
      // the entry cached one line up is already gone and this texture is being unloaded — and the
      // wake below is STILL CORRECT. Do not "fix" this into an early return or a `wake:false`;
      // that was tried during #481's close-out and is a regression, twice over:
      //
      //  · `inFlight` is keyed by the font GUID, so it OUTLIVES the provider INSTANCE while the
      //    cache entry does not. `invalidateFont` disposes P1 and re-acquires P2 under the same
      //    guid, and a repaint in that window finds P1's load still in flight and returns null
      //    WITHOUT starting P2's. Not waking strands exactly that repaint, which is verbatim the
      //    "texts are not rendered until I click the entity" bug. (`markTextDirty` is keyed by the
      //    same guid, so the wake reaches P2's text.)
      //  · The feared load/unload storm cannot happen. A woken repaint resolves its provider
      //    through `getLoadedFont(guid)`, and every disposal path deletes from `providers` in the
      //    same synchronous block — so the retry gets the LIVE P2 or no provider at all, never the
      //    disposed P1 that landed here. Bounded at one iteration.
      //
      // The `.catch` below settles without waking EXCEPT when this provider was disposed mid-load:
      // then a successor is stranded behind `inFlight` exactly as here, and it wakes too (#1397).
      //
      // Cache FIRST, then wake — a listener re-renders synchronously inside markDirty in some
      // hosts, and it must find the texture rather than kick a second load.
      inFlight.delete(key);
      markTextDirty(provider.id);
    })
    .catch((e: unknown) => {
      // Free the key WITHOUT waking: there is nothing to draw, and a wake here would make a failing
      // atlas a per-frame fetch loop. The memo decides when the next call may re-attempt, and wakes
      // for it itself (#1397).
      inFlight.delete(key);
      if (disposedProviders.has(provider)) {
        // Superseded mid-load (`invalidateFont`). Its failure is not the successor's to inherit, and
        // the successor is stranded: its repaint found this load in flight and returned null, and
        // nothing else will ask again on an idle Scene2D. Wake once, so it starts its own load —
        // the same reason the success path above still wakes for a disposed provider (#481).
        markTextDirty(provider.id);
        return;
      }
      const firstOfStreak = atlasFailures.retryAt(failureKey) === undefined;
      atlasFailures.record(failureKey, absentIfBundled(url, e));
      // One disposer per streak, not per retry: a disposed font forgets its failures.
      if (firstOfStreak) provider.addDisposable(() => atlasFailures.forget(failureKey));
    });
  return null;
}
