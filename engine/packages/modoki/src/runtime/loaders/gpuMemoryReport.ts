/** GPU-memory report — Phase 3 of #590 (docs/ios-gpu-memory.md).
 *
 *  ── WHY: THE ROOT CAUSE, AND WHERE IT ISN'T ───────────────────────────────────────────────────
 *  A live syslog capture found #590's actual cause: WebKit's separate `com.apple.WebKit.GPU` XPC
 *  process — which owns every GL context for the app — gets jetsammed at its own ~296 MB
 *  per-process highwater cap (not a device-wide OOM; ~230 MB was still free). Reading
 *  `window.__3d.renderer.info.memory` live on the SAME device found the Three/3D layer holding
 *  only ~11.5 MB — so **~284 MB of the 296 MB is NOT the 3D renderer.** It has to be the PixiJS/
 *  Canvas2D side: pool `Application`s, sprite textures, the MTSDF font atlas. This module's job is
 *  the runtime series that can show which side actually grows, and #677 (~80ms/frame of
 *  unattributed GPU time while dragging) and #678 (textured content stays blank after a GPU
 *  respawn) both point the same direction.
 *
 *  ── 3D: READ THREE'S OWN NUMBER, DO NOT RECOMPUTE IT ─────────────────────────────────────────
 *  The `three` version this engine ships already reports real BYTES on `renderer.info.memory`
 *  (`total`, `texturesSize`, `attributesSize`, `programsSize` — confirmed via the live device read
 *  above), not just object counts. Hand-rolling a second estimate from `meshTemplateCache.ts`'s
 *  registries would risk disagreeing with the renderer's own figure, which is worse than not
 *  having one — so `gpu3dBytes` is `renderer.info.memory.total`, verbatim. `rendererGeometries`/
 *  `rendererTextures` (counts) are carried alongside for a sanity cross-check, same as before.
 *
 *  ── 2D: PIXI EXPOSES NO AGGREGATE NUMBER, SO THIS COMPUTES ONE ───────────────────────────────
 *  PixiJS 8's `TextureSource` (`pixi.js`'s texture base class) has no built-in byte estimate and
 *  the renderer keeps no aggregate memory counter — so `estimatePixiTextureBytes` below does the
 *  same kind of block-size-aware estimate the 3D side used to do by hand, but against Pixi's
 *  WebGPU-style string formats (`'rgba8unorm'`, `'astc-4x4-unorm'`, `'bc3-rgba-unorm'`, …) instead
 *  of three's numeric format constants.
 *
 *  The live set is collected by walking each `canvas2DPool` SLOT's Pixi container tree
 *  (`rendering/canvas2DPool.ts`'s `getSlotsForMemoryReport()`) for any display object exposing a
 *  `.texture` — Sprites, and the MTSDF text Mesh, which sets `mesh.texture` to the SAME atlas its
 *  shader samples specifically so a generic texture walk like this one finds it (see
 *  `text/mtsdfPixiShader.ts`'s `makeMtsdfPixiShader` doc comment). This attributes bytes PER SLOT
 *  (`perSlotBytes2D`), so a leak is traceable to which entity's canvas is growing, not just a
 *  single global number — and it is a SCENE-GRAPH walk, unlike the (deliberately) registry-based
 *  3D-would-have-been-if-recomputed approach: a texture decoded into Pixi's shared `Assets` cache
 *  but not currently attached to any live slot's display tree is NOT counted here. That is a real
 *  scope boundary, not an oversight — see the module's own `getSlotsForMemoryReport()` doc comment
 *  for the GameView-only caveat too.
 *
 *  ── EMISSION: TWO CHANNELS, ONE OF WHICH MUST SURVIVE A FREEZE ────────────────────────────────
 *  1. `profilerCounters` (`setCounter`) — same enable-gated convention as every other counter in
 *     that module (`isProfilerEnabled()`), for the Profiler panel / live charting. OFF by default.
 *  2. A `console.log` line — ALWAYS on, gated by nothing (a production device build is the only
 *     place #590 happens, so this cannot be a dev-only instrument). This is what an extracted
 *     device console ring can show after the freeze — see `core/consoleRing.ts`'s header: 512
 *     entries total, only the first 128 pinned. A naive 1/sec line would evict the whole boot
 *     capture within minutes, so this logs on a >10% swing in total bytes OR any change in the
 *     live GL-context count, promptly, and otherwise at most once per `HEARTBEAT_MS` — a STABLE
 *     scene therefore costs one ring line every 30s, not one every sample.
 *
 *  Sampling itself runs on a plain `setInterval`, not a frame callback: #590's own evidence table
 *  found `setInterval` still firing after the frame loop had died (`requestAnimationFrame` did
 *  not) — hooking this to a render callback would make the instrument die at exactly the moment it
 *  is needed. `startGpuMemorySampling()`/`stopGpuMemorySampling()` are reached from
 *  `rendering/useGameLoop.ts` through a provider slot (`core/gpuMemorySamplerProvider.ts` — this
 *  module is L3/`loaders`, that one is L2/`rendering`, and L2 cannot import L3 directly; see
 *  `docs/architecture-layers.md`'s registration-inversion pattern), paired with
 *  `startFrameDriver()`/`stopFrameDriver()` so the sampler's lifetime matches the game's.
 *
 *  Sampling is deliberately cheap and infrequent (`SAMPLE_INTERVAL_MS`) — walking every slot's
 *  container every frame would be its own perf cost; 1-2s of staleness is nothing against a leak
 *  measured in minutes (#590's own capture ran 19 minutes before the freeze).
 *
 *  ── A LIVE SNAPSHOT CAN READ FLAT WHILE THE LEAK GROWS — CUMULATIVE TALLIES, NOT JUST A GAUGE ──
 *  A SECOND device measurement (30 samples over 16 minutes, ending in a confirmed ~296 MB jetsam)
 *  found `fps`, `renderer.info.memory`'s counts, and the canvas2DPool slot count ALL reading
 *  perfectly flat the entire time — `3dMB=11.5 tex=2 geom=2 canvases=2`, no drift at all, right up
 *  to the kill. That rules out "many live tracked resources" as the mechanism and points at GPU
 *  allocations the browser/OS never fully reclaims even after the engine's own JS reference is
 *  gone — an ORPHAN, invisible to any instrument that only sums what is CURRENTLY live. A snapshot
 *  gauge cannot distinguish "nothing is happening" from "things are being created and destroyed
 *  and each destroy fails to reclaim" — both read as flat.
 *
 *  So this module ALSO keeps cumulative, monotonic tallies that make CHURN visible even when the
 *  live view is not: `core/gpuContextTracking.ts`'s `totalGpuContextsCreated`/
 *  `totalGpuContextsDestroyed` (contexts), and `cumulativeTextureCreates2D`/
 *  `cumulativeTextureReleases2D` below (distinct Pixi texture-source `uid`s ever observed live,
 *  vs. ones that dropped out of the live set between samples). A created total climbing much
 *  faster than the live count holds steady is the create/destroy CYCLE happening — which
 *  `canvas2DPool`'s rebuild-on-context-loss path (`rebuildSlotApp`) is a live, reachable candidate
 *  for, given `#590` is a context-loss bug in the first place.
 *
 *  ⚠️ **Stated honestly, not worked around: this still cannot prove the orphan hypothesis, only
 *  make its SIGNATURE visible.** "JS asked to destroy N textures/contexts" (what
 *  `cumulativeTextureReleases2D`/`totalGpuContextsDestroyed` count) is not the same claim as "the
 *  GPU process actually freed the memory" — that second fact has no JS-observable channel at all
 *  in this engine today. If churn is high and the live view is flat, that is evidence pointing at
 *  an orphan, not proof of one; closing that gap needs `idevicesyslog`/Instruments on the device
 *  alongside this instrument, not a JS-side fix.
 *
 *  ── `totalBytes` IS ENGINE-TRACKED BYTES, NOT PROCESS GPU MEMORY — DO NOT READ IT AS THAT ──────
 *  `totalBytes` (`gpu3dBytes + gpu2dBytes`) is the sum of what THIS module tracks: 3D renderer
 *  resources (`renderer.info.memory.total`) plus 2D canvas textures reachable from a live
 *  `canvas2DPool` slot. `totalBytes` excludes PixiJS's own geometry/vertex buffers and text
 *  meshes — those are counted separately in `geometryBytes2D` (#832), deliberately NOT folded in
 *  here — and every WebKit-side allocation — IOSurface/compositing backing stores — which is where the
 *  overwhelming majority of the GPU PROCESS's memory actually lives. Measured on an iPhone 8 on
 *  2026-09-04: this reported **15.65 MiB** of tracked bytes at the exact moment
 *  `com.apple.WebKit.GPU` was jetsammed at **322 MB** — the engine sees roughly **5%** of what the
 *  process actually holds. That gap is why the console line below says `tracked=`, not `total=`
 *  — the old label read as "the process's GPU memory" and actively misled this investigation for
 *  a while. */

import { rawNow } from '../core/clock';
import { getActiveRenderer } from '../core/activeRenderer';
import {
  liveGpuContextCount, totalGpuContextsCreated, totalGpuContextsDestroyed,
} from '../core/gpuContextTracking';
import { setCounter } from '../core/profilerCounters';
import { gpuMemorySamplerProvider } from '../core/gpuMemorySamplerProvider';
import { getSlotsForMemoryReport } from '../rendering/canvas2DPool';

// ── 2D (Pixi) byte estimation ─────────────────────────────────────────────────────────────────

/** The subset of PixiJS `TextureSource` this module reads. Duck-typed (not imported from
 *  `pixi.js`) so this stays a pure, dependency-free estimator — the same reason
 *  `estimateTextureBytes` in an earlier draft of this module took a plain shape rather than
 *  `THREE.Texture` directly. */
export interface PixiTextureSourceLike {
  pixelWidth: number;
  pixelHeight: number;
  /** A WebGPU texture-format STRING (Pixi's own convention) — e.g. `'rgba8unorm'`,
   *  `'astc-4x4-unorm'`, `'bc3-rgba-unorm'`, `'etc2-rgba8unorm'` — not a THREE numeric constant. */
  format: string;
  mipLevelCount?: number;
  arrayLayerCount?: number;
}

/** Block footprint + bytes/block for every compressed WebGPU format this engine's KTX2 pipeline
 *  ships (ASTC/S3TC(BC)/ETC2 — the same three families `deviceCaps.ts`'s `CompressedTextureSupport`
 *  scopes to). `null` for an uncompressed (or unrecognised) format. */
function compressedBlockInfo(format: string): { bw: number; bh: number; bytes: number } | null {
  const astc = /^astc-(\d+)x(\d+)/.exec(format);
  if (astc) return { bw: Number(astc[1]), bh: Number(astc[2]), bytes: 16 }; // ASTC: always 16B/block
  // BC (S3TC/DXT) family — always a 4x4 block.
  if (format.startsWith('bc1-')) return { bw: 4, bh: 4, bytes: 8 };
  if (format.startsWith('bc2-') || format.startsWith('bc3-')) return { bw: 4, bh: 4, bytes: 16 };
  if (format.startsWith('bc4-')) return { bw: 4, bh: 4, bytes: 8 };
  if (format.startsWith('bc5-') || format.startsWith('bc6h-') || format.startsWith('bc7-')) return { bw: 4, bh: 4, bytes: 16 };
  // ETC2/EAC — also a 4x4 block. RGB8/RGB8A1 (punch-through alpha) are 8B; the EAC-alpha RGBA8
  // variant and the 2-channel EAC formats are 16B.
  if (format.startsWith('etc2-rgb8a1')) return { bw: 4, bh: 4, bytes: 8 };
  if (format.startsWith('etc2-rgb8unorm')) return { bw: 4, bh: 4, bytes: 8 };
  if (format.startsWith('etc2-rgba8')) return { bw: 4, bh: 4, bytes: 16 };
  if (format.startsWith('eac-rg11')) return { bw: 4, bh: 4, bytes: 16 };
  if (format.startsWith('eac-r11')) return { bw: 4, bh: 4, bytes: 8 };
  return null;
}

/** Bytes per pixel for an uncompressed WebGPU format string. Channel count from the leading
 *  component letters, bytes/channel from the trailing width+kind — covers what this pipeline's
 *  loaders actually emit (`rgba8unorm` by default; `r8`/`rg8` for single/dual-channel atlases;
 *  `16float`/`32float` for HDR). Unrecognised formats default to 4 bytes/pixel — the same
 *  "conservative, not silently zero" choice the compressed-format fallback makes elsewhere. */
function uncompressedBytesPerPixel(format: string): number {
  let channels = 4;
  if (/^r(8|16|32)/.test(format)) channels = 1;
  else if (/^rg(8|16|32)/.test(format)) channels = 2;
  else if (/^(rgba|bgra)/.test(format)) channels = 4;

  let bytesPerChannel = 1;
  if (/32(float|uint|sint)/.test(format)) bytesPerChannel = 4;
  else if (/16(float|uint|sint|unorm|snorm)/.test(format)) bytesPerChannel = 2;

  return channels * bytesPerChannel;
}

/** Estimate one Pixi `TextureSource`'s real GPU bytes: `pixelWidth * pixelHeight * bytesPerPixel`,
 *  block-size-aware for compressed formats (ASTC/BC/ETC2 — NOT 4 bytes/pixel, which would be
 *  4-8x wrong), times the array-layer count, times ~1.33 when a mip chain is present (the
 *  `1 + 1/4 + 1/16 + …` series converges to 4/3 — a heuristic multiplier, matching the same choice
 *  made for the (now-unused) 3D estimator this replaced). Returns 0 for a source with no known
 *  dimensions. */
export function estimatePixiTextureBytes(src: PixiTextureSourceLike): number {
  const { pixelWidth: w, pixelHeight: h } = src;
  if (!w || !h) return 0;

  const block = compressedBlockInfo(src.format);
  const perLayer = block
    ? Math.ceil(w / block.bw) * Math.ceil(h / block.bh) * block.bytes
    : w * h * uncompressedBytesPerPixel(src.format);

  const layers = Math.max(1, src.arrayLayerCount ?? 1);
  let bytes = perLayer * layers;

  if ((src.mipLevelCount ?? 1) > 1) bytes = Math.ceil(bytes * 4 / 3);
  return bytes;
}

// ── 2D (Pixi) geometry byte estimation ────────────────────────────────────────────────────────

/** The GPU-backed vertex/index buffer behind a Pixi `Geometry`. Duck-typed for the same reason
 *  `PixiTextureSourceLike` is — this module stays dependency-free from `pixi.js`. `data` is the
 *  live typed-array view (present for a CPU-resident buffer); `descriptor.size` is the fallback
 *  for a buffer whose backing array has already been dropped (a GPU-only upload). */
interface PixiBufferLike {
  uid?: number;
  data?: { byteLength?: number } | null;
  descriptor?: { size?: number } | null;
}

/** The subset of Pixi `Geometry` this module reads. `buffers` is Pixi 8's own flattened list of
 *  every GPU buffer the geometry owns — attributes AND the index buffer are already in there
 *  (verified against 8.19.0: a 2-attribute + indexed geometry reports `buffers.length === 3`,
 *  `buffers.includes(indexBuffer) === true`), so summing `buffers` is the whole allocation; adding
 *  the index buffer again on top would double it. */
interface PixiGeometryLike {
  uid?: number;
  buffers?: PixiBufferLike[] | null;
}

/** A Pixi display object as far as this walk needs it — any object with a `.texture.source`
 *  (Sprite, NineSliceSprite, TilingSprite, or a Mesh with `.texture` set, e.g. the MTSDF text
 *  mesh), a `.geometry` (a Mesh's vertex/index buffers — the MTSDF text mesh again, this time for
 *  its GEOMETRY rather than its shared atlas texture), and/or `.children`. Duck-typed for the
 *  same reason `PixiTextureSourceLike` is. */
interface PixiDisplayObjectLike {
  texture?: { source?: (PixiTextureSourceLike & { uid?: number }) | null } | null;
  geometry?: PixiGeometryLike | null;
  children?: PixiDisplayObjectLike[] | null;
}

/** One buffer's resident bytes: the live typed array when present, else the descriptor's declared
 *  size, else 0 — never silently skip a buffer whose `data` was already released, that would
 *  understate exactly the churny mesh this exists to catch. */
function bufferBytes(buf: PixiBufferLike): number {
  return buf.data?.byteLength ?? buf.descriptor?.size ?? 0;
}

/** Walk `root` and every descendant, adding each distinct texture SOURCE (deduped by `uid` — a
 *  texture shared by several display objects, like the MTSDF atlas reused by every glyph mesh,
 *  must count once) into `textures`, and each distinct GEOMETRY (deduped by geometry `uid`, into
 *  `geometries`) along with every distinct BUFFER it owns (deduped by buffer `uid`, into
 *  `geometryBuffers` — see that param's doc for why this is a SEPARATE dedup key from the
 *  geometry). Iterative, not recursive — a Pixi container tree is shallow in practice, but
 *  nothing about the shape guarantees it. One traversal for both, rather than walking the same
 *  tree twice. */
function collectPixiRenderResources(
  root: PixiDisplayObjectLike,
  textures: Map<number, PixiTextureSourceLike>,
  geometries: Map<number, PixiGeometryLike>,
  /** Deduped by BUFFER uid, not geometry uid — Pixi's batcher SHARES one buffer across several
   *  geometries, so a geometry-level dedup double-counts every buffer it shares. The GPU
   *  allocation is per buffer; the geometry is just a view over one or more of them. */
  geometryBuffers: Map<number, PixiBufferLike>,
): void {
  const stack: PixiDisplayObjectLike[] = [root];
  while (stack.length > 0) {
    const obj = stack.pop()!;
    const src = obj.texture?.source;
    if (src && typeof src.uid === 'number' && !textures.has(src.uid)) textures.set(src.uid, src);
    const geo = obj.geometry;
    if (geo && typeof geo.uid === 'number' && !geometries.has(geo.uid)) {
      geometries.set(geo.uid, geo);
      for (const buf of geo.buffers ?? []) {
        if (typeof buf.uid === 'number' && !geometryBuffers.has(buf.uid)) geometryBuffers.set(buf.uid, buf);
      }
    }
    if (obj.children) for (const c of obj.children) stack.push(c);
  }
}

// ── The report ─────────────────────────────────────────────────────────────────────────────────

export interface Slot2DMemory {
  entityId: number | null;
  bytes: number;
  textureCount: number;
}

export interface GpuMemoryReport {
  /** `rawNow()` at sample time — monotonic ms, matching `core/consoleRing.ts`'s convention. */
  sampleTimeMs: number;
  /** `renderer.info.memory.total` verbatim — see this module's header on why 3D is READ, not
   *  recomputed. `0` when no 3D renderer has registered (a 2D-only project, or before Scene3D
   *  mounts) — there is genuinely no 3D GPU memory to report, so it participates cleanly in
   *  `totalBytes` rather than needing a null-guard at every call site. */
  gpu3dBytes: number;
  /** Sum of every DISTINCT texture reachable from a live `canvas2DPool` slot (GameView pool only —
   *  see `getSlotsForMemoryReport()`). Computed, not read — see this module's header. */
  gpu2dBytes: number;
  /** ⚠️ ENGINE-TRACKED bytes only (`gpu3dBytes + gpu2dBytes`) — NOT the GPU process's real memory
   *  footprint. Excludes Pixi geometry/vertex buffers, text meshes, and every WebKit-side
   *  allocation (IOSurface/compositing backing stores) — see this module's header for the
   *  15.65 MiB tracked vs 322 MB actual measurement that is why this field must not be read as
   *  "total GPU memory". Field name kept as-is (API); the console line calls it `tracked=`. */
  totalBytes: number;
  /** Distinct 2D textures this report walked, after cross-slot dedup. */
  textureCount2D: number;
  /** `core/gpuContextTracking.ts`'s live count, across every tracked context-creation site. */
  liveGpuContexts: number;
  /** Cumulative, monotonic (never decreases) — contexts ever created/destroyed this session. See
   *  this module's header on why a live gauge cannot see create/destroy CHURN. */
  totalGpuContextsCreated: number;
  totalGpuContextsDestroyed: number;
  /** `renderer.info.memory` — COUNTS, not bytes. `null` when no renderer has registered yet. */
  rendererGeometries: number | null;
  rendererTextures: number | null;
  /** Per-slot 2D bytes, DESCENDING — so the biggest slot is first. A texture shared by several
   *  slots is counted in EACH slot's total (attribution, not a partition) but only once in
   *  `gpu2dBytes`/`textureCount2D` above. */
  perSlotBytes2D: Slot2DMemory[];
  /** Cumulative, monotonic — distinct 2D texture-source `uid`s ever observed LIVE across every
   *  sample this session (not just this one). Climbing while `textureCount2D` holds steady is
   *  create/destroy churn a snapshot alone cannot show — see this module's header.
   *  ⚠️ Fires ONCE per uid, ever — a uid that leaves the live set and later RE-ENTERS it (the
   *  same texture source re-attached to a tracked slot, not a new GPU allocation) is already in
   *  `seenTextureUidsEver` and does not increment this again. That is deliberate: re-entry is not
   *  a create at the GPU level, so counting it as one would overstate real allocation churn. The
   *  asymmetric consequence — `cumulativeTextureReleases2D` CAN exceed this field for a texture
   *  that cycles in and out of the live set several times — is documented there, not a bug. */
  cumulativeTextureCreates2D: number;
  /** Cumulative, monotonic — texture-source `uid`s that were live in a PREVIOUS sample and are no
   *  longer live in this one. "JS stopped referencing it", not "the GPU freed it" — see the
   *  module header's orphan-hypothesis caveat.
   *  ⚠️ Fires on EVERY drop-out, including a uid's second/third/… release after it re-entered the
   *  live set post-release (see `cumulativeTextureCreates2D`, which fires only on the FIRST
   *  entry). A texture cycling live→gone→live→gone racks up two releases against one create, so
   *  this can legitimately read HIGHER than `cumulativeTextureCreates2D` — that is not
   *  "impossible" accounting, it is "left the tracked set" counted honestly per departure while
   *  "entered the tracked set" is counted once per texture, ever. */
  cumulativeTextureReleases2D: number;
  /** Sum of every DISTINCT geometry BUFFER (vertex + index) reachable from a live `canvas2DPool`
   *  slot's display tree — deduped by BUFFER `uid`, not geometry uid. This is deliberately its
   *  OWN field, not folded into `gpu2dBytes`/`totalBytes`: those two fields already had a
   *  documented meaning before this existed, and a caller diffing a step change must be able to
   *  tell "we started counting a new thing" from "the tracked thing actually grew". See the
   *  module header on #590's text-mesh churn — this is the field that makes that GEOMETRY
   *  reallocation visible, where `gpu2dBytes` (textures only) could not. */
  geometryBytes2D: number;
  /** Distinct 2D geometries this report walked, after cross-slot dedup by geometry `uid` — NOT
   *  the same count as the number of distinct buffers behind `geometryBytes2D` (Pixi's batcher
   *  shares one buffer across several geometries, so this can be higher than the buffer count). */
  geometryCount2D: number;
  /** Cumulative, monotonic — derived from the largest live geometry `uid` seen, NOT from a Set of
   *  every uid ever seen. `uid`s are dense and strictly increasing per `pixi.js`'s own
   *  `uid('geometry')` counter, so the largest one observed is a proxy for "how many have ever been
   *  allocated". #590 measured ~2,700 text-mesh rebuilds/min, and a never-forgetting Set (the
   *  texture-churn pattern above) would leak a few thousand entries a minute INSIDE the leak
   *  detector — so the bound is the point, not an optimisation.
   *
   *  ⚠️ **This is a LOWER BOUND, not a count.** Only geometries that are live at a sample INSTANT
   *  are observable, and the sampler runs every `SAMPLE_INTERVAL_MS`; a geometry created and
   *  destroyed entirely between two samples is never seen by anything. It is nearly tight for the
   *  case it was built for — under a text rebuild the newest geometry IS the current text mesh, so
   *  it is live when the sample lands and the high-water tracks the allocator closely — and it
   *  degrades badly for genuinely transient geometry that never survives to a sample boundary. Read
   *  a rise as "at least this many"; never quote it as an allocation total.
   *
   *  ⚠️ **It also over-counts in one direction, so do not read it as OUR geometry alone.** The
   *  `uid('geometry')` counter is advanced by every `Geometry` Pixi allocates, including ones
   *  outside the walked tree — `DefaultBatcher`'s own `BatchGeometry`, pooled
   *  `GraphicsContextRenderData`. Those raise this field without moving `geometryCount2D`, so
   *  concurrent `Graphics` churn inflates it. `BigPool` reuse bounds the effect by peak concurrent
   *  contexts rather than per frame, and the magnitude here is UNMEASURED.
   *
   *  ⚠️ **Verify a change here by PERTURBATION.** Drive a KNOWN number of rebuilds and check this
   *  moves by the expected amount — and hold `Graphics` activity still while you do, per the
   *  over-count above. A non-zero figure cannot distinguish "counting geometry" from
   *  "counting something", which is how the module ended up blind to geometry in the first place. */
  cumulativeGeometryCreates2D: number;
  /** Cumulative, monotonic — geometry `uid`s that were live in a PREVIOUS sample and are no longer
   *  live in this one. Bounded the same way `cumulativeTextureReleases2D` is: the comparison set
   *  is only the PREVIOUS sample's live uids (small), never a full history. */
  cumulativeGeometryReleases2D: number;
}

/** Distinct 2D texture-source `uid`s ever observed live, across every call to
 *  `computeGpuMemoryReport()` this session — the "ever created" half of the churn tally. Module
 *  state, deliberately: churn is a comparison across TIME, which a single stateless call cannot
 *  make on its own. Bounded by how many distinct textures a session actually creates, which is
 *  minuscule (a `Set<number>`) next to the GPU bytes this instrument exists to explain. */
let seenTextureUidsEver = new Set<number>();
/** The live 2D texture-uid set as of the PREVIOUS call — compared against the current one to
 *  detect releases (see `cumulativeTextureReleases2D`). */
let previousLiveTextureUids = new Set<number>();
let cumulativeTextureCreates2D = 0;
let cumulativeTextureReleases2D = 0;

/** The largest geometry `uid` in the PREVIOUS sample's live set — re-baselined every sample, not a
 *  running maximum, so the name says "live" rather than "ever". It is the bounded stand-in for a
 *  `seenTextureUidsEver`-style Set (see `cumulativeGeometryCreates2D` for why a Set is unsafe
 *  here). Monotonicity of the exported counter comes from the `Math.max` clamp at the call site,
 *  NOT from this variable — which is what lets a `uid`-counter reset re-baseline it downward
 *  harmlessly. `-1` means "nothing observed yet". */
let highestLiveGeometryUid = -1;
/** The live 2D geometry-uid set as of the PREVIOUS call — mirrors `previousLiveTextureUids`, but
 *  for geometry releases. Bounded by the live set size, not by history. */
let previousLiveGeometryUids = new Set<number>();
let cumulativeGeometryCreates2D = 0;
let cumulativeGeometryReleases2D = 0;

/** Walk the live registries and compute one report. Not cheap enough to call every frame — see
 *  `SAMPLE_INTERVAL_MS` below — but cheap enough for the 1-2s cadence this module uses.
 *
 *  ⚠️ Has a side effect: it updates the cumulative 2D-texture churn tally (module header) by
 *  comparing this call's live uid set against the PREVIOUS call's. Calling this directly in a
 *  test (rather than through the sampler) is fine and is how the churn tests drive it — each call
 *  IS a sample as far as churn tracking is concerned. */
export function computeGpuMemoryReport(): GpuMemoryReport {
  const globalSeen = new Map<number, PixiTextureSourceLike>();
  const globalGeometries = new Map<number, PixiGeometryLike>();
  const globalGeometryBuffers = new Map<number, PixiBufferLike>();
  const perSlotBytes2D: Slot2DMemory[] = [];

  for (const slot of getSlotsForMemoryReport()) {
    const localSeen = new Map<number, PixiTextureSourceLike>();
    // Geometry has no per-slot attribution field today (`Slot2DMemory` is texture-only), so its
    // maps are the GLOBAL ones directly — the walker's own uid-dedup makes accumulating straight
    // into them across every slot equivalent to a per-slot pass followed by a merge.
    collectPixiRenderResources(slot.container, localSeen, globalGeometries, globalGeometryBuffers);
    let slotBytes = 0;
    for (const [uid, src] of localSeen) {
      slotBytes += estimatePixiTextureBytes(src);
      if (!globalSeen.has(uid)) globalSeen.set(uid, src);
    }
    perSlotBytes2D.push({ entityId: slot.entityId, bytes: slotBytes, textureCount: localSeen.size });
  }
  perSlotBytes2D.sort((a, b) => b.bytes - a.bytes);

  let gpu2dBytes = 0;
  for (const src of globalSeen.values()) gpu2dBytes += estimatePixiTextureBytes(src);

  let geometryBytes2D = 0;
  for (const buf of globalGeometryBuffers.values()) geometryBytes2D += bufferBytes(buf);

  // Cumulative 2D-texture churn — see the module header. A NEW uid (never seen live before) is a
  // create; a uid that was live LAST call but is absent THIS call is a release. Asymmetric ON
  // PURPOSE: `seenTextureUidsEver` never forgets, so a uid that leaves and later RE-ENTERS the
  // live set fires a SECOND release below but no second create here — see the field docs on
  // `cumulativeTextureCreates2D`/`cumulativeTextureReleases2D` for why that's the honest count,
  // not a bug (releases CAN exceed creates for a texture that cycles in and out).
  const currentUids = new Set(globalSeen.keys());
  for (const uid of currentUids) {
    if (!seenTextureUidsEver.has(uid)) {
      seenTextureUidsEver.add(uid);
      cumulativeTextureCreates2D++;
    }
  }
  for (const uid of previousLiveTextureUids) {
    if (!currentUids.has(uid)) cumulativeTextureReleases2D++;
  }
  previousLiveTextureUids = currentUids;

  // Cumulative 2D-geometry churn — same shape as the texture churn above, but the "ever seen"
  // side is a high-water mark instead of a Set (see `cumulativeGeometryCreates2D`'s field doc —
  // #590's ~2,700 rebuilds/min would make a never-forgetting Set itself a leak).
  const currentGeometryUids = new Set(globalGeometries.keys());
  let highestThisSample = -1;
  for (const uid of currentGeometryUids) if (uid > highestThisSample) highestThisSample = uid;
  // A non-empty live set whose highest uid DROPPED below the running high-water mark means
  // `pixi.js`'s dense `uid('geometry')` counter went backwards — it cannot do that on its own, so
  // this is a counter reset (a test's `resetUids()`, in practice). Either way (growth or reset),
  // re-baseline to what THIS sample actually saw; `cumulativeGeometryCreates2D` below is protected
  // from the reset case by its own `Math.max`, so it never emits a negative delta.
  if (currentGeometryUids.size > 0) highestLiveGeometryUid = highestThisSample;
  // The clamp — not the re-baseline above — is what makes the exported counter monotonic. Both a
  // reset and an empty sample therefore cost only STALLED growth, never a decrease: after a reset
  // this field holds its old value until the fresh counter climbs past the previous peak. That is
  // the honest trade for a bounded mechanism, and `resetUids()` is test-only in this repo anyway.
  cumulativeGeometryCreates2D = Math.max(cumulativeGeometryCreates2D, highestLiveGeometryUid + 1);
  for (const uid of previousLiveGeometryUids) {
    if (!currentGeometryUids.has(uid)) cumulativeGeometryReleases2D++;
  }
  previousLiveGeometryUids = currentGeometryUids;

  const renderer = getActiveRenderer() as {
    info?: { memory?: { geometries?: number; textures?: number; total?: number } };
  } | null;
  const memory = renderer?.info?.memory ?? null;
  const gpu3dBytes = memory?.total ?? 0;

  return {
    sampleTimeMs: rawNow(),
    gpu3dBytes,
    gpu2dBytes,
    totalBytes: gpu3dBytes + gpu2dBytes,
    textureCount2D: globalSeen.size,
    liveGpuContexts: liveGpuContextCount(),
    totalGpuContextsCreated: totalGpuContextsCreated(),
    totalGpuContextsDestroyed: totalGpuContextsDestroyed(),
    rendererGeometries: memory?.geometries ?? null,
    rendererTextures: memory?.textures ?? null,
    perSlotBytes2D,
    cumulativeTextureCreates2D,
    cumulativeTextureReleases2D,
    geometryBytes2D,
    geometryCount2D: globalGeometries.size,
    cumulativeGeometryCreates2D,
    cumulativeGeometryReleases2D,
  };
}

// ── Sampling + emission ───────────────────────────────────────────────────────────────────────

/** 1-2s is plenty of resolution for a leak measured in minutes — see this module's header.
 *  Exported (not just documented) so tests can drive the sampler's own cadence exactly, rather
 *  than guessing it or duplicating the number. */
export const SAMPLE_INTERVAL_MS = 1500;
/** A STABLE scene must not flood the console ring — see this module's header on why 30s. */
export const HEARTBEAT_MS = 30_000;
/** Swing in total bytes that counts as "significant" — see this module's header. */
export const CHANGE_FRACTION = 0.10;

/** Minimum real time between LOGGED console lines, however eager `shouldLog()` is under sustained
 *  churn. The console ring holds 384 entries (`core/consoleRing.ts`); at the raw `SAMPLE_INTERVAL_MS`
 *  cadence of 1.5s, a churny scene that qualifies for a line on EVERY sample fills the whole ring
 *  in 384 * 1.5s ≈ 9.6 minutes — evicting the boot prefix and the start of the session well before
 *  the freeze this instrument exists to diagnose (#590's own capture: 14-31 minutes to jetsam).
 *  This floor buys 384 * 5s ≈ 32 minutes of history instead, comfortably covering that window. A
 *  sample `shouldLog()` accepts but that lands inside the floor is SUPPRESSED, not dropped — see
 *  `suppressedSinceLastLog` below, which folds every suppressed sample into the next line that
 *  actually gets through so the burst is never silently lost, only delayed. */
export const MIN_LOG_INTERVAL_MS = 5000;

let lastReport: GpuMemoryReport | null = null;
let lastLoggedReport: GpuMemoryReport | null = null;
let lastLoggedAtMs = 0;
/** Samples `shouldLog()` accepted but the `MIN_LOG_INTERVAL_MS` floor suppressed since the last
 *  line actually written — folded into that next line as `(+N suppressed)`, then reset to 0. */
let suppressedSinceLastLog = 0;
let intervalId: ReturnType<typeof setInterval> | undefined;

function fractionalChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Infinity;
  return Math.abs(after - before) / before;
}

/** Cumulative churn events (creates + releases, contexts + 2D textures) since the last LOGGED
 *  sample that counts as "worth interrupting the heartbeat for" — see the module header on why a
 *  flat live view does not mean nothing is happening. A handful of create/destroy cycles inside
 *  one sample interval is exactly the orphan-hypothesis signature. */
export const CHURN_EVENTS_THRESHOLD = 4;

/** Should THIS sample get a console-ring line? True on the very first sample, on a live-context
 *  count change (any leaked/evicted context matters, however small), on a >10% swing in either
 *  total bytes or 2D GEOMETRY bytes (the latter is NOT part of `totalBytes` — see
 *  `geometryBytes2D`), on enough create/destroy CHURN since the last log across contexts,
 *  textures AND geometry (even with a flat live view — see the module header), or once the
 *  heartbeat interval has elapsed since the last logged line. */
function shouldLog(prev: GpuMemoryReport | null, next: GpuMemoryReport): boolean {
  if (!prev) return true;
  if (prev.liveGpuContexts !== next.liveGpuContexts) return true;
  if (fractionalChange(prev.totalBytes, next.totalBytes) >= CHANGE_FRACTION) return true;
  if (fractionalChange(prev.geometryBytes2D, next.geometryBytes2D) >= CHANGE_FRACTION) return true;
  const churnSinceLastLog =
    (next.totalGpuContextsCreated - prev.totalGpuContextsCreated) +
    (next.totalGpuContextsDestroyed - prev.totalGpuContextsDestroyed) +
    (next.cumulativeTextureCreates2D - prev.cumulativeTextureCreates2D) +
    (next.cumulativeTextureReleases2D - prev.cumulativeTextureReleases2D) +
    // ⚠️ Geometry MUST be in this sum, and it is the case the gate was blindest to. #590's actual
    // driver is text-mesh rebuild churn, where the MTSDF atlas is shared and stable (no texture
    // churn), the context count never moves, and `totalBytes` excludes `geometryBytes2D` by
    // design — so before this term the driving signal reached the ring only on the 30 s
    // heartbeat, at 1/20th the resolution of the thing it was built to catch.
    (next.cumulativeGeometryCreates2D - prev.cumulativeGeometryCreates2D) +
    (next.cumulativeGeometryReleases2D - prev.cumulativeGeometryReleases2D);
  if (churnSinceLastLog >= CHURN_EVENTS_THRESHOLD) return true;
  return next.sampleTimeMs - lastLoggedAtMs >= HEARTBEAT_MS;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function sampleGpuMemory(): void {
  const report = computeGpuMemoryReport();
  lastReport = report;

  // Profiler-panel channel — same enable gate every other counter in this module respects
  // (`isProfilerEnabled()`, checked inside `setCounter`). OFF unless a session turned it on.
  setCounter('gpu.3dBytes', report.gpu3dBytes);
  setCounter('gpu.2dBytes', report.gpu2dBytes);
  setCounter('gpu.totalBytes', report.totalBytes);
  setCounter('gpu.liveContexts', report.liveGpuContexts);
  setCounter('gpu.totalContextsCreated', report.totalGpuContextsCreated);
  setCounter('gpu.totalContextsDestroyed', report.totalGpuContextsDestroyed);
  setCounter('gpu.cumulativeTextureCreates2D', report.cumulativeTextureCreates2D);
  setCounter('gpu.cumulativeTextureReleases2D', report.cumulativeTextureReleases2D);
  setCounter('gpu.geometryBytes2D', report.geometryBytes2D);
  setCounter('gpu.geometryCount2D', report.geometryCount2D);
  // ⚠️ The CHURN pair matters more than the two gauges above on this path, and charting only the
  // gauges reproduces the exact failure this module's header exists to warn about: a live snapshot
  // reads flat while the leak grows. Both are set for the same reason the texture twins are.
  setCounter('gpu.cumulativeGeometryCreates2D', report.cumulativeGeometryCreates2D);
  setCounter('gpu.cumulativeGeometryReleases2D', report.cumulativeGeometryReleases2D);

  // Console-ring channel — ALWAYS on (see module header). `console.log` reaches the ring through
  // whatever has patched `console.*` (installConsoleRing in the shipped app, or nothing in a
  // headless test — either way this is a plain log call, no ring import needed).
  if (shouldLog(lastLoggedReport, report)) {
    // `shouldLog()` alone would still flood the ring under sustained churn (see
    // `MIN_LOG_INTERVAL_MS`'s own comment) — a candidate line this close to the last LOGGED one is
    // suppressed, UNLESS it's the very first sample ever (nothing to floor against) or a
    // live-context-count change (rare, and exactly the orphan-hypothesis signature — worth the
    // ring line even mid-floor). Suppressed samples are not lost: the count rides along on the
    // next line that does get through.
    const isFirstSample = lastLoggedReport === null;
    const contextChanged = lastLoggedReport !== null
      && lastLoggedReport.liveGpuContexts !== report.liveGpuContexts;
    const withinFloor = !isFirstSample && !contextChanged
      && report.sampleTimeMs - lastLoggedAtMs < MIN_LOG_INTERVAL_MS;
    if (withinFloor) {
      suppressedSinceLastLog++;
      return;
    }

    const suppressedSuffix = suppressedSinceLastLog > 0 ? ` (+${suppressedSinceLastLog} suppressed)` : '';
    suppressedSinceLastLog = 0;
    lastLoggedReport = report;
    lastLoggedAtMs = report.sampleTimeMs;
    const top = report.perSlotBytes2D[0];
    console.log(
      `[gpuMemory] 3d=${formatMiB(report.gpu3dBytes)}MiB ` +
      `2d=${formatMiB(report.gpu2dBytes)}MiB(${report.textureCount2D}tex,${report.perSlotBytes2D.length}slots) ` +
      `tracked=${formatMiB(report.totalBytes)}MiB ` +
      `contexts=${report.liveGpuContexts}(created=${report.totalGpuContextsCreated},destroyed=${report.totalGpuContextsDestroyed}) ` +
      `tex2dChurn(created=${report.cumulativeTextureCreates2D},released=${report.cumulativeTextureReleases2D}) ` +
      `geom2d=${formatMiB(report.geometryBytes2D)}MiB(${report.geometryCount2D}geo) ` +
      `geom2dChurn(created=${report.cumulativeGeometryCreates2D},released=${report.cumulativeGeometryReleases2D}) ` +
      `rendererInfo(geom=${report.rendererGeometries ?? 'n/a'},tex=${report.rendererTextures ?? 'n/a'})` +
      (top ? ` top2dSlot(entity=${top.entityId},${formatMiB(top.bytes)}MiB)` : '') +
      suppressedSuffix,
    );
  }
}

/** Start periodic sampling. Idempotent. Runs on a plain interval — NOT a frame callback — so it
 *  keeps sampling after the frame loop itself has died (see this module's header). No-ops with no
 *  DOM (SSR/Node). */
export function startGpuMemorySampling(): void {
  if (intervalId !== undefined) return;
  if (typeof window === 'undefined') return;
  sampleGpuMemory(); // seed an immediate first sample rather than waiting a full interval
  intervalId = setInterval(sampleGpuMemory, SAMPLE_INTERVAL_MS);
  // Never keep a Node process alive on this alone (matches frameDriver's watchdog convention).
  (intervalId as unknown as { unref?: () => void }).unref?.();
}

export function stopGpuMemorySampling(): void {
  if (intervalId === undefined) return;
  clearInterval(intervalId);
  intervalId = undefined;
}

/** The most recent sample, or `null` before the first one has run. Cheap — this returns the
 *  cached report; it does not re-walk anything. */
export function getGpuMemoryReport(): GpuMemoryReport | null {
  return lastReport;
}

/** Test-only: drop all sampler state, including the cached report, log-throttle bookkeeping, and
 *  the cumulative 2D-texture and 2D-geometry churn tallies (`computeGpuMemoryReport`'s module
 *  state). */
export function __resetGpuMemoryReportForTest(): void {
  stopGpuMemorySampling();
  lastReport = null;
  lastLoggedReport = null;
  lastLoggedAtMs = 0;
  suppressedSinceLastLog = 0;
  seenTextureUidsEver = new Set();
  previousLiveTextureUids = new Set();
  cumulativeTextureCreates2D = 0;
  cumulativeTextureReleases2D = 0;
  highestLiveGeometryUid = -1;
  previousLiveGeometryUids = new Set();
  cumulativeGeometryCreates2D = 0;
  cumulativeGeometryReleases2D = 0;
}

// Self-register into the provider slot `rendering/useGameLoop.ts` (L2) reaches through — this
// module is L3 (`loaders/`) and cannot be imported from L2 directly. Single-loader slot, so it
// registers at its own module-evaluation time (matches `particleCache.ts`'s convention), and
// `loaders/registerProviders.ts` imports this module for that side effect.
gpuMemorySamplerProvider.provide({ start: startGpuMemorySampling, stop: stopGpuMemorySampling });
