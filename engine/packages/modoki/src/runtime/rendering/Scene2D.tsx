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
import { Graphics, Sprite, Mesh, MeshGeometry, Texture, Rectangle, Assets, Container, Buffer, BufferUsage, type Shader } from 'pixi.js';
import { deactivatedEntities } from '../../three/systems/transformPropagationSystem';
import { getCurrentWorld, onWorldSwap } from '../ecs/world';
import { getAllTraits } from '../ecs/traitRegistry';
import { Transform, Renderable2D, Collider2D, SkinnedSprite2D, Billboard3D, FlatSprite3D, Text2D, TextAnimation } from '../traits';
import { MaterialInstance } from '../traits/MaterialInstance';
import { applyTextAnimation, isTextAnimating, isColorEffect, type TextAnimParams } from './text/textAnimate';
import { getTime } from '../systems/getTime';
import { ensureFontLoaded, getLoadedFont } from './text/fontAtlasLoader';
import { getFontTexturePixi } from './text/fontTexturePixi';
import { loadPixiTexture } from './pixiTextureLoad';
import { makeMtsdfPixiShader, updateMtsdfPixiStyle } from './text/mtsdfPixiShader';
import { layoutText } from './text/layoutText';
import { buildTextGeometryByPage, buildTextPositionsByPage, buildTextColorsByPage } from './text/textMesh';
import type { TextQuad } from './text/layoutText';
import { getTextDirtyVersion, onTextDirty } from './text/textDirty';
import type { MtsdfStyle } from './text/mtsdfStyle';
import { getCurrentSceneId } from '../scene/SceneManager';
import { getSkin2DBuffer, clearSkin2DBuffers, frameSkin2DUVs } from '../systems/skin2DBuffers';
import { clearDeform2DBuffers } from '../systems/deform2DBuffers';
import { registerFrameCallback, unregisterFrameCallback, PRIORITY_RENDER_2D, PRIORITY_EDITOR_2D } from './frameDriver';
import { sceneManager } from '../scene/SceneManager';
import { isImagePath, resolveImageUrl, resolvePrimitiveShape, getWorldTransform2D, resolveSprite, type ResolvedSprite } from './renderUtils';
import { computePivotOffset, computeSpriteScale, drawPrimitiveShapeGfx, drawColliderFillGfx, drawColliderOutlineGfx, colliderOutlineSig, COLLIDER_SPRITE, pixiBlendMode2D } from './render2DUtils';
import { computeCanvasScale } from './canvas2DScaler';
import { getSpriteEpoch } from '../loaders/assetManifest';
import { ensureSpriteMaterial, clearSpriteMaterialCache } from '../loaders/spriteMaterialCache';
import { makePixiShaderInstance, type PixiShaderProgram } from './pixiShaderBuilder';
import { coerceParamValue } from '../loaders/shaderSchema';
import { register2DMaterialShaderMap, isEntity2DMaterialDirty } from './sprite2DMaterialBroker';
import { computePaintOrder } from './paintOrder';
import { findCanvasAncestor as resolveCanvasAncestor } from './canvas2DRouting';
import {
  createParticleSync2DState, syncParticles2D, releaseCanvas2DEmitters, disposeParticleSync2DState,
  type ParticleSync2DState, type ParticleSync2DCtx,
} from './particleSync2D';
import { addDirtyListener, onStructureDirty } from '../ecs/entityUtils';
import { isSimRunning, onPlayStateChange } from '../systems/playState';
import { Canvas2DPool, defaultPool } from './canvas2DPool';
import { registerBoundsProvider, type EntityScreenBounds } from './screenBounds';
import { ensurePixiKtxTranscoder } from './pixiKtxTranscoder';

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
  // Material slots (kind 'material'): obj is a Mesh (quad geometry + a per-entity
  // pixiShaderBuilder Shader) sampling the entity's OWN sprite bitmap as `uTexture`
  // (or Texture.WHITE when it has no sprite). `matGuid` is the bound 2D-material GUID;
  // `matSig` gates a rebuild (size/pivot AND the resolved sprite-texture url, so the
  // Mesh re-mints with the real texture the frame it lands). `textureUrl` holds the
  // retained sprite url (shared spriteTextureRefs — released in disposeSlot). The shader
  // is also registered in Scene2DRenderer.entityShaders for MaterialInstance driving.
  // `materialTexUrls` holds the resolved urls of the shader's extra `texture` params
  // (additional samplers) — each retained on build + released in disposeSlot, like textureUrl.
  matShader?: Shader; matGuid?: string; matSig?: string; materialTexUrls?: string[] }

// ── SHARED texture refcount (global — tracks the global Assets cache) ──
// Per-URL refcount for PixiJS Assets. When the last sprite using a URL is
// destroyed, the texture is unloaded from the global Assets cache to release VRAM.
// SHARED across all Scene2DRenderer instances: two viewports displaying the same URL
// each hold a ref, so a texture unloads only when the LAST viewport releases it (F3).
const spriteTextureRefs = new Map<string, number>();
function retainSpriteTexture(url: string) {
  spriteTextureRefs.set(url, (spriteTextureRefs.get(url) ?? 0) + 1);
}
function releaseSpriteTexture(url: string) {
  const n = (spriteTextureRefs.get(url) ?? 0) - 1;
  if (n <= 0) {
    spriteTextureRefs.delete(url);
    if (Assets.cache.has(url)) Assets.unload(url).catch(() => { /* ignore */ });
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
  for (const url of spriteTextureRefs.keys()) {
    if (Assets.cache.has(url)) Assets.unload(url).catch(() => { /* ignore */ });
  }
  spriteTextureRefs.clear();
}

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

function disposeSlot(slot: Slot) {
  slot.obj.removeFromParent();
  // Skinned mesh: a Container holding one Mesh per rig part. Release each part's shared
  // base texture (retained like a sprite) and destroy each per-part geometry (Mesh.destroy()
  // does not free it), then the container.
  if (slot.kind === 'mesh') {
    for (const m of slot.meshes ?? []) { const geo = m.geometry; m.destroy(); geo?.destroy(); }
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
    geo?.destroy();
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
    for (const m of slot.pageMeshes ?? []) { const geo = m.geometry; m.destroy(); geo?.destroy(); }
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
  private paintOrderOf = new Map<number, number>();              // entityId → global paint index (sortOrder DFS)
  private readonly canvasOfEntity = new Map<number, number>();   // entityId → canvas2D entityId (cached)
  private readonly canvasEntityIds = new Set<number>();          // all Canvas2D entity IDs this frame
  private readonly canvasCompensate = new Map<number, { x: number; y: number }>();  // canvasEntityId → shape compensation
  // Reused out-param so the path-caching walk allocates nothing per call.
  private readonly ancestorPath: number[] = [];

  // ── 2D particle emitters ──
  private particleState2D: ParticleSync2DState | null = null;
  private readonly _oneComp = { x: 1, y: 1 };
  private readonly particleCtx: ParticleSync2DCtx;

  // ── Collider debug overlay (editor-only) ──
  private readonly colliderOverlays = new Map<number, Graphics>();
  private _showColliders = false;

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

  private makeSprite(resolved: ResolvedSprite, container: Container): Sprite {
    const sp = new Sprite(Texture.EMPTY);
    sp.anchor.set(0.5);
    container.addChild(sp);
    const url = resolved.url;
    retainSpriteTexture(url);
    if (Assets.cache.has(url)) {
      sp.texture = frameTexture(Assets.get(url) as Texture, resolved);
    } else {
      loadPixiTexture(url).then((base: Texture) => {
        // F12 — the `sp.destroyed` check is the LOAD-BEARING guard against a stale async
        // load clobbering the wrong texture. A sprite is NEVER reused across URL changes:
        // a ref change disposes the slot (sp.destroy()) + makes a FRESH Sprite, so an
        // in-flight load for the OLD url always resolves onto an already-destroyed object
        // and is dropped here; disposeSlot already released its refcount.
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

  /** Resolve the texture a 2D-material entity should sample as `uTexture` from its
   *  Renderable2D.sprite. Returns the entity's own sprite bitmap once resident; while
   *  it loads (or when the entity has no image sprite) returns Texture.WHITE with an
   *  empty url, and kicks a deduped async load that wakes a redraw (markDirty) when it
   *  lands — the material pass then rebuilds the Mesh with the real texture (matSig
   *  carries the sprite ref + url, so the landed texture forces exactly one rebuild). An
   *  atlas slice (`resolved.frame`) becomes a framed WRAPPER (`hasFrame`) whose
   *  textureMatrix maps the quad's 0..1 UVs into the sub-rect, so the shader samples the
   *  right pixels; a whole image borrows the base texture. */
  private resolveMaterialTexture(spriteRef: string, wholeOnly = false): { tex: Texture; url: string; hasFrame: boolean } {
    if (!isImagePath(spriteRef)) return { tex: Texture.WHITE, url: '', hasFrame: false };
    const resolved = resolveSprite(spriteRef);
    if (!resolved) return { tex: Texture.WHITE, url: '', hasFrame: false }; // guid not in manifest yet
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
        return { tex: framed ? frameTexture(base, resolved) : base, url, hasFrame: framed };
      }
      this.markDirty();
      return { tex: Texture.WHITE, url: '', hasFrame: false };
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
    return { tex: Texture.WHITE, url: '', hasFrame: false };
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
    if (!this._showColliders) return;

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

      // Collider dims are world-unit (NOT scaled by Transform.scale — matching the sim), so bake
      // position + rotation (not scale) from the world transform into the shared overlay Graphics.
      const wt = getWorldTransform2D(id, tf);
      const cos = Math.cos(wt.rz), sin = Math.sin(wt.rz);
      const xf = (lx: number, ly: number) => ({ x: wt.x + lx * cos - ly * sin, y: wt.y + lx * sin + ly * cos });
      drawColliderOutlineGfx(g, col, OUTLINE_STROKE, xf, wt.rz);
      this.dirtyCanvases.add(canvasId);
    });
  }

  renderFrame() {
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

    // (1) Idle whole-frame skip — while the sim is stopped/paused, 2D only changes
    // via paths that set _externalDirty, so idle + clean ⇒ no ECS scan, no render.
    if (!isSimRunning() && !this._externalDirty && !previewing2D && !previewChanged2D) return;
    const forceAll = this._externalDirty; // external edit / load / resize / swap ⇒ redraw all
    this._externalDirty = false;

    this.activeIds.clear();
    this.parentOfEntity.clear();
    this.sortOrderOfEntity.clear();
    this.canvasOfEntity.clear();
    this.canvasEntityIds.clear();
    this.canvasCompensate.clear();
    this.currentCanvasIds.clear();
    this.dirtyCanvases.clear();

    // Step 1: Build parentId + sortOrder maps from all entities with EntityAttributes
    world.query(attrMeta.trait).updateEach(([attr]: any[], entity: any) => {
      this.parentOfEntity.set(entity.id(), attr.parentId || 0);
      this.sortOrderOfEntity.set(entity.id(), attr.sortOrder || 0);
    });
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
        const { scaleX, scaleY, offsetX, offsetY, compensateX, compensateY } =
          computeCanvasScale(refW, refH, slot.canvas.width, slot.canvas.height, mode);
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

    // Step 3: Query all Renderable2D entities, find their Canvas2D ancestor, and —
    // when their render inputs changed since last frame — redraw.
    world.query(Transform, Renderable2D).updateEach(
      ([tf, rend]: [any, any], entity: any) => {
        if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
        const id = entity.id();

        // Custom 2D material: once its shader program is ready, the material pass (Step
        // 3b) owns this entity — skip it here. While the program is still loading (or
        // failed) we fall through and render the default sprite/tint, so it's never blank.
        // The onReady wake makes the entity swap to the material Mesh when the async compile
        // finishes even while the sim is stopped (else the idle gate would skip it forever).
        if (rend.material && ensureSpriteMaterial(rend.material, () => this.markDirty())) return;

        // Find which Canvas2D this entity belongs to
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) return; // no Canvas2D ancestor — skip

        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        this.activeIds.add(id);

        const imageMode = isImagePath(rend.sprite);
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
        } else if (displaySlot && ((imageMode ? 'sprite' : 'graphics') !== displaySlot.kind || displaySlot.spriteRef !== rend.sprite ||
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
          if (imageMode) {
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
          snap.color !== rend.color || snap.opacity !== rend.opacity || snap.w !== rend.width || snap.h !== rend.height ||
          snap.px !== px || snap.py !== py || snap.keepAspect !== rend.keepAspect ||
          snap.flipX !== rend.flipX || snap.flipY !== rend.flipY ||
          snap.texW !== texW || snap.texH !== texH || snap.compX !== comp.x || snap.compY !== comp.y ||
          snap.paint !== paint || snap.colliderSig !== colliderSig || snap.blend !== blend;
        if (!changed) return; // display object already correct from last frame

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId); // left a canvas → it redraws too

        // Ensure display object is in the right container
        if (displaySlot.obj.parent !== canvasSlot.container) {
          displaySlot.obj.removeFromParent();
          canvasSlot.container.addChild(displaySlot.obj);
        }
        // Stack by hierarchy paint order (sortableChildren re-sorts on render).
        displaySlot.obj.zIndex = paint;
        // Alpha (color's A channel) — applies to both sprites and primitives.
        displaySlot.obj.alpha = rend.opacity;
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
          snap.color = rend.color; snap.opacity = rend.opacity; snap.w = rend.width; snap.h = rend.height; snap.px = px; snap.py = py;
          snap.keepAspect = rend.keepAspect; snap.flipX = rend.flipX; snap.flipY = rend.flipY; snap.texW = texW; snap.texH = texH;
          snap.compX = comp.x; snap.compY = comp.y; snap.paint = paint; snap.colliderSig = colliderSig; snap.blend = blend;
        } else {
          this.lastRender.set(id, {
            canvasId, kind: displaySlot.kind, spriteRef: rend.sprite,
            x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            color: rend.color, opacity: rend.opacity, w: rend.width, h: rend.height, px, py, keepAspect: rend.keepAspect,
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
        if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
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
        const { tex, url: texUrl, hasFrame: matHasFrame } = this.resolveMaterialTexture(rend.sprite);
        // Never hand a source-less texture to the shader — makePixiShaderInstance reads
        // `texture.source.style` and would throw, killing the whole 2D frame callback.
        // resolveMaterialTexture already falls back to Texture.WHITE (a live source), so
        // this only trips if even WHITE isn't ready yet; skip + retry next frame.
        if (!tex.source) { this.markDirty(); return; }
        // Resolve the shader's extra `texture` params (additional samplers). The value is the
        // param's manifest default GUID, OR a per-instance `kind:'texture'` MaterialInstance
        // override on that target (a static ref — MaterialInstance sources drive only scalar
        // uniforms). Resolved WHOLE-image through the same shared refcount + KTX2/WebP variant
        // seam as the sprite. An unresolved one binds WHITE (live source) and matSig's empty url
        // forces exactly one rebuild when it lands. matTexUrls holds the non-empty urls this slot
        // must retain/release; the override ref is part of matSig (via extraSig's url) so an
        // inspector edit that swaps the texture rebuilds the Mesh with the new one.
        const texOverrides = readTextureOverrides(entity);
        const extraTextures: Record<string, Texture> = {};
        const matTexUrls: string[] = [];
        let extraSig = '';
        for (const [key, param] of program.textureParams ?? []) {
          const ref = texOverrides?.get(key) ?? (coerceParamValue(param, undefined) as string);
          const { tex: etex, url: eurl } = this.resolveMaterialTexture(ref, true);
          extraTextures[key] = etex;
          if (eurl) matTexUrls.push(eurl);
          extraSig += `|${key}=${eurl}`;
        }
        // matSig carries the sprite REF (not just texUrl): two atlas slices of one sheet share a
        // url but need different frames, so a frame swap must force a rebuild (re-mints the wrapper
        // + its uv matrix). texUrl still flips '' → url when an async load lands. extraSig moves
        // when an extra sampler's texture becomes resident, forcing a rebuild that binds the real one.
        const matSig = `${rend.width}|${rend.height}|${px}|${py}|${rend.sprite}|${texUrl}${extraSig}`;
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
        if (slot && (slot.kind !== 'material' || slot.matGuid !== rend.material || slot.matSig !== matSig)) {
          for (const u of newUrls) retainSpriteTexture(u);
          preRetained = true;
          disposeSlot(slot); this.slots.delete(id); this.entityShaders.delete(id);
          this.lastRender.delete(id);
          slot = undefined;
        }
        let built = false;
        if (!slot) {
          const shader = makePixiShaderInstance(program, tex, undefined, extraTextures);
          const mesh = new Mesh({ geometry: buildMaterialQuad(rend.width, rend.height, px, py), texture: tex, shader });
          canvasSlot.container.addChild(mesh);
          if (!preRetained) for (const u of newUrls) retainSpriteTexture(u);
          slot = { kind: 'material', obj: mesh, spriteRef: rend.material, textureUrl: texUrl, hasFrame: matHasFrame, builtEpoch: 0, meshVersion: -1, matShader: shader, matGuid: rend.material, matSig, materialTexUrls: matTexUrls };
          this.slots.set(id, slot);
          this.entityShaders.set(id, shader);
          built = true; // fresh/rebuilt Mesh → must draw at least once
        }

        // Ensure parented to the right canvas (an entity can move between canvases).
        const mesh = slot.obj as Mesh;
        if (mesh.parent !== canvasSlot.container) { mesh.removeFromParent(); canvasSlot.container.addChild(mesh); }

        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };
        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        const fx = rend.flipX ? -1 : 1, fy = rend.flipY ? -1 : 1;
        const blend = pixiBlendMode2D(rend.blendMode);
        // Apply the placement/appearance every frame (cheap property writes, always correct).
        mesh.zIndex = paint;
        mesh.alpha = rend.opacity;
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
            snap.color = rend.color; snap.opacity = rend.opacity; snap.blend = blend; snap.paint = paint;
            snap.flipX = rend.flipX; snap.flipY = rend.flipY; snap.compX = comp.x; snap.compY = comp.y;
          } else {
            this.lastMaterialRender.set(id, {
              canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
              color: rend.color, opacity: rend.opacity, blend, paint,
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
        if (!ss.isVisible || deactivatedEntities.has(entity.id())) return;
        // A Billboard3D (camera-facing) or FlatSprite3D (ground-plane) companion promotes
        // this rig OUT of the flat 2D canvas and into the Three.js scene. Skip it here —
        // returning before `activeIds.add` lets the end-of-pass sweep dispose any stale 2D slot.
        if (entity.has(Billboard3D) || entity.has(FlatSprite3D)) return;
        const id = entity.id();
        const buf = getSkin2DBuffer(id);
        if (!buf || !buf.parts.length) return; // rig not ready yet — skin2DSystem retries next frame

        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) return;
        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        // Every part texture must be resident before building; kick off loads for any missing.
        let allLoaded = true;
        for (const part of buf.parts) {
          if (!part.url) { allLoaded = false; continue; }
          if (!Assets.cache.has(part.url)) {
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
          canvasSlot.container.addChild(container);
          slot = { kind: 'mesh', obj: container, meshes, partUrls, spriteRef: ss.rig, textureUrl: '', hasFrame: false, builtEpoch: 0, meshVersion: -1, meshFrameKey: sig };
          this.slots.set(id, slot);
        }

        const wt = getWorldTransform2D(id, tf);
        const paint = this.paintOrderOf.get(id) ?? 0;
        const comp = this.canvasCompensate.get(canvasId) || { x: 1, y: 1 };
        const deform = buf.version;

        // Change detection: skip when neither the placement nor the deform moved.
        const snap = this.lastMeshRender.get(id);
        const changed = forceAll || !snap ||
          snap.canvasId !== canvasId ||
          snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz || snap.sx !== wt.sx || snap.sy !== wt.sy ||
          snap.color !== ss.color || snap.opacity !== ss.opacity ||
          snap.flipX !== ss.flipX || snap.flipY !== ss.flipY || snap.paint !== paint ||
          snap.deform !== deform || snap.compX !== comp.x || snap.compY !== comp.y;
        if (!changed) return;

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId);

        const container = slot.obj as Container;
        const meshes = slot.meshes ?? [];
        if (container.parent !== canvasSlot.container) { container.removeFromParent(); canvasSlot.container.addChild(container); }

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
        container.alpha = ss.opacity;
        container.position.set(wt.x, wt.y);
        container.rotation = wt.rz;
        // flipX/flipY mirror about the rig origin — a render-only sign flip on scale.
        const fx = ss.flipX ? -1 : 1, fy = ss.flipY ? -1 : 1;
        container.scale.set(wt.sx * comp.x * fx, wt.sy * comp.y * fy);

        if (snap) {
          snap.canvasId = canvasId; snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
          snap.color = ss.color; snap.opacity = ss.opacity; snap.flipX = ss.flipX; snap.flipY = ss.flipY;
          snap.paint = paint; snap.deform = deform; snap.compX = comp.x; snap.compY = comp.y;
        } else {
          this.lastMeshRender.set(id, {
            canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            color: ss.color, opacity: ss.opacity, flipX: ss.flipX, flipY: ss.flipY,
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
        if (!t.isVisible || deactivatedEntities.has(entity.id())) return;
        const id = entity.id();
        const canvasId = this.findCanvasAncestor(id);
        if (canvasId === null) return;
        const canvasSlot = this.pool.getSlot(canvasId);
        if (!canvasSlot) return;

        if (t.font && fontSceneId !== undefined) ensureFontLoaded(fontSceneId, t.font);
        const provider = t.font ? getLoadedFont(t.font) : undefined;
        if (!provider) return;
        // Page-0 texture readiness gates the entity (baked atlas still loading, or a
        // dynamic provider before its first page). Per-page textures fetched below.
        if (!getFontTexturePixi(provider, 0, () => this.markDirty())) return;

        this.activeIds.add(id);

        const layoutHash = [t.font, t.text, t.fontSize, t.align, t.maxWidth, t.lineSpacing,
          t.letterSpacing, provider.atlasVersion, getTextDirtyVersion()].join('|');
        const styleHash = [t.color, t.opacity, t.weight, t.outlineColor, t.outlineWidth, t.outlineOpacity,
          t.glowColor, t.glowSize, t.glowStrength, t.shadowColor, t.shadowOpacity,
          t.shadowOffsetX, t.shadowOffsetY, t.shadowSoftness].join('|');

        let slot = this.slots.get(id);
        if (slot && (slot.kind !== 'text' || slot.spriteRef !== t.font)) {
          disposeSlot(slot); this.slots.delete(id); this.lastTextRender.delete(id); slot = undefined;
        }

        const atlas = { width: provider.atlas.width, height: provider.atlas.height, distanceRange: provider.atlas.distanceRange, size: provider.atlas.size };

        // (Re)build geometry only when the layout changed (or the slot is new). One Mesh
        // per atlas PAGE the text touches (dynamic CJK spills across pages); baked text
        // is a single page. All page meshes are children of the slot Container, so the
        // anchor/pivot/transform below apply to the whole block at once.
        if (!slot || slot.meshFrameKey !== layoutHash) {
          provider.ensureGlyphs(textCodepoints(t.text));
          const layout = layoutText(provider, t.text, {
            fontSize: t.fontSize, maxWidth: t.maxWidth, align: t.align as 'left' | 'center' | 'right',
            lineSpacing: t.lineSpacing, letterSpacing: t.letterSpacing,
          });
          const style = textStyle2D(t);
          if (!slot) {
            const container = new Container();
            canvasSlot.container.addChild(container);
            slot = { kind: 'text', obj: container, spriteRef: t.font, textureUrl: '', hasFrame: false, builtEpoch: 0, meshVersion: -1, meshFrameKey: layoutHash, pageMeshes: [], textShaders: [], textW: layout.width, textH: layout.height };
            this.slots.set(id, slot);
          }
          const container = slot.obj as Container;
          // Rebuild all page meshes (a layout/atlas change is infrequent).
          for (const m of slot.pageMeshes ?? []) { const g = m.geometry; m.destroy(); g?.destroy(); }
          for (const s of slot.textShaders ?? []) s.destroy();
          slot.pageMeshes = []; slot.textShaders = []; slot.pageNums = [];
          for (const { page, geo } of buildTextGeometryByPage(layout.quads)) { // Y-down, top-origin UVs (Pixi native)
            const ptex = getFontTexturePixi(provider, page, () => this.markDirty());
            if (!ptex) continue; // page texture not ready — rebuilds on atlasVersion/textDirty bump
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
            const shader = makeMtsdfPixiShader(ptex, atlas, style);
            const mesh = new Mesh({ geometry, texture: ptex, shader });
            container.addChild(mesh);
            slot.pageMeshes.push(mesh); slot.textShaders.push(shader); slot.pageNums!.push(page);
          }
          slot.meshFrameKey = layoutHash;
          slot.textW = layout.width; slot.textH = layout.height;
          slot.baseQuads = layout.quads; slot.wasMotion = false; slot.wasColored = false;
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

        const snap = this.lastTextRender.get(id);
        const changed = forceAll || !snap ||
          snap.canvasId !== canvasId ||
          snap.x !== wt.x || snap.y !== wt.y || snap.rz !== wt.rz || snap.sx !== wt.sx || snap.sy !== wt.sy ||
          snap.anchorX !== t.anchorX || snap.anchorY !== t.anchorY || snap.paint !== paint ||
          snap.compX !== comp.x || snap.compY !== comp.y ||
          snap.layoutHash !== layoutHash || snap.styleHash !== styleHash;
        if (!changed) return;

        this.dirtyCanvases.add(canvasId);
        if (snap && snap.canvasId !== canvasId) this.dirtyCanvases.add(snap.canvasId);

        if (container.parent !== canvasSlot.container) { container.removeFromParent(); canvasSlot.container.addChild(container); }

        if (!snap || snap.styleHash !== styleHash) { const style = textStyle2D(t); for (const s of slot.textShaders ?? []) updateMtsdfPixiStyle(s, style); }

        // Anchor via pivot: (anchorX·w, anchorY·h) in local space aligns to position.
        container.pivot.set(t.anchorX * (slot.textW ?? 0), t.anchorY * (slot.textH ?? 0));
        container.position.set(wt.x, wt.y);
        container.rotation = wt.rz;
        container.scale.set(wt.sx * comp.x, wt.sy * comp.y);
        container.zIndex = paint;

        if (snap) {
          snap.canvasId = canvasId; snap.x = wt.x; snap.y = wt.y; snap.rz = wt.rz; snap.sx = wt.sx; snap.sy = wt.sy;
          snap.anchorX = t.anchorX; snap.anchorY = t.anchorY; snap.paint = paint; snap.compX = comp.x; snap.compY = comp.y;
          snap.layoutHash = layoutHash; snap.styleHash = styleHash;
        } else {
          this.lastTextRender.set(id, {
            canvasId, x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy,
            anchorX: t.anchorX, anchorY: t.anchorY, paint, compX: comp.x, compY: comp.y,
            layoutHash, styleHash,
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

    // Editor collider overlay (no-op unless enabled) — draws onto canvas containers and
    // marks them dirty, so it must run before renderAll.
    this.drawColliderOverlays(world);

    // Render only the canvases whose content changed this frame (F1).
    this.pool.renderAll(this.dirtyCanvases);
  }

  /** Screen-bounds provider (layout-bounds agent op): map each Renderable2D's live
   *  PixiJS bounds → viewport CSS px via its canvas, so an agent gets numeric 2D rects
   *  (overlap/off-screen) without a screenshot. Best-effort + guarded. Registered only
   *  by the primary renderer (the runtime/GameView view the agent inspects). */
  private bounds2DProvider(ids?: Set<number>): EntityScreenBounds[] {
    const out: EntityScreenBounds[] = [];
    for (const [id, slot] of this.slots) {
      if (ids && !ids.has(id)) continue;
      const canvasId = this.canvasOfEntity.get(id);
      const cSlot = canvasId != null ? this.pool.getSlot(canvasId) : null;
      if (!cSlot) { out.push({ id, layer: '2d', screen: null, onScreen: false }); continue; }
      try {
        const b = slot.obj.getBounds(); // PixiJS Bounds in the renderer's logical (screen) space
        const rect = cSlot.canvas.getBoundingClientRect();
        const lw = cSlot.app.renderer?.screen?.width || cSlot.canvas.width || rect.width || 1;
        const lh = cSlot.app.renderer?.screen?.height || cSlot.canvas.height || rect.height || 1;
        const sx = rect.width / lw, sy = rect.height / lh;
        const x = rect.left + b.minX * sx, y = rect.top + b.minY * sy;
        const w = (b.maxX - b.minX) * sx, h = (b.maxY - b.minY) * sy;
        const onScreen = x < rect.right && x + w > rect.left && y < rect.bottom && y + h > rect.top;
        out.push({ id, layer: '2d', screen: { x, y, w, h }, onScreen });
      } catch { out.push({ id, layer: '2d', screen: null, onScreen: false }); }
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
      for (const slot of this.slots.values()) disposeSlot(slot);
      this.slots.clear();
      this.entityShaders.clear();
      this._materialTexLoading.clear();
      // 2D-material programs are world-lifecycle — clear UNCONDITIONALLY (not renderer-count
      // gated like the texture net): clearSpriteMaterialCache only empties Maps (never
      // destroys a GlProgram/GpuProgram), and every live per-entity Shader holds its OWN
      // program reference, so wiping the shared cache can't strand the other viewport — both
      // just recompile (a Pixi cache hit) next frame. Gating this on liveRenderers<=1 was the
      // bug that left an EDITED .shader.json serving its stale compiled program on hot-reload
      // whenever both GameView + SceneView were live (the default editor).
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

    if (this.primary) {
      sceneManager.registerBeforeSwap(prewarmHook);
      this.unsubBounds = registerBoundsProvider((ids) => this.bounds2DProvider(ids));
    }
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

    for (const slot of this.slots.values()) disposeSlot(slot);
    this.slots.clear();
    this.entityShaders.clear();
    this._materialTexLoading.clear();
    // Unconditional (see onWorldSwap): safe with a sibling renderer live — only empties Maps.
    clearSpriteMaterialCache();
    this.activeIds.clear();
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
