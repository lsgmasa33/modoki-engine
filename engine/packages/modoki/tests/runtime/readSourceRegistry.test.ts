/** Read-source registry + binding-resolver integration. Manager/System-exposed
 *  live values resolve in `{name}` templates, with store state taking priority. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  registerReadSource, unregisterReadSource, getReadValue, getReadSourceNames,
  __resetReadSourcesForTesting,
} from '../../src/runtime/ui/readSourceRegistry';
import { resolveTemplate } from '../../src/runtime/ui/bindingResolver';

describe('readSourceRegistry', () => {
  afterEach(() => __resetReadSourcesForTesting());

  it('reads a registered value live each call', () => {
    let n = 1;
    registerReadSource('counter', () => n);
    expect(getReadValue('counter')).toBe(1);
    n = 2;
    expect(getReadValue('counter')).toBe(2);
  });

  it('returns undefined for an unregistered name', () => {
    expect(getReadValue('nope')).toBeUndefined();
  });

  it('swallows a throwing getter (returns undefined, does not propagate)', () => {
    registerReadSource('boom', () => { throw new Error('x'); });
    expect(() => getReadValue('boom')).not.toThrow();
    expect(getReadValue('boom')).toBeUndefined();
  });

  it('re-register replaces; unregister removes', () => {
    registerReadSource('v', () => 'a');
    registerReadSource('v', () => 'b');
    expect(getReadValue('v')).toBe('b');
    unregisterReadSource('v');
    expect(getReadValue('v')).toBeUndefined();
    expect(getReadSourceNames()).not.toContain('v');
  });

  it('returns an identity-safe disposer that removes only its own registration', () => {
    const disposeA = registerReadSource('shared', () => 'A');
    expect(getReadValue('shared')).toBe('A');
    disposeA();
    expect(getReadValue('shared')).toBeUndefined();
  });

  // F9 footgun guard: owner B overwrites owner A's name; A's late disposer must NOT
  // yank B's getter (the bug the bare name-keyed unregister has).
  it('a stale disposer does not clobber a later registrant of the same name', () => {
    const disposeA = registerReadSource('canGoBack', () => 'A');
    registerReadSource('canGoBack', () => 'B'); // B shadows A
    disposeA();                                  // A tears down later
    expect(getReadValue('canGoBack')).toBe('B'); // B survives — not deleted by A
  });
});

describe('resolveTemplate ← read sources', () => {
  afterEach(() => __resetReadSourcesForTesting());

  it('resolves a placeholder from a registered read source when the store lacks it', () => {
    registerReadSource('timeSinceGameStart', () => 12);
    expect(resolveTemplate('t={timeSinceGameStart}', {})).toBe('t=12');
  });

  it('store state takes priority over a read source of the same name', () => {
    registerReadSource('score', () => 999);
    expect(resolveTemplate('s={score}', { score: 5 })).toBe('s=5');
  });

  it('leaves the placeholder literal when neither store nor source resolves', () => {
    expect(resolveTemplate('x={missing}', {})).toBe('x={missing}');
  });

  it('mixes store and read-source placeholders in one template', () => {
    registerReadSource('canGoBack', () => false);
    expect(resolveTemplate('{name}/{canGoBack}', { name: 'Menu' })).toBe('Menu/false');
  });
});
