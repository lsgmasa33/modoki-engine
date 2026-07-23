/** Engine-owned test fixture standing in for a real game's setup.
 *
 *  The editor tests here (registerTraits / entityNaming / serialize / gameConfig) exercise
 *  ENGINE machinery — trait registration, entity naming, scene serialization, the game/editor
 *  config boundary — and only need a *game-style* resource trait + a GameConfig as sample data.
 *  They used to import games/3d-test's `registerGameSystems` / `GamePhase` / `tropicalIslandConfig`,
 *  which coupled the engine test surface to a demo game. The OSS engine repo ships engine-only
 *  (no games/), so an engine test must not depend on one — this fixture provides the equivalent
 *  scaffolding without leaving the engine. docs/engine-oss-publishing.md. */

import { trait } from 'koota';
import { registerTrait, type GameConfig } from '@modoki/engine/runtime';

/** Mirrors a real game's GamePhase: a singleton resource trait with an enum field. */
export const TestPhase = trait({ phase: 'home' as 'home' | 'game' | 'result' });

/** Register the fixture trait's editor metadata — parity with a game's `registerSystems()`
 *  registering its own resource traits. Idempotent (registerTrait overwrites). */
export function registerTestGameTraits(): void {
  registerTrait({
    name: 'TestPhase', trait: TestPhase, category: 'resource',
    fields: {
      phase: { type: 'enum', options: ['home', 'game', 'result'] },
    },
  });
}

/** A minimal GameConfig for the game/editor config-boundary test. */
export const testGameConfig: GameConfig = {
  name: 'Test Fixture Game',
  sceneSetup: () => {},
  initWorld: () => {},
  assetManifest: '/assets.manifest.json',
};
