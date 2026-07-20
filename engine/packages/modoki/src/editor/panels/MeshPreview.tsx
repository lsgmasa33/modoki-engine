/** MeshPreview — a 3D preview of a `.mesh.json`'s geometry, on a neutral material.
 *  Loads the shared mesh template (the same geometry the runtime uses), CLONES it
 *  (the cache owns the original — never dispose it), and renders it in the shared
 *  Preview3DShell. See docs/asset-inspector-plan.md Phase 2. */

import { useCallback } from 'react';
import * as THREE from 'three';
import { whenMeshTemplate } from '../../runtime/loaders/meshTemplateCache';
import { Preview3DShell } from './Preview3DShell';
import type { PreviewSceneHandle } from './previewScene';

export function MeshPreview({ path }: { path: string }) {
  const populate = useCallback(async (h: PreviewSceneHandle, signal: AbortSignal) => {
    const template = await whenMeshTemplate(path);
    if (signal.aborted) return;
    if (!template) throw new Error('Failed to load geometry.');
    // Clone — the template's geometry is cache-owned and shared with the live scene.
    const geometry = template.geometry.clone();
    const material = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.6, metalness: 0.0 });
    h.contentRoot.add(new THREE.Mesh(geometry, material));
  }, [path]);

  return <Preview3DShell populate={populate} resetKey={path} />;
}
