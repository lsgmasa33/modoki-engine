/** MaterialPreview — the material rendered on a sphere in the Material Inspector.
 *  Builds a faithful THREE material from the `.mat.json` data via the engine's own
 *  material builders (buildPreviewMaterial), then loads its texture maps (base color,
 *  normal, roughness, …) and shows it under IBL in the shared Preview3DShell. Rebuilds
 *  on any data edit (keyed on the serialized data), so a color/roughness/texture tweak
 *  reflects live. See docs/asset-inspector-plan.md Phase 2. */

import { useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Preview3DShell } from './Preview3DShell';
import { buildPreviewMaterial, loadPreviewMaps } from './buildPreviewMaterial';
import { releaseTexture3D } from '../../runtime/loaders/textureResolver';
import type { PreviewSceneHandle } from './previewScene';

export function MaterialPreview({ data }: { data: Record<string, unknown> }) {
  // Rebuild when any material field changes (edits mutate `data` in the inspector).
  const resetKey = useMemo(() => {
    try { return JSON.stringify(data); } catch { return String(Object.keys(data).length); }
  }, [data]);

  const populate = useCallback(async (h: PreviewSceneHandle, signal: AbortSignal) => {
    const geometry = new THREE.SphereGeometry(1, 48, 32);
    const material = buildPreviewMaterial(data);
    h.contentRoot.add(new THREE.Mesh(geometry, material));
    h.requestRender(); // show the base surface immediately, before texture maps land
    // Maps come from the shared, refcounted loadTexture3D — release each on teardown.
    // `signal` aborts on both a data-edit rebuild and unmount (Preview3DShell wiring),
    // so releasing here is the single, correct place to drop our texture refs.
    const textures = await loadPreviewMaps(material, data, signal);
    if (signal.aborted) { textures.forEach(releaseTexture3D); return; }
    signal.addEventListener('abort', () => textures.forEach(releaseTexture3D), { once: true });
    h.requestRender(); // maps assigned + material recompiled → redraw
  }, [data]);

  return <Preview3DShell populate={populate} resetKey={resetKey} />;
}
