/** pipeline unit tests — system registration, ordering, execution, replacement. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../../src/runtime/systems/pipeline');
}

describe('pipeline', () => {
  describe('registerSystem + runPipeline', () => {
    it('executes registered systems', async () => {
      const { registerSystem, runPipeline } = await getModule();
      const fn = vi.fn();
      registerSystem('test', fn, 100);

      const mockWorld = {} as any;
      runPipeline(mockWorld);
      expect(fn).toHaveBeenCalledWith(mockWorld);
    });

    it('executes systems in priority order (lower first)', async () => {
      const { registerSystem, runPipeline } = await getModule();
      const order: string[] = [];
      registerSystem('late', () => order.push('late'), 200);
      registerSystem('early', () => order.push('early'), 0);
      registerSystem('mid', () => order.push('mid'), 100);

      runPipeline({} as any);
      expect(order).toEqual(['early', 'mid', 'late']);
    });

    it('systems at same priority run in registration order', async () => {
      const { registerSystem, runPipeline } = await getModule();
      const order: string[] = [];
      registerSystem('first', () => order.push('first'), 100);
      registerSystem('second', () => order.push('second'), 100);
      registerSystem('third', () => order.push('third'), 100);

      runPipeline({} as any);
      expect(order).toEqual(['first', 'second', 'third']);
    });
  });

  describe('registerSystem replacement', () => {
    it('replaces existing system with same name', async () => {
      const { registerSystem, runPipeline } = await getModule();
      const old = vi.fn();
      const replacement = vi.fn();
      registerSystem('sys', old, 100);
      registerSystem('sys', replacement, 50);

      runPipeline({} as any);
      expect(old).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalled();
    });

    it('replacement updates priority', async () => {
      const { registerSystem, getRegisteredSystems } = await getModule();
      registerSystem('sys', vi.fn(), 100);
      registerSystem('sys', vi.fn(), 50);
      expect(getRegisteredSystems()).toEqual(['sys (50)']);
    });
  });

  describe('unregisterSystem', () => {
    it('removes a registered system', async () => {
      const { registerSystem, unregisterSystem, runPipeline } = await getModule();
      const fn = vi.fn();
      registerSystem('removable', fn, 100);
      unregisterSystem('removable');

      runPipeline({} as any);
      expect(fn).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown system names', async () => {
      const { unregisterSystem } = await getModule();
      expect(() => unregisterSystem('nonexistent')).not.toThrow();
    });
  });

  describe('getRegisteredSystems', () => {
    it('returns formatted list of registered systems', async () => {
      const { registerSystem, getRegisteredSystems } = await getModule();
      registerSystem('time', vi.fn(), 0);
      registerSystem('game', vi.fn(), 100);
      expect(getRegisteredSystems()).toEqual([
        'time (0)',
        'game (100)',
      ]);
    });

    it('returns empty array when no systems registered', async () => {
      const { getRegisteredSystems } = await getModule();
      expect(getRegisteredSystems()).toEqual([]);
    });
  });

  describe('game-switch lifecycle (regression for game system leak)', () => {
    it('previous game systems do not run after unregister', async () => {
      const { registerSystem, unregisterSystem, runPipeline } = await getModule();

      // Simulate Game A registration
      const gameAProjection = vi.fn();
      const gameAGameSys = vi.fn();
      registerSystem('gameA.projection', gameAProjection, 300);
      registerSystem('gameA.game', gameAGameSys, 100);

      // Simulate game switch: tear down A, register B
      unregisterSystem('gameA.projection');
      unregisterSystem('gameA.game');
      const gameBProjection = vi.fn();
      registerSystem('gameB.projection', gameBProjection, 300);

      runPipeline({} as any);
      expect(gameAProjection).not.toHaveBeenCalled();
      expect(gameAGameSys).not.toHaveBeenCalled();
      expect(gameBProjection).toHaveBeenCalledOnce();
    });

    it('re-registering after unregister works (game A → B → A round-trip)', async () => {
      const { registerSystem, unregisterSystem, runPipeline } = await getModule();
      const gameASystem = vi.fn();

      registerSystem('gameA.sys', gameASystem, 100);
      unregisterSystem('gameA.sys');
      registerSystem('gameA.sys', gameASystem, 100); // re-register
      runPipeline({} as any);
      expect(gameASystem).toHaveBeenCalledOnce();
    });

    it('getRegisteredSystems reflects unregister', async () => {
      const { registerSystem, unregisterSystem, getRegisteredSystems } = await getModule();
      registerSystem('a', vi.fn(), 100);
      registerSystem('b', vi.fn(), 200);
      expect(getRegisteredSystems()).toHaveLength(2);
      unregisterSystem('a');
      expect(getRegisteredSystems()).toEqual(['b (200)']);
    });
  });

  describe('SYSTEM_PRIORITY', () => {
    it('defines well-known priority tiers', async () => {
      const { SYSTEM_PRIORITY } = await getModule();
      expect(SYSTEM_PRIORITY.TIME).toBe(0);
      expect(SYSTEM_PRIORITY.GAME).toBe(100);
      expect(SYSTEM_PRIORITY.TRANSFORM).toBe(200);
      expect(SYSTEM_PRIORITY.PROJECTION).toBe(300);
    });

    it('TIME < GAME < TRANSFORM < PROJECTION', async () => {
      const { SYSTEM_PRIORITY } = await getModule();
      expect(SYSTEM_PRIORITY.TIME).toBeLessThan(SYSTEM_PRIORITY.GAME);
      expect(SYSTEM_PRIORITY.GAME).toBeLessThan(SYSTEM_PRIORITY.TRANSFORM);
      expect(SYSTEM_PRIORITY.TRANSFORM).toBeLessThan(SYSTEM_PRIORITY.PROJECTION);
    });

    it('MATERIAL runs after TRANSFORM + AUDIO but before PROJECTION (presentation tier)', async () => {
      // MATERIAL (260) drives material params in the presentation tier: it must run
      // AFTER transform propagation (200) and be ≥ TRANSFORM so it keeps writing while
      // the sim is paused (like AUDIO at 250), yet BEFORE projections/store sync (300).
      const { SYSTEM_PRIORITY } = await getModule();
      expect(SYSTEM_PRIORITY.MATERIAL).toBe(260);
      expect(SYSTEM_PRIORITY.MATERIAL).toBeGreaterThan(SYSTEM_PRIORITY.TRANSFORM);
      expect(SYSTEM_PRIORITY.MATERIAL).toBeGreaterThan(SYSTEM_PRIORITY.AUDIO);
      expect(SYSTEM_PRIORITY.MATERIAL).toBeLessThan(SYSTEM_PRIORITY.PROJECTION);
    });
  });

  describe('simulation gating (ecs-core P2)', () => {
    async function getPlayState() {
      return import('../../../src/runtime/systems/playState');
    }
    const registerTiers = (registerSystem: any, SYSTEM_PRIORITY: any, order: string[]) => {
      registerSystem('time', () => order.push('time'), SYSTEM_PRIORITY.TIME);
      registerSystem('game', () => order.push('game'), SYSTEM_PRIORITY.GAME);
      registerSystem('anim', () => order.push('anim'), SYSTEM_PRIORITY.ANIMATION);
      registerSystem('xform', () => order.push('xform'), SYSTEM_PRIORITY.TRANSFORM);
      registerSystem('proj', () => order.push('proj'), SYSTEM_PRIORITY.PROJECTION);
    };

    it('skips sim tiers (priority < TRANSFORM) when the sim is NOT running; runs transform + projection', async () => {
      const { registerSystem, runPipeline, SYSTEM_PRIORITY } = await getModule();
      const { setPlayState } = await getPlayState();
      setPlayState('stopped');
      const order: string[] = [];
      registerTiers(registerSystem, SYSTEM_PRIORITY, order);
      runPipeline({} as any);
      // Editor Stopped/Paused: game time + logic + animation frozen, but transform
      // propagation + projections still run so inspector/gizmo edits reflect live.
      expect(order).toEqual(['xform', 'proj']);
      setPlayState('playing'); // restore default for sibling tests (module is reset per-test anyway)
    });

    it('also skips sim tiers when paused', async () => {
      const { registerSystem, runPipeline, SYSTEM_PRIORITY } = await getModule();
      const { setPlayState } = await getPlayState();
      setPlayState('paused');
      const order: string[] = [];
      registerTiers(registerSystem, SYSTEM_PRIORITY, order);
      runPipeline({} as any);
      expect(order).toEqual(['xform', 'proj']);
      setPlayState('playing');
    });

    it('runs every tier when the sim IS running', async () => {
      const { registerSystem, runPipeline, SYSTEM_PRIORITY } = await getModule();
      const { setPlayState } = await getPlayState();
      setPlayState('playing');
      const order: string[] = [];
      registerTiers(registerSystem, SYSTEM_PRIORITY, order);
      runPipeline({} as any);
      expect(order).toEqual(['time', 'game', 'anim', 'xform', 'proj']);
    });
  });
});
