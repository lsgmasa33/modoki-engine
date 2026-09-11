/** #1076 — the shared input-vocabulary check every input surface refuses against.
 *
 *  The routes that call it are covered through the routes themselves (`inputRoutes.test.ts`,
 *  `routeVocabularyForwarding.test.ts`, `bridgePointerButtonVocab.test.ts`); this pins the predicate's
 *  own edges once, so each of those can assert the refusal happened without re-deriving them. */

import { describe, it, expect } from 'vitest';
import {
  DEVICE_KEY_MODIFIERS, EDITOR_INPUT_MODIFIERS, MOUSE_BUTTONS, POINTER_ACTIONS,
  refuseDeviceInputVocabulary, refuseUnknownValue, refuseUnknownValues,
} from '../../tools/shared/inputVocabulary';

const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('refuseUnknownValue', () => {
  it.each([undefined, null])('%s is "not given" — the caller takes the default', (value) => {
    expect(refuseUnknownValue('tap button', value, MOUSE_BUTTONS)).toBeNull();
  });

  it.each([...MOUSE_BUTTONS])('ACCEPT: %s', (value) => {
    expect(refuseUnknownValue('tap button', value, MOUSE_BUTTONS)).toBeNull();
  });

  it('refuses a typo, naming the field, the value and every option', () => {
    const r = refuseUnknownValue('tap button', 'rigth', MOUSE_BUTTONS);
    expect(r?.options).toEqual(['left', 'right', 'middle']);
    expect(r?.error).toBe('tap button: unknown value "rigth" — nothing was dispatched. Valid: left, right, middle.');
  });

  it.each(PROTO_KEYS)('refuses the prototype key %s — an array has no inherited members', (value) => {
    expect(refuseUnknownValue('tap button', value, MOUSE_BUTTONS)).not.toBeNull();
  });

  it.each([0, 2, true, {}, ['left']])('refuses the non-string %j', (value) => {
    expect(refuseUnknownValue('tap button', value, MOUSE_BUTTONS)).not.toBeNull();
  });
});

describe('refuseUnknownValues', () => {
  it.each([undefined, null])('%s is "not given"', (values) => {
    expect(refuseUnknownValues('tap modifiers', values, EDITOR_INPUT_MODIFIERS)).toBeNull();
  });

  it('ACCEPT: an empty list, and every modifier together', () => {
    expect(refuseUnknownValues('tap modifiers', [], EDITOR_INPUT_MODIFIERS)).toBeNull();
    expect(refuseUnknownValues('tap modifiers', [...EDITOR_INPUT_MODIFIERS], EDITOR_INPUT_MODIFIERS)).toBeNull();
  });

  it('names every unknown entry, and only those', () => {
    const r = refuseUnknownValues('tap modifiers', ['shift', 'cmmd', 'ctrl'], EDITOR_INPUT_MODIFIERS);
    expect(r?.error).toBe('tap modifiers: unknown values "cmmd", "ctrl" — nothing was dispatched. Valid: shift, control, alt, meta, cmd, command.');
    expect(r?.options).toEqual([...EDITOR_INPUT_MODIFIERS]);
  });

  it('refuses a bare string where a list is required', () => {
    expect(refuseUnknownValues('tap modifiers', 'shift', EDITOR_INPUT_MODIFIERS)?.error).toMatch(/^tap modifiers: expected a list, got "shift"/);
  });
});

describe('refuseDeviceInputVocabulary', () => {
  it('pointer: an unknown action or button is refused; a missing action is the handler\'s refusal, not this one', () => {
    expect(refuseDeviceInputVocabulary('pointer', { action: 'wiggle' })?.options).toEqual([...POINTER_ACTIONS]);
    expect(refuseDeviceInputVocabulary('pointer', { action: 'down', button: 'middel' })?.options).toEqual([...MOUSE_BUTTONS]);
    expect(refuseDeviceInputVocabulary('pointer', {})).toBeNull();
    expect(refuseDeviceInputVocabulary('pointer', { action: 'down', button: 'right' })).toBeNull();
  });

  it('press-key: the DEVICE modifier vocabulary, which is not the editor\'s', () => {
    expect(refuseDeviceInputVocabulary('press-key', { key: 'z', modifiers: ['meta'] })).toBeNull();
    // `control` is an editor name; the device says `ctrl`.
    expect(refuseDeviceInputVocabulary('press-key', { key: 'z', modifiers: ['control'] })?.options).toEqual([...DEVICE_KEY_MODIFIERS]);
  });

  it('any other method carries no vocabulary here', () => {
    expect(refuseDeviceInputVocabulary('tap', { button: 'rigth' })).toBeNull();
  });
});
