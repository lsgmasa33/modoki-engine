/** #1076 — the shared input-vocabulary check every input surface refuses against.
 *
 *  The routes that call it are covered through the routes themselves (`inputRoutes.test.ts`,
 *  `routeVocabularyForwarding.test.ts`, `bridgePointerButtonVocab.test.ts`); this pins the predicate's
 *  own edges once, so each of those can assert the refusal happened without re-deriving them. */

import { describe, it, expect } from 'vitest';
import {
  DEVICE_KEY_MODIFIERS, EDITOR_INPUT_MODIFIERS, INPUT_KEYS, KEY_ARG_DESCRIPTION, MOUSE_BUTTONS,
  POINTER_ACTIONS, domCodeForKey, normalizeKeyName, refuseDeviceInputVocabulary, refuseUnknownKey,
  refuseUnknownValue, refuseUnknownValues,
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

  // #1094 — `key` was the one vocabulary #1076 left open, at the one predicate BOTH device
  // transports pass (CDP dispatches press-key itself and never reaches the bridge handler).
  it('press-key: an unrecognised key NAME is refused, a recognised one is not', () => {
    expect(refuseDeviceInputVocabulary('press-key', { key: 'NumpadEnter' })?.options).toEqual([...INPUT_KEYS]);
    expect(refuseDeviceInputVocabulary('press-key', { key: 'Excape' })).not.toBeNull();
    expect(refuseDeviceInputVocabulary('press-key', { key: 'Escape' })).toBeNull();
    expect(refuseDeviceInputVocabulary('press-key', { key: 'Up' })).toBeNull();
    expect(refuseDeviceInputVocabulary('press-key', { key: 'z' })).toBeNull();
    // A MISSING key stays the handler's own refusal, not this one.
    expect(refuseDeviceInputVocabulary('press-key', {})).toBeNull();
  });

  it('type-text: the same key vocabulary guards submitKey, and an absent one is not a refusal', () => {
    expect(refuseDeviceInputVocabulary('type-text', { text: 'abc', submitKey: 'Retrun' })).not.toBeNull();
    expect(refuseDeviceInputVocabulary('type-text', { text: 'abc', submitKey: 'Enter' })).toBeNull();
    expect(refuseDeviceInputVocabulary('type-text', { text: 'abc' })).toBeNull();
  });
});

describe('normalizeKeyName (#1094)', () => {
  it.each([...INPUT_KEYS])('ACCEPT: %s is its own canonical name', (key) => {
    expect(normalizeKeyName(key)).toBe(key);
  });

  it.each([
    ['Return', 'Enter'], ['Esc', 'Escape'], ['Space', ' '],
    ['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Left', 'ArrowLeft'], ['Right', 'ArrowRight'],
  ])('the MEASURED alias %s resolves to %s', (sent, canonical) => {
    expect(normalizeKeyName(sent)).toBe(canonical);
  });

  it.each(['escape', 'ESCAPE', 'arrowup', 'f12', 'return'])('a NAME is matched case-insensitively: %s', (sent) => {
    expect(normalizeKeyName(sent)).not.toBeNull();
  });

  it('a single character is verbatim and case-SIGNIFICANT — the case-insensitive path must not reach it', () => {
    expect(normalizeKeyName('w')).toBe('w');
    expect(normalizeKeyName('W')).toBe('W');
    expect(normalizeKeyName('+')).toBe('+');
    expect(normalizeKeyName(' ')).toBe(' ');
  });

  it('counts CODE POINTS, so an emoji is one character rather than an unmatched two-unit string', () => {
    expect('\u{1F600}'.length).toBe(2); // the trap this guards
    expect(normalizeKeyName('\u{1F600}')).toBe('\u{1F600}');
  });

  it.each(['NumpadEnter', 'KeyW', 'Excape', 'Enterr', 'zzz', 'F25', 'Del', ''])('unrecognised: %s', (sent) => {
    expect(normalizeKeyName(sent)).toBeNull();
  });

  it.each(PROTO_KEYS)('a prototype key is not a key name: %s', (sent) => {
    expect(normalizeKeyName(sent)).toBeNull();
  });
});

describe('domCodeForKey — `code` must not be derived from `key` (#1094 review)', () => {
  // The bug this exists to stop: #1094 canonicalised `key` at the shared predicate, and both device
  // transports derived `code` from it with a single-letter rule. That is right for 'w' and WRONG
  // wherever the physical key differs from what it produces — so the fix repaired `e.key` and broke
  // `e.code` on the very same call. Every row below is MEASURED against Electron (2026-09-12).
  it.each([
    [' ', 'Space'],
    ['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['Alt', 'AltLeft'], ['Meta', 'MetaLeft'],
  ])('%s reports code %s', (key, code) => {
    expect(domCodeForKey(key)).toBe(code);
  });

  it('a single letter still follows the KeyX rule, and a named key is already its own code', () => {
    expect(domCodeForKey('w')).toBe('KeyW');
    expect(domCodeForKey('W')).toBe('KeyW');
    expect(domCodeForKey('ArrowUp')).toBe('ArrowUp');
    expect(domCodeForKey('F12')).toBe('F12');
  });

  it('⚠️ the spacebar is reachable by BOTH spellings and lands identically', () => {
    // `Space` is the alias, `' '` the canonical key — a caller using either must get the same event.
    expect(domCodeForKey(normalizeKeyName('Space')!)).toBe('Space');
    expect(domCodeForKey(normalizeKeyName(' ')!)).toBe('Space');
  });

  // ⚠️ This test used to assert `domCodeForKey('1') === '1'` and PINNED A BUG: the single-letter rule
  // fell through for every digit and punctuation mark, emitting a `code` no browser produces, so
  // `e.code === 'Digit1'` never fired on either transport. All 21 measured on a US layout.
  it.each([
    ['0', 'Digit0'], ['1', 'Digit1'], ['9', 'Digit9'],
    ['-', 'Minus'], ['=', 'Equal'], ['[', 'BracketLeft'], [']', 'BracketRight'], ['\\', 'Backslash'],
    [';', 'Semicolon'], ["'", 'Quote'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], ['`', 'Backquote'],
  ])('%s reports code %s, not itself', (key, code) => {
    expect(domCodeForKey(key)).toBe(code);
  });

  it('every single-character key the table covers reports a code that is NOT the key itself', () => {
    // The shape of the bug: a fallback returning the key verbatim looks plausible and is wrong for
    // every non-letter. Nothing one character long should pass through unchanged.
    for (const ch of ['0', '5', '-', '.', '/', ';', ' ']) expect(domCodeForKey(ch)).not.toBe(ch);
  });
});

describe('a bare modifier is a pressable key (#1094 review)', () => {
  // Excluding these was wrong: the editor's own keymap models a modifier-only press
  // (`BARE_MODIFIERS` in editor/input/keyReach.ts), and refusing them made that branch unreachable
  // from its only production caller. MEASURED reaching the renderer as {key:'Shift',code:'ShiftLeft'}.
  it.each(['Shift', 'Control', 'Alt', 'Meta'])('%s is accepted and is its own canonical name', (key) => {
    expect(normalizeKeyName(key)).toBe(key);
    expect(refuseUnknownKey('key', key)).toBeNull();
  });

  it('they are NOT the modifier vocabulary — that one is lower-case and means HELD', () => {
    // `modifiers:['shift']` holds shift across another key; `key:'Shift'` presses shift itself.
    expect(normalizeKeyName('shift')).toBe('Shift');
    expect(EDITOR_INPUT_MODIFIERS).toContain('shift');
    expect(EDITOR_INPUT_MODIFIERS as readonly string[]).not.toContain('Shift');
  });
});

describe('refuseUnknownKey (#1094)', () => {
  it.each([undefined, null])('%s is "not given" — an optional submitKey is absent, not wrong', (value) => {
    expect(refuseUnknownKey('submitKey', value)).toBeNull();
  });

  it('names the key/code confusion, because that is the mistake actually observed', () => {
    const r = refuseUnknownKey('key', 'NumpadEnter');
    expect(r?.error).toMatch(/unrecognised key name "NumpadEnter" — nothing was dispatched/);
    expect(r?.error).toMatch(/KeyboardEvent\.key, not \.code/);
    expect(r?.options).toEqual([...INPUT_KEYS]);
  });

  it('a non-string is refused rather than coerced', () => {
    expect(refuseUnknownKey('key', 42)).not.toBeNull();
    expect(refuseUnknownKey('key', { key: 'Enter' })).not.toBeNull();
  });

  it("'' is NOT GIVEN — and it is decided here, so both hosts answer the same", () => {
    // An optional terminal key has always taken `''` to mean "no submit key", and the device bridge's
    // own falsy check already did. The first cut normalised it at the editor ROUTE instead, which
    // made the same call succeed on the editor and refuse on the device — the per-host divergence
    // docs/mcp-tool-conventions.md §5 forbids, reintroduced by the fix for it.
    expect(refuseUnknownKey('submitKey', '')).toBeNull();
    expect(refuseDeviceInputVocabulary('type-text', { text: 'abc', submitKey: '' })).toBeNull();
  });

  it('⚠️ but a non-string FALSY is not absent — it is wrong, and still refused', () => {
    // The trap in spelling "absent" as `value || undefined`: it swallows 0 and false, which is
    // exactly #1094's "a wrong value silently does nothing and reports ok".
    for (const v of [0, false, NaN]) expect(refuseUnknownKey('submitKey', v)).not.toBeNull();
  });

  it('every name the refusal ADVERTISES as valid is one the predicate accepts', () => {
    for (const key of refuseUnknownKey('key', 'nope')!.options) expect(refuseUnknownKey('key', key)).toBeNull();
  });
});

describe('KEY_ARG_DESCRIPTION is derived from the table, not hand-copied (#1094)', () => {
  // `key` cannot be a z.enum (a single character is legal), so the advertised/enforced parity that
  // vocabularyEnumParity.test.ts gives the other vocabularies is carried by this string instead.
  it('names every non-function key, and the F-run as a range', () => {
    for (const key of INPUT_KEYS) {
      if (/^F\d+$/.test(key)) continue;
      expect(KEY_ARG_DESCRIPTION).toContain(key);
    }
    expect(KEY_ARG_DESCRIPTION).toContain('F1-F24');
  });

  it('states the rule the predicate actually implements', () => {
    expect(KEY_ARG_DESCRIPTION).toMatch(/single character/);
    expect(KEY_ARG_DESCRIPTION).toMatch(/case-insensitively/);
    expect(KEY_ARG_DESCRIPTION).toMatch(/NOT \.code/);
  });
});
