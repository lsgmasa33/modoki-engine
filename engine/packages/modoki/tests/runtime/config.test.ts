/** config unit tests — setGameConfig, getGameConfig. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function getConfig() {
  return import('../../../src/runtime/config');
}

beforeEach(() => {
  vi.resetModules();
});

describe('config', () => {
  describe('getGameConfig', () => {
    it('throws when no config is set', async () => {
      const { getGameConfig } = await getConfig();

      expect(() => getGameConfig()).toThrow('No game config set');
    });

    it('returns the configured config', async () => {
      const { setGameConfig, getGameConfig } = await getConfig();

      const config = {
        name: 'Test Game',
        sceneSetup: vi.fn(),
        initWorld: vi.fn(),
        scenePath: '/test/scene.json',
      };
      setGameConfig(config);

      expect(getGameConfig()).toBe(config);
      expect(getGameConfig().name).toBe('Test Game');
      expect(getGameConfig().scenePath).toBe('/test/scene.json');
    });

    it('supports optional nameTransform', async () => {
      const { setGameConfig, getGameConfig } = await getConfig();

      setGameConfig({
        name: 'Test',
        sceneSetup: vi.fn(),
        initWorld: vi.fn(),
        nameTransform: (name) => `Transformed: ${name}`,
      });

      const { nameTransform } = getGameConfig();
      expect(nameTransform?.('test')).toBe('Transformed: test');
    });
  });
});
