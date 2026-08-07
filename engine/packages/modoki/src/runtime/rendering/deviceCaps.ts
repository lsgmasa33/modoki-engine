/** Device capability probe (#121 P0) — the foundation the quality tiers branch on.
 *
 *  Answers "what hardware is this, and what can it do?" once, cached, for the tier resolver,
 *  `diagnose`, and the debug menu. Reports facts ONLY; it picks no tier and changes no
 *  behaviour.
 *
 *  ── WHAT IS DELIBERATELY *NOT* A TIER INPUT ───────────────────────────────────────────────
 *  Two signals that look authoritative and are not. Both are reported here (they are useful
 *  when reading a bug report) and both are marked non-discriminative so a future tier resolver
 *  cannot reach for them by accident:
 *
 *  - `webgpu`. Anti-correlated with GPU capability across our own targets. Safari shipped
 *    WebGPU in iOS 26, which needs an A13/iPhone 11+ — so an **iPhone 8 has no adapter**.
 *    Chrome shipped it on Android in 121 for Adreno/Mali on Android 12+ — so a **Galaxy A23 5G
 *    does**. `adapter ? high : low` therefore hands the WEAKER device the better tier. It
 *    tracks OS recency, not silicon.
 *  - `deviceMemory` / `hardwareConcurrency`. `deviceMemory` is Chromium-only and `undefined`
 *    on ALL of iOS, so any threshold on it silently never fires for half the fleet.
 *    `hardwareConcurrency` exists everywhere and does not discriminate — the iPhone 8 reports
 *    6 and the A23 reports 8, i.e. the weaker device reports more.
 *
 *  The identity fields below are the usable ones, and the two platforms hide opposite things —
 *  on each, the readable identifier happens to be the correct one to key on:
 *
 *  - **iOS → `deviceModel`** (`iPhone10,1`). The GPU string is masked to `Apple GPU`, so the
 *    hardware model is the only handle; it works because Apple's SKU list is short and cleanly
 *    ordered by capability.
 *  - **Android → `gpuRenderer`** (`Adreno (TM) 610`). NOT the model and NOT the SoC: one model
 *    name can ship two GPUs (Galaxy A23 4G is Adreno 610, A23 5G is Adreno 619 — ~30% apart),
 *    and `Build.SOC_MODEL` needs a native plugin while telling you strictly less than the GPU
 *    string already did.
 *
 *  Neither is available in a **web build on iOS** — Apple puts no model in the UA and masks the
 *  renderer. That is not a gap to work around (the documented workarounds are aspect-ratio and
 *  render-hash fingerprinting at <97% accuracy); it is why measurement, not identity, is the
 *  ground truth for tiering. Identity is only ever a shortcut.
 *
 *  ── VALIDATION ───────────────────────────────────────────────────────────────────────────
 *  Verify this in a PRODUCTION build on real hardware, not a dev server. Three recent
 *  old-device bugs (the Vite build target, the baked-font source, MTSDF's
 *  `OES_standard_derivatives`) were all the same shape: resolves fine in dev, absent in
 *  production, fails silently. A probe validated only in dev would have missed every one. */

import { getWebGPUSupported } from './gpuDetect';
import { getActiveRenderer } from '../core/activeRenderer';

export interface CompressedTextureSupport {
  /** ASTC — the mobile target format for KTX2. */
  astc: boolean;
  /** ETC2 — the GLES3 baseline, present on essentially all Android. */
  etc2: boolean;
  /** S3TC/DXT — desktop. */
  s3tc: boolean;
}

export interface DeviceCaps {
  /** `'ios'` / `'android'` / `'web'` — from the Capacitor global, `'web'` when absent. */
  platform: string;
  /** A WebGPU adapter AND device resolved. **Not a tier input** — see the module header. */
  webgpu: boolean;
  /** What the LIVE renderer is actually using, or null before one registers. A `webgpu: true`
   *  device can still be on `'WebGL'` if the project forced the backend. */
  backend: 'WebGPU' | 'WebGL' | null;
  /** iOS/Android hardware identifier (`iPhone10,1`). Native builds only — `undefined` on web,
   *  where no reliable equivalent exists on iOS at all. */
  deviceModel?: string;
  /** Unmasked GPU renderer (`Adreno (TM) 610`). Absent on iOS (masked to `Apple GPU`) and
   *  wherever the extension is blocked for fingerprinting reasons. */
  gpuRenderer?: string;
  /** GL `MAX_TEXTURE_SIZE`, the hard ceiling on any texture the device can hold. */
  maxTextureSize?: number;
  compressed: CompressedTextureSupport;
  /** **Reporting only, never a tier input** — `undefined` on all of iOS. */
  deviceMemory?: number;
  /** **Reporting only, never a tier input** — does not discriminate. */
  hardwareConcurrency?: number;
}

let cached: DeviceCaps | null = null;
let pending: Promise<DeviceCaps> | null = null;

/** Read the Capacitor global rather than importing `@capacitor/core`.
 *
 *  Deliberate, and it matches the debug menu's `DeviceTab`: this module ships inside every
 *  game, and the published demos are **web-only**. A hard import would make a native plugin a
 *  build-time requirement for a web page that can never use it. Reading the global degrades to
 *  `'web'` with nothing installed. */
function readPlatform(): string {
  const cap = (globalThis as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  try { return cap?.getPlatform?.() ?? 'web'; } catch { return 'web'; }
}

/** Hardware model via the **debug-bridge** plugin global. Resolves `undefined` when it is absent
 *  (web) — never throws, never rejects.
 *
 *  **It read `@capacitor/device` until #146's close-out swept for that pattern, and that made the
 *  iOS half of the tier allowlist DEAD IN PRODUCTION.** No Modoki project installs that plugin
 *  (checked across all 22 games + demos: not a dependency, no `CapacitorDevice` in any iOS
 *  `Package.swift`), so this resolved `undefined` on every real device — and per the module header
 *  above, `deviceModel` is the ONLY usable discriminator on iOS, because the GPU string is masked
 *  to `Apple GPU`. So `qualityTier`'s `TIER_ALLOWLIST.iosModels` branch could never fire on any
 *  phone. It failed the safe way (fall through to the fallback tiering) which is exactly why it
 *  went unnoticed.
 *
 *  `GameDebug` is the right source for the same reason it was for the lease (#146): it is present
 *  in every build that can be debugged, whereas `@capacitor/device` is optional and universally
 *  absent. Read off the GLOBAL rather than imported — this module ships inside every game,
 *  including the web-only published demos, where a hard import would make a native plugin a
 *  build-time requirement. Same pattern as `DeviceTab.tsx`.
 *
 *  ⚠️ A build older than #146 has no `getDeviceHardware`, so Capacitor rejects and this stays
 *  `undefined` — i.e. the allowlist keeps not firing until the game is redeployed. That is the
 *  pre-existing behaviour, not a regression. */
async function readDeviceModel(): Promise<string | undefined> {
  const dbg = (globalThis as unknown as {
    Capacitor?: { Plugins?: { GameDebug?: { getDeviceHardware?: () => Promise<{ model?: string }> } } };
  }).Capacitor?.Plugins?.GameDebug;
  if (!dbg?.getDeviceHardware) return undefined;
  try { return (await dbg.getDeviceHardware())?.model || undefined; } catch { return undefined; }
}

/** GL-side facts: renderer string, max texture size, compressed-format support.
 *
 *  Uses a THROWAWAY 1x1 WebGL2 context rather than the live renderer's, because the live one
 *  may be a WebGPU backend with no GL context at all — and these facts are wanted before/
 *  independently of any viewport mounting. The context is explicitly released via
 *  `WEBGL_lose_context`: a leaked GL context is a real cost on exactly the low-memory devices
 *  this probe exists to characterise, and browsers cap how many may exist at once. */
function readGlFacts(): Pick<DeviceCaps, 'gpuRenderer' | 'maxTextureSize' | 'compressed'> {
  const none: CompressedTextureSupport = { astc: false, etc2: false, s3tc: false };
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    gl = canvas.getContext('webgl2');
    if (!gl) return { compressed: none };

    // Masked on iOS ('Apple GPU') and blockable elsewhere for fingerprinting — absent, not fatal.
    let gpuRenderer: string | undefined;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const s = gl.getParameter((dbg as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL);
      if (typeof s === 'string' && s) gpuRenderer = s;
    }

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | undefined;
    const has = (name: string) => gl!.getExtension(name) != null;
    return {
      gpuRenderer,
      maxTextureSize: typeof maxTextureSize === 'number' ? maxTextureSize : undefined,
      compressed: {
        astc: has('WEBGL_compressed_texture_astc'),
        etc2: has('WEBGL_compressed_texture_etc'),
        s3tc: has('WEBGL_compressed_texture_s3tc'),
      },
    };
  } catch {
    return { compressed: none };
  } finally {
    // Best-effort release; a browser with no such extension reclaims it on GC anyway.
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* not worth reporting */ }
  }
}

/** Which backend the LIVE renderer settled on — null until a viewport registers one. Distinct
 *  from `webgpu` (what the device COULD do): a project may force WebGL via render settings. */
function readBackend(): 'WebGPU' | 'WebGL' | null {
  const r = getActiveRenderer() as unknown as { isWebGPURenderer?: boolean } | null;
  if (!r) return null;
  return r.isWebGPURenderer ? 'WebGPU' : 'WebGL';
}

/** Probe the device once and cache it. Safe to call from anywhere, any number of times;
 *  concurrent callers share the single in-flight probe.
 *
 *  NOTE `backend` is captured at probe time. Call before a renderer exists and it caches
 *  `null` — use `refreshDeviceCaps()` after renderer bring-up if the live backend matters. */
export function getDeviceCaps(): Promise<DeviceCaps> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = (async (): Promise<DeviceCaps> => {
      const nav = globalThis.navigator as unknown as {
        deviceMemory?: number; hardwareConcurrency?: number;
      } | undefined;
      const [webgpu, deviceModel] = await Promise.all([
        getWebGPUSupported().catch(() => false),
        readDeviceModel(),
      ]);
      cached = {
        platform: readPlatform(),
        webgpu,
        backend: readBackend(),
        deviceModel,
        ...readGlFacts(),
        deviceMemory: nav?.deviceMemory,
        hardwareConcurrency: nav?.hardwareConcurrency,
      };
      return cached;
    })();
  }
  return pending;
}

/** The cached probe, or null if it has not completed. For synchronous readers (a diagnose
 *  payload) that must not block on a probe. */
export function getDeviceCapsSync(): DeviceCaps | null {
  return cached;
}

/** Drop the cache so the next `getDeviceCaps()` re-probes. For tests, and for re-reading
 *  `backend` once a renderer has actually registered. */
export function resetDeviceCaps(): void {
  cached = null;
  pending = null;
}
