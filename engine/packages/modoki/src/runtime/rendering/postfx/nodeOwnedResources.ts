/** GPU resources a three.js post node allocates that its OWN `dispose()` does not free (#1269).
 *
 *  `PostFXStack` rebuilds on every structural look change, so anything a stage leaves allocated is
 *  leaked once per switch. Calling each node's `dispose()` was already done, and was not enough:
 *  measured in `demos/postfx-demo`, +12 textures and ~50 MB per 90 s tour loop on a Galaxy S22.
 *  `disposeNodeOwned` is the ONE place that knows the gaps, so a stage frees a node by calling it
 *  rather than by knowing that node's internals — the alternative was the same three lines copied
 *  into seven stage disposers, each free to miss a different gap.
 *
 *  Three gaps, all confirmed against three 0.185.1 (`docs/rendering.md` § "Disposal"):
 *   1. A target's TEXTURES are freed from the target's `dispose` event only if it was ever rendered
 *      INTO (`Textures.updateRenderTarget` registers that listener). A target that was only bound as
 *      a sampled texture — every target of a node built by a compile that then never drew — keeps
 *      its GPU texture. A texture's own `dispose` event is the path that frees it, and is a no-op
 *      when the target's dispose already did (three drops the listener, `Textures._destroyTexture`).
 *   2. `RTTNode` declares NO `dispose()` at all, so the inherited one only fires an event: its
 *      `_quadMesh` NodeMaterial — a compiled pipeline — is never freed. `RenderPipeline` frees its
 *      own quad material; `RTTNode` does not.
 *   3. Some nodes never free a resource their constructor or `setup()` made: `GTAONode`'s noise
 *      texture, and `DepthOfFieldNode`'s per-build `GaussianBlurNode` (`trackDofNode`).
 *
 *  ⚠️ These reach into three's PRIVATE fields (`_noiseNode`, `_CoCBlurredMaterial`, `_quadMesh`). A
 *  rename in a three bump makes a helper silently free nothing again. The tripwire is
 *  `tests/runtime/postfxNodeOwnedResources.test.ts`, which builds the REAL three nodes, not mocks —
 *  a mocked node's `dispose()` "frees everything" by construction, which is exactly how these
 *  shipped green. */

import { rtt } from 'three/tsl';

interface Disposable { dispose(): void }
interface NodeLike { dispose?(): void }
interface RenderTargetLike {
  isRenderTarget?: boolean;
  textures?: Disposable[];
  depthTexture?: Disposable | null;
  dispose?(): void;
}

/** Free a render target AND the GPU textures three's own dispose path can miss (gap 1). */
export function disposeRenderTarget(rt: RenderTargetLike | null | undefined): void {
  if (!rt) return;
  rt.dispose?.();
  for (const tex of rt.textures ?? []) tex?.dispose();
  rt.depthTexture?.dispose();
}

/** Free everything a post node owns: the node itself, then the gaps its `dispose()` leaves.
 *
 *  Walks the node's own properties for render targets (`BloomNode` holds two ARRAYS of them, so
 *  arrays are walked too) rather than naming each private field, because the field names differ per
 *  node and go stale on a three bump, while `isRenderTarget` does not. Only targets a node HOLDS are
 *  reached, and a stack's nodes are disposed together, so nothing still in use is freed.
 *
 *  Safe to call twice: three removes a texture's dispose listener on the first destroy. */
export function disposeNodeOwned(node: unknown): void {
  const n = node as NodeLike & { _quadMesh?: { material?: Disposable | null } };
  n.dispose?.();
  for (const value of Object.values(n as object)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      const rt = item as RenderTargetLike | null;
      if (rt?.isRenderTarget === true) disposeRenderTarget(rt);
    }
  }
  // Gap 2 — RTTNode's own quad material. Nodes that have no `_quadMesh` are unaffected.
  n._quadMesh?.material?.dispose();
}

/** Resolve a stage's input to a TEXTURE node, and own what that took.
 *
 *  A node that samples its input (FXAA's `textureSample`, and `dof()`'s `convertToTexture`) needs a
 *  texture node. When the chain so far already ends in one (the scene pass's colour, the NPR particle
 *  texture, an SS composite RTT) it is used directly and nothing is owned. Otherwise it is resolved
 *  through an `rtt()` HERE, so the stack holds the RTT and can free it.
 *
 *  Why not let `dof()` do it: `convertToTexture` mints the same RTT, but `DepthOfFieldNode` keeps no
 *  handle on it and its `dispose()` never frees it. With AO ordered straight before DOF (AO's output
 *  is a `mul`, not a texture) that was a full-screen colour + depth target per rebuild. */
export function ownedTextureInput<T>(color: T): { tex: T; dispose: () => void } {
  // Deliberately NARROWER than three's `convertToTexture`, which also passes a `SampleNode`
  // through: this helper feeds the FXAA stage too, whose `wgslFn` binds a real `texture_2d<f32>` +
  // sampler, and a SampleNode is a vec4-valued expression, not a texture binding. No stage outputs
  // one today, so the two rules cannot disagree yet — keep them from diverging silently.
  if ((color as { isTextureNode?: boolean } | null)?.isTextureNode === true) {
    return { tex: color, dispose: () => {} };
  }
  const node = rtt(color as never);
  return {
    tex: node as unknown as T,
    dispose: () => disposeNodeOwned(node),
  };
}

/** Free a `GTAONode`: `disposeNodeOwned` covers its AO target, and this adds the 5×5 noise
 *  `DataTexture` its constructor creates for `_noiseNode`, which nothing else reaches. */
export function disposeGtaoNode(node: unknown): void {
  const n = node as { _noiseNode?: { value?: Disposable | null } };
  disposeNodeOwned(n);
  n._noiseNode?.value?.dispose();
}

/** Make a `DepthOfFieldNode` free everything it builds, and return the disposer.
 *
 *  `DepthOfFieldNode.setup()` creates a NEW `GaussianBlurNode` (two full-screen render targets) every
 *  time the node is built and assigns it to `_CoCBlurredMaterial.colorNode`, orphaning the previous
 *  one. Its `dispose()` frees none of them. A node is built once per render context that compiles
 *  it, so one DOF stage made more than one blur node (the stage precompile and the draw), and only
 *  recording each as `setup()` makes it can reach the orphans. An orphan never renders, which is
 *  gap 1 above — measured in `demos/postfx-demo`, one 1×1 texture per tour loop. Call this before
 *  the node is first built — i.e. right after `dof()` returns. */
export function trackDofNode(node: unknown): () => void {
  const n = node as NodeLike & {
    setup?: (builder: unknown) => unknown;
    _CoCBlurredMaterial?: { colorNode?: unknown };
  };
  const blurNodes = new Set<object>();
  const record = () => {
    const blur = n._CoCBlurredMaterial?.colorNode as Partial<Disposable> | undefined;
    if (blur && typeof blur.dispose === 'function') blurNodes.add(blur);
  };
  const setup = n.setup;
  if (typeof setup === 'function') {
    n.setup = function (this: unknown, builder: unknown) {
      const out = setup.call(this, builder);
      record();
      return out;
    };
  }
  // ⚠️ A build AFTER this disposer runs is NOT covered: its blur node joins no set anyone will
  // free. Freeing it inside `record()` was tried and removed — at that instant its targets have
  // never been rendered into, so three's `Textures` has no entry and every dispose is a guarded
  // no-op; it would leak just the same the moment the node drew. No path reaches it today
  // (`compileStagesInner` re-checks the stack's `disposed` before every job, and `compileAsync`
  // builds synchronously before its first await), and covering it properly means not building
  // after dispose, not freeing harder here.
  return () => {
    disposeNodeOwned(n);
    for (const blur of blurNodes) disposeNodeOwned(blur);
    blurNodes.clear();
  };
}
