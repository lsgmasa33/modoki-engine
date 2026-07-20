/** `gameIdFromScenePath` — derives a game id from the `games/<id>/` path
 *  convention, used as the dev-only fallback for game-scoped manager lifecycle.
 *  Pure function (no koota worlds), so it lives apart from the heavier
 *  SceneManager integration tests. */

import { describe, it, expect } from 'vitest';
import { gameIdFromScenePath } from '../../src/runtime/scene/SceneManager';

describe('gameIdFromScenePath', () => {
  it('extracts the id from a games/<id>/ path (leading slash or not)', () => {
    expect(gameIdFromScenePath('/games/chess/runtime/assets/scenes/chess.json')).toBe('chess');
    expect(gameIdFromScenePath('games/space-console/runtime/assets/scenes/Station.json')).toBe('space-console');
    expect(gameIdFromScenePath('/games/3d-test/scenes/island.json')).toBe('3d-test');
  });

  it('returns null when no game segment is present', () => {
    expect(gameIdFromScenePath('/assets/Warp-a1b2c3d4.json')).toBeNull(); // hashed prod url
    expect(gameIdFromScenePath('/sceneA.json')).toBeNull();
    expect(gameIdFromScenePath('__prefab_edit__abc-123')).toBeNull();     // prefab-edit world
    expect(gameIdFromScenePath('')).toBeNull();
  });

  it('requires a trailing slash after the id (a bare games/<id> file is not a game scene)', () => {
    // `games/chess` with no following slash isn't the scene-dir convention.
    expect(gameIdFromScenePath('/games/chess')).toBeNull();
  });
});
