/** withRendererState — run `fn` with the renderer's global bindings guaranteed to be restored,
 *  whether it returns or THROWS.
 *
 *  ## Why this exists (#1298)
 *
 *  `setRenderTarget` / `setMRT` / `xr.enabled` are renderer-GLOBAL: whatever was bound last is what
 *  the next `renderer.render(scene, camera)` draws into. Any code that redirects the renderer to an
 *  offscreen target therefore owes an unconditional restore — and three.js does NOT provide one.
 *  Upstream restores on the NORMAL-RETURN PATH ONLY:
 *
 *  - `PMREMGenerator.dispose()` (both the core and the WebGPU generator, read from three 0.185.1)
 *    calls `_dispose()` — materials, ping-pong target, LOD geometries — and never `_cleanup()`.
 *    `_cleanup()` is what runs `setRenderTarget(_oldTarget, …)` and restores `xr.enabled`, and its
 *    only call sites are the last statement of `fromScene()` and of `_fromTexture()`.
 *  - `CubeRenderTarget.fromEquirectangularTexture` and the `CubeCamera.update` it calls both
 *    likewise restore only after a successful render.
 *
 *  So on a throw — a lost or degraded GPU context, a shader compile failure — the renderer stays
 *  bound to an internal offscreen target and every later frame draws into it instead of the canvas.
 *  The screen goes black with nothing in the log.
 *
 *  ## Why a helper rather than six more lines at each site
 *
 *  This repo hand-rolled the save/restore correctly in three places (`envPmrem`'s `'cube'` branch,
 *  `npr/ParticlePassNode`, `Scene3D`'s offscreen capture) and skipped it in two (`envPmrem`'s
 *  `'pmrem'` branch, and `PostFXStack`'s stylized `prepare()`, which restores but not in a
 *  `finally`). Three correct copies and two wrong ones is what an invariant looks like just before
 *  it stops being one.
 *
 *  ## What it deliberately does NOT cover
 *
 *  Only the renderer-global bindings above — the render target (together with its active cube face
 *  and mipmap level, which are part of that ONE binding, not separate state), the MRT and
 *  `xr.enabled`. State that belongs to the SOURCE or the SCENE —
 *  `source.minFilter`/`generateMipmaps`, `scene.background`, `camera.layers.mask`, `autoClear` —
 *  stays at its call site, because only the caller knows which of those it perturbed. `envPmrem`'s
 *  `'cube'` branch keeps its own texture-filter restore inside the `fn` it passes here.
 *
 *  Nor does it help with the ASYNC case: state borrowed across an `await`, where another consumer
 *  legitimately runs inside the window, is a different mechanism (#1239) that a `finally` cannot
 *  close and would paper over. Do not reach for this there.
 *
 *  ## The feature guards
 *
 *  Each accessor is probed with `typeof === 'function'` rather than assumed. Tests drive stub
 *  renderers that implement only part of the surface, and `xr` is absent on some backends — an
 *  unconditional `r.xr.enabled` read would turn a restore path into a second throw, masking the
 *  original error, which is the one thing worse than not restoring at all. */

/** Renderer-global bindings captured before the borrow. `undefined` means "this renderer does not
 *  expose that accessor", which is distinct from a captured value of `null` (a real unbound
 *  target) — hence the `typeof` probes rather than a truthiness test. */
interface CapturedRendererState {
  target: unknown;
  hasTarget: boolean;
  /** ⚠️ The render-target binding is a TRIPLE, not a single value: `setRenderTarget(rt, face, mip)`
   *  defaults both trailing arguments to 0, so a one-argument restore silently rebinds face 0 /
   *  mip 0 even when the caller was on face 3. Three's `_cleanup()` captures and restores all
   *  three — it reads `getActiveCubeFace()`/`getActiveMipmapLevel()` into the module-level
   *  `_oldActiveCubeFace`/`_oldActiveMipmapLevel` beside `_oldTarget`, and hands all three back to
   *  `setRenderTarget` (both `three/src/extras/PMREMGenerator.js` and
   *  `three/src/renderers/common/extras/PMREMGenerator.js`, read at 0.185.1) — and since this
   *  helper REPLACES that guarantee on the PMREM branch it has to match it. A one-argument
   *  restore made that branch's SUCCESS path
   *  strictly WORSE than leaving it unwrapped: `_cleanup()` restored face 3, then our `finally`
   *  reset it to 0. Caught in review; no repo caller binds a non-zero face today, so it was
   *  latent rather than observable. */
  cubeFace: number | undefined;
  mipLevel: number | undefined;
  mrt: unknown;
  hasMrt: boolean;
  xrEnabled: boolean | undefined;
}

/** Run `fn` and restore the renderer's render target, MRT and `xr.enabled` afterwards — on the
 *  normal path AND on a throw. Returns whatever `fn` returns; re-throws whatever it throws, with
 *  the restore already done.
 *
 *  `renderer` is typed loosely on purpose: this module must not pull the WebGPU renderer type into
 *  the signature of everything that borrows a renderer, and the two three.js renderer classes do
 *  not share an interface carrying these methods. */
export function withRendererState<T>(renderer: unknown, fn: () => T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any;
  const prev: CapturedRendererState = {
    hasTarget: typeof r?.getRenderTarget === 'function',
    target: typeof r?.getRenderTarget === 'function' ? r.getRenderTarget() : undefined,
    cubeFace: typeof r?.getActiveCubeFace === 'function' ? r.getActiveCubeFace() : undefined,
    mipLevel: typeof r?.getActiveMipmapLevel === 'function' ? r.getActiveMipmapLevel() : undefined,
    hasMrt: typeof r?.getMRT === 'function',
    mrt: typeof r?.getMRT === 'function' ? r.getMRT() : undefined,
    xrEnabled: r?.xr ? r.xr.enabled : undefined,
  };
  try {
    return fn();
  } finally {
    // ⚠️ Restore only what was actually CAPTURED. Calling `setRenderTarget(undefined)` on a
    // renderer whose getter is missing would bind undefined rather than leave the binding alone,
    // turning a no-op into a corruption — the very failure this helper exists to prevent.
    //
    // The face/mip arguments are passed only when this renderer exposed the getters, so a stub
    // that has `setRenderTarget` but not `getActiveCubeFace` still gets the one-argument call it
    // would have got before, rather than an explicit `undefined` that three would coerce to 0.
    if (prev.hasTarget && typeof r.setRenderTarget === 'function') {
      if (prev.cubeFace !== undefined || prev.mipLevel !== undefined) {
        r.setRenderTarget(prev.target, prev.cubeFace ?? 0, prev.mipLevel ?? 0);
      } else {
        r.setRenderTarget(prev.target);
      }
    }
    if (prev.hasMrt && typeof r.setMRT === 'function') r.setMRT(prev.mrt);
    if (r?.xr && prev.xrEnabled !== undefined) r.xr.enabled = prev.xrEnabled;
  }
}
