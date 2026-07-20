/** 2D physics collision LAYERS — the designer-friendly layer on top of Rapier's raw
 *  16-bit membership/filter bitmasks (Unity-style named layers + a collision matrix).
 *
 *  A project declares up to 16 layer NAMES (index = bit position, index 0 = 'Default')
 *  and a symmetric collision MATRIX ("does layer i collide with layer j"). A collider
 *  authors a single `physicsLayer` name; at collider-creation time the physics system
 *  resolves it to Rapier bits: membership = `1 << layerIndex`, filter = the matrix row
 *  for that layer. The raw `collisionGroups`/`collisionMask` fields remain the escape
 *  hatch — used verbatim when `physicsLayer` is empty or unknown.
 *
 *  This registry is process-global (like the trait registry), pushed once at boot from
 *  the project config (`setPhysicsLayers`). Defaults to a single 'Default' layer that
 *  collides with everything, so a scene with no layer config behaves exactly as before
 *  (collide-with-all). Headless tests get that same default with zero setup. */

const DEFAULT_LAYER = 'Default';
const ALL = 0xffff;

let layers: string[] = [DEFAULT_LAYER];
/** matrix[i] = 16-bit mask of the layer indices layer i collides with. Kept symmetric
 *  (the editor toggles both (i,j) and (j,i)) so Rapier's bidirectional group check
 *  reduces to a single "is bit j set in matrix[i]". */
let matrix: number[] = [ALL];

export interface PhysicsLayersConfig {
  layers: string[];
  /** Per-layer collision bitmask (matrix[i]). If omitted, every layer collides with
   *  every layer. Truncated/padded to `layers.length`. */
  collisionMatrix?: number[];
}

/** Symmetrize a matrix: if layer i collides with j, ensure j collides with i. Rapier's
 *  group test is bidirectional (A hits B iff each is in the other's filter), so an
 *  asymmetric row would silently mean "no collision" for that pair. We OR the two
 *  directions so a single authored direction is honored (the editor already keeps it
 *  symmetric; this hardens hand-edited configs). */
function symmetrize(m: number[]): number[] {
  const out = m.slice();
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (((out[i] >>> j) & 1) || ((out[j] >>> i) & 1)) { out[i] |= (1 << j); out[j] |= (1 << i); }
    }
    out[i] = (out[i] & ALL) >>> 0;
  }
  return out;
}

/** Install the project's layers + matrix. Names beyond 16 are dropped (16-bit limit).
 *  Empty/omitted (or all-blank) → reset to the collide-with-all 'Default'.
 *
 *  NOTE: entries are kept BY INDEX (a blank name is preserved as an unselectable slot,
 *  not filtered out) so a layer's index — and therefore its matrix bit-column — stays
 *  stable. Filtering blanks out of the middle would shift every later layer's bit and
 *  silently corrupt the matrix. */
export function setPhysicsLayers(config?: PhysicsLayersConfig | null): void {
  const names = (config?.layers ?? []).slice(0, 16).map((n) => (typeof n === 'string' ? n : ''));
  if (names.length === 0 || names.every((n) => n.length === 0)) { layers = [DEFAULT_LAYER]; matrix = [ALL]; return; }
  layers = names;
  const m = config?.collisionMatrix ?? [];
  matrix = symmetrize(names.map((_, i) => (typeof m[i] === 'number' ? (m[i] & ALL) >>> 0 : ALL)));
}

/** Reset to the default single collide-with-all layer (tests + game teardown). */
export function resetPhysicsLayers(): void { layers = [DEFAULT_LAYER]; matrix = [ALL]; }

/** The current layer names (for the Inspector dropdown + matrix editor). */
export function getPhysicsLayerNames(): string[] { return layers.slice(); }

/** The current collision matrix rows (copy). */
export function getPhysicsLayerMatrix(): number[] { return matrix.slice(); }

/** Does layer i collide with layer j (by index)? */
export function layersCollide(i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < matrix.length && ((matrix[i] & (1 << j)) !== 0);
}

/** Resolve a collider's authored `physicsLayer` (+ raw fields as fallback) to the
 *  Rapier {groups, mask} pair. A known layer name drives membership+filter from the
 *  matrix; an empty or unknown name falls back to the raw bitmasks (advanced/custom). */
export function resolveColliderBits(
  physicsLayer: string, rawGroups: number, rawMask: number,
): { groups: number; mask: number } {
  const idx = physicsLayer ? layers.indexOf(physicsLayer) : -1;
  if (idx < 0) return { groups: rawGroups & ALL, mask: rawMask & ALL };
  return { groups: (1 << idx) & ALL, mask: (matrix[idx] ?? ALL) & ALL };
}

/** Pack collisionGroups/collisionMask (16-bit each) into Rapier's u32 interaction-groups
 *  format: high 16 bits = membership, low 16 bits = filter. Dimension-agnostic — Rapier's
 *  format is identical for 2D and 3D — so it lives here, the shared physics-layer module. */
export function packCollisionGroups(groups: number, mask: number): number {
  return (((groups & 0xffff) << 16) | (mask & 0xffff)) >>> 0;
}
