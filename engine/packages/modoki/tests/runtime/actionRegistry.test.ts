/** actionRegistry unit tests — register, dispatch, get names. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function getActionRegistry() {
  return import('../../../src/runtime/ui/actionRegistry');
}

beforeEach(() => {
  vi.resetModules();
});

describe('actionRegistry', () => {
  it('dispatches registered action with payload in the context', async () => {
    const { registerUIAction, dispatchUIAction } = await getActionRegistry();

    const handler = vi.fn();
    registerUIAction('testAction', handler);

    dispatchUIAction('testAction', { payload: 'hello' });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }));
  });

  it('dispatches action with no payload (context payload undefined)', async () => {
    const { registerUIAction, dispatchUIAction } = await getActionRegistry();

    const handler = vi.fn();
    registerUIAction('noPayload', handler);

    dispatchUIAction('noPayload');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: undefined, target: undefined }));
  });

  it('resolves targetGuid to ctx.target', async () => {
    const { registerUIAction, dispatchUIAction } = await getActionRegistry();
    const { getCurrentWorld } = await import('../../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../../src/runtime/traits/EntityAttributes');

    const e = getCurrentWorld().spawn(EntityAttributes({ guid: 'target-guid' }));
    let target: unknown;
    registerUIAction('withTarget', (ctx) => { target = ctx.target; });

    dispatchUIAction('withTarget', { targetGuid: 'target-guid' });

    expect((target as { id(): number } | undefined)?.id()).toBe(e.id());
  });

  it('is inert when the sim is not running', async () => {
    const { registerUIAction, dispatchUIAction } = await getActionRegistry();
    const { setPlayState } = await import('../../../src/runtime/systems/playState');

    const handler = vi.fn();
    registerUIAction('gated', handler);
    setPlayState('stopped');
    dispatchUIAction('gated');
    expect(handler).not.toHaveBeenCalled();
    setPlayState('playing');
  });

  it('registerSystem actions option registers and unregisters its UIActions', async () => {
    const { getUIActionNames } = await getActionRegistry();
    const { registerSystem, unregisterSystem } = await import('../../../src/runtime/systems/pipeline');

    registerSystem('sysWithActions', () => {}, 100, { actions: { 'sysWithActions.go': () => {} } });
    expect(getUIActionNames()).toContain('sysWithActions.go');

    unregisterSystem('sysWithActions');
    expect(getUIActionNames()).not.toContain('sysWithActions.go');
  });

  it('throws in DEV when dispatching unregistered action (fail-fast)', async () => {
    // In production builds the code path falls back to console.warn so the
    // app doesn't crash on a stale handler name — but under vitest DEV mode
    // we want to surface the bug immediately.
    const { dispatchUIAction } = await getActionRegistry();

    expect(() => dispatchUIAction('nonexistent')).toThrow(/No handler for "nonexistent"/);
  });

  it('registers a UIActionDef with a params schema and exposes it via getUIActionParams', async () => {
    const { registerUIAction, getUIActionParams, dispatchUIAction } = await getActionRegistry();

    const handler = vi.fn();
    registerUIAction('withParams', { handler, params: { distance: { type: 'number', min: 1 } } });

    expect(getUIActionParams('withParams')).toEqual({ distance: { type: 'number', min: 1 } });

    dispatchUIAction('withParams', { params: { distance: 5 } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ params: { distance: 5 } }));
  });

  it('getUIActionParams is undefined for a bare-handler action', async () => {
    const { registerUIAction, getUIActionParams } = await getActionRegistry();
    registerUIAction('noSchema', () => {});
    expect(getUIActionParams('noSchema')).toBeUndefined();
  });

  it('getUIActionNames returns all registered names', async () => {
    const { registerUIAction, getUIActionNames } = await getActionRegistry();

    registerUIAction('actionA', () => {});
    registerUIAction('actionB', () => {});

    const names = getUIActionNames();

    expect(names).toContain('actionA');
    expect(names).toContain('actionB');
  });

  it('replaces existing handler for same name', async () => {
    const { registerUIAction, dispatchUIAction } = await getActionRegistry();

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    registerUIAction('replaceMe', handler1);
    registerUIAction('replaceMe', handler2);

    dispatchUIAction('replaceMe');

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });
});
