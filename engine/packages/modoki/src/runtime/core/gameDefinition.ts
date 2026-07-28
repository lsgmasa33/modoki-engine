/** GameDefinition — the engine's contract for a game/project entry. A flat
 *  project exports a single `game: GameDefinition` from its `game.ts` (one
 *  project = one game); the engine discovers it via the `virtual:modoki-games`
 *  module and never imports a specific game by path. Keeping this type in the
 *  engine (not in a project) is what lets the engine stay game-agnostic — App.tsx
 *  and the editor reference THIS type while the runtime value comes from the open
 *  project. */

import type React from 'react';
import type { World } from 'koota';
import type { GameConfig } from './config';

/** A dockable editor panel contributed by a game (see `GameDefinition.editorPanels`).
 *  `component` is only ever rendered inside the editor, so its module — and anything
 *  it imports from `@modoki/engine/editor` — stays out of the production game bundle
 *  as long as it is reached solely through the lazy `editorPanels()` loader. */
export interface EditorPanelDef {
  /** Stable id — also the FlexLayout tab component key + Window-menu entry. */
  id: string;
  /** Human-readable tab title. */
  name: string;
  component: React.ComponentType;
  /** Dock into the default layout on first load (else it opens only via the
   *  Window menu or a saved layout). */
  openByDefault?: boolean;
  /** Where an auto-docked / Window-opened panel lands. Default: 'center'
   *  (next to the Scene tabset). */
  dockLocation?: 'center' | 'bottom' | 'left' | 'right';
}

export interface GameDefinition {
  id: string;
  name: string;
  description?: string;
  /** Thumbnail asset GUID (resolved via the manifest), or an external URL.
   *  Stored into UIElement.imageSrc, which is GUID-only — never a literal path. */
  thumbnailUrl?: string;
  loadConfig: () => Promise<GameConfig>;
  registerPostprocessors?: () => Promise<void> | void;
  /** Register game-specific ECS systems and trait editor metadata. */
  registerSystems?: () => Promise<void> | void;
  /** Unregister game-specific systems and UI actions. Called on game switch
   *  before the next game's registerSystems(). Engine systems are not affected. */
  unregisterSystems?: () => Promise<void> | void;
  /** Reset game state on error recovery (called by ErrorBoundary). */
  resetPhase?: (world: World) => void;
  /** Async warm-up run AFTER the boot scene has loaded but BEFORE the loading screen is
   *  dismissed (runtime only; the editor has its own flow). Await here anything the first
   *  painted frame must already show that ISN'T reachable through the scene's `resources`
   *  manifest — e.g. RUNTIME-GENERATED content: load its assets and instantiate it now, so
   *  it doesn't pop in a few frames after the game appears. `world` is the freshly-loaded
   *  world. Best-effort: a rejection is logged and boot continues. */
  onSceneReady?: (world: World) => Promise<void> | void;
  /** Register game-specific editor-only glue — e.g. UIRenderer store-binding hooks so
   *  the editor's default UI layer can resolve this game's bindings, or a
   *  `registerCreatableAsset()` call (`@modoki/engine/editor`) adding a "Create X" entry
   *  to the Assets panel for a game-specific asset kind (e.g. sling's Level/Wave charts).
   *  Called once at editor init for every game; not called in the game runtime — put the
   *  `@modoki/engine/editor` import behind a lazy loader (like `editorPanels` below) so it
   *  never reaches the production game bundle. */
  registerEditorBindings?: () => void | Promise<void>;
  /** Register game-specific dockable editor panels (e.g. a level painter). Called
   *  once at editor init; the returned components are merged into the editor's panel
   *  registry + Window menu. MUST be a lazy loader — `() => import('./editor/X')
   *  .then(m => [{ id, name, component: m.X, openByDefault: true }])` — so the panel
   *  module (and its `@modoki/engine/editor` imports) stays off the production game
   *  bundle. Editor-only; never called in the game runtime. */
  editorPanels?: () => EditorPanelDef[] | Promise<EditorPanelDef[]>;
  /** Register this game's app-service implementations (analytics/crashlytics/ads/
   *  attribution) with the engine via `registerAppServices()`. These are native-SDK
   *  wrappers that live in the GAME (not the engine) — see runtime/appServices.ts.
   *  Called during the game's bootstrap; the engine then drives ads/attribution
   *  init (native only) and crashlytics hooks. No-op for games without services. */
  registerAppServices?: () => Promise<void> | void;
  /**
   * Custom React UI layer for this game. When set, rendered instead of the
   * default ECS UIRenderer. The component receives no props — use Zustand
   * stores or ECS queries internally.
   *
   * Lazy-load with: `UIComponent: () => import('./ui/ChatUI').then(m => m.ChatUI)`
   */
  UIComponent?: React.LazyExoticComponent<React.ComponentType> | React.ComponentType;
}
