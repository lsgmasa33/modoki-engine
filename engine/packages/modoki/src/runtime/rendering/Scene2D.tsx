/** PixiJS 2D layer — renders ECS entities with Renderable2D into Canvas2D canvases.
 *  Driven by the shared frame driver (no own rAF).
 *
 *  Each Canvas2D entity gets a pooled PixiJS Container + HTMLCanvasElement.
 *  Renderable2D entities are rendered into their nearest Canvas2D ancestor's container.
 *  A design-resolution scaler maps logical coordinates to actual canvas pixels.
 *
 *  Renderable2D.sprite supports two modes:
 *   - primitive keyword: "square" | "triangle" | "circle" (or empty → circle)
 *     → rendered as a PixiJS Graphics tinted with Renderable2D.color
 *   - image URL: any string starting with "/" or "http"
 *     → rendered as a PixiJS Sprite; textures are preloaded via the
 *       registerBeforeSwap hook so there's no pop-in on scene swap.
 *
 *  INSTANCING (SceneView-Pixi migration Phase 0b): the render pass is a {@link Scene2DRenderer}
 *  CLASS so each viewport (runtime/GameView, editor SceneView) owns its own display objects,
 *  snapshots, dirty state, particle state, collider overlays, AND its own {@link Canvas2DPool}.
 *  A Pixi display object + a <canvas> can each live in only ONE place, so two viewports rendering
 *  the same Canvas2D entity need separate object trees. renderFrame is CAMERA-AGNOSTIC — content is
 *  drawn in each Canvas2D's reference space, mapped to that canvas's backing pixels by
 *  computeCanvasScale; the viewport difference (device letterbox vs editor zoom) is entirely the
 *  canvas size/mount, owned by Canvas2DMount. A module-level {@link defaultRenderer} (on the
 *  {@link defaultPool}) backs the free-function exports so runtime/GameView are byte-identical.
 *
 *  SHARED (module-global, NOT per-instance): the `spriteTextureRefs` refcount tracks the GLOBAL
 *  Pixi `Assets` decoded-image cache, so it is shared across renderers — a per-viewport count would
 *  `Assets.unload()` a texture another viewport still displays. `unloadAllSpriteTextures` (the nuke
 *  net) therefore runs ONLY on the primary renderer's swap/stop; non-primary renderers only release
 *  their own slots' refcounts. The trait cache + `deactivatedEntities` + skin buffers are global too. */

import type { World } from 'koota';
import { Graphics, Sprite, Mesh, MeshGeometry, Texture, Rectangle, Matrix, Assets, Container, Buffer, BufferUsage, type Shader, type Geometry } from 'pixi.js';
import { deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { getCurrentWorld, onWorldSwap } from '../core/ecs/world';
import { getAllTraits } from '../core/ecs/traitRegistry';
import { Transform, Renderable2D, Collider2D, SkinnedSprite2D, Billboard3D, FlatSprite3D, Text2D, TextAnimation, GroupAlpha, Mask2D } from '../traits';
import { MaterialInstance } from '../traits/MaterialInstance';
import { applyTextAnimation, isTextAnimating, isColorEffect, type TextAnimParams } from './text/textAnimate';
import { getTime } from '../core/getTime';
import { ensureFontLoaded, getLoadedFont } from '../loaders/fontAtlasLoader';
import { getFontTexturePixi } from './text/fontTexturePixi';
import { isPixiTextureLive, loadPixiTexture } from './pixiTextureLoad';
import { makeMtsdfPixiShader, updateMtsdfPixiStyle, canReuseMtsdfPixiShader, updateMtsdfPixiMetrics } from './text/mtsdfPixiShader';
import { layoutText } from './text/layoutText';
import { buildTextGeometryByPage, buildTextPositionsByPage, buildTextColorsByPage } from './text/textMesh';
import type { TextQuad } from './text/layoutText';
import { getTextDirtyVersion, onTextDirty } from './text/textDirty';
import type { MtsdfStyle } from './text/mtsdfStyle';
import { getCurrentSceneId } from '../scene/SceneManager';
import { getSkin2DBuffer, clearSkin2DBuffers, frameSkin2DUVs } from '../skinning/skin2DBuffers';
import { clearDeform2DBuffers } from '../animation/deform2DBuffers';
import { registerFrameCallback, unregisterFrameCallback, PRIORITY_RENDER_2D, PRIORITY_EDITOR_2D } from './frameDriver';
import { sceneManager } from '../scene/SceneManager';
import { isImagePath, isVideoRef, resolveImageUrl, resolvePrimitiveShape, getWorldTransform2D, resolveSprite, type ResolvedSprite } from './renderUtils';
import { syncVideoTextures2D, disposeVideoTextures2D, flushPendingVideoDestroy2D } from './videoTextureSync2D';
/** Shared empty result for the video pass when the module is excluded — a fresh [] per frame
 *  would allocate for a subsystem that isn't even in the build. */
const EMPTY_IDS: number[] = [];
import { computePivotOffset, computeSpriteScale, drawPrimitiveShapeGfx, drawColliderFillGfx, drawColliderOutlineGfx, colliderOutlineSig, COLLIDER_SPRITE, pixiBlendMode2D } from './render2DUtils';
import { computeCanvasScale, canvasPxToClient } from './canvas2DScaler';
import { getSpriteEpoch } from '../loaders/assetManifest';
import { ensureSpriteMaterial, clearSpriteMaterialCache } from '../loaders/spriteMaterialCache';
import { makePixiShaderInstance, type PixiShaderProgram } from './pixiShaderBuilder';
import { coerceParamValue } from '../loaders/shaderSchema';
import { register2DMaterialShaderMap, isEntity2DMaterialDirty } from './sprite2DMaterialBroker';
import { computePaintOrder } from './paintOrder';
import { computeGroupAlpha } from './groupAlpha';
import { computeMaskGroups } from './maskGroups';
import { buildMaskRamp } from './maskRamp';
import { maskOffsetWorld } from './maskPlacement';
import { findCanvasAncestor as resolveCanvasAncestor, Orphan2DTracker, orphan2DFallbackKey } from './canvas2DRouting';
import {
  createParticleSync2DState, syncParticles2D, releaseCanvas2DEmitters, disposeParticleSync2DState,
  type ParticleSync2DState, type ParticleSync2DCtx,
} from './particleSync2D';
import { addDirtyListener, onStructureDirty, readTraitData } from '../core/ecs/entityUtils';
import { isSimRunning, onPlayStateChange } from '../core/playState';
import { Canvas2DPool, defaultPool, type Canvas2DSlot } from './canvas2DPool';
import { registerBoundsProvider, type BoundsSurface, type EntityScreenBounds } from '../core/screenBounds';
import { ensurePixiKtxTranscoder } from '../loaders/pixiKtxTranscoder';

// ── Display object tracking ──

type DisplayKind = 'graphics' | 'sprite' | 'mesh' | 'text' | 'material';
// `spriteRef` is the RAW Renderable2D.sprite ref — used only for change detection
// (kind/url swap). `textureUrl` is the RESOLVED url makeSprite retained the
// texture under; disposeSlot must release on THIS, not spriteRef, or the refcount
// never balances when ref ≠ url (the normal GUID case) — see F3.
// `hasFrame` = the sprite displays a SUB-RECT of its base texture (a sliced sprite /
// atlas frame), so `obj.texture` is a per-slot framed Texture WRAPPER we created and
// must `.destroy(false)` on dispose — destroying the wrapper, never the Assets-owned
// shared source. A whole-image sprite (hasFrame=false) borrows the base texture and
// must NOT destroy it.
// `meshVersion` (mesh slots only) tracks the last skin-deform version uploaded to the
// geometry — Scene2D re-uploads positions only when skin2DSystem bumps it. -1 for
// non-mesh slots. For a mesh slot `spriteRef` holds the rig ref (change detection).
interface Slot { kind: DisplayKind; obj: Graphics | Sprite | Mesh | Container; spriteRef: string; textureUrl: string; hasFrame: boolean; builtEpoch: number; meshVersion: number; meshFrameKey?: string;
  // Skinned-mesh slots (kind 'mesh'): obj is a Container holding one Mesh per rig part.
  meshes?: Mesh[]; partUrls?: string[];
  // Text slots (kind 'text'): obj is a Container holding one Mesh per atlas PAGE (in
  // `pageMeshes` — its own field because `meshes` (TextureShader) would reject the mtsdf
  // Shader — each with its page's shader in `textShaders`). Dynamic CJK spills across
  // pages; baked/single-page has one. `spriteRef` holds the font GUID, `meshFrameKey`
  // the layout hash. `textW/textH` are the laid-out block size (for the anchor pivot on
  // the container); the atlas textures are font-owned (not disposed here).
  pageMeshes?: Mesh<MeshGeometry, Shader>[]; textShaders?: Shader[]; textW?: number; textH?: number;
  // Text animation: un-animated layout quads (per-frame per-glyph animation recomputes
  // page positions from these, reusing the shaders); `pageNums[i]` is the atlas page of
  // `pageMeshes[i]` (built list can SKIP not-ready pages, so the animation write must
  // match by page number, not array index); `wasAnimated` restores the base pose once
  // on deactivation; `animStart` is the smoothedElapsed captured at (re)activation so
  // each Play restarts the effect from t=0.
  baseQuads?: TextQuad[]; pageNums?: number[]; wasMotion?: boolean; wasColored?: boolean; animStart?: number; animEffect?: string;
  // Text slots only: consecutive failed rebuild attempts (see the `meshFrameKey` sentinel
  // comment below) — bounds the retry so a PERMANENT failure degrades to a quiet blank
  // instead of churning every frame forever.
  textRebuildFails?: number; textRebuildFailHash?: string;
  // Material slots (kind 'material'): obj is a Mesh (quad geometry + a per-entity
  // pixiShaderBuilder Shader) sampling the entity's OWN sprite bitmap as `uTexture`
  // (or Texture.WHITE when it has no sprite). `matGuid` is the bound 2D-material GUID;
  // `matSig` gates a rebuild (size/pivot AND the resolved sprite-texture url, so the
  // Mesh re-mints with the real texture the frame it lands). `textureUrl` holds the
  // retained sprite url (shared spriteTextureRefs — released in disposeSlot). The shader
  // is also registered in Scene2DRenderer.entityShaders for MaterialInstance driving.
  // `materialTexUrls` holds the resolved urls of the shader's extra `texture` params
  // (additional samplers) — each retained on build + released in disposeSlot, like textureUrl.
  // `matSpriteRef` is the SAMPLED sprite ref (`spriteRef` is taken — it holds the material GUID
  // on this kind). It is deliberately NOT in `matSig`, so an atlas frame swap within one sheet
  // shows up as "sig equal, ref moved" and takes the one-uniform fast path instead of a full
  // Mesh+Shader+Geometry rebuild (#698). `builtEpoch` tracks the sampled sprite's re-slice epoch
  // here (the sprite path's meaning), so re-slicing the sheet invalidates the slot even when the
  // url is unchanged.
  matShader?: Shader; matGuid?: string; matSig?: string; materialTexUrls?: string[]; matSpriteRef?: string }

// ── SHARED texture refcount (global — tracks the global Assets cache) ──
// Per-URL refcount for PixiJS Assets. When the last sprite using a URL is
// destroyed, the texture is unloaded from the global Assets cache to release VRAM.
// SHARED across all Scene2DRenderer instances: two viewports displaying the same URL
// each hold a ref, so a texture unloads only when the LAST viewport releases it (F3).
const spriteTextureRefs = new Map<string, number>();

// ⚠️ A refcount reaching 0 does NOT mean the texture is finished with — it means nothing holds it
// AT THIS INSTANT. A renderer that rebuilds a subtree by despawning and respawning it (Court's
// board overlay does exactly this on every interaction) legitimately drops a url to 0 and back to
// 1 inside ONE synchronous frame, and unloading on the spot destroyed the source out from under
// the sprite about to re-retain it: `Assets.unload` removes the cache entry asynchronously but
// destroys the source eagerly, so the respawned sprite found `cache.has(url) === true`, bound a
// sourceless texture and drew NOTHING, permanently. So the unload is DEFERRED by a macrotask and
// CANCELLED if anything re-retains in the meantime — a same-frame rebuild never reaches it, while
// a genuine last release still frees the VRAM one tick later.
const pendingTextureUnloads = new Map<string, ReturnType<typeof setTimeout>>();

// ── EDITOR-PANEL holds on a sprite url (#701) ──
// Deliberately a SECOND map rather than more entries in `spriteTextureRefs`, because that one is
// SCENE-scoped by design (F3: "no texture accounting survives a scene") and `unloadAllSpriteTextures`
// erases it wholesale on world swap / last-renderer stop. An editor panel showing a preview outlives
// any number of world swaps, so folding its hold into the scene map would have the swap unload a
// texture the panel is still displaying — the mirror image of the hazard #701 exists to avoid.
// A panel hold therefore VETOES the unload instead of participating in the scene refcount.
const panelTextureRefs = new Map<string, number>();

/** Hold a sprite url on behalf of a long-lived editor panel. Pair with {@link releasePanelTexture}. */
export function retainPanelTexture(url: string): void {
  if (!url) return;
  const pending = pendingTextureUnloads.get(url);
  if (pending !== undefined) { clearTimeout(pending); pendingTextureUnloads.delete(url); }
  panelTextureRefs.set(url, (panelTextureRefs.get(url) ?? 0) + 1);
}

/** Drop a panel's hold. Frees the texture only when no OTHER panel and no scene slot holds it —
 *  a blind `Assets.unload` here would evict a texture another live panel (or the viewport) is
 *  still sampling, which is exactly why #701 could not be fixed with a matching unload. */
export function releasePanelTexture(url: string): void {
  if (!url) return;
  const n = (panelTextureRefs.get(url) ?? 0) - 1;
  if (n > 0) { panelTextureRefs.set(url, n); return; }
  panelTextureRefs.delete(url);
  if ((spriteTextureRefs.get(url) ?? 0) > 0) return;   // a scene slot still samples it
  deferUnload(url);
}

/** Arm the deferred unload shared by both release paths. Deferred rather than immediate for the
 *  reason `pendingTextureUnloads` documents above: a release landing in the same tick as a
 *  refcount trough on a shared url would otherwise destroy the source out from under the rebuild
 *  about to re-retain it. Cancels itself if EITHER a scene slot or a panel re-retains meanwhile. */
function deferUnload(url: string): void {
  if (pendingTextureUnloads.has(url)) return;
  const handle = setTimeout(() => {
    pendingTextureUnloads.delete(url);
    if ((spriteTextureRefs.get(url) ?? 0) > 0 || panelTextureRefs.has(url)) return;
    unloadSpriteTextureNow(url);
  }, 0);
  pendingTextureUnloads.set(url, handle);
}

function unloadSpriteTextureNow(url: string) {
  // A panel hold vetoes every unload path — both `releaseSpriteTexture`'s deferred timer and
  // `unloadAllSpriteTextures`'s wholesale sweep funnel through here, so this one check covers
  // both without either needing to know panels exist.
  if (panelTextureRefs.has(url)) return;
  if (Assets.cache.has(url)) Assets.unload(url).catch(() => { /* ignore */ });
}

function retainSpriteTexture(url: string) {
  const pending = pendingTextureUnloads.get(url);
  if (pending !== undefined) { clearTimeout(pending); pendingTextureUnloads.delete(url); }
  spriteTextureRefs.set(url, (spriteTextureRefs.get(url) ?? 0) + 1);
}
function releaseSpriteTexture(url: string) {
  const n = (spriteTextureRefs.get(url) ?? 0) - 1;
  if (n <= 0) {
    spriteTextureRefs.delete(url);
    deferUnload(url);
  } else {
    spriteTextureRefs.set(url, n);
  }
}

/** Unload every tracked sprite texture and clear the refcount map. Called on world
 *  swap + stop AFTER all slots are disposed, and ONLY by the PRIMARY renderer: a
 *  non-primary (editor) renderer stopping alone must NOT nuke textures GameView still
 *  shows. A balanced run leaves the map empty (each disposeSlot already released its
 *  texture), so this is a defensive net that also enforces the "no texture accounting
 *  survives a scene" invariant (F3) — without it any drift would pin VRAM across scenes. */
function unloadAllSpriteTextures() {
  for (const url of spriteTextureRefs.keys()) unloadSpriteTextureNow(url);
  spriteTextureRefs.clear();
  // Deferred unloads must be SETTLED here, not left to fire after the world is gone: their
  // timers close over a url whose accounting this call is erasing, so leaving one armed would
  // let it run against the NEXT scene's cache. Flushing them (rather than only cancelling)
  // keeps the "no texture accounting survives a scene" invariant (F3) exact.
  for (const [url, handle] of pendingTextureUnloads) { clearTimeout(handle); unloadSpriteTextureNow(url); }
  pendingTextureUnloads.clear();
}

/** SCANNED frames a visible 2D entity may go undrawn for want of a Canvas2D ancestor before the
 *  warning fires — deliberately 1, i.e. the first scan that sees it.
 *
 *  This started as ~1s-at-60fps, on the reasonable-sounding theory that a grace window would
 *  cover a load that spawns a child before its canvas host. Measured in a live editor: it NEVER
 *  fired. `renderFrame` skips its entire ECS scan while the sim is stopped and nothing is dirty
 *  (the idle skip below), so these are not wall-clock frames at all — instantiating an orphaned
 *  rig into a stopped editor produced exactly ONE scan with the entity orphaned, and then
 *  silence. Any threshold above 1 is therefore a warning that only fires while the game is
 *  running, which is precisely the case a human is least likely to be reading the console for.
 *  The residual risk — a mid-load scan catching a child before its canvas — is a single
 *  console line, against the alternative of the silence this whole change exists to end. */
const ORPHAN_2D_WARN_FRAMES = 1;

// A Text2D rebuild that keeps throwing (malformed atlas, a font provider stuck not-ready)
// gets this many consecutive attempts before giving up for the current layout hash — see
// the `textRebuildFails` catch in the Text2D draw pass below. Small on purpose: a
// transient failure (the common case — a texture arriving next frame) clears in one or
// two, so this exists only to cap the PERMANENT case, not to smooth over real flakiness.
const TEXT_REBUILD_MAX_RETRIES = 3;

// ── Trait metadata cache (global — the trait registry is process-wide) ──
let traitsCached = false;
let canvas2dMeta: any;
let attrMeta: any;

function cacheTraits() {
  const allTraits = getAllTraits();
  canvas2dMeta = allTraits.find(m => m.name === 'Canvas2D');
  attrMeta = allTraits.find(m => m.name === 'EntityAttributes');
  traitsCached = !!(canvas2dMeta && attrMeta);
}

// ── Display object factories (stateless / global-refcount only) ──

function makeGraphics(container: Container): Graphics {
  const g = new Graphics();
  container.addChild(g);
  return g;
}

/** A pivot-offset quad (two triangles) sized to a Renderable2D's width/height, with
 *  0..1 UVs — the geometry a 2D-material Mesh is drawn on. Matches the primitive
 *  convention (width/height are half-extents; full size is ×2), so a material quad
 *  lines up with the same entity rendered as a primitive. */
export function buildMaterialQuad(w: number, h: number, px: number, py: number): MeshGeometry {
  const { ox, oy } = computePivotOffset(w, h, px, py); // top-left corner in local space
  const x0 = ox, y0 = oy, x1 = ox + w * 2, y1 = oy + h * 2;
  return new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

/** Build the per-slot texture for a sprite: the base texture for a whole image, or a
 *  framed WRAPPER (sub-rect) for a sliced sprite / atlas frame. Source-px frames are
 *  scaled to the actually-loaded variant (which `maxSize` may have downscaled). */
function frameTexture(base: Texture, r: ResolvedSprite): Texture {
  if (!r.frame) return base;
  let { x, y, w, h } = r.frame;
  if (r.sheetW && r.sheetH && base.width > 0 && base.height > 0) {
    const sx = base.width / r.sheetW, sy = base.height / r.sheetH;
    x *= sx; y *= sy; w *= sx; h *= sy;
  }
  // Clamp into the base texture so a slightly-off rect never throws on upload.
  x = Math.max(0, Math.min(x, base.width));
  y = Math.max(0, Math.min(y, base.height));
  w = Math.max(1, Math.min(w, base.width - x));
  h = Math.max(1, Math.min(h, base.height - y));
  return new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) });
}

/** Mint what a material Mesh samples, from an already-resolved ref: the base texture for a whole
 *  image, a framed WRAPPER for an atlas slice.
 *
 *  ⚠️ EVERY call that mints a wrapper allocates a `Texture` the shared long-lived `TextureSource`
 *  then holds via a `source.on('resize')` backref — so the wrapper is NOT collectable once
 *  dropped. Call this ONLY where a wrapper is actually kept: a Mesh build, or a frame swap that
 *  stores it on the slot. The material pass used to call the resolver (which minted inline) once
 *  per material entity per FRAME and drop the result on the floor. Only an ATLAS-SLICED sprite
 *  allocated — a whole image borrows the base texture and always did — so the cost was 482 bytes
 *  per frame per sliced material entity, ~1.65 MB/min (#697, measured in Node against the
 *  vendored pixi; LATENT today because no such entity is authored in any current project). The
 *  sprite path never had this bug: its `needResolve` guard resolves only when the ref or the
 *  re-slice epoch actually moved. */
function mintMaterialTexture(r: { base: Texture; resolved: ResolvedSprite | null; hasFrame: boolean }): Texture {
  return r.hasFrame && r.resolved ? frameTexture(r.base, r.resolved) : r.base;
}

/** Collect an entity's per-instance 2D-material TEXTURE overrides — `MaterialInstance`
 *  overrides with `kind:'texture'` — as a Map<param target, sprite/texture GUID>. These
 *  override the shader's texture-param manifest DEFAULT for this instance (an extra-sampler
 *  swap). Returns undefined when the entity has no such override (the common case), so the
 *  material pass skips the Map allocation entirely. Scalar `uniform` overrides are ignored
 *  here — they're driven by materialInstanceSystem into the shader uniforms. */
function readTextureOverrides(entity: any): Map<string, string> | undefined {
  if (!entity.has(MaterialInstance)) return undefined;
  const mi = entity.get(MaterialInstance) as { overrides?: { target: string; kind?: string; ref?: string }[] } | undefined;
  let out: Map<string, string> | undefined;
  for (const o of mi?.overrides ?? []) {
    if (o.kind === 'texture' && o.ref && o.target) (out ??= new Map()).set(o.target, o.ref);
  }
  return out;
}

/** Record the scale that maps a mask Sprite's texture onto the authored half-extents.
 *
 *  A texture whose size is not yet known (an async sprite load still in flight — `Texture.EMPTY`
 *  is 0x0 or 1x1) would divide to a garbage factor, so this leaves the base at 1 and lets the
 *  next rebuild fix it once the bitmap has landed; `makeSprite` calls `markDirty` on load, which
 *  is what brings that frame around. */
function setMaskBaseScale(slot: MaskSlot, sp: Sprite, d: MaskData) {
  const tw = sp.texture?.width ?? 0;
  const th = sp.texture?.height ?? 0;
  slot.baseScaleX = tw > 1 ? (d.width * 2) / tw : 1;
  slot.baseScaleY = th > 1 ? (d.height * 2) / th : 1;
}

/** Whether two sparse entityId → maskId maps agree. Both are SPARSE (only masked entities
 *  appear), so the common case — no masks anywhere, or a stable set — is a size check against
 *  two empty maps and returns immediately. */
function sameGrouping(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, mask] of a) if (b.get(id) !== mask) return false;
  return true;
}

/** The ONLY place a Pixi `Geometry` is destroyed. PixiJS 8.19.0's `Geometry.destroy()` calls
 *  `removeAllListeners()` BEFORE it calls `unload()`, so the GC hook that actually frees the GL
 *  VAO — `GlGeometrySystem.onGeometryUnload`, the only `gl.deleteVertexArray` call site, reached
 *  only via `GCManagedHash`'s `item.once("unload", …)` registration — is torn off before
 *  `unload()` ever fires, permanently orphaning the VAO. `destroy(true)` alone does not fix it:
 *  `buffers.forEach` still runs before `unload()` inside the same call. `Buffer`, `TextureSource`,
 *  `GraphicsContext` and `ViewContainer` all order `unload()` before `destroy()` correctly —
 *  `Geometry` is the one Pixi class that inverts it, so this is a workaround for an upstream
 *  quirk, not a local convention.
 *
 *  Guards against a second call on the same Geometry: `destroy(true)` nulls `buffers` (so
 *  `Geometry.destroy`'s own `this.buffers.forEach(...)` would run on a null next time), so a
 *  double release now THROWS where the old bare `geo.destroy()` was a silent no-op. The
 *  `!g.buffers` check below is load-bearing, not defensive noise — a caller that releases the
 *  same geometry twice (e.g. two dispose paths racing on the same slot) must still land here
 *  safely. */
export function releaseGeometry(g: Geometry | undefined | null): void {
  if (!g || !g.buffers) return;
  g.unload();
  g.destroy(true);
}

function disposeSlot(slot: Slot) {
  slot.obj.removeFromParent();
  // Skinned mesh: a Container holding one Mesh per rig part. Release each part's shared
  // base texture (retained like a sprite) and destroy each per-part geometry (Mesh.destroy()
  // does not free it), then the container.
  if (slot.kind === 'mesh') {
    for (const m of slot.meshes ?? []) { const geo = m.geometry; m.destroy(); releaseGeometry(geo); }
    for (const u of slot.partUrls ?? []) if (u) releaseSpriteTexture(u);
    slot.obj.destroy();
    return;
  }
  // Material: a single Mesh (quad geometry + a per-entity pixiShaderBuilder Shader).
  // Destroy the geometry (Mesh.destroy() doesn't) and the shader. The sampled texture
  // is the entity's own sprite bitmap (retained via the shared spriteTextureRefs, same
  // as a sprite slot) — release it on THIS slot's `textureUrl`, so its refcount balances
  // and it unloads when no sprite/material still holds it. A material with no sprite
  // samples Texture.WHITE (textureUrl='') → nothing to release. The instance's
  // entityShaders map entry is unregistered by the caller (it holds the entity id).
  if (slot.kind === 'material') {
    const mesh = slot.obj as Mesh;
    const geo = mesh.geometry;
    // An atlas slice bound a per-slot framed WRAPPER Texture (base source borrowed) — destroy it
    // with destroy(false) so the Texture object drops but the Assets-owned shared source survives
    // for releaseSpriteTexture to unload at refcount 0. A whole-image material borrows the base
    // texture (hasFrame=false), and a spriteless material samples Texture.WHITE — never destroyed.
    const tex = slot.hasFrame ? (mesh.texture as Texture | undefined) : undefined;
    mesh.destroy();
    releaseGeometry(geo);
    // ⚠️ BARE `destroy()` ON PURPOSE — Pixi's `Shader.destroy(destroyPrograms = false)` leaves the
    // shared program alone, and (post-#716) `pixiShaderBuilder`'s program cache is MODULE-scope,
    // shared by every entity using that material across every canvas, for the rest of the session
    // — not just a per-GUID cache `ensureSpriteMaterial` itself owns. Changing this to
    // `destroy(true)` would free a GlProgram that other live Meshes STILL IN THE GRAPH point at,
    // from inside the pass that renders them — the #455 class, with a worse blast radius than the
    // mask that found it. Same for the text shaders below.
    slot.matShader?.destroy();
    if (tex && tex !== Texture.WHITE) tex.destroy(false);
    if (slot.textureUrl) releaseSpriteTexture(slot.textureUrl);
    // Extra samplers (texture params) borrow the base texture whole-image (no wrapper to
    // destroy) — just balance each retain. Empty urls (unresolved/WHITE) were never retained.
    for (const u of slot.materialTexUrls ?? []) if (u) releaseSpriteTexture(u);
    return;
  }
  // Text: a Container of one Mesh per atlas page, each with its own geometry + mtsdf
  // shader. The atlas textures are owned by the font (fontTexturePixi, freed on font
  // release) — never destroy them here.
  if (slot.kind === 'text') {
    for (const m of slot.pageMeshes ?? []) { const geo = m.geometry; m.destroy(); releaseGeometry(geo); }
    // ⚠️ BARE `destroy()` ON PURPOSE — same hazard as the material Shader above, now shared by
    // EVERY text entity: `mtsdfPixiShader.ts` caches its GL/GPU program at MODULE level (one
    // program for the whole file, not one per Shader instance), so `destroy(true)` here would call
    // `destroyPrograms` and null the SHARED program's `vertex`/`fragment` — killing every text mesh
    // in every canvas for the rest of the session, not just this slot's.
    for (const s of slot.textShaders ?? []) s.destroy();
    slot.obj.destroy();
    return;
  }
  // Destroy the per-slot framed-texture WRAPPER (sliced sprite / atlas frame) before
  // releasing the URL — `destroy(false)` drops the Texture object but keeps the
  // Assets-owned source, which releaseSpriteTexture then unloads when its refcount
  // hits 0. A whole-image sprite borrows the base texture (hasFrame=false) → never
  // destroyed here. Guard against the not-yet-loaded EMPTY placeholder.
  if (slot.kind === 'sprite' && slot.hasFrame) {
    const tex = (slot.obj as Sprite).texture;
    if (tex && tex !== Texture.EMPTY) tex.destroy(false);
  }
  // Release on the RESOLVED url makeSprite retained — NOT slot.spriteRef. For
  // GUID/variant refs the two differ, so releasing spriteRef would never balance
  // the retain and the texture would leak (never unload) — F3.
  if (slot.kind === 'sprite' && slot.textureUrl) {
    releaseSpriteTexture(slot.textureUrl);
  }
  slot.obj.destroy();
}

/** Per-entity snapshot of the inputs that determine an entity's rendered output.
 *  If every field matches last frame, the display object is already correct and we
 *  skip its gfx rebuild + transform writes. Mutated in place to avoid per-frame
 *  allocation for animating entities. */
interface RenderSnap {
  canvasId: number; kind: DisplayKind; spriteRef: string;
  x: number; y: number; rz: number; sx: number; sy: number;
  color: number; opacity: number; w: number; h: number; px: number; py: number; keepAspect: boolean;
  flipX: boolean; flipY: boolean;
  texW: number; texH: number; compX: number; compY: number; paint: number;
  /** Collider-outline signature when sprite='collider' — redraw when the shape/points change. */
  colliderSig: string;
  /** PixiJS blend mode string (from Renderable2D.blendMode). */
  blend: string;
}

/** A `Mask2D`'s authored fields plus its resolved WORLD transform, copied flat for the frame.
 *  Flat copies rather than the koota trait object because both are recycled: the trait row and
 *  `getWorldTransform2D`'s return are each shared storage that the next read overwrites. */
interface MaskData {
  mode: 'rect' | 'texture';
  width: number; height: number; pivotX: number; pivotY: number;
  cornerRadius: number; feather: number; sprite: string;
  /** The clip rect's centre, in the mask entity's own LOCAL space (design px) — see Mask2D's
   *  `offsetX`/`offsetY` doc. Applied on top of the entity's WORLD transform below, not composed
   *  into it, so the entity itself can stay at identity while the rect sits elsewhere. */
  offsetX: number; offsetY: number;
  x: number; y: number; rz: number; sx: number; sy: number;
}

/** Per-`Mask2D`-entity render state (#449).
 *
 *  The PixiJS tree this renderer builds is otherwise FLAT — every display object goes straight
 *  onto its Canvas2D slot container — but a Pixi mask applies to ONE display object, so masking a
 *  subtree needs a real container to hang it on. Each enabled `Mask2D` gets exactly one:
 *  `container` holds every display object the mask clips, and `maskObj` is what clips them.
 *
 *  ⚠️ `container` stays at IDENTITY transform. Children already carry fully-composed WORLD
 *  transforms (see the `getWorldTransform2D` writes below), so a container that transformed
 *  anything would apply it twice. It exists only to be something a mask can attach to.
 *
 *  ⚠️ A masked group therefore becomes a contiguous z-BAND: `sortableChildren` sorts within the
 *  container, and the container itself sorts among its siblings by the mask entity's own paint
 *  index. Entities outside the group cannot interleave with entities inside it. That is a real
 *  authoring constraint, documented on the trait.
 *
 *  `kind` records which Pixi pipe the mask resolved to, because it decides teardown: Pixi picks
 *  `AlphaMask` for a `Sprite` and `StencilMask` for any other `Container`, tested in that order
 *  (`pixi.js/lib/rendering/init.mjs` registers `AlphaMask, ColorMask, StencilMask`). An alpha mask
 *  owns a generated or loaded Texture that has to be released; a stencil `Graphics` does not.
 *
 *  `sig` is the geometry+mode signature the mask object was last built from — rebuilding is
 *  expensive for the alpha path (it rasterises a ramp), so it happens only when this changes, or
 *  (texture mode) when `forceAll` fires while the sprite is still showing an unsized placeholder
 *  bitmap (`stillPlaceholder`, below). Deliberately excludes `offsetX`/`offsetY`/the compensation
 *  factor — nothing the rebuild reads depends on them; they only feed the per-frame placement
 *  writes further down, so folding them in would rasterise a fresh ramp on every Inspector drag. */
interface MaskSlot {
  container: Container;
  maskObj: Graphics | Sprite;
  kind: 'stencil' | 'alpha';
  sig: string;
  canvasId: number;
  /** Sprite-texture URL retained for an alpha mask in `texture` mode, '' otherwise. Released on
   *  rebuild and on dispose so the shared sprite-texture refcount balances. */
  textureUrl: string;
  /** A Texture this slot GENERATED (the feathered ramp) and therefore owns outright. Distinct
   *  from `textureUrl`, which names a shared, refcounted asset this slot merely borrows. */
  ownedTexture: Texture | null;
  /** Scale that maps the mask OBJECT's intrinsic size onto the authored half-extents, before the
   *  entity's own world scale is applied.
   *
   *  ⚠️ This exists because Pixi implements `sprite.width = n` AS A SCALE against the texture's
   *  pixel size — so the per-frame `scale.set(worldScale)` below would silently undo the sizing
   *  done at build, and an alpha mask would collapse to its raw texture dimensions. (Measured:
   *  the crossword's 984x751 design-px clip shrank to the ~256px ramp and masked away all but a
   *  sliver of the grid, with every unit test and the typecheck green.) A `Graphics` mask draws
   *  its geometry in design units already and keeps 1. */
  baseScaleX: number;
  baseScaleY: number;
}

/** Per-entity snapshot for the SkinnedSprite2D (mesh) pass — mirrors RenderSnap but
 *  keyed on what a deformable mesh's output depends on: its world transform, tint/
 *  alpha, flips, paint order, AND the skin deform version (bumped by skin2DSystem). */
interface MeshSnap {
  canvasId: number; x: number; y: number; rz: number; sx: number; sy: number;
  color: number; opacity: number; flipX: boolean; flipY: boolean; paint: number;
  deform: number; compX: number; compY: number;
}

/** Per-entity snapshot for the Text2D pass. `layoutHash` gates a geometry rebuild
 *  (text/font/size/wrap/spacing changed); `styleHash` gates a shader-uniform update;
 *  the transform fields gate the cheap placement writes. */
interface TextSnap {
  canvasId: number; x: number; y: number; rz: number; sx: number; sy: number;
  anchorX: number; anchorY: number; paint: number; compX: number; compY: number;
  layoutHash: string; styleHash: string;
  /** GroupAlpha ancestry product (#211). Its own field rather than a term in `styleHash`:
   *  text opacity lives in the MTSDF shader uniforms, group alpha rides on the container,
   *  and folding it into the style hash would trigger a pointless uniform rewrite on every
   *  frame of a fade. It still has to be COMPARED here — the block early-returns when
   *  nothing changed, so a parent fading over a static label would otherwise never paint. */
  groupAlpha: number;
}

/** Per-entity snapshot for the 2D-material (Mesh) pass — the inputs that determine the
 *  Mesh's placement/appearance. The material pass used to force a canvas redraw EVERY
 *  running frame (a driver writes uniforms with no render-visible signal); this snap +
 *  the driver's `isEntity2DMaterialDirty` flag let a static-uniform material skip the GPU
 *  pass. Geometry/texture changes go through a slot REBUILD (`built`), not this snap. */
interface MaterialSnap {
  canvasId: number; x: number; y: number; rz: number; sx: number; sy: number;
  color: number; opacity: number; blend: string; paint: number;
  flipX: boolean; flipY: boolean; compX: number; compY: number;
}

/** Build the shared {@link MtsdfStyle} from a Text2D trait (same shape the 3D path
 *  feeds its material). */
function textStyle2D(t: any): MtsdfStyle {
  return {
    color: t.color, opacity: t.opacity, weight: t.weight,
    outlineColor: t.outlineColor, outlineWidth: t.outlineWidth, outlineOpacity: t.outlineOpacity,
    glowColor: t.glowColor, glowSize: t.glowSize, glowStrength: t.glowStrength,
    shadowColor: t.shadowColor, shadowOpacity: t.shadowOpacity,
    shadowOffsetX: t.shadowOffsetX, shadowOffsetY: t.shadowOffsetY, shadowSoftness: t.shadowSoftness,
  };
}
function textCodepoints(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}

const OUTLINE_STROKE = { width: 2, color: 0x2effa6, alpha: 0.9 } as const;
// Collider-ONLY mode (sprites hidden) uses purple — matches the 3D SceneView's collider-only
// wireframe color (see SceneView.tsx's ThreeJSViewport `drawCollider`), so the two viewports
// read as one consistent "you're looking at collision shapes" convention.
const COLLIDER_ONLY_STROKE = { width: 2, color: 0x9b59b6, alpha: 0.9 } as const;

// Frame-driver identity for the editor SceneView's (non-primary) renderer — distinct from the
// runtime's 'render2d' so the two never collide in the frame-driver Map. Defined before the class
// (the constructor derives the key from `primary`).
export const EDITOR_SCENE2D_FRAME_KEY = 'render2d:editor';
export const EDITOR_SCENE2D_FRAME_PRIORITY = PRIORITY_EDITOR_2D;

// Count of live Scene2DRenderers (start()↑ / stop()↓). The SHARED world/texture state
// (skin buffers, the `unloadAllSpriteTextures` refcount-net) may only be nuked when the LAST
// renderer stops — nuking it while another viewport is live would tear textures/skin buffers
// out from under it (the shared refcount is non-empty BY DESIGN with two viewports). Per-slot
// `releaseSpriteTexture` already unloads a texture correctly when its count hits 0 across BOTH
// viewports, so the blanket net is only for single-instance drift + final teardown.
let liveRenderers = 0;

/** Options for a {@link Scene2DRenderer}. */
export interface Scene2DRendererOptions {
  /** The pool this renderer's canvases come from. Default renderer uses `defaultPool`. */
  pool?: Canvas2DPool;
  /** Frame-driver callback key (must be unique per live renderer). */
  frameKey?: string;
  /** Frame-driver priority. Default renderer = PRIORITY_RENDER_2D; editor = PRIORITY_EDITOR_2D. */
  framePriority?: number;
  /** The PRIMARY (runtime) renderer owns process-wide registrations: the layout-bounds
   *  provider, the prewarm-before-swap hook, and the `unloadAllSpriteTextures` net (which
   *  nukes the SHARED Assets refcount). A non-primary (editor) renderer skips all three so
   *  it never tears texture accounting out from under GameView. */
  primary?: boolean;
  /** Per-frame presentation-delta PROVIDER for the 2D particle preview. Undefined → runtime: the sim
   *  advances on engine time (the `Time` trait). The editor SceneView passes a provider because its
   *  `Time` isn't advancing: it returns a wall-clock delta while particle-preview is ON, or `undefined`
   *  while OFF — which tells renderFrame to DISPOSE the preview emitters (matching the 3D preview) and
   *  keeps the render loop alive frame-to-frame only while previewing. */
  particleDt?: () => number | undefined;
}

export class Scene2DRenderer {
  private readonly pool: Canvas2DPool;
  private readonly frameKey: string;
  private readonly framePriority: number;
  private readonly primary: boolean;
  particleDt: (() => number | undefined) | undefined;
  private _wasPreviewing2D = false;

  // SoA-ish display tracking (per-instance).
  private readonly slots = new Map<number, Slot>();
  // Live per-entity 2D-material Shaders (kind 'material'), keyed by entity id — the
  // Scene2D-owned registry MaterialInstance's 2D driver writes uniforms into (Phase 3),
  // the minimal analog of the 3D materialBroker. Populated/cleared with the slot.
  readonly entityShaders = new Map<number, Shader>();
  // Pooled per-frame set of entity ids drawn by the material pass — used to purge stale
  // entityShaders entries without a per-frame allocation.
  private readonly _materialIdsScratch = new Set<number>();
  // Sprite-texture urls a material entity has kicked an async Assets.load for but that
  // aren't resident yet — dedupes the load so the every-running-frame material pass
  // doesn't re-issue it. Cleared per-url on settle (then markDirty wakes the rebuild).
  private readonly _materialTexLoading = new Set<string>();
  private readonly activeIds = new Set<number>();
  private readonly prevCanvasIds = new Set<number>();
  // Pooled per-frame canvas-id set; cleared on entry, mutated through the loop,
  // transferred into prevCanvasIds at the end. Avoids the per-frame `new Set`.
  private readonly currentCanvasIds = new Set<number>();

  // ── Dirty gating (F1) ──
  // renderFrame re-rendered every Canvas2D every frame: a full ECS scan, paint-order
  // DFS, per-entity gfx.clear()+re-tessellate, and a GPU pass — even for a fully
  // static 2D HUD/board, 60–120×/s. Two-tier gate:
  //  1. Idle whole-frame skip: when the sim is STOPPED/paused nothing mutates 2D
  //     except editor edits, texture loads, canvas resizes, and world swaps — all of
  //     which set `_externalDirty`. So idle+clean ⇒ skip the entire frame.
  //  2. Per-entity change detection (while the sim runs we must scan). Only canvases
  //     with a changed entity are GPU-rendered (`dirtyCanvases` → pool.renderAll).
  private _externalDirty = true; // start dirty so the first frame always draws

  private readonly lastRender = new Map<number, RenderSnap>();
  private readonly lastMeshRender = new Map<number, MeshSnap>();
  private readonly lastTextRender = new Map<number, TextSnap>();
  private readonly lastMaterialRender = new Map<number, MaterialSnap>();
  private _textErrWarned = false;
  // Per-canvas scaler snapshot — detects resize / referenceWidth / scaleMode changes
  // (which move the container) so the canvas re-renders even if no entity changed.
  private readonly lastCanvasScale = new Map<number, { sx: number; sy: number; ox: number; oy: number; cx: number; cy: number }>();
  // Canvas2D entity ids whose content changed this frame → the only ones GPU-rendered.
  private readonly dirtyCanvases = new Set<number>();

  // Reusable maps to avoid per-frame allocation (per-instance so concurrent renderers
  // can't stomp each other's scratch; renderers also run sequentially via frame callbacks).
  private readonly parentOfEntity = new Map<number, number>();   // entityId → parentId
  private readonly sortOrderOfEntity = new Map<number, number>(); // entityId → EntityAttributes.sortOrder
  // Every entity id alive THIS frame (built from the same EntityAttributes query as
  // parentOfEntity, so it's effectively "every scene entity"). Feeds `orphan2D.prune` — see
  // there for why `activeIds` (canvas-routed entities only) is the WRONG set: an entity still
  // orphaned this frame is alive but never enters `activeIds`, and pruning against that set
  // would erase its in-progress warn-frame count every single frame.
  private readonly liveEntityIds = new Set<number>();
  private paintOrderOf = new Map<number, number>();              // entityId → global paint index (sortOrder DFS)
  /** entityId → alpha inherited from GroupAlpha ancestors × its own (#211). SPARSE: only
   *  entities actually faded appear, so a scene with no GroupAlpha keeps an empty map and
   *  every read falls through to 1. */
  private groupAlphaOf = new Map<number, number>();
  /** entityId → the `Mask2D` entity clipping it (#449). SPARSE, exactly like `groupAlphaOf`: a
   *  scene with no mask keeps an empty map and every lookup falls through to "no mask". */
  private maskGroupOf = new Map<number, number>();
  /** maskId → its nearest ANCESTOR mask, so mask containers nest and their clips INTERSECT. */
  private parentMaskOf = new Map<number, number>();
  /** maskId → its live container + mask object. Persists across frames; entries are built on
   *  first sight and dropped by the end-of-frame sweep when the mask entity goes away. */
  private readonly maskSlots = new Map<number, MaskSlot>();
  /** Mask display objects + generated ramp textures whose destroy is DEFERRED by one frame (#455).
   *
   *  ⚠️ Destroying a mask's Sprite / owned ramp texture in the SAME pass as the `pool.renderAll`
   *  at the end of it leaves PixiJS's `AlphaMaskPipe` holding a bind group whose resource is now
   *  null, and `renderer.render()` throws mid-pass. `renderAll` swallows that throw — but the
   *  aborted render has already CLEARED the surface, so the canvas presents a BLANK frame and then
   *  never redraws, because the per-frame dirty set was consumed by the failed attempt. Measured on
   *  a wordweave level advance, which builds the new crossword clip and disposes the old one in one
   *  frame: dispose at t+3ms, render throws at t+4ms, canvas blank until an unrelated edit.
   *  Flushed at the TOP of the next renderFrame, by which time that render has completed. */
  private readonly pendingMaskDestroy: Array<{ obj: Container; tex: Texture | null }> = [];
  /** Mask entity ids seen THIS frame — the sweep's liveness set, mirroring `activeIds`. */
  private readonly activeMaskIds = new Set<number>();
  /** `${maskId}|${sprite}` keys that already logged the unresolved-texture-ref warning, so a
   *  `texture`-mode mask with a bad `sprite` ref warns ONCE rather than on every `forceAll`
   *  rebuild. Keyed on the REF too, not just the mask id (round 2, Fix 5) — keying on id alone
   *  missed two cases: an author fixes bad GUID A then mistypes GUID B (no warning, since A
   *  already "used up" the warn-once slot), and koota recycling a deleted mask's id onto a new
   *  mask that also happens to have a bad ref (no warning, inherited from the dead entity). */
  private readonly warnedMaskIds = new Set<string>();
  private readonly canvasOfEntity = new Map<number, number>();   // entityId → canvas2D entityId (cached)
  private readonly canvasEntityIds = new Set<number>();          // all Canvas2D entity IDs this frame
  private readonly canvasCompensate = new Map<number, { x: number; y: number }>();  // canvasEntityId → shape compensation
  // Reused out-param so the path-caching walk allocates nothing per call.
  private readonly ancestorPath: number[] = [];
  // Visible Renderable2D entities skipped for want of a Canvas2D ancestor: id → consecutive
  // frames skipped. A 2D entity outside every canvas draws NOTHING and said so nowhere — the
  // one measured cost was an agent instantiating a 2D prefab at the world root (the tool's own
  // default), getting ok:true and screen:null, and having to reparent by trial and error
  // (QA-ASSET-0014). Counted rather than warned on sight because a scene/prefab load can spawn a
  // child a frame or two before its canvas host, and a warning fired in that window is a lie.
  // Warn-once bookkeeping for "visible 2D entity with no Canvas2D ancestor". Keyed by guid
  // (falling back to id) so the warning survives a hot-reload's id reassignment; see
  // `Orphan2DTracker` in canvas2DRouting.ts for what it guarantees and why it is not inline here.
  private readonly orphan2D = new Orphan2DTracker();

  // ── 2D particle emitters ──
  private particleState2D: ParticleSync2DState | null = null;
  private readonly _oneComp = { x: 1, y: 1 };
  private readonly particleCtx: ParticleSync2DCtx;

  // ── Collider debug overlay (editor-only) ──
  private readonly colliderOverlays = new Map<number, Graphics>();
  private _showColliders = false;
  // Collider-ONLY mode: sprites hide entirely and every Collider2D outline draws (in purple),
  // regardless of `_showColliders` — the 2D counterpart of the 3D SceneView's collider-only
  // toggle. Implies `_showColliders` is effectively on too (see isShowColliders()/drawColliderOverlays).
  private _collidersOnly = false;

  // ── Lifecycle ──
  private started = false;
  private unsubSwap: (() => void) | null = null;
  private unsubDirty: (() => void) | null = null;
  private unsubStructure: (() => void) | null = null;
  private unsubPlay: (() => void) | null = null;
  private unsubText: (() => void) | null = null;
  private unsubBounds: (() => void) | null = null;
  private unsub2DMat: (() => void) | null = null;

  constructor(opts: Scene2DRendererOptions = {}) {
    this.pool = opts.pool ?? defaultPool;
    this.primary = opts.primary ?? true;
    // Derive the frame-driver key/priority from `primary` so a non-primary (editor) instance can
    // NEVER silently collide with the primary's 'render2d' callback (which would overwrite it and
    // freeze one viewport). An explicit override still wins for a third viewport, if ever needed.
    this.frameKey = opts.frameKey ?? (this.primary ? 'render2d' : EDITOR_SCENE2D_FRAME_KEY);
    this.framePriority = opts.framePriority ?? (this.primary ? PRIORITY_RENDER_2D : PRIORITY_EDITOR_2D);
    this.particleDt = opts.particleDt;
    // Wiring for particleSync2D — closes over this instance's routing / slot lookup / dirty set.
    this.particleCtx = {
      canvasIdOf: (id) => this.findCanvasAncestor(id),
      slotContainer: (cid) => this.pool.getSlot(cid)?.container ?? null,
      markDirty: (cid) => { this.dirtyCanvases.add(cid); },
      compensate: (cid) => this.canvasCompensate.get(cid) ?? this._oneComp,
      groupAlphaOf: (id) => this.groupAlphaOf.get(id) ?? 1,
    };
  }

  /** Mark the 2D layer as needing a redraw next frame. Fired on editor ECS writes
   *  (addDirtyListener), play-state changes, async sprite-texture loads, canvas
   *  resizes (Canvas2DMount), and world swaps — every mutation source the per-entity
   *  scan can't see on its own (or that happens while idle). */
  markDirty() { this._externalDirty = true; }

  /** Toggle the collider debug overlay (editor). Forces a redraw so it appears/clears now. */
  setShowColliders(on: boolean) {
    if (this._showColliders === on) return;
    this._showColliders = on;
    this._externalDirty = true;
  }
  isShowColliders() { return this._showColliders; }

  /** Toggle collider-ONLY mode (editor): hides every sprite and forces every Collider2D
   *  outline on, in purple — the 2D SceneView counterpart of the 3D "Colliders" toolbar
   *  toggle (see docs/editor.md). Forces a redraw so sprites vanish/reappear now. */
  setCollidersOnly(on: boolean) {
    if (this._collidersOnly === on) return;
    this._collidersOnly = on;
    this._externalDirty = true;
  }
  isCollidersOnly() { return this._collidersOnly; }

  /** Whether an entity currently has a live display-object slot (sprite/graphics/mesh/text) —
   *  i.e. it's actually drawn right now, not just Renderable2D.isVisible on the ECS side. Lets
   *  an E2E assert collider-only mode really hides sprites (see devTestBridge.has2DSprite). */
  hasSprite(entityId: number): boolean { return this.slots.has(entityId); }

  /** The guid-or-id key this entity warns under. A callback at both call sites so the trait read
   *  never happens on the healthy path — see `Orphan2DTracker`. */
  private orphan2DKey(entityId: number): string {
    const attrs = attrMeta ? readTraitData(entityId, attrMeta) : null;
    return ((attrs?.guid as string) || '') || orphan2DFallbackKey(entityId);
  }

  /** Count a frame in which `entityId` was visible, active, and drawn by nothing because no
   *  Canvas2D ancestor exists — and say so ONCE, after the grace window, at warn level. */
  private noteOrphan2D(entityId: number): void {
    const key = this.orphan2D.note(entityId, () => this.orphan2DKey(entityId), ORPHAN_2D_WARN_FRAMES);
    if (!key) return;
    const attrs = attrMeta ? readTraitData(entityId, attrMeta) : null;
    const name = (attrs?.name as string) || `entity ${entityId}`;
    console.warn(
      `[Scene2D] "${name}" (${key}) is a visible 2D entity with no Canvas2D ancestor, so it is `
      + 'never drawn. Parent it under the scene\'s Canvas2D host entity — a 2D entity at the '
      + 'world root renders nowhere.',
    );
  }

  private findCanvasAncestor(entityId: number): number | null {
    // Per-frame cache fast-path (set by the path-caching below for siblings that
    // share intermediate ancestors). 0 is the sentinel for "no canvas ancestor".
    const cached = this.canvasOfEntity.get(entityId);
    if (cached !== undefined) return cached || null;

    // Single, cycle-guarded walk shared with the editor SceneView overlay.
    // `ancestorPath` collects the walked entities so we cache the whole path → resolved
    // canvas (or 0) in one pass.
    this.ancestorPath.length = 0;
    const result = resolveCanvasAncestor(entityId, this.parentOfEntity, this.canvasEntityIds, this.ancestorPath);
    for (const id of this.ancestorPath) this.canvasOfEntity.set(id, result ?? 0);
    return result;
  }

  /** The container a display object belongs in: its mask group's, or the canvas's when unmasked.
   *
   *  Every pass routes its `addChild` through here so the five of them cannot drift — the sprite,
   *  material, skinned-mesh and text passes each used to name `canvasSlot.container` directly, and
   *  a mask that only some of them honoured would clip a rig but not its label. */
  private containerFor(canvasSlot: Canvas2DSlot, entityId: number): Container {
    const maskId = this.maskGroupOf.get(entityId);
    if (maskId === undefined) return canvasSlot.container;
    const ms = this.maskSlots.get(maskId);
    // No slot yet (or the mask lost its canvas) ⇒ fall back to the canvas container rather than
    // dropping the object. An unmasked frame is a cosmetic miss; a missing parent is invisible
    // content, and the mask slot is normally built earlier in this same frame.
    return ms ? ms.container : canvasSlot.container;
  }

  /** Build/refresh one container + mask object per enabled `Mask2D` (#449).
   *
   *  ⚠️ Ordering is load-bearing twice over. It runs AFTER canvas slots are allocated (a mask
   *  needs the container it hangs under) and BEFORE the renderable passes (they look their mask
   *  container up through `containerFor`). Within itself it walks masks OUTERMOST-FIRST, so a
   *  nested mask's parent container already exists when it is parented — the nesting is what
   *  makes overlapping masks intersect instead of the innermost simply winning. */
  private syncMaskSlots(maskDataOf: ReadonlyMap<number, MaskData>, forceAll: boolean) {
    if (maskDataOf.size === 0) return;

    // Depth = how many masks enclose this one. `parentMaskOf` is a strict-ancestor chain and
    // `computeMaskGroups` guarantees it is acyclic, but the bound is kept anyway: this runs every
    // frame on scene data an author can edit, and a hang here takes the whole render loop with it.
    const depthOf = (id: number): number => {
      let d = 0;
      for (let p = this.parentMaskOf.get(id); p !== undefined && d <= maskDataOf.size; p = this.parentMaskOf.get(p)) d++;
      return d;
    };
    const ordered = [...maskDataOf.keys()].sort((a, b) => depthOf(a) - depthOf(b));

    for (const maskId of ordered) {
      const d = maskDataOf.get(maskId)!;
      const canvasId = this.findCanvasAncestor(maskId);
      // A mask outside every Canvas2D clips nothing, because the things it would clip are
      // themselves unrenderable. Drop any slot it had rather than leaving an orphan container.
      if (canvasId == null) { this.disposeMaskSlot(maskId); continue; }
      const canvasSlot = this.pool.getSlot(canvasId);
      if (!canvasSlot) { this.disposeMaskSlot(maskId); continue; }

      this.activeMaskIds.add(maskId);
      const comp = this.canvasCompensate.get(canvasId) ?? this._oneComp;
      // `texture` mode also depends on state that isn't a MaskData field: the sprite's slice
      // epoch (bumped by a re-import/re-slice — same source ordinary sprite slots key on, see
      // `builtEpoch !== spriteEpoch` below) and whether the GUID currently resolves at all (a bad
      // ref that later resolves, or vice versa). Neither is folded into `stillPlaceholder` —
      // that only covers an in-flight ASYNC load of an already-resolved sprite — so without this
      // a re-slice or a fixed/broken ref would never trigger a rebuild (round 2, Fix 2).
      const texSig = d.mode === 'texture' ? `${getSpriteEpoch(d.sprite)}|${resolveSprite(d.sprite) ? 1 : 0}` : '';
      const sig = `${d.mode}|${d.width}|${d.height}|${d.pivotX}|${d.pivotY}|${d.cornerRadius}|${d.feather}|${d.sprite}|${texSig}`;

      let slot = this.maskSlots.get(maskId);
      if (!slot) {
        const container = new Container();
        container.sortableChildren = true;
        slot = { container, maskObj: new Graphics(), kind: 'stencil', sig: '', canvasId, textureUrl: '', ownedTexture: null, baseScaleX: 1, baseScaleY: 1 };
        this.maskSlots.set(maskId, slot);
      }

      // Rebuild the mask object only when its SHAPE changed — the alpha path rasterises a ramp
      // (~50k iterations) and does a fresh GPU upload, which is far too expensive to redo on every
      // `forceAll` frame (an editor trait write or gizmo drag on ANY entity, not just this mask).
      // `forceAll` alone earns a rebuild in exactly ONE case: a `texture`-mode mask's sprite is
      // still showing the unsized/placeholder texture (`Texture.EMPTY`, or a 0/1px bitmap) an
      // async load hasn't landed for yet — `makeSprite` calls `markDirty()` on that load, which
      // raises `_externalDirty` → `forceAll` on the very next frame, so this still gets rebuilt
      // once the real bitmap (and its size, for `setMaskBaseScale`) is available.
      const stillPlaceholder = slot.kind === 'alpha' && (() => {
        const tex = (slot.maskObj as Sprite).texture;
        return !tex || tex === Texture.EMPTY || tex.width <= 1 || tex.height <= 1;
      })();
      if (slot.sig !== sig || (forceAll && stillPlaceholder)) {
        this.rebuildMaskObject(slot, d, maskId);
        slot.sig = sig;
        this.dirtyCanvases.add(canvasId);
      }

      // Re-home the container if its canvas or its enclosing mask changed.
      const parentMaskId = this.parentMaskOf.get(maskId);
      const parentSlot = parentMaskId !== undefined ? this.maskSlots.get(parentMaskId) : undefined;
      const wantParent = parentSlot ? parentSlot.container : canvasSlot.container;
      if (slot.container.parent !== wantParent) {
        slot.container.removeFromParent();
        wantParent.addChild(slot.container);
        this.dirtyCanvases.add(canvasId);
        if (slot.canvasId !== canvasId) this.dirtyCanvases.add(slot.canvasId); // the canvas it left redraws too
        slot.canvasId = canvasId;
      }

      // The group's z-band: the mask entity's own paint index places the WHOLE group among its
      // siblings (see MaskSlot's doc — entities outside cannot interleave with those inside).
      const paint = this.paintOrderOf.get(maskId) ?? 0;
      if (slot.container.zIndex !== paint) { slot.container.zIndex = paint; this.dirtyCanvases.add(canvasId); }

      // Place the mask object itself. It lives INSIDE the container it masks (the ordinary Pixi
      // arrangement — Pixi marks a mask non-renderable), and the container is identity, so the
      // mask is positioned in the same fully-composed WORLD design space as the children.
      //
      // `offsetX`/`offsetY` (Mask2D's escape from the "moving the entity moves everything it
      // clips" trap) are authored in the mask entity's own LOCAL space, so they need the SAME
      // rotate+scale that carries a local vector into world space before adding it to the
      // entity's world position — a bare `d.x + d.offsetX` would be right only for an unrotated,
      // unit-scale mask.
      const { ox, oy } = maskOffsetWorld(d.offsetX, d.offsetY, d.rz, d.sx, d.sy, comp.x, comp.y);
      const wantX = d.x + ox, wantY = d.y + oy;
      const obj = slot.maskObj;
      const px = obj.position.x, py = obj.position.y;
      if (px !== wantX || py !== wantY || obj.rotation !== d.rz) this.dirtyCanvases.add(canvasId);
      obj.position.set(wantX, wantY);
      obj.rotation = d.rz;
      obj.scale.set(slot.baseScaleX * d.sx * comp.x, slot.baseScaleY * d.sy * comp.y);
    }
  }

  /** Build the cheap hard-edged path: a `Graphics` rounded-rect, resolved to a `StencilMask`. Its
   *  own method because two callers reach it — the ordinary `feather: 0` rect mask, and a
   *  `texture`-mode mask whose sprite ref hasn't resolved and whose feather is 0 too (see the
   *  fallback below), which has no business paying for an alpha ramp it can't even source from. */
  private buildStencilMask(slot: MaskSlot, d: MaskData) {
    const g = new Graphics();
    const { ox, oy } = computePivotOffset(d.width, d.height, d.pivotX, d.pivotY);
    const r = Math.max(0, Math.min(d.cornerRadius, Math.min(d.width, d.height)));
    g.roundRect(ox, oy, d.width * 2, d.height * 2, r);
    g.fill(0xffffff);
    slot.container.addChild(g);
    slot.maskObj = g; slot.kind = 'stencil';
    slot.baseScaleX = 1; slot.baseScaleY = 1; // geometry is already in design units
    slot.container.mask = g;
  }

  /** (Re)build a mask slot's mask object for the shape `d` describes, releasing whatever the slot
   *  held before. Which Pixi pipe this lands in is decided ENTIRELY by the object's class:
   *  `Sprite` ⇒ AlphaMask (soft, a filter pass), anything else ⇒ StencilMask (hard, cheap).
   *  `maskId` is only for `warnedMaskIds` — throttling the unresolved-ref warning below to once per
   *  mask entity PER REF, rather than once per rebuild. */
  private rebuildMaskObject(slot: MaskSlot, d: MaskData, maskId: number) {
    slot.maskObj.removeFromParent();
    // DEFERRED, not destroyed here — see `pendingMaskDestroy`. Destroying the outgoing mask object
    // and its ramp texture in this pass makes the render at the end of it throw (#455).
    this.pendingMaskDestroy.push({ obj: slot.maskObj, tex: slot.ownedTexture });
    slot.ownedTexture = null;
    if (slot.textureUrl) { releaseSpriteTexture(slot.textureUrl); slot.textureUrl = ''; }

    const wantsAlpha = d.mode === 'texture' || d.feather > 0;
    if (!wantsAlpha) { this.buildStencilMask(slot, d); return; }

    if (d.mode === 'texture') {
      const resolved = resolveSprite(d.sprite);
      if (resolved) {
        const sp = this.makeSprite(resolved, slot.container); // retains the texture + handles async load
        sp.anchor.set(d.pivotX, d.pivotY);
        // The authored half-extents drive the size regardless of the source bitmap's dimensions:
        // a mask is a SHAPE, and letting the image's pixel size decide its extent would make the
        // clip silently depend on which PNG got dropped in. Recorded as a BASE scale rather than
        // written to `.width`, which the per-frame world-scale write would overwrite.
        setMaskBaseScale(slot, sp, d);
        slot.maskObj = sp; slot.kind = 'alpha'; slot.textureUrl = resolved.url;
        slot.container.mask = sp;
        return;
      }
      // Unresolvable GUID ⇒ fall through rather than leaving the subtree unmasked — a mask that
      // vanishes on a bad ref shows content that was meant to be clipped, which reads as a
      // rendering bug somewhere else entirely. Warn once per mask entity PER REF, not once per
      // rebuild — this ref stays unresolved across every `forceAll` frame until an author fixes
      // it, and keying on the ref too means a later mistyped ref still warns.
      const warnKey = `${maskId}|${d.sprite}`;
      if (!this.warnedMaskIds.has(warnKey)) {
        console.warn(`[Scene2D] Mask2D texture ref did not resolve: ${d.sprite}`);
        this.warnedMaskIds.add(warnKey);
      }
      // A hard edge doesn't need an alpha ramp it has no source image for — fall through to the
      // cheap Graphics stencil instead. The trait's own default is `sprite: ''`, so switching
      // `mode` to 'texture' in the Inspector before picking a sprite hits this every time.
      if (d.feather <= 0) { this.buildStencilMask(slot, d); return; }
    }

    // The feathered ramp is rasterised analytically (`buildMaskRamp`, a rounded-box SDF) rather
    // than by blurring a rect: no dependency on Canvas2D `filter`, deterministic, and unit-tested
    // as a pure function. It goes through a canvas because Pixi's Texture source wants an image
    // element, not a bare ImageData; `createImageData` + `set` also avoids the ImageData
    // constructor's array-type overloads.
    const ramp = buildMaskRamp(d.width, d.height, d.cornerRadius, d.feather);
    const cv = document.createElement('canvas');
    cv.width = ramp.width; cv.height = ramp.height;
    const ctx = cv.getContext('2d');
    if (!ctx) {
      // No 2D context (a headless or context-starved host) — there is no bitmap to rasterise the
      // feather into. `Texture.WHITE` used to stand in here, but it's 1×1 and `setMaskBaseScale`'s
      // `tw > 1` guard leaves `baseScale` at 1 for a 1px texture — so it clipped the WHOLE subtree
      // to nothing, the opposite of "shows too much rather than too little". Fall back to the
      // hard-edged Graphics stencil instead: it needs no texture at all, so the mask still clips
      // to the right RECT — it just loses the feather. Losing softness is a far better failure
      // than losing the content.
      console.warn('[Scene2D] Mask2D feather ramp: no 2D context; falling back to an unfeathered mask');
      this.buildStencilMask(slot, d);
      return;
    }
    const img = ctx.createImageData(ramp.width, ramp.height);
    img.data.set(ramp.data);
    ctx.putImageData(img, 0, 0);
    const tex = Texture.from(cv);
    const sp = new Sprite(tex);
    sp.anchor.set(d.pivotX, d.pivotY);
    setMaskBaseScale(slot, sp, d);
    slot.container.addChild(sp);
    // This texture was generated right above (the no-context case returned early into the
    // stencil fallback instead), so unlike a loaded sprite texture it's owned outright here.
    slot.maskObj = sp; slot.kind = 'alpha'; slot.ownedTexture = tex;
    slot.container.mask = sp;
  }

  /** Destroy the mask objects/textures queued by the previous frame (#455). Called at the TOP of
   *  renderFrame and from the renderer's own teardown — never mid-pass, which is the whole point. */
  private flushPendingMaskDestroy() {
    if (this.pendingMaskDestroy.length === 0) return;
    for (const p of this.pendingMaskDestroy) {
      if (!p.obj.destroyed) p.obj.destroy();
      if (p.tex) p.tex.destroy(true);
    }
    this.pendingMaskDestroy.length = 0;
  }

  /** Tear one mask group down: unmask, detach, destroy the container WITHOUT its children, and
   *  release whatever texture the mask object held.
   *
   *  ⚠️ `{ children: false }` is the load-bearing half. The container's children are live display
   *  objects owned by entity slots that may well still exist — destroying them here would take
   *  out sprites whose entities are perfectly alive, and they would come back only on a full
   *  rebuild. They are re-homed to the canvas container by `containerFor` on the next frame. */
  private disposeMaskSlot(maskId: number) {
    const slot = this.maskSlots.get(maskId);
    if (!slot) return;
    slot.container.mask = null;
    for (const child of [...slot.container.children]) {
      if (child !== slot.maskObj) child.removeFromParent();
    }
    // DEFERRED, not destroyed here — see `pendingMaskDestroy` (#455).
    slot.maskObj.removeFromParent();
    this.pendingMaskDestroy.push({ obj: slot.maskObj, tex: slot.ownedTexture });
    slot.ownedTexture = null;
    if (slot.textureUrl) releaseSpriteTexture(slot.textureUrl);
    slot.container.removeFromParent();
    slot.container.destroy({ children: false });
    this.maskSlots.delete(maskId);
    this.dirtyCanvases.add(slot.canvasId);
  }

  private makeSprite(resolved: ResolvedSprite, container: Container): Sprite {
    const sp = new Sprite(Texture.EMPTY);
    sp.anchor.set(0.5);
    container.addChild(sp);
    const url = resolved.url;
    retainSpriteTexture(url);
    // ⚠️ Presence in the cache is NOT the same as being usable, and this used to test only
    // `has(url)`. An entry whose source was destroyed by an in-flight `Assets.unload` is still
    // PRESENT — binding it yields a sprite that draws nothing, forever, because this branch
    // never kicks a load. `resolveMaterialTextureRef` already validates `source` for the same
    // reason; the sprite path did not, which is the whole of Court's invisible pen marks.
    // Evict the dead entry first, or `Assets.load` would hand back the same corpse.
    const cachedBase = Assets.cache.has(url) ? (Assets.get(url) as Texture | undefined) : undefined;
    if (cachedBase?.source) {
      sp.texture = frameTexture(cachedBase, resolved);
    } else {
      if (cachedBase) Assets.cache.remove(url);
      loadPixiTexture(url).then((base: Texture) => {
        // F12 — the `sp.destroyed` check is the LOAD-BEARING guard against a stale async
        // load clobbering the wrong texture. A sprite is NEVER reused across URL changes:
        // a ref change disposes the slot (sp.destroy()) + makes a FRESH Sprite, so an
        // in-flight load for the OLD url always resolves onto an already-destroyed object
        // and is dropped here; disposeSlot already released its refcount.
        // ⚠️ Exception, one frame wide: a `texture`-mode MASK sprite's destroy is now DEFERRED
        // (`pendingMaskDestroy`, #455), so a load landing in that window resolves onto a
        // live-but-doomed detached sprite and this guard does NOT catch it. Consequence is
        // benign — a spurious `markDirty` redraw on an object about to be destroyed anyway,
        // never a wrong texture landing on screen.
        if (sp.destroyed) return;
        sp.texture = frameTexture(base, resolved);
        // The texture's size feeds the sprite's scale — force a redraw so the gate
        // recomputes it (and wakes an idle frame if the sim is stopped).
        this.markDirty();
      }).catch((e: unknown) => {
        console.warn(`[Scene2D] Sprite texture load failed: ${url}`, e);
      });
    }
    return sp;
  }

  /** A Sprite for a VIDEO ref: an empty shell, deliberately.
   *
   *  No `Assets.load`, no URL retain, no frame/atlas handling — `videoTextureSync2D`
   *  fills the texture in from the element `videoService` already owns. Routing a video
   *  through `makeSprite` would have Pixi's video loader mint a SECOND
   *  `HTMLVideoElement` for the same clip: two decoders, two audio paths, and playback
   *  the engine's `timeScale` cannot reach. `textureUrl` stays `''`, so `disposeSlot`
   *  has nothing to release — which is right, since nothing was ever retained. */
  private makeVideoSprite(container: Container): Sprite {
    const sp = new Sprite(Texture.EMPTY);
    sp.anchor.set(0.5);
    container.addChild(sp);
    return sp;
  }

  /** Resolve the texture a 2D-material entity should sample as `uTexture` from its
   *  Renderable2D.sprite. Returns the entity's own sprite bitmap once resident; while
   *  it loads (or when the entity has no image sprite) returns Texture.WHITE with an
   *  empty url, and kicks a deduped async load that wakes a redraw (markDirty) when it
   *  lands — the material pass then rebuilds the Mesh with the real texture (matSig
   *  carries the sprite ref + url, so the landed texture forces exactly one rebuild). An
   *  atlas slice (`resolved.frame`) becomes a framed WRAPPER (`hasFrame`) whose
   *  textureMatrix maps the quad's 0..1 UVs into the sub-rect, so the shader samples the
   *  right pixels; a whole image borrows the base texture. */
  private resolveMaterialTextureRef(spriteRef: string, wholeOnly = false): { base: Texture; resolved: ResolvedSprite | null; url: string; hasFrame: boolean } {
    if (!isImagePath(spriteRef)) return { base: Texture.WHITE, resolved: null, url: '', hasFrame: false };
    const resolved = resolveSprite(spriteRef);
    if (!resolved) return { base: Texture.WHITE, resolved: null, url: '', hasFrame: false }; // guid not in manifest yet
    const url = resolved.url;
    if (Assets.cache.has(url)) {
      // A cached texture can still be mid-decode (or stale after a prior unload) with a
      // NULL `source` — binding it would crash makePixiShaderInstance (`source.style`).
      // Only hand it over once its source is live; otherwise fall through to WHITE and
      // wake a retry (matSig's url='' means the real texture forces a rebuild when ready).
      const base = Assets.get(url) as Texture | undefined;
      if (base && base.source) {
        // Atlas slice → per-slot framed wrapper (base source borrowed, sub-rect frame);
        // whole image → the base texture directly. `wholeOnly` (extra samplers) always
        // borrows the base, so there's no per-slot wrapper to track/destroy for them.
        const framed = !wholeOnly && resolved.frame != null;
        return { base, resolved, url, hasFrame: framed };
      }
      // ⚠️ Sourceless-but-cached is TERMINAL unless the entry is evicted. `markDirty` alone only
      // re-runs this same branch, which re-reads the same dead entry — a livelock that renders
      // WHITE forever. Drop it so the load path below can genuinely refetch. (Mid-decode entries
      // are not reachable here: Pixi publishes to the cache on resolve, not before.)
      Assets.cache.remove(url);
      this.markDirty();
    }
    if (!this._materialTexLoading.has(url)) {
      this._materialTexLoading.add(url);
      loadPixiTexture(url)
        .then(() => { this._materialTexLoading.delete(url); this.markDirty(); })
        .catch((e: unknown) => {
          this._materialTexLoading.delete(url);
          console.warn(`[Scene2D] Material sprite texture load failed: ${url}`, e);
        });
    }
    return { base: Texture.WHITE, resolved: null, url: '', hasFrame: false };
  }

  private destroyColliderOverlay(canvasId: number) {
    const g = this.colliderOverlays.get(canvasId);
    if (g && !g.destroyed) g.destroy();
    this.colliderOverlays.delete(canvasId);
  }
  private clearAllColliderOverlays() {
    for (const g of this.colliderOverlays.values()) if (!g.destroyed) g.destroy();
    this.colliderOverlays.clear();
  }

  /** Draw (or clear) collider outlines for every Collider2D entity, into a per-canvas
   *  overlay Graphics. Called at the end of renderFrame; marks touched canvases dirty. */
  private drawColliderOverlays(world: World) {
    for (const g of this.colliderOverlays.values()) if (!g.destroyed) g.clear();
    if (!this._showColliders && !this._collidersOnly) return;

    world.query(Transform, Collider2D).updateEach(([tf, col]: [any, any], entity: any) => {
      const id = entity.id();
      if (deactivatedEntities.has(id)) return;
      const canvasId = this.findCanvasAncestor(id);
      if (canvasId === null) return;
      const cSlot = this.pool.getSlot(canvasId);
      if (!cSlot) return;

      let g = this.colliderOverlays.get(canvasId);
      if (!g || g.destroyed) { g = new Graphics(); this.colliderOverlays.set(canvasId, g); }
      if (g.parent !== cSlot.container) { g.removeFromParent(); cSlot.container.addChild(g); }
      g.zIndex = 1e9; // above every sprite (sortableChildren re-sorts on render)

      // Collider dims scale with Transform.scale, matching the sim (physics2DSystem's
      // makeColliderDesc) — bake position + rotation from the world transform into the shared
      // overlay Graphics; drawColliderOutlineGfx applies `scale` to the outline's own dims.
      const wt = getWorldTransform2D(id, tf);
      const cos = Math.cos(wt.rz), sin = Math.sin(wt.rz);
      const xf = (lx: number, ly: number) => ({ x: wt.x + lx * cos - ly * sin, y: wt.y + lx * sin + ly * cos });
      drawColliderOutlineGfx(g, col, this._collidersOnly ? COLLIDER_ONLY_STROKE : OUTLINE_STROKE, xf, wt.rz, { sx: wt.sx ?? 1, sy: wt.sy ?? 1 });
      this.dirtyCanvases.add(canvasId);
    });
  }

  renderFrame() {
    // Deferred mask teardown queued by the previous frame (#455) — must run BEFORE anything
    // renders, and never in the same pass as the destroy itself. The video queue drains here
    // too, for the same reason: both sit ABOVE the idle-frame skip below, so a clip that ends
    // right as the sim goes idle still gets its detached decoder + GPU texture freed instead
    // of stranded until the surface tears down (#476 follow-up).
    this.flushPendingMaskDestroy();
    if (__MODOKI_MODULE_VIDEO__) flushPendingVideoDestroy2D(this);
    const world = getCurrentWorld();
    if (!traitsCached) cacheTraits();
    if (!traitsCached) return;

    // Editor particle-preview delta (if a provider was supplied) — computed ONCE per frame (the
    // provider has a wall-clock side effect). A non-undefined value ⇒ actively previewing, which
    // must keep the render loop alive (below) even while the sim is stopped. A transition either way
    // forces one frame so the emitters spawn / get disposed.
    const previewDt = this.particleDt ? this.particleDt() : undefined;
    const previewing2D = this.particleDt !== undefined && previewDt !== undefined;
    const previewChanged2D = previewing2D !== this._wasPreviewing2D;
    this._wasPreviewing2D = previewing2D;

    // A slot whose renderer was rebuilt after GPU context loss owes its new (empty) frame a FULL
    // redraw (#213). Read-and-clear, and read BEFORE the idle skip below: a context can die while
    // the sim is paused — an editor viewport, or a game between levels — and skipping the frame
    // would drop the one signal that says "everything on this surface must be drawn again",
    // leaving it blank behind a perfectly healthy context.
    if (this.pool.consumeRebuildFlag()) this._externalDirty = true;
    // Same reasoning as the rebuild flag above, for the same reason it is read HERE and not below
    // the skip: a slot whose last render THREW owes a redraw, and the idle skip returns before
    // `renderAll` is reached, so while the sim is stopped/paused nothing would ever deliver it and
    // the blank frame the aborted render presented would stand (#455).
    if (this.pool.hasRedrawOwed()) this._externalDirty = true;

    // (1) Idle whole-frame skip — while the sim is stopped/paused, 2D only changes
    // via paths that set _externalDirty, so idle + clean ⇒ no ECS scan, no render.
    if (!isSimRunning() && !this._externalDirty && !previewing2D && !previewChanged2D) return;
    let forceAll = this._externalDirty; // external edit / load / resize / swap ⇒ redraw all
    this._externalDirty = false;

    this.activeIds.clear();
    this.activeMaskIds.clear();
    this.parentOfEntity.clear();
    this.sortOrderOfEntity.clear();
    this.canvasOfEntity.clear();
    this.canvasEntityIds.clear();
    this.canvasCompensate.clear();
    this.currentCanvasIds.clear();
    this.dirtyCanvases.clear();
    this.liveEntityIds.clear();

    // Step 1: Build parentId + sortOrder maps from all entities with EntityAttributes
    world.query(attrMeta.trait).updateEach(([attr]: any[], entity: any) => {
      this.parentOfEntity.set(entity.id(), attr.parentId || 0);
      this.sortOrderOfEntity.set(entity.id(), attr.sortOrder || 0);
      this.liveEntityIds.add(entity.id());
    });
    // ⚠️ `liveEntityIds` must also cover every entity `noteOrphan2D` can reach, not just the ones
    // with EntityAttributes: `orphan2DKey` already falls back to an `id:`-prefixed key when
    // EntityAttributes is absent or guid-less (see that method), and an entity missing
    // EntityAttributes entirely is exactly the one the query above skips. Without this, a LIVE
    // such entity would have its frame count deleted by `prune` below on every single frame — the
    // #700-adjacent gap, but for `frames` rather than `warned`. `Transform` is what every pass that
    // can call `noteOrphan2D` (Renderable2D/SkinnedSprite2D/Text2D, all queried as `Transform + X`
    // below) actually requires, so this one query is a superset covering all three without having
    // to touch each pass — and it must run HERE, before `prune`, not inside those passes: they run
    // after `prune` this same frame, so an addition made there would only ever help NEXT frame's
    // prune, one frame too late.
    // `updateEach` deliberately NOT used: it opens the trait stores and runs koota's change
    // detection over every Transform in the scene, and all we want is the id set. A QueryResult IS
    // a readonly Entity[], so plain iteration reads nothing and marks nothing.
    for (const entity of world.query(Transform)) this.liveEntityIds.add(entity.id());
    // Forget any orphan-warn bookkeeping for an id that no longer names a live entity — koota
    // recycles ids, so an entity that died while still orphaned must not leave a stale count for
    // its id's next occupant to inherit (see `Orphan2DTracker.prune`). Runs right after the live
    // set is fully built and before any pass below calls `note`/`clear` on it.
    this.orphan2D.prune(this.liveEntityIds);
    // Explicit Order-in-Layer overrides (Renderable2D) → sprites can stack independent of
    // the entity tree (e.g. a cut-out character's parts parented to scattered bones).
    const orderInLayerOfEntity = new Map<number, number>();
    world.query(Renderable2D).updateEach(([r]: any[], entity: any) => {
      if (r.orderInLayer) orderInLayerOfEntity.set(entity.id(), r.orderInLayer);
    });
    world.query(Text2D).updateEach(([t]: any[], entity: any) => {
      if (t.orderInLayer) orderInLayerOfEntity.set(entity.id(), t.orderInLayer);
    });
    // Global paint order (hierarchy DFS by sortOrder, re-ranked by orderInLayer) — drives
    // Pixi child z so 2D siblings stack by hierarchy, matching the editor SceneView.
    this.paintOrderOf = computePaintOrder(this.sortOrderOfEntity, this.parentOfEntity, orderInLayerOfEntity.size ? orderInLayerOfEntity : undefined);
    // Group alpha (#211): the ancestor product that the flat PixiJS tree cannot give us for
    // free. Same parent map as the paint order, one pass, and skipped entirely when nothing
    // in the scene carries the trait.
    const groupAlphaOfEntity = new Map<number, number>();
    world.query(GroupAlpha).updateEach(([g]: any[], entity: any) => {
      if (g.alpha !== 1) groupAlphaOfEntity.set(entity.id(), g.alpha);
    });
    this.groupAlphaOf = computeGroupAlpha(groupAlphaOfEntity, this.parentOfEntity);
    // 2D masking (#449): which Mask2D clips which entity, and how masks nest. Same sparse-walk
    // shape as the group alpha above and skipped entirely when nothing carries the trait — a
    // scene with no mask pays one `.size` check. `isEnabled: false` is dropped HERE rather than
    // at draw time, so a disabled mask contributes no group at all and its would-be children
    // route straight to the canvas container, which is what "disabled" has to mean.
    const maskIds = new Set<number>();
    const maskDataOf = new Map<number, MaskData>();
    world.query(Transform, Mask2D).updateEach(([tf, m]: any[], entity: any) => {
      if (!m.isEnabled) return;
      const mid = entity.id();
      maskIds.add(mid);
      // ⚠️ `getWorldTransform2D` returns a SHARED module singleton (see renderUtils' alias
      // hazard note) — copy the six numbers out NOW. Holding the object would leave every mask
      // in this map pointing at whichever entity happened to be read last.
      const mwt = getWorldTransform2D(mid, tf);
      maskDataOf.set(mid, {
        mode: m.mode === 'texture' ? 'texture' : 'rect',
        width: m.width, height: m.height, pivotX: m.pivotX, pivotY: m.pivotY,
        cornerRadius: m.cornerRadius, feather: m.feather, sprite: m.sprite,
        offsetX: m.offsetX, offsetY: m.offsetY,
        x: mwt.x, y: mwt.y, rz: mwt.rz, sx: mwt.sx, sy: mwt.sy,
      });
    });
    const masking = computeMaskGroups(maskIds, this.parentOfEntity);
    // ⚠️ A change in WHICH mask clips an entity has to force a full redraw, and this is the only
    // place that can notice. Every pass below early-returns on an unchanged per-entity snapshot
    // and only re-parents AFTER that guard, so an entity that entered or left a mask without
    // otherwise changing — a mask toggled off, a subtree reparented, a level rebuilt — would keep
    // its old container forever and render clipped by a mask that no longer owns it.
    //
    // Folded into `forceAll` rather than threaded as a field through the sprite/material/skinned/
    // text snapshots: four parallel `changed` tests is four chances to miss one, and this costs a
    // single full redraw on a frame where group membership moved, which is a scene-build event
    // rather than a per-frame one. Compared BEFORE step 2 so the flag reaches every consumer.
    if (!sameGrouping(this.maskGroupOf, masking.groupOf)) forceAll = true;
    this.maskGroupOf = masking.groupOf;
    this.parentMaskOf = masking.parentMaskOf;

    // Step 2: Collect Canvas2D entity IDs and set up their pool slots + scaler. A
    // canvas is dirty when its scaler output changed (resize / referenceWidth /
    // scaleMode) — that moves the container, so it must re-render even if no entity
    // moved. (sortableChildren is set once at slot creation now — F9.)
    world.query(canvas2dMeta.trait).updateEach(
      ([c2d]: any[], entity: any) => {
        const canvasEntityId = entity.id();
        this.canvasEntityIds.add(canvasEntityId);
        this.currentCanvasIds.add(canvasEntityId);

        const slot = this.pool.allocate(canvasEntityId);
        if (!slot) return;

        const refW = c2d.referenceWidth || 1080;
        const refH = c2d.referenceHeight || 1920;
        const mode = c2d.scaleMode || 'fitH';
        // The container this scale/offset positions lives in the Pixi renderer's
        // logical `screen` space, NOT necessarily the canvas's backing-pixel size —
        // those diverge once a project pins `rendering.pixi.resolution` > 0 (which
        // turns on autoDensity in canvas2DPool). Falls back to the backing size
        // pre-init (screen isn't available yet, and at that point they're equal).
        const actualW = slot.app.renderer?.screen?.width || slot.canvas.width;
        const actualH = slot.app.renderer?.screen?.height || slot.canvas.height;
        const { scaleX, scaleY, offsetX, offsetY, compensateX, compensateY } =
          computeCanvasScale(refW, refH, actualW, actualH, mode);
        slot.container.scale.set(scaleX, scaleY);
        slot.container.position.set(offsetX, offsetY);
        this.canvasCompensate.set(canvasEntityId, { x: compensateX, y: compensateY });

        const prev = this.lastCanvasScale.get(canvasEntityId);
        if (forceAll || !prev || prev.sx !== scaleX || prev.sy !== scaleY ||
            prev.ox !== offsetX || prev.oy !== offsetY || prev.cx !== compensateX || prev.cy !== compensateY) {
          this.dirtyCanvases.add(canvasEntityId);
          if (prev) { prev.sx = scaleX; prev.sy = scaleY; prev.ox = offsetX; prev.oy = offsetY; prev.cx = compensateX; prev.cy = compensateY; }
          else this.lastCanvasScale.set(canvasEntityId, { sx: scaleX, sy: scaleY, ox: offsetX, oy: offsetY, cx: compensateX, cy: compensateY });
        }
      },
    );

    // Mask groups (#449): one container + mask object per enabled Mask2D. MUST run after the
    // canvas slots above (a mask needs a container to hang under) and before every renderable
    // pass below (each routes its addChild through `containerFor`, which reads these slots).
    this.syncMaskSlots(maskDataOf, forceAll);

    // Step 3: Query all Renderable2D entities, find their Canvas2D ancestor, and —
    // when their render inputs changed since last frame — redraw.
    world.query(Transform, Renderable2D).updateEach(
      ([tf, rend]: [any, any], entity: any) => {
        if (!rend.isVisible || this._collidersOnly || deactivatedEntities.has(entity.id())) return;
        const id = entity.id();

        // Custom 2D material: once its shader program is ready, the material pass (Step
        // 3b) owns this entity — skip it here. While the program is still loading (or
        // failed) we fall through and render the default sprite/tint, so it's never blank.
        // The onReady wake makes the entity swap to the material Mesh when the async compile
        // finishes even while the sim is stopped (else the idle gate would skip it forever).
        if (rend.material && ensureSpriteMaterial(rend.material, () => this.markDirty())) return;

        // Find which Canvas2D this entity belongs to
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) { this.noteOrphan2D(id); return; } // no Canvas2D ancestor — skip
        this.orphan2D.clear(id, () => this.orphan2DKey(id));

        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        this.activeIds.add(id);

        // A video ref is a Sprite on screen but NOT an image asset — it skips the whole
        // still-image path (resolve/load/retain/atlas) and gets its texture from
        // videoTextureSync2D instead. Checked first so `imageMode` can never also be
        // true for it; both together would double-build the slot.
        const videoMode = isVideoRef(rend.sprite);
        const imageMode = !videoMode && isImagePath(rend.sprite);
        const spriteKind: DisplayKind = (imageMode || videoMode) ? 'sprite' : 'graphics';
        // Epoch of the texture backing THIS ref (per-texture, so re-slicing one sheet
        // only rebuilds sprites of that sheet — not every 2D sprite on screen).
        const spriteEpoch = getSpriteEpoch(rend.sprite);
        let displaySlot = this.slots.get(id);

        // Resolve only when something actually changed (ref or re-slice epoch) or the slot
        // is new — NOT every frame for static sprites (keeps the idle/static fast path).
        const needResolve = imageMode && (!displaySlot || displaySlot.spriteRef !== rend.sprite || displaySlot.builtEpoch !== spriteEpoch);
        let resolved: ResolvedSprite | undefined;
        if (needResolve) {
          resolved = resolveSprite(rend.sprite);
          if (!resolved) return; // guid not yet in manifest — wait for next frame
        }

        // FRAME SWAP (sprite-sheet animation / atlas swap): the ref changed but it
        // resolves to the SAME base texture (only the sub-rect differs). Swap the framed
        // sub-texture IN PLACE instead of disposing the slot.
        const frameSwap = !!(displaySlot && resolved &&
          displaySlot.kind === 'sprite' &&
          displaySlot.spriteRef !== rend.sprite &&
          displaySlot.builtEpoch === spriteEpoch &&
          resolved.url === displaySlot.textureUrl &&
          Assets.cache.has(resolved.url));

        // Set when a material→sprite swap reuses the same texture url — bridge-retained across
        // the dispose below and released after makeSprite takes its own hold (see edge (b)).
        let bridgeUrl = '';
        if (frameSwap) {
          const sp = displaySlot!.obj as Sprite;
          const oldTex = sp.texture;
          sp.texture = frameTexture(Assets.get(resolved!.url) as Texture, resolved!);
          // Destroy the previous per-slot framed WRAPPER (never the shared source); a
          // whole-image borrow (hasFrame=false) must not be destroyed.
          if (displaySlot!.hasFrame && oldTex && oldTex !== Texture.EMPTY) oldTex.destroy(false);
          displaySlot!.spriteRef = rend.sprite;
          displaySlot!.hasFrame = resolved!.frame != null;
          // textureUrl + refcount unchanged — that's the whole point (no unload churn).
        } else if (displaySlot && (spriteKind !== displaySlot.kind || displaySlot.spriteRef !== rend.sprite ||
          (imageMode && displaySlot.builtEpoch !== spriteEpoch))) {
          // Kind changed, a genuine URL change, or a re-slice epoch bump → full rebuild.
          // RETAIN-BEFORE-RELEASE (material→sprite same-url swap): when a material is cleared at
          // runtime while its sprite stays, the outgoing material slot and the incoming sprite
          // sample the SAME url — dropping it to 0 in disposeSlot would Assets.unload + force a
          // re-download (a one-shot flicker). Bridge-retain it across the dispose; makeSprite
          // below establishes the sprite's own hold, so the bridge is released right after.
          if (imageMode && resolved && resolved.url && resolved.url === displaySlot.textureUrl) {
            bridgeUrl = resolved.url;
            retainSpriteTexture(bridgeUrl);
          }
          disposeSlot(displaySlot);
          this.slots.delete(id);
          displaySlot = undefined;
        }

        if (!displaySlot) {
          if (videoMode) {
            displaySlot = {
              kind: 'sprite', obj: this.makeVideoSprite(canvasSlot.container),
              spriteRef: rend.sprite, textureUrl: '', hasFrame: false, builtEpoch: spriteEpoch, meshVersion: -1,
            };
          } else if (imageMode) {
            if (!resolved) { if (bridgeUrl) releaseSpriteTexture(bridgeUrl); return; } // guid not yet in manifest — wait for next frame
            displaySlot = {
              kind: 'sprite', obj: this.makeSprite(resolved, canvasSlot.container),
              spriteRef: rend.sprite, textureUrl: resolved.url, hasFrame: resolved.frame != null, builtEpoch: spriteEpoch, meshVersion: -1,
            };
          } else {
            displaySlot = { kind: 'graphics', obj: makeGraphics(canvasSlot.container), spriteRef: rend.sprite, textureUrl: '', hasFrame: false, builtEpoch: spriteEpoch, meshVersion: -1 };
          }
          this.slots.set(id, displaySlot);
        }
        // Release the material→sprite bridge hold now that makeSprite has taken its own (the
        // shared url never touched 0 across the swap). No-op for the non-bridge paths.
        if (bridgeUrl) releaseSpriteTexture(bridgeUrl);

        // Compute this frame's render inputs.
        const px = rend.pivotX, py = rend.pivotY;
        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };
        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        // Effective alpha = the entity's own opacity × its GroupAlpha ancestry (#211). The
        // PRODUCT is what goes in the snapshot below, not `rend.opacity` — otherwise a parent
        // group fading while the child's own opacity holds still reads as "unchanged" and the
        // fade never paints.
        const alpha = rend.opacity * (this.groupAlphaOf.get(id) ?? 1);
        let texW = 0, texH = 0;
        if (displaySlot.kind === 'sprite') {
          const sp = displaySlot.obj as Sprite;
          texW = sp.texture.width || 1;
          texH = sp.texture.height || 1;
        }

        // Collider-fill mode: draws the entity's own Collider2D shape (a body for
        // polygon/mesh/concave colliders that have no primitive form).
        const colliderMode = rend.sprite === COLLIDER_SPRITE && entity.has(Collider2D);
        const colliderSig = colliderMode ? colliderOutlineSig(entity.get(Collider2D) as never) : '';
        const blend = pixiBlendMode2D(rend.blendMode);

        // Change detection: bail if nothing that affects this entity's output moved.
        const snap = this.lastRender.get(id);
        const changed = forceAll || !snap ||
          snap.canvasId !== canvasId || snap.kind !== displaySlot.kind || snap.spriteRef !== rend.sprite ||
          snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz || snap.sx !== wt.sx || snap.sy !== wt.sy ||
          snap.color !== rend.color || snap.opacity !== alpha || snap.w !== rend.width || snap.h !== rend.height ||
          snap.px !== px || snap.py !== py || snap.keepAspect !== rend.keepAspect ||
          snap.flipX !== rend.flipX || snap.flipY !== rend.flipY ||
          snap.texW !== texW || snap.texH !== texH || snap.compX !== comp.x || snap.compY !== comp.y ||
          snap.paint !== paint || snap.colliderSig !== colliderSig || snap.blend !== blend;
        if (!changed) return; // display object already correct from last frame

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId); // left a canvas → it redraws too

        // Ensure display object is in the right container — its mask group's when one clips it.
        const wantParent = this.containerFor(canvasSlot, id);
        if (displaySlot.obj.parent !== wantParent) {
          displaySlot.obj.removeFromParent();
          wantParent.addChild(displaySlot.obj);
        }
        // Stack by hierarchy paint order (sortableChildren re-sorts on render).
        displaySlot.obj.zIndex = paint;
        // Alpha (color's A channel) — applies to both sprites and primitives.
        displaySlot.obj.alpha = alpha;
        // Blend/compositing mode — set on the view (Sprite or Graphics both support it).
        (displaySlot.obj as Sprite | Graphics).blendMode = blend;

        let baseScaleX = 1;
        let baseScaleY = 1;

        if (displaySlot.kind === 'graphics') {
          const gfx = displaySlot.obj as Graphics;
          gfx.clear();
          // Pivot offset + shape vertices come from the shared render2DUtils helpers so
          // the runtime (Pixi) and editor Canvas2D preview derive geometry from one
          // source and can't silently drift (F7).
          if (colliderMode) {
            drawColliderFillGfx(gfx, entity.get(Collider2D) as never, rend.color);
          } else {
            const { ox, oy } = computePivotOffset(rend.width, rend.height, px, py);
            drawPrimitiveShapeGfx(gfx, resolvePrimitiveShape(rend.sprite), rend.width, rend.height, ox, oy, rend.color);
          }
        } else {
          const sp = displaySlot.obj as Sprite;
          sp.anchor.set(px, py);
          sp.tint = rend.color;
          ({ scaleX: baseScaleX, scaleY: baseScaleY } = computeSpriteScale(rend.width, rend.height, texW, texH, rend.keepAspect));
        }

        displaySlot.obj.position.set(wt.x, wt.y);
        displaySlot.obj.rotation = wt.rz;
        // flipX/flipY mirror about the pivot (anchor for sprites; origin for primitives) —
        // a render-only sign flip on scale, independent of the transform.
        const fx = rend.flipX ? -1 : 1, fy = rend.flipY ? -1 : 1;
        displaySlot.obj.scale.set(wt.sx * baseScaleX * comp.x * fx, wt.sy * baseScaleY * comp.y * fy);

        // Update the snapshot (mutate in place; allocate only on first sight).
        if (snap) {
          snap.canvasId = canvasId; snap.kind = displaySlot.kind; snap.spriteRef = rend.sprite;
          snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
          snap.color = rend.color; snap.opacity = alpha; snap.w = rend.width; snap.h = rend.height; snap.px = px; snap.py = py;
          snap.keepAspect = rend.keepAspect; snap.flipX = rend.flipX; snap.flipY = rend.flipY; snap.texW = texW; snap.texH = texH;
          snap.compX = comp.x; snap.compY = comp.y; snap.paint = paint; snap.colliderSig = colliderSig; snap.blend = blend;
        } else {
          this.lastRender.set(id, {
            canvasId, kind: displaySlot.kind, spriteRef: rend.sprite,
            x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            color: rend.color, opacity: alpha, w: rend.width, h: rend.height, px, py, keepAspect: rend.keepAspect,
            flipX: rend.flipX, flipY: rend.flipY,
            texW, texH, compX: comp.x, compY: comp.y, paint, colliderSig, blend,
          });
        }
      },
    );

    // Step 3b: custom 2D-material pass. Entities whose Renderable2D.material resolved to a
    // compiled program (Step 3 skipped them) render as a Mesh: a pivot quad + a per-entity
    // pixiShaderBuilder Shader sampling the entity's OWN sprite bitmap as `uTexture` (or
    // Texture.WHITE when it has no image sprite). A MaterialInstance drives the shader's
    // uniforms. The Shader is registered in entityShaders for the driver; a per-frame purge
    // drops entries for entities that left.
    const materialIds = this._materialIdsScratch;
    materialIds.clear();
    world.query(Transform, Renderable2D).updateEach(
      ([tf, rend]: [any, any], entity: any) => {
        if (!rend.isVisible || this._collidersOnly || deactivatedEntities.has(entity.id())) return;
        if (!rend.material) return;
        const program = ensureSpriteMaterial(rend.material, () => this.markDirty()) as PixiShaderProgram | undefined;
        if (!program) return; // still loading / failed → Step 3 drew the default; nothing here

        const id = entity.id();
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) return;
        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        this.activeIds.add(id);
        materialIds.add(id);

        const px = rend.pivotX, py = rend.pivotY;
        // Sample the entity's own sprite as uTexture (Texture.WHITE + url='' while it
        // loads or when it has no image sprite). The resolved url is part of matSig so
        // the Mesh re-mints with the real texture the frame it becomes resident.
        // Resolve WITHOUT minting a wrapper (#697) — `matSig` only needs the url and the frame
        // identity, and the framed `Texture` is allocated below, once per build/frame-swap.
        const matRef = this.resolveMaterialTextureRef(rend.sprite);
        const texUrl = matRef.url, matHasFrame = matRef.hasFrame;
        // Never hand a source-less texture to the shader — makePixiShaderInstance reads
        // `texture.source.style` and would throw, killing the whole 2D frame callback.
        // resolveMaterialTextureRef already falls back to Texture.WHITE (a live source), so
        // this only trips if even WHITE isn't ready yet; skip + retry next frame.
        if (!matRef.base.source) { this.markDirty(); return; }
        // Resolve the shader's extra `texture` params (additional samplers). The value is the
        // param's manifest default GUID, OR a per-instance `kind:'texture'` MaterialInstance
        // override on that target (a static ref — MaterialInstance sources drive only scalar
        // uniforms). Resolved WHOLE-image through the same shared refcount + KTX2/WebP variant
        // seam as the sprite. An unresolved one binds WHITE (live source) and matSig's empty url
        // forces exactly one rebuild when it lands. matTexUrls holds the non-empty urls this slot
        // must retain/release; the override ref is part of matSig (via extraSig's url) so an
        // inspector edit that swaps the texture rebuilds the Mesh with the new one.
        const texOverrides = readTextureOverrides(entity);
        const extraRefs: [string, { base: Texture; resolved: ResolvedSprite | null; hasFrame: boolean }][] = [];
        const matTexUrls: string[] = [];
        let extraSig = '';
        for (const [key, param] of program.textureParams ?? []) {
          const ref = texOverrides?.get(key) ?? (coerceParamValue(param, undefined) as string);
          // `wholeOnly` → `hasFrame` is always false for these, so minting one below never
          // allocates; they are resolved per frame only to keep `extraSig` current.
          const eref = this.resolveMaterialTextureRef(ref, true);
          extraRefs.push([key, eref]);
          if (eref.url) matTexUrls.push(eref.url);
          extraSig += `|${key}=${eref.url}`;
        }
        // matSig deliberately does NOT carry the sprite REF (#698). It used to: two atlas slices
        // of one sheet share a url but need different frames, so a frame swap had to force a
        // rebuild. That made a SpriteAnimator-driven material rebuild its Mesh, Shader AND
        // Geometry at clip fps for what is only a sub-rect change. The ref now lives in
        // `matSpriteRef`, so "sig equal, ref moved" is exactly the frame-swap case and is handled
        // in place below; everything genuinely structural still rebuilds through this sig.
        // texUrl still flips '' → url when an async load lands. extraSig moves when an extra
        // sampler's texture becomes resident, forcing a rebuild that binds the real one.
        const matSig = `${rend.width}|${rend.height}|${px}|${py}|${texUrl}${extraSig}`;
        // The sampled sprite's re-slice epoch — re-slicing the sheet must invalidate the slot even
        // when the url is unchanged, which the ref-in-sig form could not express.
        const matSpriteEpoch = getSpriteEpoch(rend.sprite);
        let slot = this.slots.get(id);
        // Rebuild the slot when the kind changed (was a sprite/graphics while loading),
        // the bound material GUID changed, the quad size/pivot changed, or the sampled
        // sprite texture changed (ref swap or async-load landing — both move texUrl in
        // matSig). A rebuild is rare (materials animate via uniforms, not geometry) so
        // recreating the Mesh — rather than mutating it in place — keeps this simple.
        //
        // RETAIN-BEFORE-RELEASE: pre-retain the texture we're about to sample BEFORE
        // disposing the old slot, so a rebuild whose old+new slot share one url never drops
        // its refcount to 0. Two real cases share a url across the dispose: (a) the flagship
        // sprite→material handoff — the sprite pass already holds this texture (its sprite
        // loaded before the shader compiled), and (b) a same-url size/pivot edit. Hitting 0
        // would fire Assets.unload (Pixi removes it from the cache synchronously and destroys
        // the GPU source on a microtask), leaving the just-rebuilt Mesh sampling a dead source
        // → a blank/WHITE flicker + a needless re-download. The pre-retain becomes the new
        // slot's hold (the build below skips its own retain).
        // All urls the NEW slot will hold (sprite + every extra sampler) — retained together
        // so retain-before-release covers the shared-url cases for the sprite AND the samplers.
        const newUrls = texUrl ? [texUrl, ...matTexUrls] : matTexUrls;
        let preRetained = false;
        if (slot && (slot.kind !== 'material' || slot.matGuid !== rend.material || slot.matSig !== matSig
          || slot.builtEpoch !== matSpriteEpoch)) {
          for (const u of newUrls) retainSpriteTexture(u);
          preRetained = true;
          disposeSlot(slot); this.slots.delete(id); this.entityShaders.delete(id);
          this.lastRender.delete(id);
          slot = undefined;
        }
        let built = false;
        // FRAME SWAP (#698) — the material analogue of the sprite path's fast path above. The slot
        // survived the gate, so the material, size, pivot, resolved url, samplers and re-slice
        // epoch are all identical and only the atlas sub-rect moved. `makePixiShaderInstance`
        // binds `uTexture: texture.SOURCE` (and `uSampler: source.style`), which are the SAME
        // object across slices of one sheet — the only thing a sub-rect change actually moves is
        // `uTextureMatrix`. So the whole swap is one wrapper + one uniform write, in place: no
        // Mesh, no Shader, no Geometry, and no texture refcount churn (the url is unchanged, so
        // retain/release would cancel out anyway). Same in-place-uniform shape as
        // `updateMtsdfPixiMetrics`, which is how #690 decoupled the text shader.
        if (slot && slot.matSpriteRef !== rend.sprite) {
          // ⚠️ `uTextureMatrix` is not an optimisation here — it is the ONLY thing that makes the
          // swap visible. Both Pixi mesh adaptors (`GlMeshAdaptor` / `GpuMeshAdapter`) refresh the
          // uTexture/uSampler/uTextureMatrix bindings ONLY inside `if (!shader)`, and a material
          // slot always sets one, so `mesh.texture = newTex` alone changes nothing on screen.
          // Hence: if the uniform group is not reachable, DO NOT take the fast path — fall through
          // to a full rebuild, which re-mints the shader with the right `mapCoord`. Swapping the
          // texture and skipping the uniform would animate the ECS while rendering frame 0
          // forever, with nothing failing — the "mechanism that cannot fire" shape this whole
          // batch of fixes is about, reintroduced by the fix for it.
          const tu = (slot.matShader?.resources as any)?.textureUniforms?.uniforms as Record<string, unknown> | undefined;
          if (tu) {
            const swapMesh = slot.obj as Mesh;
            const oldTex = swapMesh.texture;
            const newTex = mintMaterialTexture(matRef);
            swapMesh.texture = newTex;
            tu.uTextureMatrix = newTex.textureMatrix?.mapCoord ?? new Matrix();
            // Destroy the previous per-slot framed WRAPPER only. A whole-image borrow
            // (hasFrame=false) is the SHARED base texture and must never be destroyed, and
            // `destroy(false)` leaves the source alone in either case.
            if (slot.hasFrame && oldTex && oldTex !== Texture.EMPTY && oldTex !== newTex) oldTex.destroy(false);
            slot.matSpriteRef = rend.sprite;
            slot.hasFrame = matRef.hasFrame;
            built = true;   // the quad samples different pixels now — it must redraw
          } else {
            for (const u of newUrls) retainSpriteTexture(u);
            preRetained = true;
            disposeSlot(slot); this.slots.delete(id); this.entityShaders.delete(id);
            this.lastRender.delete(id);
            slot = undefined;
          }
        }
        if (!slot) {
          const tex = mintMaterialTexture(matRef);
          const extraTextures: Record<string, Texture> = {};
          for (const [key, eref] of extraRefs) extraTextures[key] = mintMaterialTexture(eref);
          const shader = makePixiShaderInstance(program, tex, undefined, extraTextures);
          const mesh = new Mesh({ geometry: buildMaterialQuad(rend.width, rend.height, px, py), texture: tex, shader });
          this.containerFor(canvasSlot, id).addChild(mesh);
          if (!preRetained) for (const u of newUrls) retainSpriteTexture(u);
          slot = { kind: 'material', obj: mesh, spriteRef: rend.material, textureUrl: texUrl, hasFrame: matHasFrame, builtEpoch: matSpriteEpoch, meshVersion: -1, matShader: shader, matGuid: rend.material, matSig, materialTexUrls: matTexUrls, matSpriteRef: rend.sprite };
          this.slots.set(id, slot);
          this.entityShaders.set(id, shader);
          built = true; // fresh/rebuilt Mesh → must draw at least once
        }

        // Ensure parented to the right canvas (an entity can move between canvases).
        const mesh = slot.obj as Mesh;
        { const wp = this.containerFor(canvasSlot, id); if (mesh.parent !== wp) { mesh.removeFromParent(); wp.addChild(mesh); } }

        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };
        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        const fx = rend.flipX ? -1 : 1, fy = rend.flipY ? -1 : 1;
        const blend = pixiBlendMode2D(rend.blendMode);
        const alpha = rend.opacity * (this.groupAlphaOf.get(id) ?? 1); // #211 — see the sprite path

        // Apply the placement/appearance every frame (cheap property writes, always correct).
        mesh.zIndex = paint;
        mesh.alpha = alpha;
        mesh.tint = rend.color; // flows into the shader's vColor (localUniformBit)
        mesh.blendMode = blend;
        mesh.position.set(wt.x, wt.y);
        mesh.rotation = wt.rz;
        mesh.scale.set(wt.sx * comp.x * fx, wt.sy * comp.y * fy);

        // Gate the EXPENSIVE GPU redraw (MaterialSnap): a material's uniforms are the only
        // thing that changes on a typical frame, and the driver writes them with no
        // render-visible signal — so instead of dirtying every running frame, dirty only when
        // (a) the Mesh was just (re)built, (b) an external edit/load/swap forced it (forceAll),
        // (c) the placement/appearance moved vs last frame, or (d) the driver wrote a NEW
        // uniform value this frame (isEntity2DMaterialDirty — set at ECS priority, before this
        // pass). A static-uniform material (no driver, or a driver holding a constant / a
        // stopped clock) now costs zero redraws once settled.
        const snap = this.lastMaterialRender.get(id);
        const changed = forceAll || built || isEntity2DMaterialDirty(id) || !snap ||
          snap.canvasId !== canvasId || snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz ||
          snap.sx !== wt.sx || snap.sy !== wt.sy || snap.color !== rend.color || snap.opacity !== rend.opacity ||
          snap.blend !== blend || snap.paint !== paint || snap.flipX !== rend.flipX || snap.flipY !== rend.flipY ||
          snap.compX !== comp.x || snap.compY !== comp.y;
        if (changed) {
          this.dirtyCanvases.add(canvasId);
          if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId); // left a canvas → redraw it too
          if (snap) {
            snap.canvasId = canvasId; snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
            snap.color = rend.color; snap.opacity = alpha; snap.blend = blend; snap.paint = paint;
            snap.flipX = rend.flipX; snap.flipY = rend.flipY; snap.compX = comp.x; snap.compY = comp.y;
          } else {
            this.lastMaterialRender.set(id, {
              canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
              color: rend.color, opacity: alpha, blend, paint,
              flipX: rend.flipX, flipY: rend.flipY, compX: comp.x, compY: comp.y,
            });
          }
        }
      },
    );
    // Purge entityShaders + MaterialSnap entries for entities that stopped rendering as a
    // material this frame (removed, hidden, deactivated, or switched away) — the slot itself is
    // disposed by the sweep below; this drops the driver's stale reference and the stale snap.
    for (const eid of this.entityShaders.keys()) if (!materialIds.has(eid)) this.entityShaders.delete(eid);
    for (const eid of this.lastMaterialRender.keys()) if (!materialIds.has(eid)) {
      // MUST dirty the entity's canvas BEFORE dropping its snap: the disposal sweep (below)
      // removes the Mesh but looks up canvasId only in lastRender/lastMeshRender/lastTextRender —
      // a pure material entity has NO entry there, so without this its canvas would never
      // re-render and its last-drawn pixels would freeze (a co-resident static-uniform material
      // no longer force-dirties every frame to mask it — the whole point of the redraw gate).
      const s = this.lastMaterialRender.get(eid);
      if (s) this.dirtyCanvases.add(s.canvasId);
      this.lastMaterialRender.delete(eid);
    }

    // Step 4: SkinnedSprite2D (deformable mesh) pass. Reads the CPU-skinned vertex buffers
    // skin2DSystem wrote into skin2DBuffers and uploads them to PixiJS Meshes — ONE Mesh per
    // rig part, held in a per-entity Container. Positions re-upload only when the deform
    // version advanced (idle rig ⇒ no GPU churn).
    world.query(Transform, SkinnedSprite2D).updateEach(
      ([tf, ss]: [any, any], entity: any) => {
        if (!ss.isVisible || this._collidersOnly || deactivatedEntities.has(entity.id())) return;
        // A Billboard3D (camera-facing) or FlatSprite3D (ground-plane) companion promotes
        // this rig OUT of the flat 2D canvas and into the Three.js scene. Skip it here —
        // returning before `activeIds.add` lets the end-of-pass sweep dispose any stale 2D slot.
        if (entity.has(Billboard3D) || entity.has(FlatSprite3D)) return;
        const id = entity.id();
        // Canvas routing is checked BEFORE rig readiness: "parented outside every canvas" is the
        // more fundamental failure of the two, and a rig that never finishes loading would
        // otherwise swallow the report of it entirely (measured — the warning never fired).
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) { this.noteOrphan2D(id); return; }
        this.orphan2D.clear(id, () => this.orphan2DKey(id));
        const buf = getSkin2DBuffer(id);
        if (!buf || !buf.parts.length) return; // rig not ready yet — skin2DSystem retries next frame

        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        // Every part texture must be resident before building; kick off loads for any missing.
        let allLoaded = true;
        for (const part of buf.parts) {
          if (!part.url) { allLoaded = false; continue; }
          // ⚠️ `isPixiTextureLive`, NOT `Assets.cache.has` — a present-but-SOURCELESS entry must
          // count as "not loaded" or this loop skips the shim and binds the corpse into a `new Mesh`
          // below. `12fea928` named this exact site and judged it covered by the shim's eviction;
          // it was not, because `has()` short-circuits before the shim is ever called. See
          // `isPixiTextureLive`'s banner.
          if (!isPixiTextureLive(part.url)) {
            allLoaded = false;
            loadPixiTexture(part.url).then(() => this.markDirty()).catch((e: unknown) => {
              console.warn(`[Scene2D] Skinned mesh texture load failed: ${part.url}`, e);
            });
          }
        }
        if (!allLoaded) return;

        this.activeIds.add(id);

        // Rebuild signature: part count + each part's url / atlas-frame / topology.
        const sig = buf.parts.map((p) => {
          const fk = p.uvRect ? `${p.uvRect.u0},${p.uvRect.v0},${p.uvRect.uw},${p.uvRect.vh}` : '';
          return `${p.url}#${fk}#${p.positions.length}#${p.indices.length}`;
        }).join('|');

        let slot = this.slots.get(id);
        if (slot && (slot.kind !== 'mesh' || slot.spriteRef !== ss.rig || (slot.meshFrameKey ?? '') !== sig)) {
          disposeSlot(slot); this.slots.delete(id); slot = undefined;
        }
        if (!slot) {
          const container = new Container();
          container.sortableChildren = true; // parts stack by their own zIndex (draw order)
          const meshes: Mesh[] = [];
          const partUrls: string[] = [];
          for (const part of buf.parts) {
            // UVs are 0..1 within the part's sprite; remap into the sheet sub-rect for a slice.
            const geometry = new MeshGeometry({
              positions: part.positions.slice(), uvs: frameSkin2DUVs(part.uvs, part.uvRect), indices: part.indices.slice(),
            });
            const mesh = new Mesh({ geometry, texture: Assets.get(part.url) as Texture });
            mesh.zIndex = part.order;
            container.addChild(mesh);
            retainSpriteTexture(part.url);
            meshes.push(mesh);
            partUrls.push(part.url);
          }
          this.containerFor(canvasSlot, id).addChild(container);
          slot = { kind: 'mesh', obj: container, meshes, partUrls, spriteRef: ss.rig, textureUrl: '', hasFrame: false, builtEpoch: 0, meshVersion: -1, meshFrameKey: sig };
          this.slots.set(id, slot);
        }

        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };
        const deform = buf.version;
        const alpha = ss.opacity * (this.groupAlphaOf.get(id) ?? 1); // #211 — see the sprite path

        // Change detection: skip when neither the placement nor the deform moved.
        const snap = this.lastMeshRender.get(id);
        const changed = forceAll || !snap ||
          snap.canvasId !== canvasId ||
          snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz || snap.sx !== wt.sx || snap.sy !== wt.sy ||
          snap.color !== ss.color || snap.opacity !== alpha ||
          snap.flipX !== ss.flipX || snap.flipY !== ss.flipY || snap.paint !== paint ||
          snap.deform !== deform || snap.compX !== comp.x || snap.compY !== comp.y;
        if (!changed) return;

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId);

        const container = slot.obj as Container;
        const meshes = slot.meshes ?? [];
        { const wp = this.containerFor(canvasSlot, id); if (container.parent !== wp) { container.removeFromParent(); wp.addChild(container); } }

        // Re-upload each part's deformed positions only when the skin version advanced.
        if (slot.meshVersion !== deform) {
          for (let pi = 0; pi < meshes.length; pi++) {
            const part = buf.parts[pi];
            if (!part) continue;
            meshes[pi].geometry.positions.set(part.positions);
            meshes[pi].geometry.getBuffer('aPosition').update();
          }
          slot.meshVersion = deform;
        }

        // Per-entity tint applies to every part; alpha via the container. A hidden part
        // (editor visibility toggle) simply doesn't draw.
        for (let pi = 0; pi < meshes.length; pi++) { meshes[pi].tint = ss.color; meshes[pi].visible = buf.parts[pi]?.visible !== false; }
        container.zIndex = paint;
        container.alpha = alpha;
        container.position.set(wt.x, wt.y);
        container.rotation = wt.rz;
        // flipX/flipY mirror about the rig origin — a render-only sign flip on scale.
        const fx = ss.flipX ? -1 : 1, fy = ss.flipY ? -1 : 1;
        container.scale.set(wt.sx * comp.x * fx, wt.sy * comp.y * fy);

        if (snap) {
          snap.canvasId = canvasId; snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
          snap.color = ss.color; snap.opacity = alpha; snap.flipX = ss.flipX; snap.flipY = ss.flipY;
          snap.paint = paint; snap.deform = deform; snap.compX = comp.x; snap.compY = comp.y;
        } else {
          this.lastMeshRender.set(id, {
            canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            color: ss.color, opacity: alpha, flipX: ss.flipX, flipY: ss.flipY,
            paint, deform, compX: comp.x, compY: comp.y,
          });
        }
      },
    );

    // Step 5: Text2D (SDF text) pass. One Pixi Mesh with the mtsdf shader per entity;
    // geometry rebuilds only when the layout changes (text/font/size/wrap/spacing), the
    // shader uniforms update only when the style changes, placement writes only when the
    // transform moves. The atlas texture loads async (font-owned lifetime, freed on
    // scene teardown). Anchor is applied via the mesh pivot; paint order via zIndex.
    const fontSceneId = getCurrentSceneId();
    world.query(Transform, Text2D).updateEach(
      ([tf, t]: [any, any], entity: any) => {
       try {
        if (!t.isVisible || this._collidersOnly || deactivatedEntities.has(entity.id())) return;
        const id = entity.id();
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) { this.noteOrphan2D(id); return; }
        this.orphan2D.clear(id, () => this.orphan2DKey(id));
        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        if (t.font && fontSceneId !== undefined) ensureFontLoaded(fontSceneId, t.font);
        const provider = t.font ? getLoadedFont(t.font) : undefined;
        if (!provider) return;
        // Page-0 texture readiness gates the entity (baked atlas still loading, or a
        // dynamic provider before its first page). Per-page textures fetched below.
        // ⚠️ `.destroyed` as well as null — a destroyed Pixi Texture is truthy (#481), and this
        // gate is the one that decides the entity is renderable AT ALL. Letting a corpse through
        // here admits the entity to `activeIds` and stamps `meshFrameKey`, while the per-page
        // guard below then skips every page: the string renders as nothing. For a BAKED provider
        // that is permanent, not transient — `atlasVersion` is `readonly = 0`, so the
        // "rebuilds on atlasVersion/textDirty bump" consolation below cannot fire for it.
        const gate = getFontTexturePixi(provider, 0, () => this.markDirty());
        if (!gate || gate.destroyed) return;

        this.activeIds.add(id);

        const layoutHash = [t.font, t.text, t.fontSize, t.align, t.maxWidth, t.lineSpacing,
          t.letterSpacing, provider.atlasVersion, getTextDirtyVersion(t.font)].join('|');
        const styleHash = [t.color, t.opacity, t.weight, t.outlineColor, t.outlineWidth, t.outlineOpacity,
          t.glowColor, t.glowSize, t.glowStrength, t.shadowColor, t.shadowOpacity,
          t.shadowOffsetX, t.shadowOffsetY, t.shadowSoftness].join('|');

        let slot = this.slots.get(id);
        if (slot && (slot.kind !== 'text' || slot.spriteRef !== t.font)) {
          disposeSlot(slot); this.slots.delete(id); this.lastTextRender.delete(id); slot = undefined;
        }

        // SPREAD, never an enumerated field list. A snapshot is wanted (it is stashed on the
        // shader to re-derive the shadow offset on a style change), but naming the fields
        // means a new one is silently dropped: `type` was added so the shader could tell an
        // mtsdf atlas from a 3-channel msdf one, this literal kept omitting it, and the
        // fallback stayed off — the msdf glow rendered as a solid rectangle exactly as
        // before the fix, with the unit tests green because they assert on the shader
        // SOURCE, not on the uniform that reaches it.
        const atlas = { ...provider.atlas };

        // (Re)build geometry only when the layout changed (or the slot is new). One Mesh
        // per atlas PAGE the text touches (dynamic CJK spills across pages); baked text
        // is a single page. All page meshes are children of the slot Container, so the
        // anchor/pivot/transform below apply to the whole block at once.
        if (!slot || slot.meshFrameKey !== layoutHash) {
          if (!slot) {
            const container = new Container();
            this.containerFor(canvasSlot, id).addChild(container);
            // `meshFrameKey` starts at the SENTINEL '', not `layoutHash` — pre-existing, not
            // introduced by #716. The sentinel can never equal a real hash (the join always has
            // literal `|` separators against real field values), so a slot that never reaches
            // the real stamp below (the catch just below explains when) keeps being seen as
            // stale and gets retried, rather than silently reading as already-built.
            slot = { kind: 'text', obj: container, spriteRef: t.font, textureUrl: '', hasFrame: false, builtEpoch: 0, meshVersion: -1, meshFrameKey: '', pageMeshes: [], textShaders: [], textW: 0, textH: 0 };
            this.slots.set(id, slot);
          }
          const container = slot.obj as Container;
          try {
            provider.ensureGlyphs(textCodepoints(t.text));
            const layout = layoutText(provider, t.text, {
              fontSize: t.fontSize, maxWidth: t.maxWidth, align: t.align as 'left' | 'center' | 'right',
              lineSpacing: t.lineSpacing, letterSpacing: t.letterSpacing,
            });
            const style = textStyle2D(t);
            // Reclaim the existing shaders BEFORE tearing anything down, indexed by PAGE
            // NUMBER (not array index — a page can be skipped below when its texture isn't
            // ready yet, so `pageNums` and the array index can disagree). A Shader depends
            // only on the page texture + atlas geometry (#690); fontSize/style reach it
            // purely through uniforms, so a plain text/fontSize edit can keep the same
            // Shader instead of paying for a new one (and its UniformGroup — see #699).
            // This does NOT save a GL/GPU program compile: the programs are already shared
            // module-level via `getMtsdfPrograms` ("Program cache (fixes #590)").
            const reusable = new Map<number, Shader>();
            if (slot.pageNums && slot.textShaders) {
              for (let i = 0; i < slot.pageNums.length; i++) {
                const s = slot.textShaders[i];
                if (s) reusable.set(slot.pageNums[i], s);
              }
            }
            // Rebuild all page geometry (a layout/atlas change is infrequent). Bare
            // `destroy()` — Mesh.destroy() sets `_shader = null` and does not destroy the
            // shader, which is why a reclaimed shader survives its mesh being destroyed.
            for (const m of slot.pageMeshes ?? []) { const g = m.geometry; m.destroy(); releaseGeometry(g); }
            slot.pageMeshes = []; slot.textShaders = []; slot.pageNums = [];
            try {
              for (const { page, geo } of buildTextGeometryByPage(layout.quads)) { // Y-down, top-origin UVs (Pixi native)
                const ptex = getFontTexturePixi(provider, page, () => this.markDirty());
                // A destroyed Texture is still truthy — `!ptex` alone would miss the contract hole
                // where a just-minted texture is torn down inside the same call (#481, an
                // already-disposed provider's addDisposable running synchronously). Same posture as
                // #455's fix in videoTextureSync2D.detach: "destroyed but truthy" reads as not-ready.
                if (!ptex || ptex.destroyed) continue; // page texture not ready — rebuilds on atlasVersion/textDirty bump
                // Pixi MeshGeometry wants a Uint32Array index buffer.
                const indices = geo.indices instanceof Uint32Array ? geo.indices : new Uint32Array(geo.indices);
                const geometry = new MeshGeometry({ positions: geo.positions, uvs: geo.uvs, indices });
                // Per-glyph colour attribute (white ⇒ no tint); animated by rainbow/fade.
                // Explicit Buffer with COPY_DST so per-frame .update() actually re-uploads
                // (addAttribute's auto-buffer is static-uploaded once, like the positions one).
                geometry.addAttribute('aTextColor', {
                  buffer: new Buffer({ data: geo.colors, label: 'attribute-text-color', usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }),
                  format: 'float32x4', stride: 4 * 4, offset: 0,
                });
                let shader = reusable.get(page);
                if (shader && canReuseMtsdfPixiShader(shader, ptex, atlas)) {
                  reusable.delete(page);
                  updateMtsdfPixiMetrics(shader, atlas, t.fontSize);
                } else {
                  shader = makeMtsdfPixiShader(ptex, atlas, style, t.fontSize);
                }
                const mesh = new Mesh({ geometry, texture: ptex, shader });
                container.addChild(mesh);
                slot.pageMeshes.push(mesh); slot.textShaders.push(shader); slot.pageNums!.push(page);
              }
            } finally {
              // Destroy any shaders NOT reclaimed above (a page the text no longer touches,
              // or whose texture/atlas changed under it).
              // ⚠️ BARE `destroy()` ON PURPOSE — same hazard as the material Shader's destroy above:
              // `mtsdfPixiShader.ts` caches its GL/GPU program at MODULE level (one program shared by
              // every text entity in the process), so `destroy(true)` here would null the SHARED
              // program's `vertex`/`fragment` on a layout rebuild and kill every OTHER text mesh in
              // every canvas too.
              // ⚠️ `finally`, NOT a plain trailing loop: a throw inside the page loop (context loss, a
              // failed buffer allocation — the pass's catch below expects those) would otherwise strand
              // every reclaimed shader, unreachable AND already removed from slot.textShaders, so
              // disposeSlot cannot free them either. That is the exact leak #690 exists to remove.
              for (const s of reusable.values()) s.destroy();
            }
            slot.meshFrameKey = layoutHash;
            slot.textW = layout.width; slot.textH = layout.height;
            slot.baseQuads = layout.quads; slot.wasMotion = false; slot.wasColored = false;
            slot.textRebuildFails = 0; slot.textRebuildFailHash = undefined; // a good rebuild clears the streak
          } catch (err) {
            // `layoutText`/`buildTextGeometryByPage` above can throw (a font provider not
            // ready, a malformed atlas). Left uncaught here, that throw skips `slot.meshFrameKey
            // = layoutHash` above, so `meshFrameKey` stays at whatever it was (the sentinel, or
            // the last successful hash) — always ≠ `layoutHash`, so the NEXT frame re-enters
            // this whole block: destroys the page meshes/geometry just rebuilt, re-runs
            // `layoutText`/the page loop, and throws again. For a TRANSIENT cause (a texture
            // arriving next frame) that self-heals in a frame or two and is exactly the retry
            // wanted. For a PERMANENT one it never terminates — silent per-frame teardown/
            // rebuild churn on top of the silent blank (the outer catch below logs only once
            // per session, so nothing surfaces this). Bound it: after `TEXT_REBUILD_MAX_RETRIES`
            // consecutive failures for this hash, stamp `meshFrameKey` anyway so the retry
            // stops and the entity settles into a quiet blank — the same outcome a permanent
            // failure always had, just without the unbounded churn. A later change to the
            // actual inputs (text/fontSize/atlas/textDirty) computes a different hash and gets
            // a fresh set of attempts.
            // The streak is per-HASH. Without this reset the counter is global to the slot, so a
            // permanent failure that burned it to the cap would leave a genuinely DIFFERENT layout
            // (new text, new fontSize, a grown atlas) with a single attempt before being stamped
            // off — contradicting the paragraph above, which promises a changed input gets a fresh
            // set. Keyed on the hash, each distinct layout gets its own budget.
            if (slot.textRebuildFailHash !== layoutHash) { slot.textRebuildFails = 0; slot.textRebuildFailHash = layoutHash; }
            slot.textRebuildFails = (slot.textRebuildFails ?? 0) + 1;
            if (slot.textRebuildFails >= TEXT_REBUILD_MAX_RETRIES) slot.meshFrameKey = layoutHash;
            throw err;
          }
        }

        // Per-glyph animation: recompute page positions from the base quads each frame
        // while the sim runs (frozen when stopped, like skeletal); reuses the shaders. On
        // deactivation, restore the base pose once (the play-stop markDirty gives us that
        // frame). Runs BEFORE the transform/style change-gate below (which it bypasses).
        const anim = (entity.has(TextAnimation) ? entity.get(TextAnimation) : undefined) as TextAnimParams | undefined;
        const animActive = isTextAnimating(anim) && isSimRunning();
        const motion = animActive && !isColorEffect(anim!.effect);
        const colored = animActive && isColorEffect(anim!.effect);
        if ((motion || colored || slot.wasMotion || slot.wasColored) && slot.baseQuads && slot.pageMeshes?.length) {
          const now = getTime(world)?.smoothedElapsed ?? 0;
          // Restart at t=0 on (re)activation OR an effect switch (effect isn't in the
          // layout hash, so a mid-Play switch keeps the stale start → intros would skip).
          if (animActive && ((!slot.wasMotion && !slot.wasColored) || slot.animEffect !== anim!.effect)) slot.animStart = now;
          slot.animEffect = animActive ? anim!.effect : undefined;
          const tsec = animActive ? now - (slot.animStart ?? now) : 0;
          const quads = animActive ? applyTextAnimation(slot.baseQuads, anim!, tsec, t.fontSize) : slot.baseQuads;
          // pageMeshes can SKIP not-ready pages, so match each page's buffer to its mesh
          // by PAGE NUMBER, not array index.
          const pageMesh = (page: number) => {
            const mi = slot.pageNums ? slot.pageNums.indexOf(page) : -1;
            return mi >= 0 ? slot.pageMeshes![mi] : undefined;
          };
          if (motion || slot.wasMotion) { // positions-only (UVs/indices invariant); length-guarded
            for (const { page, positions } of buildTextPositionsByPage(quads)) {
              const m = pageMesh(page);
              if (!m || m.geometry.positions.length !== positions.length) continue;
              m.geometry.positions.set(positions);
              m.geometry.getBuffer('aPosition').update();
            }
            slot.wasMotion = motion;
          }
          if (colored || slot.wasColored) { // per-glyph colour (rainbow/fade) → aTextColor buffer
            for (const { page, colors } of buildTextColorsByPage(quads)) {
              const cbuf = pageMesh(page)?.geometry.getBuffer('aTextColor');
              if (!cbuf || cbuf.data.length !== colors.length) continue;
              cbuf.data.set(colors);
              cbuf.update();
            }
            slot.wasColored = colored;
          }
          this.dirtyCanvases.add(canvasId);
        }

        const container = slot.obj as Container;
        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };

        const groupAlpha = this.groupAlphaOf.get(id) ?? 1; // #211 — t.opacity is already in the shader
        const snap = this.lastTextRender.get(id);
        const changed = forceAll || !snap ||
          snap.canvasId !== canvasId ||
          snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz || snap.sx !== wt.sx || snap.sy !== wt.sy ||
          snap.anchorX !== t.anchorX || snap.anchorY !== t.anchorY || snap.paint !== paint ||
          snap.compX !== comp.x || snap.compY !== comp.y || snap.groupAlpha !== groupAlpha ||
          snap.layoutHash !== layoutHash || snap.styleHash !== styleHash;
        if (!changed) return;

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId);

        { const wp = this.containerFor(canvasSlot, id); if (container.parent !== wp) { container.removeFromParent(); wp.addChild(container); } }

        if (!snap || snap.styleHash !== styleHash) { const style = textStyle2D(t); for (const s of slot.textShaders ?? []) updateMtsdfPixiStyle(s, style); }

        // Anchor via pivot: (anchorX·w, anchorY·h) in local space aligns to position.
        container.pivot.set(t.anchorX * (slot.textW ?? 0), t.anchorY * (slot.textH ?? 0));
        container.position.set(wt.x, wt.y);
        container.rotation = wt.rz;
        container.scale.set(wt.sx * comp.x, wt.sy * comp.y);
        container.zIndex = paint;
        container.alpha = groupAlpha;

        if (snap) {
          snap.canvasId = canvasId; snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
          snap.anchorX = t.anchorX; snap.anchorY = t.anchorY; snap.paint = paint; snap.compX = comp.x; snap.compY = comp.y;
          snap.layoutHash = layoutHash; snap.styleHash = styleHash; snap.groupAlpha = groupAlpha;
        } else {
          this.lastTextRender.set(id, {
            canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            anchorX: t.anchorX, anchorY: t.anchorY, paint, compX: comp.x, compY: comp.y,
            layoutHash, styleHash, groupAlpha,
          });
        }
       } catch (e) {
        // One malformed Text2D (bad shader/geometry) must NOT abort the whole 2D
        // frame (that would blank every other 2D entity on the canvas). Log once,
        // skip this entity.
        if (!this._textErrWarned) { this._textErrWarned = true; console.error('[Scene2D] Text2D render failed', e); }
       }
      },
    );

    // Release pool slots for Canvas2D entities that disappeared
    for (const id of this.prevCanvasIds) {
      if (!this.currentCanvasIds.has(id)) {
        this.destroyColliderOverlay(id); // drop the canvas's overlay before its slot is released
        // The pool orphans (does NOT destroy) children on release, so dispose this canvas's emitter
        // handles + wrappers ourselves before its slot goes away.
        if (this.particleState2D) releaseCanvas2DEmitters(this.particleState2D, id);
        this.pool.release(id);
      }
    }
    this.prevCanvasIds.clear();
    for (const id of this.currentCanvasIds) this.prevCanvasIds.add(id);

    // Dispose display objects no longer active; their canvas must redraw without them.
    for (const [id, slot] of this.slots) {
      if (!this.activeIds.has(id)) {
        const snap = this.lastRender.get(id) ?? this.lastMeshRender.get(id) ?? this.lastTextRender.get(id);
        if (snap) this.dirtyCanvases.add(snap.canvasId);
        disposeSlot(slot);
        this.slots.delete(id);
        this.entityShaders.delete(id);
        this.lastRender.delete(id);
        this.lastMeshRender.delete(id);
        this.lastTextRender.delete(id);
      }
    }

    // Drop mask groups whose Mask2D entity went away, was disabled, or lost its canvas (#449).
    // Runs AFTER the entity sweep above so a mask and its children disappearing together tear
    // down in dependency order. Children that OUTLIVE their mask are not destroyed with it — see
    // `disposeMaskSlot` — and `forceAll` was already raised this frame by the grouping change, so
    // they re-home to the canvas container on this very frame rather than blinking out for one.
    if (this.maskSlots.size) {
      for (const maskId of [...this.maskSlots.keys()]) {
        if (!this.activeMaskIds.has(maskId)) this.disposeMaskSlot(maskId);
      }
    }

    // 2D particle emitters: step the sim + sync each emitter's wrapper into its Canvas2D slot,
    // marking that canvas dirty so it re-renders. Runs after the sprite/mesh passes (so canvas
    // slots + routing maps are built) and before the GPU render. Runtime → engine time. Editor →
    // the preview provider: a wall-clock dt while previewing, else DISPOSE the emitters so toggling
    // the FX button off clears them (mirrors the 3D preview), marking their canvases to redraw clean.
    if (this.particleState2D) {
      if (this.particleDt !== undefined && previewDt === undefined) {
        if (this.particleState2D.recs.size) {
          for (const rec of this.particleState2D.recs.values()) this.dirtyCanvases.add(rec.canvasId);
          disposeParticleSync2DState(this.particleState2D);
        }
      } else {
        syncParticles2D(world, this.particleCtx, this.particleState2D, previewDt);
      }
    }

    // Video sprites: adopt each playing entity's HTMLVideoElement onto its Sprite. Runs
    // after the sprite pass (it needs the slots) and before renderAll.
    //
    // A playing clip changes its pixels every frame with NO ECS write to notice, so it
    // has to hold its own canvas dirty AND keep the idle gate awake — otherwise the
    // editor's render-on-demand loop settles and the video freezes on its first frame,
    // which looks exactly like a decode failure.
    const videoIds = __MODOKI_MODULE_VIDEO__ ? syncVideoTextures2D(world, this, (eid) => {
      const s = this.slots.get(eid);
      return s?.kind === 'sprite' ? (s.obj as Sprite) : null;
    }) : EMPTY_IDS;
    if (videoIds.length) {
      for (const eid of videoIds) {
        const cid = this.canvasOfEntity.get(eid);
        if (cid != null) this.dirtyCanvases.add(cid);
      }
      this.markDirty();
    }

    // Editor collider overlay (no-op unless enabled) — draws onto canvas containers and
    // marks them dirty, so it must run before renderAll.
    this.drawColliderOverlays(world);

    // Render only the canvases whose content changed this frame (F1).
    this.pool.renderAll(this.dirtyCanvases);
  }

  /** Which on-screen surface THIS instance speaks for — `'game-2d'` for the primary
   *  runtime/GameView renderer, `'scene-view'` for the editor's own instance (#80). Single
   *  source of truth for both the `registerBoundsProvider` label and the rect stamp below —
   *  deriving both from this getter means they can't drift apart. */
  private get boundsSurface(): BoundsSurface { return this.primary ? 'game-2d' : 'scene-view'; }

  /** Screen-bounds provider (layout-bounds agent op): map each Renderable2D's live
   *  PixiJS bounds → viewport CSS px via its canvas, so an agent gets numeric 2D rects
   *  (overlap/off-screen) without a screenshot. Best-effort + guarded. Registered by every
   *  instance — primary (GameView) and non-primary (editor SceneView, #80) alike — each
   *  labelling its rects with its own `boundsSurface`. */
  private bounds2DProvider(ids?: Set<number>): EntityScreenBounds[] {
    const surface = this.boundsSurface;
    const out: EntityScreenBounds[] = [];
    for (const [id, slot] of this.slots) {
      if (ids && !ids.has(id)) continue;
      const canvasId = this.canvasOfEntity.get(id);
      const cSlot = canvasId != null ? this.pool.getSlot(canvasId) : null;
      if (!cSlot || !cSlot.canvas.isConnected) { out.push({ id, layer: '2d', surface, screen: null, onScreen: false, canvasId }); continue; }
      try {
        const b = slot.obj.getBounds(); // PixiJS Bounds in the renderer's logical (screen) space
        const rect = cSlot.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { out.push({ id, layer: '2d', surface, screen: null, onScreen: false, canvasId }); continue; }
        // Same canvas-px→client transform bounds2DProvider and screenToReference2D/
        // referenceToScreen2D share (canvas2DScaler.ts) — one source of truth for the
        // client↔canvas coordinate space, so a reported bounds rect and an aim computed
        // from the design space always agree.
        const backingW = cSlot.app.renderer?.screen?.width || cSlot.canvas.width || 1;
        const backingH = cSlot.app.renderer?.screen?.height || cSlot.canvas.height || 1;
        const p0 = canvasPxToClient(b.minX, b.minY, rect, backingW, backingH);
        const p1 = canvasPxToClient(b.maxX, b.maxY, rect, backingW, backingH);
        const x = p0.x, y = p0.y, w = p1.x - p0.x, h = p1.y - p0.y;
        const onScreen = x < rect.right && x + w > rect.left && y < rect.bottom && y + h > rect.top;
        out.push({ id, layer: '2d', surface, screen: { x, y, w, h }, onScreen, canvasId });
      } catch { out.push({ id, layer: '2d', surface, screen: null, onScreen: false, canvasId }); }
    }
    return out;
  }

  start() {
    if (this.started) return;
    this.started = true;
    liveRenderers++;
    this._externalDirty = true; // first frame after (re)start must draw

    ensurePixiKtxTranscoder(); // KTX2 sprites decode via the locally-served libktx (idempotent)

    this.particleState2D = createParticleSync2DState(); // 2D emitter sim/render handles

    registerFrameCallback(this.frameKey, () => this.renderFrame(), this.framePriority);
    this.unsubDirty = addDirtyListener(() => this.markDirty());     // editor trait writes wake the idle gate
    this.unsubStructure = onStructureDirty(() => this.markDirty()); // entity create/delete/reparent too
    this.unsubPlay = onPlayStateChange(() => this.markDirty());     // play/stop/pause transitions redraw
    // A dynamic font generating a just-typed glyph (or an async atlas load finishing) bumps the
    // text-dirty version but is NOT an ECS write — without this the idle editor gate never wakes,
    // so the new glyph stays tofu until the next unrelated edit ("re-type to see it"). getTextDirtyVersion
    // is already in the per-entity layoutHash, so the woken frame rebuilds the affected text.
    this.unsubText = onTextDirty(() => this.markDirty());
    // Expose this renderer's live entity→Shader map so materialInstanceSystem can drive
    // 2D-material uniforms (the 2D analog of the 3D materialBroker).
    this.unsub2DMat = register2DMaterialShaderMap(this.entityShaders);

    this.unsubSwap = onWorldSwap(() => {
      // Before the slots go: release() restores each Sprite's previous texture, and a
      // destroyed Sprite can't take one back.
      if (__MODOKI_MODULE_VIDEO__) disposeVideoTextures2D(this);
      for (const slot of this.slots.values()) disposeSlot(slot);
      this.slots.clear();
      // Mask groups (#449) — after the entity slots, mirroring `stop()`'s order and its own
      // comment: each releases its own texture, and `disposeMaskSlot` deliberately does NOT
      // destroy the container's children (already destroyed/detached above). Left out of this
      // block before — koota recycles entity ids across the swap, so a stale mask slot here would
      // alias the new world's recycled id onto a dead Texture.
      for (const maskId of [...this.maskSlots.keys()]) this.disposeMaskSlot(maskId);
      this.maskSlots.clear();
      this.activeMaskIds.clear();
      this.maskGroupOf.clear();
      this.parentMaskOf.clear();
      this.warnedMaskIds.clear();
      this.entityShaders.clear();
      this._materialTexLoading.clear();
      // 2D-material programs are world-lifecycle — clear UNCONDITIONALLY (not renderer-count
      // gated like the texture net): every live per-entity Shader holds its OWN program
      // reference, so wiping the shared cache can't strand the other viewport's already-drawn
      // frame, AND (#716) the compiled GlProgram/GpuProgram itself now survives this clear —
      // it's memoised at module scope in `pixiShaderBuilder`'s program cache, keyed on the
      // manifest path, and this clear never evicts it — so the clear no longer forces a
      // recompile at all. It ALSO bumps a generation that supersedes any in-flight compile —
      // what keeps a sibling safe from THAT is that the clear fires the pending waiters (#523),
      // not that it's maps-only. Gating this on liveRenderers<=1 was the bug that left an
      // EDITED .shader.json serving its stale compiled program on hot-reload whenever both
      // GameView + SceneView were live (the default editor).
      clearSpriteMaterialCache();
      this.activeIds.clear();
      this.prevCanvasIds.clear();
      // The new world recycles entity ids — stale snapshots would alias a different
      // entity onto an old one and wrongly skip its first draw. Drop them.
      this.lastRender.clear();
      this.lastMeshRender.clear();
      this.lastTextRender.clear();
      this.lastMaterialRender.clear();
      this.lastCanvasScale.clear();
      this.clearAllColliderOverlays();
      // Dispose emitter handles + clear recs (the state object stays reusable for the new scene) —
      // recycled ids must not alias stale emitters.
      if (this.particleState2D) disposeParticleSync2DState(this.particleState2D);
      // Orphan-warn bookkeeping is WORLD-lifecycle (#700). `prune()` bounds it WITHIN a world, but
      // across a swap koota recycles ids as the norm rather than the exception, so a surviving
      // `id:` key would silence the new world's occupant of that id on its very first orphaning —
      // and a surviving guid key would suppress a legitimately new warning for a re-loaded scene.
      this.orphan2D.reset();
      this.pool.releaseAll();
      // Skin/deform buffers are WORLD-lifecycle state: recycled entity ids in the new world must
      // not alias stale buffers. clearSkin2DBuffers/clearDeform2DBuffers just empty a Map, so this
      // is idempotent — every live renderer clears (harmless double-clear), which also covers the
      // editor-only case (no primary renderer live) that a `this.primary` gate would miss.
      clearSkin2DBuffers();
      clearDeform2DBuffers();
      // Texture net (F3): only force-clean when THIS is the sole live renderer. With two viewports
      // the shared spriteTextureRefs is non-empty by design; the per-slot releaseSpriteTexture path
      // (run in the disposeSlot loop above, in EVERY instance's swap handler) unloads a texture
      // correctly once BOTH viewports have released it — a blanket nuke here would destroy textures
      // the other viewport still shows (adversarial-review finding).
      if (liveRenderers <= 1) unloadAllSpriteTextures();
      this._externalDirty = true;  // redraw the incoming scene
    });

    if (this.primary) sceneManager.registerBeforeSwap(prewarmHook);
    // Registered unconditionally (#80): the editor's non-primary SceneView instance needs a
    // bounds provider too, just labelled 'scene-view' instead of 'game-2d' — prewarmHook stays
    // primary-gated above since it's a module-level hook that must not double-run.
    this.unsubBounds = registerBoundsProvider((ids) => this.bounds2DProvider(ids), this.boundsSurface);
  }

  stop() {
    if (!this.started) return;
    this.started = false;

    unregisterFrameCallback(this.frameKey);
    if (this.unsubSwap) { this.unsubSwap(); this.unsubSwap = null; }
    if (this.unsubDirty) { this.unsubDirty(); this.unsubDirty = null; }
    if (this.unsubStructure) { this.unsubStructure(); this.unsubStructure = null; }
    if (this.unsubPlay) { this.unsubPlay(); this.unsubPlay = null; }
    if (this.unsubText) { this.unsubText(); this.unsubText = null; }
    if (this.unsub2DMat) { this.unsub2DMat(); this.unsub2DMat = null; }
    if (this.unsubBounds) { this.unsubBounds(); this.unsubBounds = null; }
    if (this.primary) sceneManager.unregisterBeforeSwap(prewarmHook);

    if (__MODOKI_MODULE_VIDEO__) disposeVideoTextures2D(this);   // before disposeSlot — see the onWorldSwap note
    for (const slot of this.slots.values()) disposeSlot(slot);
    this.slots.clear();
    // Mask groups (#449) — after the entity slots, mirroring the per-frame sweep's order. Each
    // releases its own texture, and `disposeMaskSlot` deliberately does NOT destroy the
    // container's children: by this point they are already destroyed and detached above, and a
    // `{ children: true }` here would double-destroy them.
    for (const maskId of [...this.maskSlots.keys()]) this.disposeMaskSlot(maskId);
    this.maskSlots.clear();
    // No further frame will run for this renderer, so the deferred queue has to drain here or the
    // ramp textures it holds leak their GPU memory (#455).
    this.flushPendingMaskDestroy();
    this.entityShaders.clear();
    this._materialTexLoading.clear();
    // Unconditional (see onWorldSwap): safe with a sibling renderer live because the clear wakes
    // pending waiters, not because it's maps-only — this call site NEEDS that wake, since below
    // only re-dirties the instance that's going away, not the surviving sibling.
    clearSpriteMaterialCache();
    this.activeIds.clear();
    this.activeMaskIds.clear();
    this.maskGroupOf.clear();
    this.parentMaskOf.clear();
    this.warnedMaskIds.clear();
    this.prevCanvasIds.clear();
    this.parentOfEntity.clear();
    this.canvasOfEntity.clear();
    this.canvasEntityIds.clear();
    this.canvasCompensate.clear();
    this.lastRender.clear();
    this.lastMeshRender.clear();
    this.lastTextRender.clear();
    this.lastMaterialRender.clear();
    this.lastCanvasScale.clear();
    this.dirtyCanvases.clear();
    this.clearAllColliderOverlays();
    if (this.particleState2D) { disposeParticleSync2DState(this.particleState2D); this.particleState2D = null; }
    this.orphan2D.reset();   // world-lifecycle, same reason as the onWorldSwap handler (#700)
    // Drop this renderer's sim claim on every pool slot (#718) — same call, same position as the
    // `onWorldSwap` handler above, and for the same reason: it must run AFTER the `disposeSlot`
    // loop, because `releaseAll` only DETACHES children and relies on Scene2D having destroyed
    // them already (F4). Without it `stop()` left every slot `boundBySim`, so `unmount` →
    // `reclaimIfUnclaimed` bailed and the slot kept a live Application + GPU context with its
    // canvas detached — and nothing could ever come back for it, because `stop()` had just
    // unregistered the frame callback that drives `renderAll`'s shrink pass AND cleared
    // `prevCanvasIds`, so even a later `start()` diffs against an empty set. The runtime pool
    // masked this (`Game.tsx` calls `destroyPool()`, which opens with `releaseAll()`); the EDITOR
    // pool has no such caller — `editorCanvas2DPool` is a module singleton whose only teardown is
    // this method. Predicted (NOT observed on a running editor) end state: stuck slots accumulate
    // to `MAX_SLOTS` (6), after which `allocate` refuses and warns and the 2D viewport draws
    // nothing. That consequence is derived from `canvas2DPool.ts:508`, not measured.
    // Idempotent: it acts only on `boundBySim` slots and clears that flag, so the runtime's
    // existing stop-then-destroyPool sequence is unaffected.
    this.pool.releaseAll();
    // Nuke the SHARED skin buffers + texture net only when THIS was the LAST live renderer.
    // Gating on renderer count (not `this.primary`) fixes both directions: a non-primary editor
    // stop while GameView lives must not wipe shared state, AND a primary GameView stop while the
    // editor lives must not either (the adversarial-review HIGH finding). This instance's own
    // slots were already released above (per-slot releaseSpriteTexture, correct across viewports).
    liveRenderers = Math.max(0, liveRenderers - 1);
    if (liveRenderers === 0) {
      clearSkin2DBuffers();
      clearDeform2DBuffers();
      unloadAllSpriteTextures();   // don't strand texture accounting on final teardown (F3)
    }
    this._externalDirty = true;    // a subsequent restart draws fresh
  }
}

// Preload the INCOMING scene's sprite textures so there's no pop-in on swap. Global (the
// Assets cache is shared) — registered by the primary renderer only. These take NO refcount:
// they're a transient cache warmer. After the swap each scene's makeSprite() retains the
// textures it instantiates (cache hit), and the primary's onWorldSwap teardown unloads only
// the OUTGOING scene's tracked textures — so it never evicts what we just prewarmed.
async function prewarmHook(stagingWorld: World) {
  const urls = new Set<string>();
  stagingWorld.query(Renderable2D).updateEach(([rend]: [{ sprite: string; isVisible: boolean }]) => {
    if (rend.isVisible && isImagePath(rend.sprite)) {
      const url = resolveImageUrl(rend.sprite);
      if (url) urls.add(url);
    }
  });
  if (urls.size === 0) return;
  try {
    await Promise.all([...urls].map(u => loadPixiTexture(u)));
  } catch (e) {
    console.warn('[Scene2D] Sprite texture preload failed:', e);
  }
}

// ── Default (primary) renderer + free-function API ──
// Backs the runtime + GameView so nothing outside this module changes. The editor SceneView
// will construct its OWN Scene2DRenderer on its own Canvas2DPool (primary: false, editor frame
// key/priority) in a later phase.
export const defaultRenderer = new Scene2DRenderer({ pool: defaultPool, primary: true });

/** Mark the (default) 2D layer as needing a redraw next frame. */
export function markScene2DDirty() { defaultRenderer.markDirty(); }
/** Toggle the collider debug overlay on the default renderer (editor). */
export function setShowColliders2D(on: boolean) { defaultRenderer.setShowColliders(on); }
export function isShowColliders2D() { return defaultRenderer.isShowColliders(); }
/** Drive the default renderer's frame directly (tests/runtime/Scene2D.test.ts). */
export function renderFrame() { defaultRenderer.renderFrame(); }
export function startScene2D() { defaultRenderer.start(); }
export function stopScene2D() { defaultRenderer.stop(); }

// ── React component (backward compat — renders nothing, just starts/stops the default) ──

import { useEffect } from 'react';

export default function Scene2D() {
  useEffect(() => {
    startScene2D();
    return () => stopScene2D();
  }, []);
  return null;
}
