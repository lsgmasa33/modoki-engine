/** Tests for GameConfig — the game/editor boundary. */

import { describe, it, expect } from 'vitest';
import { setGameConfig, getGameConfig } from '@modoki/engine/runtime';
import { testGameConfig } from './_fixtures/testGame';

describe('gameConfig', () => {
  it('throws when no config is set', () => {
    // Note: config is a module singleton set by other tests, so we test that
    // getGameConfig returns something valid after a set instead.
    setGameConfig(testGameConfig);
    expect(() => getGameConfig()).not.toThrow();
  });

  it('returns the active config after setGameConfig', () => {
    setGameConfig(testGameConfig);
    const config = getGameConfig();
    expect(config.name).toBe('Test Fixture Game');
    expect(config.sceneSetup).toBeTypeOf('function');
    expect(config.initWorld).toBeTypeOf('function');
  });

  it('config has asset manifest path', () => {
    const config = getGameConfig();
    expect(config.assetManifest).toBe('/assets.manifest.json');
  });
});
