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
 *  fall back to three's own per-frame behaviour.
 *
 *  ## Why a CLONE of the material, never the material itself
 *
 *  Binding writes the video onto a private CLONE and swaps that onto the mesh; the shared
 *  material it was cloned from is never mutated, and the clone is swapped out whole and
 *  disposed rather than having its `map` cleared. Two reasons, and the second is a crash
 *  that permanently kills the renderer (#192) — full mechanism, with three's asymmetric
 *  `NodeMaterialObserver` quoted, in **docs/video.md § Gotchas**:
 *
 *    1. engine materials are shared + refcounted by GUID, so mutating one leaks the video
 *       onto every other mesh using it;
 *    2. handing three a material whose monitored texture slot went back to `null` makes
 *       `NodeMaterialObserver.equals` dereference null on every later frame.
 *
 *  The rule this file must never break: **no material is ever handed back to the renderer
 *  with a map REMOVED.**
 *
 *  ## What a texture's lifetime is tied to
 *
 *  The `VideoTexture` follows the **element**, never the material. A material swapping identity
 *  under a live binding — a light-mask variant, a re-resolved `.mat.json` — re-derives the clone
 *  and carries the SAME texture across (`rebindMaterial`). Tying the two together cost a GPU
 *  texture create+destroy per frame whenever the material identity oscillated (#352).
 *
 *  Two same-element paths still dispose, both deliberately: a slot SHAPE change, and a
 *  replacement material with no `map` slot (a file-shader `NodeMaterial`) — the second is a
 *  refusal to bind rather than a rebuild, so there is nothing to carry the texture onto. */

import * as THREE from 'three/webgpu';
import type { World } from 'koota';
import { VideoPlayer } from '../traits/VideoPlayer';
import { videoElementFor } from '../video/videoSystem';
import { cloneDerived } from './derivedMaterials';
import { inheritMaskBase } from './lightMaskVariants';

/** What we hold per (surface, entity). */
interface Bound {
  texture: THREE.VideoTexture;
  element: HTMLVideoElement;
  /** The mesh whose material slot we swapped, and which slot. */
  mesh: THREE.Mesh;
  /** -1 = single material; otherwise the index into a material ARRAY. */
  slot: number;
  /** The material that was on the slot before us. Restored verbatim on teardown, and
   *  NEVER mutated — see the header's "why a clone". */
  original: MapMaterial;
  /** Our private copy of `original`, carrying the video `map`. Ours alone, so disposing
   *  it on teardown is safe and cannot affect any other mesh. */
  clone: MapMaterial;
  /** rVFC handle, so it can be cancelled. 0 = not using rVFC. */
  rvfcHandle: number;
  cancelled: boolean;
}

/** Per-RenderState binding table. Keyed by the state object itself so two viewports
 *  never share textures — see the file header. */
const bindings = new WeakMap<object, Map<number, Bound>>();

type MapMaterial = THREE.Material & { map?: THREE.Texture | null };

/** The mesh + material slot a video should bind to. A multi-material mesh takes slot 0 —
 *  picking a slot is authoring, not engine policy, and slot 0 is the one a single-material
 *  screen has. `slot` is -1 for the single-material case so restoring is exact. */
function videoTargetOf(obj: THREE.Object3D): { mesh: THREE.Mesh; slot: number; material: MapMaterial } | null {
  const mesh = obj as THREE.Mesh;
  const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!m) return null;
  const first = Array.isArray(m) ? m[0] : m;
  if (!first) return null;
  if (!('map' in first)) return null;
  return { mesh, slot: Array.isArray(m) ? 0 : -1, material: first as MapMaterial };
}

/** Read the material currently on a bound slot (null if the mesh was restructured). */
function materialAt(mesh: THREE.Mesh, slot: number): THREE.Material | null {
  const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!m) return null;
  return slot < 0 ? (Array.isArray(m) ? null : m) : (Array.isArray(m) ? m[slot] ?? null : null);
}

/** Put `mat` on a bound slot, preserving the single-vs-array shape. */
function setMaterialAt(mesh: THREE.Mesh, slot: number, mat: THREE.Material): void {
  if (slot < 0) mesh.material = mat;
  else if (Array.isArray(mesh.material)) mesh.material[slot] = mat;
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
  // Hand the slot back the ORIGINAL material object. Note what we deliberately do NOT do:
  // clear `map` on anything three has been observing. See the header.
  if (materialAt(b.mesh, b.slot) === b.clone) setMaterialAt(b.mesh, b.slot, b.original);
  b.clone.dispose();
  b.texture.dispose();
}

/** The material under a LIVE binding changed identity — a light-mask variant swapped, or a
 *  different `.mat.json` resolved — while the video ELEMENT stayed the same. Re-derive the clone
 *  from whatever is on the slot now and move the EXISTING `VideoTexture` onto it (#352).
 *
 *  Why this is not `release()` + rebuild, which is what it used to be: a texture's lifetime
 *  belongs to the element, not to the material. The old path disposed the `VideoTexture` from
 *  inside a branch that had already established `existing.element === el` — it threw away a
 *  texture it had just proved was still valid. Invisible for a one-shot change, ruinous for a
 *  repeating one: `maskForObject` picks the nearest lights with no hysteresis
 *  (`autoLightCap.ts`), so an object crossing an equidistance boundary alternates between two
 *  CACHED variants indefinitely, and an identity test against one remembered material cannot
 *  tell "one I have already seen" from "a brand new one". Measured at 10 texture create+destroy
 *  pairs over 10 alternating frames, on the mid/low tier where the automatic cap engages.
 *
 *  The material clone is deliberately NOT reused. The material genuinely changed, so cloning the
 *  new one is the correct answer and costs a JS object; copying individual lighting properties
 *  onto the old clone instead would be a hand-maintained list of "fields we carry" that goes
 *  stale the first time a variant grows another one. */
function rebindMaterial(b: Bound, next: MapMaterial): void {
  // Nothing to hand back — our clone is NOT in the slot, `next` is, which is how we got here. So
  // the header's rule is untouched: no material is handed to the renderer map-free, and
  // `b.original` was never mutated. The superseded clone is simply dropped.
  //
  // Disposing a material does not dispose its textures in three, so `b.texture` survives this
  // even though the clone still references it.
  b.clone.dispose();
  const clone = cloneDerived(next, next) as MapMaterial;
  inheritMaskBase(clone, next);
  clone.map = b.texture;      // the whole point: the same texture, not a fresh one
  clone.needsUpdate = true;
  b.original = next;
  b.clone = clone;
  setMaterialAt(b.mesh, b.slot, clone);
  // `texture`, `element` and the rVFC pump are left alone. The pump closes over `b`, and `b` is
  // mutated IN PLACE rather than replaced, so uploads carry on uninterrupted across the swap.
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
    if (existing && existing.element === el) {
      // RE-ASSERT the clone. `syncMaterial` re-binds an entity's resolved `.mat.json`
      // material every frame once the async load settles, which would drop our clone and
      // take the picture with it. This module runs LAST in the frame (see scene3DSync's
      // call site), so simply putting it back here is enough — and it is the same
      // arrangement Tint and MaterialInstance already rely on for THEIR per-entity clones.
      const current = materialAt(existing.mesh, existing.slot);
      if (current !== existing.clone) {
        if (current === null) {
          // The SHAPE changed under us — the slot we recorded no longer exists (single ⇄
          // array). Re-asserting into that would be worse than doing nothing: with a
          // single-material binding it would overwrite a freshly-assigned material ARRAY with
          // our one stale clone, and with an array binding it would silently no-op and leave a
          // binding nothing can ever restore. Drop it and re-derive the target from what the
          // mesh actually looks like now.
          //
          // One of TWO same-element paths that still dispose the texture (the other is the
          // map-less replacement below). Both are scoping calls rather than oversights:
          // carrying the texture would mean re-plumbing the rVFC pump, which closes over the
          // `Bound` record the rebuild below replaces. A mesh does not oscillate between single
          // and array, so this costs one texture, once — and the churn #352 is about needs a
          // REPEATING trigger.
          release(existing);
          table.delete(id);
        } else if (current !== existing.original && 'map' in current) {
          // The material REF changed — a light-mask variant swapped, or a different `.mat.json`
          // resolved. The clone is stale; the TEXTURE is not, because the element is unchanged
          // (we are inside that very check). Re-derive one, carry the other (#352).
          //
          // `'map' in current` is not decoration: this path SKIPS `videoTargetOf`, which is where
          // that guard otherwise lives (a material with no map slot is not a video target, and
          // forcing `.map` onto one would invent a property three never monitors). Without the
          // check, the shortcut would accept a material the full path declines.
          rebindMaterial(existing, current as MapMaterial);
          continue;
        } else if (current !== existing.original) {
          // Map-less replacement — fall through to the full teardown + re-derive, which declines
          // to bind at `videoTargetOf` exactly as it would have before this shortcut existed.
          //
          // Reachable, not theoretical: `loaders/fileShaderBuilder.ts` builds a bare
          // `new NodeMaterial()` for a file-shader `.mat.json`, and TSL textures ride nodes
          // rather than PBR slots — so it has no `map`. A video screen whose material ref
          // resolves to one lands here, and disposing is right: there is no slot to carry the
          // texture ONTO, so this is a refusal to bind, not a rebuild.
          release(existing);
          table.delete(id);
        } else {
          setMaterialAt(existing.mesh, existing.slot, existing.clone);
          continue;
        }
      } else {
        continue;
      }
    } else if (existing) {
      release(existing);
      table.delete(id);
    }

    const target = videoTargetOf(obj);
    if (!target) continue;                  // nothing to put a texture on

    const texture = makeTexture(el);
    // A private clone, never the shared material we found — see the header and
    // docs/video.md § Gotchas (#192).
    //
    // `cloneDerived` rather than a bare `.clone()`, and both halves of it matter here (#325).
    //
    // The STAMP keeps the base alive while this clone is bound (#318). Only `.map` is replaced
    // below; every other slot the base carries (normal/roughness/emissive…) is still a SHARED
    // reference, so a `.mat.json` re-import that retires the base would otherwise let the sweep
    // free it — releasing textures this clone is drawing with.
    //
    // The rest of `cloneDerived` is what makes a LIGHT-MASKED video screen correct. The material
    // we find on the mesh is whatever `applyLightMask` settled on, and once masking is active that
    // is a VARIANT — so a bare `.clone()` both JSON-round-tripped the base Material parked in its
    // `userData` and dropped the `lightsNode`/`customProgramCacheKey` that make the variant
    // distinct, leaving the screen lit by every light and colliding with the base's pipeline key.
    // The original comment here asserted a video entity "is neither tinted, instanced nor masked";
    // the first two hold, the third never did.
    const clone = cloneDerived(target.material, target.material) as MapMaterial;
    // Answer `baseOf` with the variant's OWN base, not with this clone — see `inheritMaskBase` for
    // why video inherits where a tint clone self-references, and what mints a material per frame
    // if it does not.
    inheritMaskBase(clone, target.material);
    clone.map = texture;
    clone.needsUpdate = true;
    const bound: Bound = {
      texture, element: el, mesh: target.mesh, slot: target.slot,
      original: target.material, clone,
      rvfcHandle: 0, cancelled: false,
    };
    setMaterialAt(target.mesh, target.slot, clone);
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
