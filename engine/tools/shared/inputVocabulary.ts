/** The closed VOCABULARIES of agent-driven input — mouse buttons, pointer phases, modifier keys —
 *  and the one membership check every surface refuses against (#1076).
 *
 *  Each table used to exist only as an MCP tool's `z.enum([...])`. Every other way in — the Electron
 *  `/api/input/*` routes (curl, `modoki.api` from an eval), the `/api/device/request` relay, the
 *  device bridge's own handlers — read the value straight off the payload and COERCED an unknown one
 *  to a default: `button:'rigth'` pressed left, `modifiers:['cmmd']` turned Cmd+Z into a plain `z`,
 *  and the reply said `ok`. Those routes own their table (nothing sits between them and the dispatch),
 *  so they refuse, with the valid options — `docs/mcp-tool-conventions.md` §5.
 *
 *  ONE declaration for both halves: the MCP tools derive their `z.enum` from these tuples and the
 *  routes check against the same tuples, so the advertised schema and the enforced one cannot drift.
 *
 *  Dependency-free ON PURPOSE, like `simStepTiming.ts`: the Electron main process, the Node backend,
 *  both MCP servers and the device-shipped bridge all import it as a VALUE. */

/** Which mouse button a trusted press uses. Order is the tools' advertised order. */
export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

/** The three phases of a sustained pointer gesture (`/api/input/pointer`, `device_pointer`). */
export const POINTER_ACTIONS = ['down', 'move', 'up'] as const;
export type PointerAction = (typeof POINTER_ACTIONS)[number];

/** Modifier keys on the EDITOR's trusted input — Chromium `sendInputEvent` names, with the macOS
 *  aliases `cmd`/`command` for `meta`. */
export const EDITOR_INPUT_MODIFIERS = ['shift', 'control', 'alt', 'meta', 'cmd', 'command'] as const;
export type EditorInputModifier = (typeof EDITOR_INPUT_MODIFIERS)[number];

/** Modifier keys on the DEVICE's `press-key` — a DIFFERENT vocabulary from the editor's (`ctrl`, not
 *  `control`; no aliases), because it maps onto `KeyboardEvent` flags and CDP's modifier bitmask. */
export const DEVICE_KEY_MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;
export type DeviceKeyModifier = (typeof DEVICE_KEY_MODIFIERS)[number];

/** A refusal as DATA — each surface adapts it once (a 400 body, an `Error:` reply string). */
export interface VocabularyRefusal {
  error: string;
  options: string[];
}

/** `undefined` and `null` both mean "not given" — the caller takes the default (#1072's ruling on
 *  `platform:null`). Anything else must be a member. */
const given = (value: unknown): boolean => value !== undefined && value !== null;

/** `Array.prototype.includes` on the tuple, never a keyed lookup: a prototype key (`'toString'`) is
 *  not a member of an array, where it IS a "member" of an object literal (#993). */
const isMember = (value: unknown, table: readonly string[]): boolean =>
  typeof value === 'string' && table.includes(value);

/** Refuse a single value outside `table`. `what` names the field in the caller's terms. */
export function refuseUnknownValue(what: string, value: unknown, table: readonly string[]): VocabularyRefusal | null {
  if (!given(value) || isMember(value, table)) return null;
  return {
    error: `${what}: unknown value ${JSON.stringify(value)} — nothing was dispatched. Valid: ${table.join(', ')}.`,
    options: [...table],
  };
}

/** Refuse a LIST whose entries are not all in `table` (or that is not a list at all). */
export function refuseUnknownValues(what: string, values: unknown, table: readonly string[]): VocabularyRefusal | null {
  if (!given(values)) return null;
  if (!Array.isArray(values)) {
    return {
      error: `${what}: expected a list, got ${JSON.stringify(values)} — nothing was dispatched. Valid entries: ${table.join(', ')}.`,
      options: [...table],
    };
  }
  const unknown = values.filter((v) => !isMember(v, table));
  if (unknown.length === 0) return null;
  return {
    error: `${what}: unknown ${unknown.length === 1 ? 'value' : 'values'} ${unknown.map((v) => JSON.stringify(v)).join(', ')} — nothing was dispatched. Valid: ${table.join(', ')}.`,
    options: [...table],
  };
}

/** The NAMED keys a trusted press may aim at, as DOM `KeyboardEvent.key` values — the spelling the
 *  game itself compares against (`e.key === 'Escape'`), the spelling the device bridge puts on the
 *  event it constructs, and the spelling both MCP tools already advertised in prose while enforcing
 *  nothing (#1094).
 *
 *  A single CHARACTER is legal too and is not listed here (`'w'`, `'z'`, `' '`, `'+'`) — see
 *  {@link normalizeKeyName}. So the rule is "one character, or a name from this table", not a plain
 *  table lookup, which is what makes `key` the one input vocabulary #1076 left open.
 *
 *  ⚠️ Deliberately NARROWER than what Chromium accepts, and that is the trade. MEASURED on Electron
 *  43.2.0 (2026-09-12, #1094): `sendInputEvent` also takes Electron's own Accelerator dialect
 *  case-insensitively — `VolumeUp` arrives as `AudioVolumeUp`, `numadd` as `'+'` — so a closed table
 *  refuses a handful of spellings that do work. That is accepted on purpose: the caller is an AGENT,
 *  which reaches for DOM names because that is what web code looks like, and a table that IS the
 *  accepted set can print `Valid: …` truthfully. Tolerating everything Chromium knows would make
 *  that list a hint dressed as a spec, and would leave the editor and the device enforcing DIFFERENT
 *  vocabularies — the divergence #1094 filed. The spellings that survive as aliases are the ones
 *  measured to be reachable AND plausible from a caller; see {@link KEY_NAME_ALIASES}. */
export const INPUT_KEYS = [
  'Enter', 'Tab', 'Escape',
  'Backspace', 'Delete', 'Insert',
  // The bare modifier keys are pressable in their own right, and excluding them was wrong: the
  // editor's own keymap models a modifier-only press (`BARE_MODIFIERS` in `editor/input/keyReach.ts`,
  // "a bare modifier press is not a chord"), and refusing them made that branch unreachable from its
  // only production caller. MEASURED reaching the renderer as `{key:'Shift', code:'ShiftLeft'}` and
  // the other three likewise (2026-09-12). They are NOT a substitute for the `modifiers` array —
  // that HOLDS a modifier across another key; this PRESSES and releases the modifier itself.
  'Shift', 'Control', 'Alt', 'Meta',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
] as const;
export type InputKey = (typeof INPUT_KEYS)[number];

/** Spellings ACCEPTED and rewritten to their canonical {@link INPUT_KEYS} name, lower-cased keys.
 *
 *  These are Electron Accelerator names a caller can reasonably arrive at (they are what
 *  `rendererOps`' own `KEYCODE_ALIAS` and `KEY_INSERTS_TEXT` already spoke), each MEASURED to reach
 *  the renderer as the canonical key: `Return`→`Enter`, `Esc`→`Escape`, `Up`→`ArrowUp`, `Space`→`' '`.
 *  ⚠️ `Del` is NOT here — it is measured to be REJECTED by Chromium where `Delete` works, which is
 *  why this table is measured rather than reasoned: the accepted set is not guessable. */
const KEY_NAME_ALIASES = new Map<string, string>([
  ['return', 'Enter'],
  ['esc', 'Escape'],
  ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight'],
  ['space', ' '],
]);

/** Canonical name by lower-cased spelling. A Map, never an object literal: `key` is agent-supplied,
 *  and a prototype key (`'toString'`) is a "member" of an object and is not of a Map (#993). */
const INPUT_KEY_BY_LOWER = new Map<string, string>(INPUT_KEYS.map((k) => [k.toLowerCase(), k]));

/** The canonical DOM `key` for a caller's spelling, or `null` if nothing recognises it.
 *
 *  - a single CHARACTER is itself, verbatim and CASE-SIGNIFICANT (`'w'` and `'W'` are different keys,
 *    which is exactly why the case-insensitive lookup below must not reach them);
 *  - any other string is matched case-insensitively against {@link INPUT_KEYS} and
 *    {@link KEY_NAME_ALIASES}, because Chromium's own parse is case-insensitive and refusing
 *    `'escape'` while accepting `'Escape'` would be a refusal with no mechanism behind it.
 *
 *  Length is counted in CODE POINTS: `[...'😀'].length` is 1 where `'😀'.length` is 2, so an emoji is
 *  one character rather than a two-unit string that matches no name. */
export function normalizeKeyName(key: string): string | null {
  if ([...key].length === 1) return key;
  const lower = key.toLowerCase();
  return KEY_NAME_ALIASES.get(lower) ?? INPUT_KEY_BY_LOWER.get(lower) ?? null;
}

/** Refuse a key name nothing recognises. `what` names the field in the caller's terms.
 *
 *  The refusal is the whole point: an unrecognised name is NOT an error anywhere downstream. Measured
 *  (#1094): Chromium turns it into a keydown whose `key` is the EMPTY STRING, which matches no
 *  handler and inserts nothing, and every layer then reports `ok` — `type_text {submitKey:'Retrun'}`
 *  answered `ok, typed:3` having pressed nothing at all. */
export function refuseUnknownKey(what: string, value: unknown): VocabularyRefusal | null {
  // `''` is "not given" for an optional terminal key — the historical editor meaning, and what the
  // device bridge's own falsy check already did. Handled HERE rather than at either host: normalising
  // it per host is exactly the divergence §5 of docs/mcp-tool-conventions.md forbids, and the first
  // cut of this fix did it with a `|| undefined` at the route, so the same call was accepted by the
  // editor and refused by the device. A non-string falsy (`0`, `false`) is NOT absent and is refused.
  if (!given(value) || value === '') return null;
  if (typeof value === 'string' && normalizeKeyName(value) !== null) return null;
  return {
    error: `${what}: unrecognised key name ${JSON.stringify(value)} — nothing was dispatched. `
      + `Valid: a single character (e.g. "w"), or one of: ${INPUT_KEYS.join(', ')}. `
      + `Also accepted: ${[...KEY_NAME_ALIASES.keys()].join(', ')}. `
      + 'Names are matched case-insensitively. Note this is KeyboardEvent.key, not .code — '
      + '"NumpadEnter" and "KeyW" are `code` values; send "Enter" and "w".',
    options: [...INPUT_KEYS],
  };
}

/** The DOM `code` for a canonical key, where it is not derivable from the key itself.
 *
 *  `code` is the PHYSICAL key and `key` is what it produces, so the two diverge exactly where a
 *  game is most likely to test `code`: `' '` is produced by `Space`, and the modifiers report a
 *  side (`ShiftLeft`). Both device transports build `code` from `key` with the same
 *  single-letter rule, which is right for `'w'` → `KeyW` and wrong for every entry below —
 *  MEASURED against Electron (2026-09-12), which reports exactly these.
 *
 *  ⚠️ This is why it lives HERE rather than beside either copy: #1094 canonicalised `key` at the
 *  shared predicate, and a `code` derived per host would re-open the divergence one layer down —
 *  `device_press_key {key:'Space'}` would fire `e.code === 'Space'` on one transport and not the
 *  other. `bridge.ts` and `deviceCdp.ts` duplicate their `keyToCode` helper because the bridge is a
 *  browser bundle, but both already value-import THIS module. */
const DOM_CODE_FOR_KEY = new Map<string, string>([
  [' ', 'Space'],
  ['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['Alt', 'AltLeft'], ['Meta', 'MetaLeft'],
  // ⚠️ Digits and punctuation are NOT their own code, which the single-letter rule below silently
  // got wrong for all 21 — `{key:'1'}` emitted `code:'1'`, a value no browser produces, so
  // `e.code === 'Digit1'` never fired. All measured on a US layout (2026-09-12). A non-US layout
  // maps some of these to different physical keys; `params.code` remains the explicit override.
  ['0', 'Digit0'], ['1', 'Digit1'], ['2', 'Digit2'], ['3', 'Digit3'], ['4', 'Digit4'],
  ['5', 'Digit5'], ['6', 'Digit6'], ['7', 'Digit7'], ['8', 'Digit8'], ['9', 'Digit9'],
  ['-', 'Minus'], ['=', 'Equal'], ['[', 'BracketLeft'], [']', 'BracketRight'], ['\\', 'Backslash'],
  [';', 'Semicolon'], ["'", 'Quote'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], ['`', 'Backquote'],
]);

/** The DOM `code` for a canonical `key`: the measured table above, else the single-letter rule
 *  (`'w'` → `'KeyW'`), else the key itself (`ArrowUp`, `F12` and friends already match). */
export function domCodeForKey(key: string): string {
  return DOM_CODE_FOR_KEY.get(key)
    ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
}

/** The `key` argument's advertised description, DERIVED from the tables above so the schema both MCP
 *  servers publish and the set the routes enforce cannot drift — the same anti-drift job
 *  `vocabularyEnumParity.test.ts` does for the `z.enum` vocabularies, adapted because `key` cannot BE
 *  an enum (a single character is legal, and enumerating every character is not).
 *
 *  The F-key run is collapsed to a range rather than listed: this string is paid for in every
 *  session's tool manifest, where the refusal message (which does list all of them) is paid only when
 *  a call is actually wrong. */
export const KEY_ARG_DESCRIPTION = (() => {
  const fKeys = INPUT_KEYS.filter((k) => /^F\d+$/.test(k));
  const named = INPUT_KEYS.filter((k) => !/^F\d+$/.test(k)).join(', ');
  return `A DOM KeyboardEvent.key: a single character (e.g. "w"), or a named key — ${named}, `
    + `${fKeys[0]}-${fKeys[fKeys.length - 1]}. Matched case-insensitively; `
    + `${[...KEY_NAME_ALIASES.keys()].join('/')} are accepted as aliases. `
    + 'This is .key, NOT .code — "NumpadEnter" and "KeyW" are refused; send "Enter" and "w".';
})();

/** The device relay's vocabulary check, shared by the backend's `/api/device/request` dispatch (which
 *  every transport — CDP, WDA, synthetic — passes first) and the bridge handlers that own the tables.
 *  Only the vocabularies; a MISSING required `action` is the handler's own refusal. */
export function refuseDeviceInputVocabulary(method: string, params: Record<string, unknown>): VocabularyRefusal | null {
  if (method === 'pointer') {
    return refuseUnknownValue('pointer action', params.action, POINTER_ACTIONS)
      ?? refuseUnknownValue('pointer button', params.button, MOUSE_BUTTONS);
  }
  if (method === 'press-key') {
    // `key` is checked HERE and not only in the bridge handler because CDP dispatches `press-key`
    // itself and never reaches the bridge (#1076's note) — this is the one predicate both transports
    // pass. A MISSING key stays the handler's own refusal; this only judges a key that was given.
    return refuseUnknownValues('press-key modifiers', params.modifiers, DEVICE_KEY_MODIFIERS)
      ?? refuseUnknownKey('press-key key', params.key);
  }
  // The device's `type-text` carries the same terminal-key field as the editor's, with the same hole
  // (#1094) — the bridge builds `new KeyboardEvent({key: submitKey})` from whatever string arrives.
  // Optional, so an absent one is not a refusal.
  if (method === 'type-text') return refuseUnknownKey('type-text submitKey', params.submitKey);
  return null;
}
