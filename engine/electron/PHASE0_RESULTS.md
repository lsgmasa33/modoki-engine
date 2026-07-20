# Phase 0 Spike — Results (GO)

Date: 2026-06-11 · Branch: `electron-migration` · Electron **42.4.0** (Chromium ~140, Node 20.x)

## Verdict: **GO** — WebGPU + NPR run under Electron; migration is unblocked.

## What was tested
Minimal hand-written CommonJS host (`electron/main.cjs` + `electron/preload.cjs`,
no electron-vite restructuring) loading the existing Vite dev server
(`http://localhost:5173/#/editor`) in a `BrowserWindow`.

## Evidence

**1. WebGPU adapter is real (not WebGL2 fallback).** Main-process probe:
```json
{ "hasNavigatorGpu": true,
  "adapter": { "vendor": "apple", "architecture": "metal-3" },
  "device": true }
```
Chromium GPU feature status: `"webgpu": "enabled"`, `"gpu_compositing": "enabled"`,
`"skia_graphite": "enabled_on"`.

**2. The app's own renderer chose WebGPU.** The in-app FPS overlay reports
**`3D: WebGPU` / `2D: WebGPU`** at 75 FPS. No `[makeWebGPURenderer] WebGPU init
failed; falling back to WebGL2` warning was emitted.

**3. NPR TSL post-process compiles.** The editor (Scene3D + NPR MRT pipeline) mounted
and rendered the tropical-island scene with no WGSL errors — specifically **no
`unresolved type 'OutputType'`** (the known TSL lazy-init risk called out in CLAUDE.md).
Renderer console was forwarded to main; only the expected dev CSP security warning appeared.

**4. HMR works in Electron.** `[vite] invalidate …/npr/*.ts` messages confirm the Vite
HMR websocket connected through the BrowserWindow.

**5. `webContents.capturePage()` from main captures the WebGPU canvas** — screenshot
saved and verified showing the live 3D scene. This pre-validates the Phase 5
`capture_viewport` tool (main-initiated, renderer-sourced — per the ownership table).

## Required flags / Chromium floor
**None.** WebGPU is on by default in Electron 42; no `--enable-unsafe-webgpu` or other
flags were needed on macOS (Apple Silicon, Metal-3). Windows/Intel/AMD still to be
spot-checked before Phase 7 packaging, but the macOS gate is clear.

## Artifacts
The throwaway `.cjs` spike host (`electron/main.cjs` / `electron/preload.cjs`,
`npm run electron:spike`) proved the gate above, then was **superseded in Phase 2**
by the real TypeScript host (`electron/main.ts`, `electron/preload.ts`, built via
`npm run electron:build`, launched with `npm run dev:electron`).
