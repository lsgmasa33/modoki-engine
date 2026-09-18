/** PixiJS texture-load shim — the single entry every Scene2D/font Pixi texture
 *  load goes through, so the playable-blob fix lives in ONE place. */

import { Assets, ImageSource, Texture } from 'pixi.js';
import { fireDirtyListeners } from '../core/renderDirty';
import { AssetNetworkError, checkAssetResponse } from '../core/assetLoadErrors';
import { rethrowFetchFailure } from '../core/loadFailureMemo';

/** Load a texture through PixiJS Assets, forcing the image parser for `blob:` URLs.
 *
 *  A playable single-file build (VITE_PLAYABLE) serves every asset as a `blob:` URL
 *  with NO extension (assetUrl → __PLAYABLE_ASSETS__). PixiJS v8 selects a texture
 *  loadParser by EXTENSION (loadTextures.test → checkExtension → path.extname, which
 *  strips BOTH the `?query` and the `#hash` — so a URL hint can't smuggle the
 *  extension in either). A bare `blob:` therefore hits "we don't know how to parse
 *  it", the texture never loads, and the 2D render callback then reads a null texture
 *  and frameDriver auto-unregisters `render2d` → a blank game (the ONE 2D-render bug a
 *  playable hits; Three uses explicit loaders, so 3D is unaffected). Playable textures
 *  are ALWAYS browser-decodable — the asset profile forces WebP/PNG, never KTX2 — so
 *  forcing the `'texture'` parser (loadTextures' id) is correct there. Non-blob URLs
 *  (dev / web / native — real extensions, incl. KTX2) auto-detect as before. */
/** Urls whose in-flight load already owns the refill wake. Pixi publishes to `Assets.cache` only
 *  on RESOLVE, so every call made while a load is in flight also reads as a miss — and Scene2D's
 *  skinned-part path calls this once per rendered frame until the texture is live. Without this,
 *  a 2 s load at 60 fps landed ~120 wakes in one burst; with it, exactly one per load. */
const wakePending = new Set<string>();

export function loadPixiTexture(url: string): Promise<Texture> {
  evictSourcelessEntry(url);
  // Decided BEFORE the load (#1368 G1): the wake belongs to a load that actually fetched, never to
  // a cache hit — Scene2D calls through here from its draw path, and a hit that woke would keep the
  // idle gate awake forever. Asked after the eviction above, so a sourceless corpse counts as a miss.
  const miss = !Assets.cache.has(url);
  let load: Promise<Texture>;
  if (url.startsWith('blob:')) {
    disablePixiTextureWorker();
    load = Assets.load<Texture>({ src: url, parser: 'texture' });
  } else {
    // #1404: no load may reach a Pixi worker before we know a failure can come back out of it.
    const gate = workerErrorProbeGate();
    load = gate ? gate.then(() => loadPastWorkerGap(url)) : loadPastWorkerGap(url);
  }
  // The WAKE lives in the shim, not at each call site (#1368 G1): `pixiParticleBackend` reveals its
  // emitter off this promise and woke nothing, so on a stopped Scene2D a texture slower than the
  // idle grace left the emitter hidden until an unrelated edit. Scene2D's own sites also wake
  // themselves; this covers every consumer that does not.
  // ⚠️ SUCCESS only. A reject stays silent here: a consumer that retries a failed url decides WHEN
  // itself — Scene2D's material-sprite path backs off and schedules its own wake (#1374) — and a
  // reject wake here would retry a 404 at frame rate. A consumer that reveals something on failure
  // wakes for itself.
  if (!miss || wakePending.has(url)) return load;
  wakePending.add(url);
  return load.then(
    (tex) => { wakePending.delete(url); fireDirtyListeners(); return tex; },
    (e: unknown) => { wakePending.delete(url); throw e; },
  );
}

/** Load a BAKED MTSDF font atlas — as DATA, never through `Assets.load` (#1045).
 *
 *  ⚠️ **An MTSDF atlas must not be premultiplied, and `alphaMode` cannot enforce that.**
 *  RGB carries the 3-channel distance field and A carries the true SDF, so premultiplying
 *  scales the field by alpha and drags `median(rgb)` below the shader's 0.5 edge threshold —
 *  `fill = clamp((sd - 0.5) * spr + 0.5, 0, 1)` is then 0 for every pixel and EVERY GLYPH IN
 *  THE GAME IS INVISIBLE. Measured on an iPhone 8 / iOS 16.7.16 over one glyph cell: texels
 *  with `median(rgb) > 0.5` were 1775 in the file and 0 on the GPU.
 *
 *  `fontTexturePixi` does set `source.alphaMode = 'no-premultiply-alpha'`, and it CANNOT win:
 *  per the WebGL spec `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is **ignored for `ImageBitmap` uploads**
 *  (verified on the device — flipping it changed nothing in either direction). The only lever is
 *  the `createImageBitmap` option, and `Assets.load` does not expose it: `loadTextures.mjs`
 *  passes `{premultiplyAlpha:'none'}` ONLY when `data.alphaMode === 'premultiplied-alpha'`, and
 *  otherwise calls `createImageBitmap(blob)` bare, leaving it to the UA. On iOS 16 that default
 *  is byte-identical to `'premultiply'`; iOS 26 and desktop do not premultiply, which is exactly
 *  why this shipped green everywhere but a real iOS 16 device.
 *
 *  ⚠️ **Do NOT "simplify" this back to `Assets.load({src, data:{alphaMode:'premultiplied-alpha'}})`.**
 *  It happens to produce an unpremultiplied bitmap today, but only by exploiting an inverted
 *  condition inside Pixi's loader while ALSO mislabelling the source — it would break silently on
 *  a Pixi bump, and the failure looks like a font bug, not a loader one.
 *
 *  `colorSpaceConversion:'none'` for the same reason: a colour-profile transform is a no-op on a
 *  profile-less PNG and corruption on any other, and this is a distance field, not a picture.
 *
 *  Fetch + decode also sidesteps the `blob:` parser problem `loadPixiTexture` exists for, so a
 *  playable build needs no special case here. The no-`createImageBitmap` fallback is SAFE rather
 *  than a quiet reintroduction: without it Pixi decodes into an `HTMLImageElement`, and the unpack
 *  flag IS honoured for those. */
export async function loadMtsdfAtlasTexture(url: string): Promise<Texture> {
  if (typeof createImageBitmap !== 'function') return loadPixiTexture(url);
  // Every outcome typed for `fontTexturePixi`'s failure memo (#1397): no response and a dropped
  // body are network errors, a non-ok status or the SPA fallback a `MissingAssetError`.
  const response = checkAssetResponse(await fetch(url).catch(rethrowFetchFailure(url)), url);
  const blob = await response.blob().catch((e: unknown) => { throw new AssetNetworkError(e); });
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  return new Texture({
    source: new ImageSource({
      resource: bitmap,
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      autoGenerateMipmaps: false,
    }),
  });
}

/**
 * Is there a cache entry for `url` that is actually USABLE — present AND still holding a source?
 *
 * ⚠️ **Exported because `Assets.cache.has(url)` is the wrong question and a call site asking it
 * cannot be rescued by the shim.** `12fea928` moved the sourceless-entry guard into
 * `loadPixiTexture` on the reasoning that every consumer shares that choke point, and listed the
 * skinned-mesh part path as covered. It is not: that site reads `if (!Assets.cache.has(part.url))`
 * and only calls the shim when the entry is ABSENT, so a present-but-sourceless entry skips the
 * load entirely and gets bound straight into a `new Mesh`. A choke-point fix only reaches callers
 * that actually call it — a `has()` short-circuit in front of it is a hole by construction.
 *
 * So: **decide "do I need to load?" with this, never with `Assets.cache.has`.**
 */
export function isPixiTextureLive(url: string): boolean {
  if (!Assets.cache.has(url)) return false;
  const cached = Assets.cache.get(url) as Texture | undefined;
  return !!cached?.source;
}

/**
 * Drop a cache entry whose `source` is gone, so the load below genuinely REFETCHES.
 *
 * `Assets.unload` destroys the texture's source EAGERLY but removes the cache entry
 * asynchronously, leaving a window where the entry is present and unusable. `Assets.load`
 * hands that corpse straight back, and every consumer then reads it as a live texture:
 * a Sprite binds it and draws nothing forever, a Mesh binds it, and the font path does
 * `tex.source.scaleMode = 'linear'` and THROWS on a null source.
 *
 * This lives in the shim rather than at the call sites because the window belongs to
 * `Assets`, not to any one consumer — the same reason the blob-parser fix is here. Measured
 * on a live renderer 2026-08-10: `{inCache: true, hasSource: false}` for a texture whose
 * sprite had rendered nothing since the previous frame's despawn.
 *
 * A mid-decode entry is NOT at risk here: Pixi publishes to the cache on resolve, so a
 * present entry has already finished loading — a null source means it was torn down.
 */
function evictSourcelessEntry(url: string): void {
  if (Assets.cache.has(url) && !isPixiTextureLive(url)) Assets.cache.remove(url);
}

// Pixi decodes textures in a Web Worker by default (loadTextures.config.preferWorkers).
// A playable opened from `file://` (Finder double-click on the built ads/index.html —
// exactly what the Build menu's "reveal ads/" step invites) mints `blob:null/…` URLs
// (file:// is a null origin), and the WORKER cannot fetch a null-origin blob →
// "TypeError: Failed to fetch" → the texture never loads (blank game), even though the
// SAME blob fetches fine on the main thread. Over http(s) (an ad container / preview
// tool) workers are fine, so this only matters for the local file:// preview — but
// forcing main-thread decode is harmless (a playable has a handful of textures) and
// makes the double-click "just work". One-shot, set before the first blob texture load.
// The second caller is the #1404 probe below.
let workerDisabled = false;
function disablePixiTextureWorker(): void {
  if (workerDisabled) return;
  workerDisabled = true;
  Assets.setPreferences({ preferWorkers: false });
}

/**
 * #1404 — on a WebKit that cannot structured-clone an `Error` (iOS 16.7.16 on the iPhone 8,
 * measured), a FAILED worker texture load never settles AND permanently removes a worker from
 * Pixi's pool — so every texture load, present files included, hangs once `hardwareConcurrency`
 * loads have failed.
 *
 * The mechanism, in pixi.js 8.20.1: the worker (`_virtual/loadImageBitmap.worker.mjs`) reports a
 * failure as `postMessage({ error: e })`. That call THROWS `DataCloneError` there, so no message
 * arrives, and `WorkerManager` both rejects the job and returns the worker to its pool only
 * from its `message` listener (it has no `error` listener). The job's promise hangs; the worker
 * is never reused.
 *
 * A timeout on `Assets.load` would NOT fix it: it rejects the caller, but the worker still never
 * returns to the pool. So this asks the browser once, before the first texture load, whether a
 * worker can post an `Error`, and falls back to Pixi's main-thread decode where it cannot.
 * Browsers that can keep their workers and pay one tiny worker spawn at boot.
 */
export const WORKER_ERROR_PROBE_SRC =
  "try{postMessage({error:new Error('modoki-probe')})}" +
  'catch(e){postMessage({cloneFailed:String(e&&e.name)})}';

/** A worker that never answers is treated as unable to report failures, the same as one that
 *  cannot clone. Main-thread decode is always correct; the cost of a false verdict is only speed. */
const WORKER_PROBE_TIMEOUT_MS = 2000;

let probe: Promise<void> | undefined;
let probeSettled = false;
/** The probe's "no" verdict. Kept apart from `workerDisabled`, which the playable blob path sets too. */
let workerErrorsLost = false;

/**
 * `preferWorkers: false` covers only PNG/WebP. Pixi decodes KTX2 on its own single worker
 * (`loadKTX2onWorker`), with no main-thread path, and that worker reports a failure the same
 * way: `postMessage({ type: 'error', err })`. So where errors cannot cross, a missing KTX2 would
 * still hang. There is no pool to drain here, just that one URL. So the shim asks the question
 * the worker cannot answer, on the main thread, first. A missing or unreachable file rejects
 * with #1402's classified errors, and only a file that answers goes on to Pixi.
 *
 * The cost is one extra request per KTX2 load that is not already cached, on affected browsers
 * only. The body is cancelled unread. What is still NOT covered: a failure only the worker sees,
 * namely a KTX2 that fetches fine but fails to TRANSCODE, or a transcoder (`libktx`) that fails to
 * init. Both still hang.
 */
function loadPastWorkerGap(url: string): Promise<Texture> {
  // A live cache entry never reaches the worker, so it needs no check. Asked NOW, not from the
  // `miss` taken before the probe: a cache hit costing a request (and failing offline) is the
  // defect this guards against.
  if (!workerErrorsLost || isPixiTextureLive(url) || !/\.ktx2(?:[?#]|$)/i.test(url)) return Assets.load<Texture>(url);
  let check = ktx2Checks.get(url);
  if (!check) {
    // Shared by same-url callers in flight (N emitters on one texture), which Pixi's loader would
    // otherwise de-duplicate for us.
    check = fetch(url).catch(rethrowFetchFailure(url)).then((res) => {
      res.body?.cancel().catch(() => {}); // status + headers are all the check reads
      checkAssetResponse(res, url);
    });
    ktx2Checks.set(url, check);
    const drop = () => { if (ktx2Checks.get(url) === check) ktx2Checks.delete(url); };
    check.then(drop, drop);
  }
  return check.then(() => Assets.load<Texture>(url));
}
const ktx2Checks = new Map<string, Promise<void>>();

/** `undefined` = load now, synchronously (verdict known, or no Worker to ask about). */
function workerErrorProbeGate(): Promise<void> | undefined {
  if (probeSettled || workerDisabled) return undefined;
  if (!probe) {
    if (typeof Worker !== 'function' || typeof URL.createObjectURL !== 'function') {
      probeSettled = true; // no worker path to protect (Node, a worker-less host)
      return undefined;
    }
    probe = workerCanPostErrors().then((ok) => {
      probeSettled = true;
      if (!ok) { workerErrorsLost = true; disablePixiTextureWorker(); }
    });
  }
  return probe;
}

/** Never rejects: every failure to get a clean "yes" answer resolves `false`. */
function workerCanPostErrors(): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (ok: boolean, why: string) => {
      if (done) return; // a late message after the timeout, or onerror after onmessage
      done = true;
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      if (!ok) console.info(`[pixiTextureLoad] a worker cannot post an Error here (${why}) — Pixi texture workers disabled (#1404)`);
      resolve(ok);
    };
    try {
      url = URL.createObjectURL(new Blob([WORKER_ERROR_PROBE_SRC], { type: 'application/javascript' }));
      timer = setTimeout(() => finish(false, 'no answer'), WORKER_PROBE_TIMEOUT_MS);
      worker = new Worker(url);
      worker.onmessage = (e: MessageEvent) => {
        // Only a cloned Error carries `error`; the probe's catch branch posts just the failure name.
        const d = e.data as { error?: unknown; cloneFailed?: string } | undefined;
        finish(d?.error !== undefined, d?.cloneFailed ?? 'no error in the message');
      };
      worker.onerror = () => finish(false, 'worker error');
    } catch (e) {
      finish(false, String(e)); // CSP-blocked blob worker, etc.
    }
  });
}
