import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRegisterAllTraits = vi.fn();
const mockSetNameTransform = vi.fn();
const mockGetGameConfig = vi.fn().mockReturnValue({});

vi.mock('../../app/ecs/registerTraits', () => ({
  registerAllTraits: () => mockRegisterAllTraits(),
}));

const mockRegisterManager = vi.fn();
const mockUnregisterManagers = vi.fn();
const mockAudioDispose = vi.fn();
const mockDisposeAllAudioBuffers = vi.fn();
const mockDisposeAudioContext = vi.fn();
const mockClearLateUpdates = vi.fn();
const mockSetPhysicsLayers = vi.fn();
const mockSetTargetFPS = vi.fn();
/** Returns a value that is NOT the project config's `targetFps`, deliberately — see the frame-cap
 *  test below for why an equal value could not tell the two code paths apart. */
const mockGetEffectiveTargetFps = vi.fn(() => 30);
const mockSetRenderSettings = vi.fn();

vi.mock('@modoki/engine/runtime', () => ({
  getGameConfig: () => mockGetGameConfig(),
  // setNameTransform is now imported from the engine public API (the app shim
  // app/ecs/traitRegistry was removed in ELECTRON_PLAN Phase 4).
  setNameTransform: (...args: any[]) => mockSetNameTransform(...args),
  registerEngineActions: () => {},
  registerAudioControls: () => {},
  registerHapticControls: () => {},
  registerQualityControls: () => {},
  registerVideoControls: () => {},
  registerManager: (...args: any[]) => mockRegisterManager(...args),
  unregisterManagers: (...args: any[]) => mockUnregisterManagers(...args),
  audioDispose: () => mockAudioDispose(),
  disposeAllAudioBuffers: () => mockDisposeAllAudioBuffers(),
  disposeAudioContext: () => mockDisposeAudioContext(),
  clearLateUpdates: () => mockClearLateUpdates(),
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
  getEffectiveTargetFps: () => mockGetEffectiveTargetFps(),
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

describe('the frame cap goes through the TIER-AWARE accessor (#202)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('reads `getEffectiveTargetFps()`, not `projectConfig.rendering.targetFps`', async () => {
    // ⚠️ A DISTINGUISHING OBSERVATION, and it has to be. The two sources agree at boot (no tier
    // has resolved yet), so a test whose mock returned the project's own 60 would pass under BOTH
    // the old direct read and the new accessor and prove nothing. The mock returns 30 instead:
    // only the accessor path can produce it.
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    expect(mockGetEffectiveTargetFps).toHaveBeenCalled();
    expect(mockSetTargetFPS).toHaveBeenCalledWith(30);
  });

  it('injects the render settings BEFORE reading the cap back', async () => {
    // Order is load-bearing: `getEffectiveTargetFps()` reads the AUTHORED value out of the
    // settings registry, so a call made before `setRenderSettings` would read the engine default
    // rather than what the project asked for.
    const { registerAll } = await import('../../app/ecs/register');
    registerAll();
    const injected = mockSetRenderSettings.mock.invocationCallOrder[0];
    const capRead = mockGetEffectiveTargetFps.mock.invocationCallOrder[0];
    expect(injected).toBeLessThan(capRead);
  });
});

describe('teardownAll — the inverse half (#534)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetGameConfig.mockReturnValue({});
  });

  it('unregisters EXACTLY the managers registerAll registered — no drift', async () => {
    // The guard on `APP_MANAGER_NAMES`, which is a hand-written list of string literals. It is
    // spelled that way on purpose (`appManagerDisposeReachable.test.ts` scans source text and
    // distrusts identifiers), and the cost of that choice is that a ninth `registerManager(...)`
    // added to `registerAll` would silently never be torn down. This is what makes that loud:
    // the two sides are compared as SETS, so an addition on either side alone fails.
    const { registerAll, teardownAll } = await import('../../app/ecs/register');
    registerAll();
    teardownAll();
    const registered = mockRegisterManager.mock.calls.map(([m]: any[]) => m.name).sort();
    const [torndown] = mockUnregisterManagers.mock.calls[0] as [string[]];
    expect([...torndown].sort()).toEqual(registered);
  });

  it('disposes audio in the order service → buffers → context', async () => {
    // ORDER IS LOAD-BEARING and only a mocked suite can see it. `audioService`'s node graph caches
    // GainNodes hanging off the shared context and the buffer cache holds AudioBuffers that context
    // decoded, so closing the context FIRST leaves both alive pointing at a dead one — a state
    // `graphOrNull()` cannot detect, since it only rebuilds when `graph` is null.
    const { registerAll, teardownAll } = await import('../../app/ecs/register');
    registerAll();
    teardownAll();
    const svc = mockAudioDispose.mock.invocationCallOrder[0];
    const buf = mockDisposeAllAudioBuffers.mock.invocationCallOrder[0];
    const ctx = mockDisposeAudioContext.mock.invocationCallOrder[0];
    expect(svc).toBeLessThan(buf);
    expect(buf).toBeLessThan(ctx);
  });

  it('drops the LateUpdate registry', async () => {
    const { registerAll, teardownAll } = await import('../../app/ecs/register');
    registerAll();
    teardownAll();
    expect(mockClearLateUpdates).toHaveBeenCalledTimes(1);
  });

  it('re-arms registerAll, and does nothing when nothing is registered', async () => {
    const { registerAll, teardownAll } = await import('../../app/ecs/register');
    teardownAll();                                    // cold — must be inert
    expect(mockUnregisterManagers).not.toHaveBeenCalled();
    registerAll();
    teardownAll();
    registerAll();                                    // the re-arm
    expect(mockRegisterAllTraits).toHaveBeenCalledTimes(2);
    teardownAll();
    teardownAll();                                    // second call in a row — still inert
    expect(mockUnregisterManagers).toHaveBeenCalledTimes(2);
  });
});
