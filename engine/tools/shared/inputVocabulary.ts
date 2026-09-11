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

/** The device relay's vocabulary check, shared by the backend's `/api/device/request` dispatch (which
 *  every transport — CDP, WDA, synthetic — passes first) and the bridge handlers that own the tables.
 *  Only the vocabularies; a MISSING required `action` is the handler's own refusal. */
export function refuseDeviceInputVocabulary(method: string, params: Record<string, unknown>): VocabularyRefusal | null {
  if (method === 'pointer') {
    return refuseUnknownValue('pointer action', params.action, POINTER_ACTIONS)
      ?? refuseUnknownValue('pointer button', params.button, MOUSE_BUTTONS);
  }
  if (method === 'press-key') return refuseUnknownValues('press-key modifiers', params.modifiers, DEVICE_KEY_MODIFIERS);
  return null;
}
