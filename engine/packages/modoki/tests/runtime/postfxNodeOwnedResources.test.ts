/** `nodeOwnedResources` against the REAL three.js post nodes (#1269) — nothing here is mocked.
 *
 *  `postfxStack.test.ts` mocks every node, and a mocked `dispose()` frees everything by construction,
 *  which is how all three leaks below shipped green. So each case first shows the premise on the real
 *  node (its own `dispose()` leaves the resource alive), then that the helper frees it. When a three
 *  bump renames a private field a helper reads, the helper goes back to freeing nothing and the
 *  second half of its case goes red. No GPU is touched: every resource here is allocated in a
 *  constructor or in `setup()`, and a three `dispose` event is the observable. */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// This package's vitest config aliases `three/webgpu` and `three/tsl` to no-op stubs. Measured, by
// deleting the two lines below: 6 of the 14 cases go red — every one that reaches `pass`/`rtt`,
// whether through this file's own imports or through the helper's (both are Vite-processed, so the
// alias applies). three's example nodes are NOT affected either way: `dof`/`ao`/`bloom` live in
// node_modules, so vitest externalises them and Node resolves their imports through three's own
// exports map — the DOF and GTAO premises below were always against real three. Note the file
// therefore holds two copies of three, so every assertion here is duck-typed (`isRenderTarget`, a
// `dispose` event), never `instanceof`.
//
// The URL is resolved to a PATH with `fileURLToPath`, never `new URL(...).pathname`: on Windows the
// latter yields `/D:/…`, which Vite reads as root-relative and the import fails — invisible to the
// Mac gate, red on the public CI matrix. `node:url` is imported inside the factory because
// `vi.hoisted` runs before this file's imports.
// Deps are hoisted to the repo root, five levels up from this file (same root vitest.config.ts uses).
const { realThree } = vi.hoisted(() => {
  const buildUrl = new URL('../../../../../node_modules/three/build/', import.meta.url).href;
  return {
    realThree: async (file: string) => {
      const { fileURLToPath } = await import('node:url');
      return vi.importActual(fileURLToPath(new URL(file, buildUrl)));
    },
  };
});
vi.mock('three/webgpu', async () => realThree('three.webgpu.js'));
vi.mock('three/tsl', async () => realThree('three.tsl.js'));
import { texture, float, mul, pass, rtt } from 'three/tsl';
import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import {
  ownedTextureInput, disposeGtaoNode, trackDofNode, disposeNodeOwned,
} from '../../src/runtime/rendering/postfx/nodeOwnedResources';

/** Resolves true once `target` fires three's `dispose` event. */
function watchDispose(target: THREE.EventDispatcher<{ dispose: object }>): () => boolean {
  let fired = false;
  target.addEventListener('dispose', () => { fired = true; });
  return () => fired;
}

type BlurNode = { _horizontalRT: THREE.RenderTarget; _verticalRT: THREE.RenderTarget };

/** The two targets a GaussianBlurNode owns, each watched. */
function watchBlur(blur: BlurNode) {
  const h = watchDispose(blur._horizontalRT);
  const v = watchDispose(blur._verticalRT);
  return () => h() && v();
}

/** The TEXTURES of those two targets. A target's dispose event frees its GPU textures only if the
 *  target was rendered into, and a blur node orphaned by a rebuild never is — its texture's own
 *  dispose event is what frees it then. */
function watchBlurTextures(blur: BlurNode) {
  const h = watchDispose(blur._horizontalRT.texture);
  const v = watchDispose(blur._verticalRT.texture);
  return () => h() && v();
}

// DepthOfFieldNode.setup() reads only the shared context off its builder.
const builder = { getSharedContext: () => ({}) };

function makeDof() {
  const node = dof(texture(new THREE.Texture()), float(-5), float(5), float(1), float(1));
  return node as unknown as {
    setup(b: unknown): unknown;
    dispose(): void;
    _CoCBlurredMaterial: { colorNode: BlurNode };
  };
}

describe('disposeGtaoNode', () => {
  const makeAo = () => ao(
    texture(new THREE.DepthTexture(1, 1)) as never, texture(new THREE.Texture()) as never,
    new THREE.PerspectiveCamera(),
  ) as unknown as { dispose(): void; _noiseNode: { value: THREE.DataTexture } };

  it('premise: GTAONode.dispose() leaves its noise DataTexture alive', () => {
    const node = makeAo();
    expect(node.constructor.name).toBe('GTAONode');
    const noiseFreed = watchDispose(node._noiseNode.value);
    node.dispose();
    expect((node._noiseNode.value as { isDataTexture?: boolean }).isDataTexture).toBe(true);
    expect(noiseFreed()).toBe(false);
  });

  it('frees the noise texture AND the AO target\'s texture, which the node frees neither of', () => {
    const node = makeAo() as unknown as { _noiseNode: { value: THREE.DataTexture }; _aoRenderTarget: THREE.RenderTarget };
    const noiseFreed = watchDispose(node._noiseNode.value);
    // The TEXTURE, not the target: `GTAONode.dispose()` fires the target's own dispose event, so
    // watching the target cannot tell this helper apart from a bare `node.dispose()`.
    const textureFreed = watchDispose(node._aoRenderTarget.texture);
    disposeGtaoNode(node);
    expect(noiseFreed()).toBe(true);
    expect(textureFreed()).toBe(true);
  });

  it('premise: GTAONode.dispose() leaves its AO target\'s TEXTURE alive', () => {
    const node = makeAo() as unknown as { dispose(): void; _aoRenderTarget: THREE.RenderTarget };
    const textureFreed = watchDispose(node._aoRenderTarget.texture);
    node.dispose();
    expect(textureFreed()).toBe(false);
  });
});

describe('trackDofNode', () => {
  it('premise: every setup() mints a new GaussianBlurNode, and DOF dispose() frees none of them', () => {
    const node = makeDof();
    node.setup(builder);
    const first = node._CoCBlurredMaterial.colorNode;
    node.setup(builder);
    const second = node._CoCBlurredMaterial.colorNode;
    // The real class, not the config's stub — the whole file rests on this.
    expect((first as unknown as object).constructor.name).toBe('GaussianBlurNode');
    expect(second).not.toBe(first);
    const firstFreed = watchBlur(first);
    const secondFreed = watchBlur(second);
    node.dispose();
    expect(firstFreed()).toBe(false);
    expect(secondFreed()).toBe(false);
  });

  it('premise: disposing a render target does not fire its texture\'s dispose event', () => {
    const blur = (() => { const node = makeDof(); node.setup(builder); return node._CoCBlurredMaterial.colorNode; })();
    const texturesFreed = watchBlurTextures(blur);
    (blur as unknown as { dispose(): void }).dispose();
    expect(texturesFreed()).toBe(false);
  });

  it('frees the blur node of EVERY build, not only the last one', () => {
    const node = makeDof();
    const disposeDof = trackDofNode(node);
    node.setup(builder);
    const first = node._CoCBlurredMaterial.colorNode;
    const firstFreed = watchBlur(first);
    const firstTexturesFreed = watchBlurTextures(first);
    node.setup(builder);
    const second = node._CoCBlurredMaterial.colorNode;
    const secondFreed = watchBlur(second);
    const secondTexturesFreed = watchBlurTextures(second);
    disposeDof();
    expect(firstFreed()).toBe(true);
    expect(secondFreed()).toBe(true);
    expect(firstTexturesFreed()).toBe(true);
    expect(secondTexturesFreed()).toBe(true);
  });

  it('frees the DOF node\'s OWN targets\' textures, which its dispose() leaves alive', () => {
    const premise = makeDof() as unknown as { dispose(): void; _compositeRT: THREE.RenderTarget };
    const premiseFreed = watchDispose(premise._compositeRT.texture);
    premise.dispose();
    expect(premiseFreed(), 'premise: the node frees the target, not its texture').toBe(false);

    const node = makeDof() as unknown as { _compositeRT: THREE.RenderTarget; _CoCRT: THREE.RenderTarget };
    const compositeFreed = watchDispose(node._compositeRT.texture);
    const cocFreed = watchDispose(node._CoCRT.texture);
    trackDofNode(node as unknown as object)();
    expect(compositeFreed()).toBe(true);
    expect(cocFreed()).toBe(true);
  });
});

describe('ownedTextureInput', () => {
  it('passes a texture node through and owns nothing', () => {
    const tex = texture(new THREE.Texture());
    const owned = ownedTextureInput(tex);
    expect(owned.tex).toBe(tex);
    expect(() => owned.dispose()).not.toThrow();
  });

  it('resolves a non-texture node through an RTT and frees its render target', () => {
    const color = mul(texture(new THREE.Texture()), float(0.5));
    const owned = ownedTextureInput(color);
    const rttNode = owned.tex as unknown as { isTextureNode?: boolean; renderTarget: THREE.RenderTarget };
    expect(rttNode).not.toBe(color);
    expect((rttNode as object).constructor.name).toBe('RTTNode');
    const targetFreed = watchDispose(rttNode.renderTarget);
    owned.dispose();
    expect(targetFreed()).toBe(true);
  });
});

describe('disposeNodeOwned', () => {
  const makePass = () => pass(new THREE.Scene(), new THREE.PerspectiveCamera()) as unknown as {
    dispose(): void; renderTarget: THREE.RenderTarget; constructor: { name: string };
  };

  it('premise: PassNode.dispose() frees the target but leaves its textures and depth texture alive', () => {
    const node = makePass();
    expect(node.constructor.name).toBe('PassNode');
    const colourFreed = watchDispose(node.renderTarget.texture);
    const depthFreed = watchDispose(node.renderTarget.depthTexture!);
    node.dispose();
    expect(colourFreed()).toBe(false);
    expect(depthFreed()).toBe(false);
  });

  it('frees a PassNode target\'s colour AND depth textures', () => {
    const node = makePass();
    const colourFreed = watchDispose(node.renderTarget.texture);
    const depthFreed = watchDispose(node.renderTarget.depthTexture!);
    disposeNodeOwned(node);
    expect(colourFreed()).toBe(true);
    expect(depthFreed()).toBe(true);
  });

  it('frees an RTTNode\'s quad material — the node declares no dispose() of its own', () => {
    const node = rtt(mul(texture(new THREE.Texture()), float(0.5))) as unknown as {
      dispose(): void; _quadMesh: { material: THREE.Material }; renderTarget: THREE.RenderTarget;
    };
    const premise = rtt(mul(texture(new THREE.Texture()), float(0.5))) as unknown as { dispose(): void; _quadMesh: { material: THREE.Material } };
    const premiseFreed = watchDispose(premise._quadMesh.material);
    premise.dispose();
    expect(premiseFreed(), 'premise: the inherited dispose() only fires an event').toBe(false);

    const materialFreed = watchDispose(node._quadMesh.material);
    const targetFreed = watchDispose(node.renderTarget.texture);
    // The node's own dispose() still runs: all it does is fire this event, which is how anything
    // listening on the node (three's caches) learns it is gone.
    const nodeDisposed = watchDispose(node as unknown as THREE.EventDispatcher<{ dispose: object }>);
    disposeNodeOwned(node);
    expect(materialFreed()).toBe(true);
    expect(targetFreed()).toBe(true);
    expect(nodeDisposed()).toBe(true);
  });

  it('reaches render targets held in ARRAYS — BloomNode\'s two mip pyramids', () => {
    const node = bloom(texture(new THREE.Texture())) as unknown as {
      _renderTargetsHorizontal: THREE.RenderTarget[]; _renderTargetsVertical: THREE.RenderTarget[];
    };
    const watched = [...node._renderTargetsHorizontal, ...node._renderTargetsVertical]
      .map((rt) => watchDispose(rt.texture));
    expect(watched.length).toBeGreaterThan(1);
    disposeNodeOwned(node);
    expect(watched.every((freed) => freed())).toBe(true);
  });

  it('is safe to call twice — the second pass re-fires the events, and three guards on its own map', () => {
    const node = makePass();
    disposeNodeOwned(node);
    let secondRound = 0;
    node.renderTarget.texture.addEventListener('dispose', () => { secondRound += 1; });
    expect(() => disposeNodeOwned(node)).not.toThrow();
    // The listener count three itself registered is what makes the repeat a no-op (Textures
    // ._destroyTexture is `has()`-guarded and drops its listener); this only pins that the helper
    // stays willing to run twice rather than latching itself off.
    expect(secondRound).toBe(1);
  });
});
