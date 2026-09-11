/** `errorText` (#1055): an Error rendered as text always carries its message, on every JS engine.
 *
 *  These run on V8 (Node), so a JavaScriptCore stack is FABRICATED with `defineProperty`, in the
 *  exact shape an iPad produced: frames only, no `Name: message` line. */

import { describe, it, expect } from 'vitest';
import { errorText } from '../../../src/runtime/core/errorText';

/** The frames-only stack an iPad mini 5 sent to Crashlytics on 2026-09-11 (#1055), plus a second frame. */
const JSC_STACK = 'anonymous@capacitor://localhost/assets/bridge-6HfFgXzW.js:2:1673\n'
  + 'global code@capacitor://localhost/assets/index.js:1:1';

function withStack(err: Error, stack: unknown): Error {
  Object.defineProperty(err, 'stack', { value: stack, configurable: true });
  return err;
}

describe('errorText', () => {
  it('prepends Name: message to a JavaScriptCore stack, which carries frames only (the iOS symptom)', () => {
    expect(errorText(withStack(new Error('save failed'), JSC_STACK))).toBe(`Error: save failed\n${JSC_STACK}`);
  });

  it('returns a V8 stack byte-identical, so Android/editor reports and their dedupe keys do not move', () => {
    const err = new Error('boom');
    expect(errorText(err)).toBe(err.stack);
  });

  it('returns a header-only stack as-is rather than repeating it (V8 with no frames)', () => {
    expect(errorText(withStack(new Error('boom'), 'Error: boom'))).toBe('Error: boom');
  });

  it('keeps a subclass name V8 already wrote into the header', () => {
    class SaveError extends Error { override name = 'SaveError'; }
    const err = new SaveError('boom');
    expect(errorText(err)).toBe(err.stack);
    expect(errorText(err).startsWith('SaveError: boom')).toBe(true);
  });

  it('does not print the message twice when the NAME changed after V8 wrote the header', () => {
    const err = new Error('boom');
    void err.stack; // V8 formats the header on the first read
    err.name = 'Renamed';
    const out = errorText(err);
    expect(out).toBe(err.stack);
    expect(out.split('boom').length - 1).toBe(1);
  });

  it('does not LOSE a message changed after V8 wrote the header', () => {
    const err = new Error('old');
    void err.stack;
    err.message = 'while saving: old';
    const out = errorText(err);
    expect(out.startsWith('Error: while saving: old\n')).toBe(true);
    expect(out).toContain('    at ');
  });

  it('returns Name: message when there is no stack, and the name alone when there is no message', () => {
    expect(errorText(withStack(new Error('x'), ''))).toBe('Error: x');
    expect(errorText(withStack(new Error('x'), undefined))).toBe('Error: x');
    expect(errorText(withStack(new Error(''), ''))).toBe('Error');
    expect(errorText(withStack(new TypeError('bad'), JSC_STACK))).toBe(`TypeError: bad\n${JSC_STACK}`);
  });

  it('never throws on a hostile getter: it runs while something else is already failing', () => {
    const hostileStack = new Error('a');
    Object.defineProperty(hostileStack, 'stack', { get() { throw new Error('nested'); } });
    const hostileMessage = new Error('b');
    Object.defineProperty(hostileMessage, 'message', { get() { throw new Error('nested'); } });
    expect(errorText(hostileStack)).toBe('<unprintable>');
    expect(errorText(hostileMessage)).toBe('<unprintable>');
  });
});
