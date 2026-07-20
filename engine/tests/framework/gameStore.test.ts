import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore } from '@modoki/engine/runtime';

describe('gameStore (ECS)', () => {
  beforeEach(() => {
    useGameStore.setState({
      screen: 'home',
      entityCount: 0,
      gamePhase: 'home',
      fps: 0,
      threeBackend: '',
      pixiBackend: '',
    });
  });

  it('starts with correct defaults', () => {
    const s = useGameStore.getState();
    expect(s.screen).toBe('home');
    expect(s.entityCount).toBe(0);
    expect(s.gamePhase).toBe('home');
    expect(s.fps).toBe(0);
    expect(s.threeBackend).toBe('');
    expect(s.pixiBackend).toBe('');
  });

  it('sets screen', () => {
    useGameStore.getState().setScreen('game');
    expect(useGameStore.getState().screen).toBe('game');
  });

  it('sets screen to result', () => {
    useGameStore.getState().setScreen('result');
    expect(useGameStore.getState().screen).toBe('result');
  });

  it('sets entity count', () => {
    useGameStore.getState().setEntityCount(5);
    expect(useGameStore.getState().entityCount).toBe(5);
  });

  it('sets fps', () => {
    useGameStore.getState().setFps(60);
    expect(useGameStore.getState().fps).toBe(60);
  });

  it('sets game phase', () => {
    useGameStore.getState().setGamePhase('result');
    expect(useGameStore.getState().gamePhase).toBe('result');
  });

  it('sets renderer info', () => {
    useGameStore.getState().setRendererInfo('WebGPU', 'WebGL');
    const s = useGameStore.getState();
    expect(s.threeBackend).toBe('WebGPU');
    expect(s.pixiBackend).toBe('WebGL');
  });

  it('handles multiple state changes correctly', () => {
    const { setScreen, setEntityCount, setFps, setGamePhase, setRendererInfo } =
      useGameStore.getState();

    setScreen('game');
    setEntityCount(42);
    setFps(120);
    setGamePhase('game');
    setRendererInfo('WebGL', 'WebGPU');

    const s = useGameStore.getState();
    expect(s.screen).toBe('game');
    expect(s.entityCount).toBe(42);
    expect(s.fps).toBe(120);
    expect(s.gamePhase).toBe('game');
    expect(s.threeBackend).toBe('WebGL');
    expect(s.pixiBackend).toBe('WebGPU');
  });
});
