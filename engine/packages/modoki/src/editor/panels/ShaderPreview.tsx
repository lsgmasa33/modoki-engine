/** ShaderPreview — a live PixiJS preview of a `space:'2d'` custom shader, shown at the
 *  top of ShaderAssetView. Renders the shader on a quad in a small standalone Pixi
 *  Application (its own canvas/context, ticker stopped — rendered on demand), so tuning a
 *  param default in the inspector reflects immediately. The 2D analog of MaterialPreview.
 *
 *  Caveats: `uTexture` (the entity's own sprite in a real scene) has no equivalent for an
 *  asset preview, so it's bound to Texture.WHITE — the preview shows the shader's MATH on a
 *  white base (extra `texture` params sample their real default textures). Param VALUES come
 *  from the live `data` (the edited defaults), not the compiled program, so a default edit
 *  re-binds without recompiling. Only 2D shaders preview; a 3D `.shader.json` shows nothing. */

import { useEffect, useRef } from 'react';
import { Application, Mesh, MeshGeometry, Texture, Assets, type Shader } from 'pixi.js';
import { resolvePixiBackend } from '../../runtime/rendering/canvas2DPool';
import { releaseGeometry, retainPanelTexture, releasePanelTexture } from '../../runtime/rendering/Scene2D';
import { buildPixiShaderProgram, makePixiShaderInstance, type PixiShaderProgram } from '../../runtime/rendering/pixiShaderBuilder';
import { resolveImageUrl } from '../../runtime/rendering/renderUtils';
import { shaderSpace, coerceParamValue, type ShaderParam } from '../../runtime/loaders/shaderSchema';
import { noteGpuContextCreated, noteGpuContextDestroyed } from '../../runtime/core/gpuContextTracking';
import { attachRendererLossHandling } from '../../runtime/rendering/rendererLossHandling';
import { makePreviewLossPolicy } from './previewLossPolicy';

const SIZE = 132; // css px (square)

/** Resolve a texture-param default (sprite/texture GUID) → a live Texture AND its url, or null.
 *  The url comes back so `renderNow` can hold it through the shared panel refcount — this
 *  `Assets.load` used to be unbalanced, so every param edit stranded another texture for the life
 *  of the editor process (#701). */
async function loadPreviewTexture(ref: unknown): Promise<{ tex: Texture; url: string } | null> {
  if (typeof ref !== 'string' || !ref) return null;
  const url = resolveImageUrl(ref);
  if (!url) return null;
  try {
    const tex = (await Assets.load(url)) as Texture;
    return tex?.source ? { tex, url } : null;
  } catch { return null; }
}

/** A full-canvas quad in pixel coords (matches the localUniformBit transform + textureBit UVs). */
function buildQuad(w: number, h: number): MeshGeometry {
  return new MeshGeometry({
    positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

/** Free this panel's own Mesh. `Application.destroy()` forwards its FIRST argument to the
 *  renderer only — `this.stage.destroy(options)` gets its own, second argument, which the call
 *  sites below never pass, so the stage subtree (this Mesh) is never torn down by
 *  `app.destroy(true)` alone. `Mesh`/`Container` order `unload()` before `destroy()` correctly,
 *  so a bare `mesh.destroy()` is safe and frees the mesh's own per-instance GPU state.
 *
 *  The geometry is released SEPARATELY, through `releaseGeometry` (exported from `Scene2D.tsx`):
 *  PixiJS 8.19.0's `Geometry.destroy()` tears off its `"unload"` listener before `unload()`
 *  fires, orphaning the WebGL VAO unless the release goes through `releaseGeometry`'s
 *  `unload()`-then-`destroy(true)` order — see that function's own comment in `Scene2D.tsx`, and
 *  the repo-wide static guard (`tests/architecture/geometryRelease.test.ts`) that forbids a
 *  second, un-audited copy of that ordering anywhere else. Capture `mesh.geometry` BEFORE
 *  `mesh.destroy()` — `Mesh.destroy()` nulls `_geometry`, so reading it after would hand
 *  `releaseGeometry` `undefined`. */
function destroyMesh(mesh: Mesh<MeshGeometry, Shader> | null): void {
  if (!mesh) return;
  const geometry = mesh.geometry;
  mesh.destroy();
  releaseGeometry(geometry);
}

export function ShaderPreview({ path, data }: { path: string; data: Record<string, unknown> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Live app/program/mesh, plus a serial guard so a stale async build can't touch a torn-down app.
  const stateRef = useRef<{ app: Application | null; program: PixiShaderProgram | null; mesh: Mesh<MeshGeometry, Shader> | null; serial: number; texUrls: string[] }>({ app: null, program: null, mesh: null, serial: 0, texUrls: [] });
  const dataRef = useRef(data);
  dataRef.current = data;
  const is2D = shaderSpace(data as { space?: '2d' | '3d' }) === '2d';

  // App + program lifecycle, keyed on the shader PATH (a param-default edit keeps the app).
  useEffect(() => {
    if (!is2D) return;
    const host = hostRef.current;
    if (!host) return;
    const serial = ++stateRef.current.serial;
    let disposed = false;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    host.appendChild(canvas);
    const app = new Application();

    // Fix 3 of #590's adversarial review (docs/plans/ios-rendering-update-wedge.md): this is
    // `src/editor` — dev-only, never shipped in a game build — but `app.init()` below creates a
    // REAL PixiJS context, and an editor session with several previews/viewports open is exactly
    // the surface that approaches `SOFT_CONTEXT_LIMIT`. Noted after `app.init()` resolves (never
    // before), paired with a `contextLive`-guarded decrement everywhere this effect destroys the
    // app, matching `scene3DSync.ts`'s `makeWebGPURenderer` convention — a fresh `false` per
    // effect run (a new `app` instance), never carried over from a previous shader/path.
    let contextLive = false;
    const markDestroyed = () => { if (contextLive) { contextLive = false; noteGpuContextDestroyed(); } };
    // The mesh THIS run creates, if any — separate from `stateRef.current.mesh` because that ref is
    // shared across every effect run (StrictMode's mount→unmount→mount, or a fast shader-path
    // switch). The catch below used to destroy `stateRef.current.mesh` directly: reachable only
    // when THIS run made no mesh (the try's only statement after storing one is a `void`ed
    // `renderNow`, whose rejection can't reach this catch), so it only ever fired while a LATER run
    // had already stored ITS OWN mesh there — and destroyed that live mesh out from under it.
    let ownMesh: Mesh<MeshGeometry, Shader> | null = null;
    // Detach for this run's GPU-context-loss listeners (#795) — a no-op until `app.init()`
    // succeeds and there is a canvas/device worth watching. Reassigned below; called from
    // `teardown` so a lost context tears the panel down exactly once, from the same path as
    // unmount.
    let detachLoss: () => void = () => {};

    // The panel's ONE teardown path — called on unmount AND (#795) on a lost GPU context/device,
    // so a lost context tears the panel down exactly the same way an unmount would. Idempotent by
    // construction: every step below already guards on state a first run clears (`app.renderer`
    // null after the first `destroy(true)`, `stateRef.current.mesh` null after the first
    // `destroyMesh`, `texUrls` emptied, `markDestroyed`'s own `contextLive` guard), so calling it
    // twice (once from a loss, once from unmount) is safe.
    const teardown = () => {
      disposed = true;
      stateRef.current.serial++;
      detachLoss();
      destroyMesh(stateRef.current.mesh); // must run BEFORE nulling the ref below
      // Hand back every texture this panel was holding (#701) — the panel is going away, so its
      // veto on the shared unload must go with it or the texture is pinned for the process.
      for (const u of stateRef.current.texUrls) releasePanelTexture(u);
      stateRef.current.texUrls = [];
      stateRef.current.app = null; stateRef.current.program = null; stateRef.current.mesh = null;
      if (!app.renderer) { /* init never finished */ } else app.destroy(true);
      markDestroyed();
      canvas.remove();
    };

    // Every async-side destroy is guarded on `app.renderer` (Pixi nulls it in destroy()): the
    // cleanup below may already have torn the app down while we were parked on an await, and a
    // SECOND app.destroy() throws (stage/renderer are null). The guard makes whichever destroy
    // runs second a no-op — covering both cleanup-before-init (we free it on resume) and
    // cleanup-after-init (cleanup freed it; we skip). try/catch frees the context on a failed init.
    (async () => {
      try {
        const preference = await resolvePixiBackend();
        if (disposed || stateRef.current.serial !== serial) return;
        await app.init({ preference, canvas, width: SIZE, height: SIZE, backgroundAlpha: 0, antialias: true, preserveDrawingBuffer: true });
        // The context now exists — note it before any of the early-return teardowns below, so a
        // stale/disposed resume still pairs its `app.destroy(true)` with a decrement.
        contextLive = true;
        noteGpuContextCreated();
        // Wire loss detection (#795) as soon as the context exists — a preview left open across
        // a GPU driver reset would otherwise stay blank forever with no error anywhere.
        detachLoss = attachRendererLossHandling(
          { canvas, device: (app.renderer as unknown as { gpu?: { device?: { lost?: Promise<{ reason?: string; message?: string }> } } })?.gpu?.device },
          { label: 'ShaderPreview', isStale: () => disposed || stateRef.current.serial !== serial, ...makePreviewLossPolicy({ label: 'ShaderPreview', teardown }) },
        );
        if (disposed || stateRef.current.serial !== serial) { if (app.renderer) app.destroy(true); markDestroyed(); return; }
        app.ticker.stop();
        const program = await buildPixiShaderProgram(path);
        if (disposed || stateRef.current.serial !== serial) { if (app.renderer) app.destroy(true); markDestroyed(); return; }
        stateRef.current.app = app;
        stateRef.current.program = program;
        if (program) {
          const mesh = new Mesh({ geometry: buildQuad(SIZE, SIZE), texture: Texture.WHITE, shader: makePixiShaderInstance(program, Texture.WHITE, undefined) });
          app.stage.addChild(mesh);
          ownMesh = mesh;
          stateRef.current.mesh = mesh;
        }
        void renderNow(stateRef.current, dataRef.current);
      } catch {
        // init/build rejected — free any GL context we opened; leave state cleared. `ownMesh`, not
        // `stateRef.current.mesh`: a later run may already have stored ITS mesh on the shared ref.
        destroyMesh(ownMesh);
        if (app.renderer) app.destroy(true);
        markDestroyed(); // no-op unless init actually succeeded before something else threw
      }
    })();

    return () => { teardown(); };
  }, [path, is2D]);

  // Re-bind uniforms/textures + re-render when the shader data (param defaults) changes.
  useEffect(() => { void renderNow(stateRef.current, data); }, [data]);

  if (!is2D) {
    return <div style={{ color: '#666', fontSize: '10px', padding: '6px 4px' }}>Preview is available for 2D shaders only.</div>;
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
      {/* Checkerboard so transparency/alpha in the shader output is visible. */}
      <div ref={hostRef} style={{
        width: SIZE, height: SIZE, borderRadius: 4, overflow: 'hidden', border: '1px solid #333',
        backgroundColor: '#2a2a2a',
        backgroundImage: 'linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%)',
        backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0px',
      }} />
    </div>
  );
}

/** Rebuild the mesh's shader from the current param defaults + resolved extra textures, then
 *  render one frame. Serial-guarded so an in-flight texture load can't draw into a dead app. */
async function renderNow(state: { app: Application | null; program: PixiShaderProgram | null; mesh: Mesh<MeshGeometry, Shader> | null; serial: number; texUrls: string[] }, data: Record<string, unknown>) {
  const { app, program, mesh } = state;
  if (!app || !app.renderer || !program || !mesh) return;
  const serial = state.serial;
  const params = (data.params as Record<string, ShaderParam>) ?? {};
  // Param VALUES = each declared param's current default (edits live here, not in the program).
  const values: Record<string, unknown> = {};
  for (const [key, p] of program.params) values[key] = coerceParamValue(p, params[key]?.default);
  // Extra samplers: resolve each texture param's default; WHITE while it loads/absent.
  const extraTextures: Record<string, Texture> = {};
  const held: string[] = [];
  for (const [key] of program.textureParams) {
    const loaded = await loadPreviewTexture(params[key]?.default);
    // Retain BEFORE the abort check, so a load that lands into a torn-down panel is still
    // handed back below rather than stranded (#701).
    if (loaded) { retainPanelTexture(loaded.url); held.push(loaded.url); }
    if (state.serial !== serial || !state.mesh) { for (const u of held) releasePanelTexture(u); return; }
    extraTextures[key] = loaded?.tex ?? Texture.WHITE;
  }
  // `held` is owned by this local until `state.texUrls` takes it over below. If anything between
  // here and that handover throws, the `finally` gives the holds back (#701 review): a stranded
  // PANEL hold is worse than the leak it replaced, because it is a permanent veto inside
  // `unloadSpriteTextureNow` — `unloadAllSpriteTextures`'s F3 sweep would skip that url for the
  // rest of the editor process, and the scene's own accounting could never free it either.
  let committed = false;
  try {
    const shader = makePixiShaderInstance(program, Texture.WHITE, values, extraTextures);
    const old = mesh.shader;
    mesh.shader = shader;
    old?.destroy();
    // Release the PREVIOUS pass's holds only now the new shader is bound — retain-before-release,
    // so a url common to both passes (the usual case: one param edited out of several) never dips
    // to 0 and gets unloaded out from under the shader we just built.
    const prevHeld = state.texUrls;
    state.texUrls = held;
    committed = true;
    for (const u of prevHeld) releasePanelTexture(u);
    app.renderer.render(app.stage);
  } finally {
    if (!committed) for (const u of held) releasePanelTexture(u);
  }
}
