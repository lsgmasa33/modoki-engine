/** Asset Inspector — Phase 2 Mesh + Material previews.
 *  - Unit: buildPreviewMaterial produces a faithful THREE material from .mat.json data.
 *  - Integration: Preview3DShell drives populate/frame/wireframe/rebuild/dispose and
 *    degrades gracefully when WebGL is unavailable; MaterialPreview builds a sphere.
 *  createPreviewScene is mocked (no WebGL in jsdom). See docs/asset-inspector-plan.md. */

import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import * as THREE from 'three';

vi.mock('../../packages/modoki/src/editor/panels/previewScene', () => ({
  createPreviewScene: vi.fn(),
}));
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  whenMeshTemplate: vi.fn(),
}));
// Texture maps come from the shared refcounted loader; stub it so the preview's
// map wiring is exercised without a real GPU/KTX2 load. Each call returns a fresh
// THREE.Texture so an assigned slot is identity-checkable.
vi.mock('../../packages/modoki/src/runtime/loaders/textureResolver', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadTexture3D: vi.fn(async () => new THREE.Texture()),
  releaseTexture3D: vi.fn(),
}));

import { createPreviewScene, type PreviewSceneHandle } from '../../packages/modoki/src/editor/panels/previewScene';
import { Preview3DShell } from '../../packages/modoki/src/editor/panels/Preview3DShell';
import { MaterialPreview } from '../../packages/modoki/src/editor/panels/MaterialPreview';
import { MeshPreview } from '../../packages/modoki/src/editor/panels/MeshPreview';
import { buildPreviewMaterial, loadPreviewMaps } from '../../packages/modoki/src/editor/panels/buildPreviewMaterial';
import { whenMeshTemplate } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { loadTexture3D } from '../../packages/modoki/src/runtime/loaders/textureResolver';

const GUID_A = '8af1c443-a4f0-4999-8f03-06c1208b4555';
const GUID_B = '587ab689-8a8b-455a-9c97-6cf0bcfdf4b6';

function makeFakeHandle(): PreviewSceneHandle {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    controls: {} as PreviewSceneHandle['controls'],
    contentRoot: new THREE.Group(),
    requestRender: vi.fn(),
    frameContent: vi.fn(),
    setWireframe: vi.fn(),
    clearContent: vi.fn(),
    dispose: vi.fn(),
  };
}

afterEach(() => cleanup());
beforeEach(() => (createPreviewScene as Mock).mockReset());

describe('buildPreviewMaterial', () => {
  it('builds a MeshStandardMaterial from pbr data (color/roughness/metalness/opacity/side)', () => {
    const m = buildPreviewMaterial({ type: 'pbr', color: 0xff8800, roughness: 0.3, metalness: 0.8, transparent: true, opacity: 0.5, side: 'double' }) as THREE.MeshStandardMaterial;
    expect((m as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0xff8800);
    expect(m.roughness).toBe(0.3);
    expect(m.metalness).toBe(0.8);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.5);
    expect(m.side).toBe(THREE.DoubleSide);
  });

  it('applies emissive fields', () => {
    const m = buildPreviewMaterial({ type: 'pbr', emissive: 0x00ff00, emissiveIntensity: 2 }) as THREE.MeshStandardMaterial;
    expect(m.emissive.getHex()).toBe(0x00ff00);
    expect(m.emissiveIntensity).toBe(2);
  });

  it('builds a MeshBasicMaterial for unlit', () => {
    const m = buildPreviewMaterial({ type: 'unlit', color: 0x123456 }) as THREE.MeshBasicMaterial;
    expect((m as THREE.MeshBasicMaterial).isMeshBasicMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0x123456);
  });

  it('approximates a custom shader as PBR (never an async NodeMaterial)', () => {
    const m = buildPreviewMaterial({ type: 'custom', shader: 'some.shader.json', color: 0xabcdef }) as THREE.MeshStandardMaterial;
    expect((m as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0xabcdef);
  });

  it('defaults to white MeshStandardMaterial for empty data', () => {
    const m = buildPreviewMaterial({}) as THREE.MeshStandardMaterial;
    expect((m as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0xffffff);
  });
});

describe('loadPreviewMaps', () => {
  beforeEach(() => (loadTexture3D as Mock).mockClear());

  it('resolves texture GUIDs onto the material map slots and returns them', async () => {
    const m = buildPreviewMaterial({ type: 'pbr', color: 0xffffff }) as THREE.MeshStandardMaterial;
    const loaded = await loadPreviewMaps(m, { texture: GUID_A, roughnessTexture: GUID_B, normalScale: 1.5 });
    expect(loadTexture3D).toHaveBeenCalledTimes(2);
    expect(m.map).toBeInstanceOf(THREE.Texture);
    expect(m.roughnessMap).toBeInstanceOf(THREE.Texture);
    expect(m.map).not.toBe(m.roughnessMap); // distinct slots got distinct textures
    expect(loaded).toHaveLength(2);
    expect(m.version).toBeGreaterThan(0); // needsUpdate is set-only → bumps version
  });

  it('skips PBR-only map slots on an unlit MeshBasicMaterial', async () => {
    const m = buildPreviewMaterial({ type: 'unlit', color: 0xffffff }) as THREE.MeshBasicMaterial;
    const loaded = await loadPreviewMaps(m, { texture: GUID_A, roughnessTexture: GUID_B });
    // MeshBasicMaterial has `map` but no `roughnessMap` — only the base color loads.
    expect(loadTexture3D).toHaveBeenCalledTimes(1);
    expect(m.map).toBeInstanceOf(THREE.Texture);
    expect((m as THREE.MeshBasicMaterial & { roughnessMap?: unknown }).roughnessMap).toBeUndefined();
    expect(loaded).toHaveLength(1);
  });

  it('assigns normalMap and writes normalScale.set(v, v)', async () => {
    const m = buildPreviewMaterial({ type: 'pbr', color: 0xffffff }) as THREE.MeshStandardMaterial;
    const loaded = await loadPreviewMaps(m, { normalTexture: GUID_A, normalScale: 0.7 });
    expect(loadTexture3D).toHaveBeenCalledTimes(1);
    expect(m.normalMap).toBeInstanceOf(THREE.Texture);
    expect(m.normalScale.x).toBe(0.7);
    expect(m.normalScale.y).toBe(0.7);
    expect(loaded).toHaveLength(1);
  });

  it('skips material.needsUpdate when the abort signal already fired', async () => {
    const m = buildPreviewMaterial({ type: 'pbr', color: 0xffffff }) as THREE.MeshStandardMaterial;
    const before = m.version;
    const controller = new AbortController();
    controller.abort();
    const loaded = await loadPreviewMaps(m, { texture: GUID_A }, controller.signal);
    // The texture still loads and is assigned — only the needsUpdate (version bump) is skipped.
    expect(loadTexture3D).toHaveBeenCalledTimes(1);
    expect(m.map).toBeInstanceOf(THREE.Texture);
    expect(loaded).toHaveLength(1);
    expect(m.version).toBe(before); // needsUpdate NOT set → version unchanged
  });

  it('rejects a non-GUID, non-URL ref without firing a load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = buildPreviewMaterial({ type: 'pbr' }) as THREE.MeshStandardMaterial;
    const loaded = await loadPreviewMaps(m, { texture: '1' });
    expect(loadTexture3D).not.toHaveBeenCalled();
    expect(loaded).toHaveLength(0);
    expect(m.map).toBeNull();
    warn.mockRestore();
  });
});

describe('Preview3DShell', () => {
  it('populates, frames, and clears content on mount', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    const populate = vi.fn();
    render(<Preview3DShell populate={populate} resetKey="a" />);
    await waitFor(() => expect(populate).toHaveBeenCalledTimes(1));
    expect(handle.clearContent).toHaveBeenCalled();
    expect(handle.frameContent).toHaveBeenCalled();
  });

  it('toggles wireframe on the scene handle', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    const { getByLabelText } = render(<Preview3DShell populate={vi.fn()} resetKey="a" />);
    await waitFor(() => expect(handle.frameContent).toHaveBeenCalled());
    fireEvent.click(getByLabelText('Wireframe'));
    expect(handle.setWireframe).toHaveBeenLastCalledWith(true);
  });

  it('re-runs populate when resetKey changes and disposes on unmount', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    const populate = vi.fn();
    const { rerender, unmount } = render(<Preview3DShell populate={populate} resetKey="a" />);
    await waitFor(() => expect(populate).toHaveBeenCalledTimes(1));
    rerender(<Preview3DShell populate={populate} resetKey="b" />);
    await waitFor(() => expect(populate).toHaveBeenCalledTimes(2));
    unmount();
    expect(handle.dispose).toHaveBeenCalled();
  });
  // The WebGL-unavailable path (createPreviewScene throws → graceful error message)
  // is covered in its own file — a throwing mock shared with other tests in one file
  // trips a vitest cross-test async-attribution quirk. See Preview3DShell.graceful.test.tsx.
});

describe('MaterialPreview', () => {
  it('adds a sphere with the built material to the scene', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    render(<MaterialPreview data={{ type: 'pbr', color: 0x00aaff }} />);
    await waitFor(() => expect(handle.contentRoot.children.length).toBe(1));
    const mesh = handle.contentRoot.children[0] as THREE.Mesh;
    expect((mesh.geometry as THREE.SphereGeometry).type).toBe('SphereGeometry');
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x00aaff);
  });
});

describe('MeshPreview', () => {
  it('clones the cache geometry (never renders/owns the shared original)', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    // A cache-owned geometry the preview must NOT dispose.
    const shared = new THREE.BoxGeometry(1, 1, 1);
    (whenMeshTemplate as Mock).mockResolvedValue({ geometry: shared });

    render(<MeshPreview path="/x/m.mesh.json" />);
    await waitFor(() => expect(handle.contentRoot.children.length).toBe(1));
    const mesh = handle.contentRoot.children[0] as THREE.Mesh;
    // The rendered geometry is a CLONE, not the shared cache object.
    expect(mesh.geometry).not.toBe(shared);
    expect(mesh.geometry.type).toBe('BoxGeometry');
    // The shared original still has its attributes (was never disposed).
    expect(shared.getAttribute('position')).toBeTruthy();
  });

  it('surfaces a load failure without adding content', async () => {
    const handle = makeFakeHandle();
    (createPreviewScene as Mock).mockReturnValue(handle);
    (whenMeshTemplate as Mock).mockResolvedValue(undefined);
    const { findByText } = render(<MeshPreview path="/x/bad.mesh.json" />);
    expect(await findByText(/Failed to load geometry/)).not.toBeNull();
    expect(handle.contentRoot.children.length).toBe(0);
  });
});
