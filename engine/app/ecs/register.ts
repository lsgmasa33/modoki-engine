/** Register all traits and name transforms. Call once at startup.
 *  Game-specific postprocessors are registered via GameDefinition.registerPostprocessors(). */

import projectConfig from 'virtual:modoki-project-config';
import { registerAllTraits } from './registerTraits';
import { setNameTransform } from '@modoki/engine/runtime';
import { getGameConfig, registerEngineActions, registerAudioControls, registerManager, timeManager, navigationManager, physics2DEventsManager, physics3DEventsManager, zone2DEventsManager, zone3DEventsManager, timelineEventsManager, inputSourcesManager, setPhysicsLayers, setTargetFPS, setRenderSettings } from '@modoki/engine/runtime';

let registered = false;

export function registerAll() {
  if (registered) return;
  registered = true;

  registerAllTraits();
  // Engine built-in lifecycle UIActions (reload / quit), available to every game.
  registerEngineActions();
  // Built-in audio control layer: audio.* UIActions (play/pause/stop/setClip/
  // toggleCrossfade/setBusVolume/playOneShot) + the mixer store hook so sliders'
  // inputBinding resolves bus volumes. Lets games control audio declaratively.
  registerAudioControls();
  // Engine-global Managers (game scope → survive scene swaps):
  //  - TimeManager: anchors + timeSince* read sources for UI bindings.
  //  - NavigationManager: history stack + engine.loadScene / engine.navigateBack
  //    + canGoBack read source.
  registerManager(timeManager);
  registerManager(navigationManager);
  // Physics2DEvents: scene-scoped collision/sensor bus (activates per scene; clears
  // its subscribers on swap). The producer is physics2DSystem; game code subscribes.
  registerManager(physics2DEventsManager);
  // Physics3DEvents: the 3D equivalent — scene-scoped 3D collision/sensor bus.
  registerManager(physics3DEventsManager);
  // Zone2DEvents / Zone3DEvents: scene-scoped Zone trigger buses (physics-free enter/exit over
  // ZoneOccupant containment). Producers are zone2DSystem / zone3DSystem; game code subscribes.
  registerManager(zone2DEventsManager);
  registerManager(zone3DEventsManager);
  // TimelineEvents: scene-scoped Director sequence bus (start/marker/end). The producer is
  // timelineSystem; game code subscribes via onSequenceStart/onMarker/onSequenceEnd.
  registerManager(timelineEventsManager);
  // Input sources (app scope): attaches every registered input source (keyboard now;
  // pointer/gamepad later). The inputSystem samples them into the Input resource each frame.
  registerManager(inputSourcesManager);

  // Project-defined 2D physics collision layers + matrix → runtime registry.
  setPhysicsLayers(projectConfig.physics);
  // Project frame-rate cap → frame driver (0 = uncapped / display refresh).
  setTargetFPS(projectConfig.rendering.targetFps);
  // Project renderer knobs (three backend/AA/shadows/tone/exposure, pixi
  // backend/AA/resolution, web canvas sizing) → engine render-settings registry.
  setRenderSettings(projectConfig.rendering);

  // Use nameTransform from game config if provided
  const config = getGameConfig();
  if (config.nameTransform) {
    setNameTransform(config.nameTransform);
  }
}
