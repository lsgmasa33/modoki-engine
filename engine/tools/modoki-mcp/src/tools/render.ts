/** Visual capture: viewport screenshot, offscreen scene render, frame sequences.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';

export function registerRenderTools(tool: ToolDef, ctx: ToolContext): void {
  const { postJson } = ctx;

  // ── capture_viewport — "does it actually render?" (Electron editor only) ──
  tool(
    'modoki_capture_viewport',
    'Screenshot the live editor window to a downscaled JPEG file and return its PATH ' +
      '(read it with your file tool). Use AFTER verifying data with get_scene_state, to ' +
      'catch the "numbers right, renders black/NaN" class of bug. A single screenshot ' +
      'shows STATIC correctness only — never judge motion/timing from one frame. The result ' +
      'also reports `width`/`height` (read from the JPEG on disk, so they describe the FILE even ' +
      'when no downscale happened on a HiDPI display), `cssWidth`/`cssHeight` (DIP window size) and ' +
      '`scale` = width/cssWidth: image px ÷ scale = DIP px. `zoomFactor` is the live Chromium page-zoom factor — DIP px ÷ ' +
      'zoomFactor = the zoomed-CSS space tap/drag\'s `{x,y}` aim mode actually uses, so an ' +
      'eyeballed coordinate must divide by it when UI zoom ≠ 100%. Prefer a `selector` ' +
      '(modoki_tap) or entity bounds (get_scene_state) over eyeballing at all. ' +
      'Requires the Electron editor (MODOKI_BACKEND must point at it, not the Vite dev server). ' +
      'If NO viewport is mounted, modoki_render_scene is NOT a fallback — it needs the Game ' +
      'panel\'s 3D surface, i.e. exactly what is missing. Open the panel, or read the scene as ' +
      'DATA (modoki_get_scene_state / modoki_diagnose), which needs no renderer at all. ' +
      '\n\n⚠️ This does NOT force a render. It is `webContents.capturePage()` — a screenshot of ' +
      'the WINDOW, i.e. whatever each surface last drew. The Game panel renders continuously so ' +
      'its pixels are current, but the editor SceneView is RENDER-ON-DEMAND: with nothing marking ' +
      'it dirty it can hand you a frame from minutes ago, and repeated captures come back ' +
      'BYTE-IDENTICAL through a change you just made. (Measured 2026-08-18: painting a visible ' +
      'material red left three successive captures identical until a camera move re-armed the ' +
      'gate.) So a capture that "did not change" is NOT evidence the change failed to render — ' +
      'this description used to claim the opposite and cost a QA session a wrong verdict. To ' +
      'force one, use modoki_render_scene (a real offscreen render, Game panel only), or move ' +
      'the SceneView camera first. For the TRUE framebuffer use CDP Page.captureScreenshot ' +
      '(see CLAUDE.md). ',
    {
      maxSide: z.number().int().positive().optional().describe('Longest-side cap in px (default 1568).'),
      quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100 (default 70). SAME unit as render_scene/render_sequence; the effective value is echoed back.'),
    },
    async ({ maxSide, quality }) => postJson('/api/capture-viewport', { maxSide, quality }, 60_000),
  );

  // ── render_scene — deterministic offscreen render (any backend with a 3D view) ──
  tool(
    'modoki_render_scene',
    'Deterministically render the LIVE scene offscreen to a JPEG file and return its ' +
      'PATH. Unlike capture_viewport (a screenshot of the editor WINDOW — final ' +
      'composited pixels incl. NPR, but tied to window size/layout), this is ' +
      'reproducible and window-independent: pick the size and camera, get the same ' +
      'framing every time — ideal for before/after geometry, material, lighting, and ' +
      'camera checks. Renders the forward pass only (NPR/post-FX is window-bound — use ' +
      'capture_viewport for the final stylized look).\n\n' +
      'IT RENDERS THE GAME VIEW\'S 3D SURFACE, always — never the editor SceneView you are ' +
      'orbiting. Only the runtime Scene3D (mounted by the Game panel) registers an offscreen ' +
      'renderer, so the framing you get is the GAME camera unless you override `camera`, and a ' +
      'closed Game panel means there is nothing to render. Check `surfaces` in ' +
      'modoki_get_editor_state. The reply echoes `surface` — the label of the surface that ' +
      'actually served the frame, read off the mounted registrant, so it confirms rather than ' +
      'assumes (`game-3d` today, always).\n\n' +
      'This FORCES a fresh render, so it CANNOT reveal a stale or render-on-demand frame — the broken frame heals in the capture. For the TRUE framebuffer use CDP Page.captureScreenshot (see CLAUDE.md). ',
    {
      width: z.number().int().positive().max(4096).optional().describe('Output width px (default: live viewport; ≤4096).'),
      height: z.number().int().positive().max(4096).optional().describe('Output height px (default: live viewport; ≤4096).'),
      quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100 (default 85) — the SAME unit as capture_viewport. It used to be a 0..1 fraction, and a 1-100 value was then silently ignored by canvas.toDataURL. The effective value comes back as `quality`.'),
      camera: z.object({
        position: z.array(z.number()).length(3).optional().describe('World camera position [x,y,z].'),
        target: z.array(z.number()).length(3).optional().describe('Look-at target [x,y,z].'),
        fov: z.number().optional().describe('Vertical FOV degrees.'),
      }).optional().describe('Camera override (omit to use the live camera pose).'),
    },
    async (args) => postJson('/api/render-scene', args, 60_000),
  );

  // ── render_sequence — sampled frames for motion checks ──
  tool(
    'modoki_render_sequence',
    'Render N offscreen frames sampled over wall-clock at `fps` (the live animation ' +
      'advances between them) and return their PATHS — for judging MOTION/timing, ' +
      'which a single frame cannot show. Same camera/size options as render_scene. ' +
      'Read a few of the returned frames in order to see the temporal progression.\n\n' +
      'REFUSED (409) when the editor is STOPPED: time does not advance there, so every frame ' +
      'would be identical and a sequence cannot show motion. Press Play first, or use ' +
      'render_scene for a static frame — or pass forceRender:true to render identical frames anyway.\n\n' +
      'TIMING: use the returned `tMs[]` (ms from the first frame), never frameIndex × 1/fps. Each ' +
      'frame costs a synchronous render + IPC round-trip that the requested rate does not account ' +
      'for, so the reply reports `requestedFps` AND the achieved `actualFps`/`spanMs`.\n\n' +
      'This FORCES a fresh render, so it CANNOT reveal a stale or render-on-demand frame — the broken frame heals in the capture. For the TRUE framebuffer use CDP Page.captureScreenshot (see CLAUDE.md). ',
    {
      frames: z.number().int().min(1).max(120).optional().describe('Frame count (default 8, ≤120).'),
      fps: z.number().min(1).max(60).optional().describe('REQUESTED sampling rate (default 10, ≤60). The achieved rate comes back as `actualFps`; frame times as `tMs[]`.'),
      // RENAMED from `force` (2026-08-22). §2: "if two tools need different meanings, they need
      // different names" — `force` means "proceed even though there is unsaved work" on
      // build/add_native_target/ota_publish/load_scene/prefab, and meant something entirely
      // unrelated here. One word, two meanings, on one surface. With .strict() armed a caller who
      // passes the old `force` now gets a refusal naming the real params, which is the loud
      // outcome; silently accepting it under the wrong mental model was the quiet one.
      forceRender: z.boolean().optional().describe('Render even when the editor is STOPPED and every frame will be identical. Nothing to do with unsaved work — unlike `force` on modoki_build / modoki_load_scene, which is about that.'),
      width: z.number().int().positive().max(4096).optional().describe('Output width px (default: live viewport; ≤4096). Per FRAME — forwarded to the same render op as modoki_render_scene.'),
      height: z.number().int().positive().max(4096).optional().describe('Output height px (default: live viewport; ≤4096). Per frame.'),
      quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100 (default 85), per frame — the SAME unit as capture_viewport/render_scene.'),
      camera: z.object({
        position: z.array(z.number()).length(3).optional().describe('World camera position [x,y,z].'),
        target: z.array(z.number()).length(3).optional().describe('Look-at target [x,y,z].'),
        fov: z.number().optional().describe('Vertical FOV degrees.'),
      }).optional()
        .describe('Override the render camera: position [x,y,z], target [x,y,z] to look at, fov in degrees. Omit to use the live viewport camera. Same shape as modoki_render_scene.'),
    },
    async (args) => {
      // Allow enough wall-clock for the whole sequence: frames sampled at fps, each
      // with its own backend render budget, plus headroom — so the MCP-side timeout
      // never fires before the backend's own per-frame timeout would.
      const frames = Math.min(args.frames ?? 8, 120);
      const fps = Math.max(args.fps ?? 10, 1);
      const timeoutMs = Math.ceil((frames / fps) * 1000) + frames * 16_000 + 5_000;
      return postJson('/api/render-sequence', args, timeoutMs);
    },
  );
}
