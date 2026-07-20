import * as THREE from 'three';

/** Mark a DynamicDrawUsage attribute for a PARTIAL GPU re-upload of just the dense
 *  live prefix — rows `[0, rows)`, i.e. floats `[0, rows * itemSize)` — instead of the
 *  whole `maxParticles`-sized buffer (particles F8). The CPU sim keeps alive particles
 *  packed at the front (swap-remove), so the live data is always a contiguous prefix,
 *  making the partial range exactly expressible.
 *
 *  For a 1000-cap effect with 20 live particles this uploads 20 rows, not 1000. r183+
 *  `addUpdateRange`/`clearUpdateRanges` carry the range to both the WebGL and WebGPU
 *  backends; a backend that ignores ranges still uploads correctly (just not partially),
 *  so this is a pure bandwidth optimization with no correctness dependency.
 *
 *  `rows` is the number of attribute elements touched (e.g. `aliveCount` for per-instance
 *  attributes, `aliveCount * verticesPerParticle` for a per-vertex trail buffer). */
export function uploadDenseRows(attr: THREE.BufferAttribute, rows: number): void {
  attr.clearUpdateRanges();
  if (rows > 0) attr.addUpdateRange(0, rows * attr.itemSize);
  attr.needsUpdate = true;
}
