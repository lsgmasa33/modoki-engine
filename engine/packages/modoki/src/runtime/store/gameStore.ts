/** Game store — Zustand state populated by ECS projections, read by React views.
 *
 *  Lives in the ENGINE PACKAGE (not the app shell) so a game imports it via
 *  `@modoki/engine/runtime` — a specifier the editor resolves regardless of where
 *  the game folder physically sits. A game reaching it through a relative
 *  `../../../../engine/app/store/gameStore` path only worked while the game sat
 *  inside the repo; copied out (opened standalone), that path escaped to nothing
 *  and Vite failed to resolve it. */

import { create } from 'zustand';
import { appServices } from '../appServices';

export type Screen = 'home' | 'game' | 'result';
export type FontStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Typed interface for UIRenderer binding resolution — avoids `as unknown as Record<string, unknown>` */
export interface UIBindableState {
  screen: Screen;
  entityCount: number;
  gamePhase: string;
  fps: number;
  threeBackend: string;
  pixiBackend: string;
  fontStatus: FontStatus;
}

interface GameState extends UIBindableState {
  setScreen: (screen: Screen) => void;
  setEntityCount: (count: number) => void;
  setGamePhase: (phase: string) => void;
  setFps: (fps: number) => void;
  setRendererInfo: (threeBackend: string, pixiBackend: string) => void;
  setFontStatus: (status: FontStatus) => void;
}

export const useGameStore = create<GameState>((set) => ({
  screen: 'home',
  entityCount: 0,
  gamePhase: 'home',
  fps: 0,
  threeBackend: '',
  pixiBackend: '',
  fontStatus: 'idle',

  setScreen: (screen) => {
    appServices().crashlytics?.log(`Screen: ${screen}`);
    set({ screen });
  },

  setEntityCount: (entityCount) => set({ entityCount }),
  setGamePhase: (gamePhase) => set({ gamePhase }),
  setFps: (fps) => set({ fps }),
  setRendererInfo: (threeBackend, pixiBackend) => set({ threeBackend, pixiBackend }),
  setFontStatus: (fontStatus) => set({ fontStatus }),
}));
