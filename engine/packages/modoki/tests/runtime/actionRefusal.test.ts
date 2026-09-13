/** refuseAction / isActionRefusal — the return channel a UIAction handler refuses through (#1129).
 *
 *  The dispatch-action agent op maps a refusal to `ok:false` (covered row-by-row, against the real
 *  handlers, in `engine/tests/framework/dispatchActionOp.test.ts`). These pin the helper itself: the
 *  log channel, the brand, and that `dispatchUIAction` hands the refusal back unchanged. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { refuseAction, isActionRefusal, registerUIAction, unregisterUIAction, dispatchUIAction } from '../../src/runtime/core/actionRegistry';

afterEach(() => { vi.restoreAllMocks(); });

describe('refuseAction', () => {
  it('logs through console.warn by default, console.error on request, and not at all with log:false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    refuseAction('a');
    expect(warn).toHaveBeenCalledWith('a');
    refuseAction('b', { log: 'error' });
    expect(error).toHaveBeenCalledWith('b');
    refuseAction('c', { log: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('carries the reason and a frozen COPY of detail', () => {
    const detail = { known: ['idle'] };
    const r = refuseAction('no clip', { detail, log: false });
    detail.known = ['mutated'];
    expect(r.reason).toBe('no clip');
    expect(r.detail).toEqual({ known: ['idle'] });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.detail)).toBe(true);
  });

  /** `applyBindings` holds the #466 input lock open for anything with a `then` — a refusal must not. */
  it('is not thenable', () => {
    expect('then' in refuseAction('x', { log: false })).toBe(false);
  });
});

describe('isActionRefusal', () => {
  it('recognises a refusal', () => {
    expect(isActionRefusal(refuseAction('x', { log: false }))).toBe(true);
  });

  it('rejects look-alikes and ordinary handler returns', () => {
    for (const v of [undefined, null, 0, 'refused', { reason: 'x' }, { ok: false, reason: 'x' }, Promise.resolve(), () => {}]) {
      expect(isActionRefusal(v)).toBe(false);
    }
  });
});

describe('dispatchUIAction hands a refusal back unchanged', () => {
  afterEach(() => { unregisterUIAction('test.refuses'); unregisterUIAction('test.acts'); });

  it('returns the handler refusal, and undefined from a handler that acted', () => {
    const refusal = refuseAction('nope', { log: false });
    registerUIAction('test.refuses', () => refusal);
    registerUIAction('test.acts', () => undefined);
    expect(dispatchUIAction('test.refuses')).toBe(refusal);
    expect(dispatchUIAction('test.acts')).toBeUndefined();
  });
});
