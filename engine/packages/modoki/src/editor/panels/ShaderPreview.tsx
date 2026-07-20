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
import { buildPixiShaderProgram, makePixiShaderInstance, type PixiShaderProgram } from '../../runtime/rendering/pixiShaderBuilder';
import { resolveImageUrl } from '../../runtime/rendering/renderUtils';
import { shaderSpace, coerceParamValue, type ShaderParam } from '../../runtime/loaders/shaderSchema';

const SIZE = 132; // css px (square)

/** Resolve a texture-param default (sprite/texture GUID) → a live Texture, or null. */
async function loadPreviewTexture(ref: unknown): Promise<Texture | null> {
  if (typeof ref !== 'string' || !ref) return null;
  const url = resolveImageUrl(ref);
  if (!url) return null;
  try {
    const tex = (await Assets.load(url)) as Texture;
    return tex?.source ? tex : null;
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

export function ShaderPreview({ path, data }: { path: string; data: Record<string, unknown> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Live app/program/mesh, plus a serial guard so a stale async build can't touch a torn-down app.
  const stateRef = useRef<{ app: Application | null; program: PixiShaderProgram | null; mesh: Mesh<MeshGeometry, Shader> | null; serial: number }>({ app: null, program: null, mesh: null, serial: 0 });
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
        if (disposed || stateRef.current.serial !== serial) { if (app.renderer) app.destroy(true); return; }
        app.ticker.stop();
        const program = await buildPixiShaderProgram(path);
        if (disposed || stateRef.current.serial !== serial) { if (app.renderer) app.destroy(true); return; }
        stateRef.current.app = app;
        stateRef.current.program = program;
        if (program) {
          const mesh = new Mesh({ geometry: buildQuad(SIZE, SIZE), texture: Texture.WHITE, shader: makePixiShaderInstance(program, Texture.WHITE, undefined) });
          app.stage.addChild(mesh);
          stateRef.current.mesh = mesh;
        }
        void renderNow(stateRef.current, dataRef.current);
      } catch {
        // init/build rejected — free any GL context we opened; leave state cleared.
        if (app.renderer) app.destroy(true);
      }
    })();

    return () => {
      disposed = true;
      stateRef.current.serial++;
      stateRef.current.app = null; stateRef.current.program = null; stateRef.current.mesh = null;
      if (!app.renderer) { /* init never finished */ } else app.destroy(true);
      canvas.remove();
    };
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
async function renderNow(state: { app: Application | null; program: PixiShaderProgram | null; mesh: Mesh<MeshGeometry, Shader> | null; serial: number }, data: Record<string, unknown>) {
  const { app, program, mesh } = state;
  if (!app || !app.renderer || !program || !mesh) return;
  const serial = state.serial;
  const params = (data.params as Record<string, ShaderParam>) ?? {};
  // Param VALUES = each declared param's current default (edits live here, not in the program).
  const values: Record<string, unknown> = {};
  for (const [key, p] of program.params) values[key] = coerceParamValue(p, params[key]?.default);
  // Extra samplers: resolve each texture param's default; WHITE while it loads/absent.
  const extraTextures: Record<string, Texture> = {};
  for (const [key] of program.textureParams) {
    const tex = await loadPreviewTexture(params[key]?.default);
    if (state.serial !== serial || !state.mesh) return; // torn down mid-load
    extraTextures[key] = tex ?? Texture.WHITE;
  }
  const shader = makePixiShaderInstance(program, Texture.WHITE, values, extraTextures);
  const old = mesh.shader;
  mesh.shader = shader;
  old?.destroy();
  app.renderer.render(app.stage);
}
