/** Shared WebGPU availability check — cached, used by both the 3D and 2D renderers.
 *
 *  Probes natively via `navigator.gpu` (requestAdapter + requestDevice, mirroring
 *  what PixiJS's `isWebGPUSupported` did) so this SHARED module carries no
 *  renderer-SDK dependency. Previously it imported `isWebGPUSupported` from
 *  'pixi.js', which pulled PixiJS into the 3D renderer's backend-detection path and
 *  blocked a Pixi-free (3D-only) build from stripping pixi.js. */

// Set to true to force WebGL everywhere (for testing frame pacing).
const FORCE_WEBGL = false;

let result: boolean | null = null;
let pending: Promise<boolean> | null = null;

/** Native WebGPU probe: an adapter must exist AND yield a device (some adapters
 *  advertise but fail device creation — the same two-step check PixiJS made). */
async function probeWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as {
    gpu?: { requestAdapter(): Promise<{ requestDevice(): Promise<unknown> } | null> };
  }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    await adapter.requestDevice();
    return true;
  } catch {
    return false;
  }
}

/** Returns the cached WebGPU support result. Probes once. */
export function getWebGPUSupported(): Promise<boolean> {
  if (FORCE_WEBGL) return Promise.resolve(false);
  if (result !== null) return Promise.resolve(result);
  if (!pending) {
    pending = probeWebGPU().then((ok) => { result = ok; return ok; });
  }
  return pending;
}

/** Synchronous check — returns null if not probed yet. */
export function getWebGPUSupportedSync(): boolean | null {
  return result;
}
