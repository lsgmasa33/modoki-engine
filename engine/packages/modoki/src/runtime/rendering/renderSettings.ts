/** renderSettings — project-configured renderer knobs injected at boot.
 *
 *  The app pushes `projectConfig.rendering` in here via {@link setRenderSettings}
 *  (mirrors the `setPhysicsLayers` / `setTargetFPS` pattern in app/ecs/register.ts).
 *  The engine renderers then READ these instead of hardcoding values:
 *   - `makeWebGPURenderer` (scene3DSync)  → backend, antialias, pixelRatioCap,
 *     shadows, toneMapping, exposure
 *   - `canvas2DPool`                       → pixi backend, antialias, resolution
 *   - web canvas sizing (Scene3D/Scene2D)  → web.{sizeMode,width,height}
 *
 *  The defaults here MUST equal the pre-wiring hardcoded behavior so that when
 *  no project injects settings (tests, standalone imports) nothing regresses:
 *  ACESFilmic @ 1.2 exposure, antialias on, DPR capped at 2, shadows on, auto
 *  backend, free canvas sizing. */

import * as THREE from 'three';

export interface ThreeRenderSettings {
  backend: 'auto' | 'webgpu' | 'webgl';
  antialias: boolean;
  pixelRatioCap: number;
  shadows: boolean;
  /** 'ACESFilmic' | 'AgX' | 'Neutral' | 'Linear' | 'None' */
  toneMapping: string;
  exposure: number;
}

export interface PixiRenderSettings {
  backend: 'auto' | 'webgpu' | 'webgl';
  antialias: boolean;
  /** Pixi renderer resolution; 0 = auto (devicePixelRatio). */
  resolution: number;
}

export interface WebRenderSettings {
  sizeMode: 'free' | 'fixed' | 'max';
  width: number;
  height: number;
}

export interface RenderSettings {
  three: ThreeRenderSettings;
  pixi: PixiRenderSettings;
  web: WebRenderSettings;
}

/** Live defaults = the exact hardcoded behavior that existed before wiring. */
let settings: RenderSettings = {
  three: {
    backend: 'auto',
    antialias: true,
    pixelRatioCap: 2,
    shadows: true,
    toneMapping: 'ACESFilmic',
    exposure: 1.2,
  },
  pixi: { backend: 'auto', antialias: true, resolution: 0 },
  web: { sizeMode: 'free', width: 1280, height: 720 },
};

/** Inject the project's rendering config. Called once at app boot (register.ts).
 *  Partial input is deep-merged over the current settings so a missing sub-block
 *  keeps its default. */
export function setRenderSettings(next: Partial<RenderSettings> | undefined): void {
  if (!next) return;
  settings = {
    three: { ...settings.three, ...next.three },
    pixi: { ...settings.pixi, ...next.pixi },
    web: { ...settings.web, ...next.web },
  };
}

export function getRenderSettings(): RenderSettings {
  return settings;
}

/** Reset to hardcoded defaults — for test isolation. */
export function resetRenderSettings(): void {
  settings = {
    three: { backend: 'auto', antialias: true, pixelRatioCap: 2, shadows: true, toneMapping: 'ACESFilmic', exposure: 1.2 },
    pixi: { backend: 'auto', antialias: true, resolution: 0 },
    web: { sizeMode: 'free', width: 1280, height: 720 },
  };
}

/** Map a tone-mapping name to the THREE constant. Unknown → ACESFilmic. */
export function resolveToneMapping(name: string): THREE.ToneMapping {
  switch (name) {
    case 'None': return THREE.NoToneMapping;
    case 'Linear': return THREE.LinearToneMapping;
    case 'AgX': return THREE.AgXToneMapping;
    case 'Neutral': return THREE.NeutralToneMapping;
    case 'ACESFilmic':
    default: return THREE.ACESFilmicToneMapping;
  }
}
