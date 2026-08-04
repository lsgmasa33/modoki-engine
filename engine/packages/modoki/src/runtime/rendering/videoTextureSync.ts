/** videoTextureSync — binds a `VideoPlayer` entity's live `HTMLVideoElement` onto its
 *  3D material as a `THREE.VideoTexture`.
 *
 *  Kept OUT of scene3DSync's main loop on purpose: this is an independent, additive
 *  concern (a screen in the world is a normal mesh whose `map` happens to be moving),
 *  and scene3DSync is already 3000 lines. It runs alongside `syncRenderables`, over
 *  the objects that call has already created.
 *
 *  ## Why per-RenderState, not per-entity
 *
 *  The editor runs TWO 3D viewports on ONE world (SceneView + GameView), each with its
 *  own `RenderState` and its own renderer. A `THREE.Texture` belongs to a renderer's
 *  GPU resources, so each surface needs its OWN VideoTexture — but both wrap the SAME
 *  `HTMLVideoElement`, which is correct and cheap: one decoder, two uploads. Sharing a
 *  single texture across both would upload to one renderer's context and show black in
 *  the other.
 *
 *  ## Upload cadence
 *
 *  `THREE.VideoTexture` marks itself dirty every frame. For a 24 fps clip on a 60 Hz
 *  display that is 60 GPU uploads for 24 distinct frames — 2.5× the bandwidth for zero
 *  extra information. Where `requestVideoFrameCallback` exists we drive `needsUpdate`
 *  from it instead, so an upload happens once per PRESENTED frame. Browsers without it
 *  fall back to three's own per-frame behaviour. */

import * as THREE from 'three/webgpu';
import type { World } from 'koota';
import { VideoPlayer } from '../traits/VideoPlayer';
import { videoElementFor } from '../video/videoSystem';

/** What we hold per (surface, entity). */
interface Bound {
  texture: THREE.VideoTexture;
  element: HTMLVideoElement;
  /** Material we wrote `map` onto, so we can restore/clear on teardown. */
  material: THREE.Material & { map?: THREE.Texture | null };
  /** Previous map, restored when the video goes away (a screen with a static
   *  fallback texture shouldn't be left blank when its clip stops). */
  previousMap: THREE.Texture | null;
  /** rVFC handle, so it can be cancelled. 0 = not using rVFC. */
  rvfcHandle: number;
  cancelled: boolean;
}

/** Per-RenderState binding table. Keyed by the state object itself so two viewports
 *  never share textures — see the file header. */
const bindings = new WeakMap<object, Map<number, Bound>>();

type MapMaterial = THREE.Material & { map?: THREE.Texture | null };

/** First material of an object that can carry a `map`. A multi-material mesh takes
 *  slot 0 — picking a slot is authoring, not engine policy, and slot 0 is the one a
 *  single-material screen has. */
function materialWithMap(obj: THREE.Object3D): MapMaterial | null {
  const mesh = obj as THREE.Mesh;
  const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!m) return null;
  const first = Array.isArray(m) ? m[0] : m;
  if (!first) return null;
  return 'map' in first ? (first as MapMaterial) : null;
}

function makeTexture(el: HTMLVideoElement): THREE.VideoTexture {
  const tex = new THREE.VideoTexture(el);
  // Video frames are sRGB-encoded. Without this the picture renders washed out /
  // over-bright under a linear workflow — subtly wrong rather than obviously broken,
  // which is why it's easy to miss.
  tex.colorSpace = THREE.SRGBColorSpace;
  // No mipmaps for a stream: they'd be regenerated every frame for no benefit.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Drive `needsUpdate` from presented frames rather than render frames. */
function driveUploads(b: Bound): void {
  const el = b.element as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (h: number) => void;
  };
  if (typeof el.requestVideoFrameCallback !== 'function') return; // three's per-frame default
  const step = () => {
    if (b.cancelled) return;
    b.texture.needsUpdate = true;
    b.rvfcHandle = el.requestVideoFrameCallback!(step);
  };
  b.rvfcHandle = el.requestVideoFrameCallback(step);
}

function release(b: Bound): void {
  b.cancelled = true;
  if (b.rvfcHandle) {
    const el = b.element as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    try { el.cancelVideoFrameCallback?.(b.rvfcHandle); } catch { /* noop */ }
  }
  // Restore whatever the material had before we took its `map`.
  if (b.material.map === b.texture) {
    b.material.map = b.previousMap;
    b.material.needsUpdate = true;
  }
  b.texture.dispose();
}

/** Bind/unbind video textures for one render surface. Call once per frame, AFTER
 *  `syncRenderables` (it reads the objects that call creates). */
export function syncVideoTextures(
  world: World, state: { ecsObjects: Map<number, THREE.Object3D> },
): void {
  let table = bindings.get(state);
  if (!table) { table = new Map(); bindings.set(state, table); }

  const seen = new Set<number>();

  // The trait's FIELDS are irrelevant here — playback state lives in videoSystem, and
  // this only needs to know which entities have a live element. So query, don't destructure.
  for (const entity of world.query(VideoPlayer)) {
    const id = entity.id();
    const obj = state.ecsObjects.get(id);
    if (!obj) continue;                     // no 3D body (a 2D or UI consumer)
    const el = videoElementFor(id);
    if (!el) continue;                      // no live clip right now
    seen.add(id);

    const existing = table.get(id);
    // The element identity changes when the clip is swapped — rebind rather than
    // keep uploading frames from a decoder that is no longer running.
    if (existing && existing.element === el) continue;
    if (existing) { release(existing); table.delete(id); }

    const material = materialWithMap(obj);
    if (!material) continue;                // nothing to put a texture on

    const texture = makeTexture(el);
    const bound: Bound = {
      texture, element: el, material,
      previousMap: material.map ?? null,
      rvfcHandle: 0, cancelled: false,
    };
    material.map = texture;
    material.needsUpdate = true;
    driveUploads(bound);
    table.set(id, bound);
  }

  // Entities whose clip stopped, lost the trait, or were despawned.
  for (const [id, b] of [...table]) {
    if (!seen.has(id)) { release(b); table.delete(id); }
  }
}

/** Drop every binding for a surface (viewport unmount / scene teardown). */
export function disposeVideoTextures(state: object): void {
  const table = bindings.get(state);
  if (!table) return;
  for (const b of table.values()) release(b);
  table.clear();
  bindings.delete(state);
}

/** Test/inspection hook — how many bindings a surface holds. */
export function videoTextureCount(state: object): number {
  return bindings.get(state)?.size ?? 0;
}
