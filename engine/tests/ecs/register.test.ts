import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRegisterAllTraits = vi.fn();
const mockSetNameTransform = vi.fn();
const mockGetGameConfig = vi.fn().mockReturnValue({});

vi.mock('../../app/ecs/registerTraits', () => ({
  registerAllTraits: () => mockRegisterAllTraits(),
}));

const mockRegisterManager = vi.fn();
const mockSetPhysicsLayers = vi.fn();
const mockSetTargetFPS = vi.fn();
const mockSetRenderSettings = vi.fn();

vi.mock('@modoki/engine/runtime', () => ({
  getGameConfig: () => mockGetGameConfig(),
  // setNameTransform is now imported from the engine public API (the app shim
  // app/ecs/traitRegistry was removed in ELECTRON_PLAN Phase 4).
  setNameTransform: (...args: any[]) => mockSetNameTransform(...args),
  registerEngineActions: () => {},
  registerAudioControls: () => {},
  registerManager: (...args: any[]) => mockRegisterManager(...args),
  timeManager: { name: 'engine.time' },
  navigationManager: { name: 'engine.navigation' },
  physics2DEventsManager: { name: 'Physics2DEvents' },
  physics3DEventsManager: { name: 'Physics3DEvents' },
  zone2DEventsManager: { name: 'Zone2DEvents' },
  zone3DEventsManager: { name: 'Zone3DEvents' },
  timelineEventsManager: { name: 'TimelineEvents' },
  inputSourcesManager: { name: 'Input' },
  setPhysicsLayers: (...args: any[]) => mockSetPhysicsLayers(...args),
  setTargetFPS: (...args: any[]) => mockSetTargetFPS(...args),
  setRenderSettings: (...args: any[]) => mockSetRenderSettings(...args),
}));

describe('registerAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level `registered` flag by resetting modules
    vi.resetModules();
  });

  it('registers all traits on first call', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockRegisterAllTraits).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second call does not re-register', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    registerAll();
    expect(mockRegisterAllTraits).toHaveBeenCalledTimes(1);
  });

  it('applies nameTransform from game config when provided', async () => {
    const transform = (name: string) => name.toUpperCase();
    mockGetGameConfig.mockReturnValue({ nameTransform: transform });
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockSetNameTransform).toHaveBeenCalledWith(transform);
  });

  it('skips setNameTransform when config has none', async () => {
    mockGetGameConfig.mockReturnValue({});
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockSetNameTransform).not.toHaveBeenCalled();
  });

  it('registers the engine-global TimeManager', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockRegisterManager).toHaveBeenCalledWith(expect.objectContaining({ name: 'engine.time' }));
  });

  it('registers the engine-global NavigationManager', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockRegisterManager).toHaveBeenCalledWith(expect.objectContaining({ name: 'engine.navigation' }));
  });

  it('registers the Zone2D/Zone3D trigger event buses', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockRegisterManager).toHaveBeenCalledWith(expect.objectContaining({ name: 'Zone2DEvents' }));
    expect(mockRegisterManager).toHaveBeenCalledWith(expect.objectContaining({ name: 'Zone3DEvents' }));
  });

  it('registers the TimelineEvents sequence bus', async () => {
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockRegisterManager).toHaveBeenCalledWith(expect.objectContaining({ name: 'TimelineEvents' }));
  });
});
