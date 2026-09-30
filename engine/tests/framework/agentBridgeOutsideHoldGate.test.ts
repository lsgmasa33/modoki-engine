// @vitest-environment jsdom
/** #1879: the watcher's changes are HELD only where the editor is (`enableOutsideChangeHold`, turned on by
 *  `agentEditorOps.ts` with the `refresh` op that applies them). A game page in dev has no refresh, so it applies a
 *  change as it arrives, as before #1879 (close-out review U6). Driven through the real `scene-changed` listener over a
 *  fake Electron bridge; "applied" is the handler reaching the scene path (`sceneManager.getCurrent`).
 *  Mutations, measured: `if (!_holdEnabled)` made never true (always hold) → "no editor" goes red; the hold skipped
 *  (always apply) → "the editor" goes red. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sceneManager } from '@modoki/engine/runtime';

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

async function rig() {
  const handlers = new Map<string, Handler[]>();
  (window as Win).__modokiElectron = {
    bridge: { on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); }, send: vi.fn() },
  };
  const bridge = await import('../../app/debug/agentBridge');
  bridge.initAgentBridge();
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null);
  const emit = () => { for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath: '/games/g/assets/S.scene.json', kind: 'scene' }); };
  const turns = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { bridge, getCurrent, emit, turns };
}

afterEach(async () => {
  const bridge = await import('../../app/debug/agentBridge');
  bridge.enableOutsideChangeHold(false);
  bridge._resetOutsideChangesForTests();
  vi.restoreAllMocks();
});

describe('the hold is the editor\'s (#1879 review U6)', () => {
  it('no editor (a game page): a change applies as it arrives', async () => {
    const { bridge, getCurrent, emit, turns } = await rig();
    emit();
    await turns();
    expect(getCurrent).toHaveBeenCalled();
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });

  it('the editor: a change is held until a release', async () => {
    const { bridge, getCurrent, emit, turns } = await rig();
    bridge.enableOutsideChangeHold(true);
    emit();
    await turns();
    expect(getCurrent).not.toHaveBeenCalled();
    expect(bridge.pendingOutsideChanges()).toEqual(['/games/g/assets/S.scene.json']);
    await bridge.releaseOutsideChanges();
    expect(getCurrent).toHaveBeenCalled();
    expect(bridge.pendingOutsideChanges()).toEqual([]);
  });
});
