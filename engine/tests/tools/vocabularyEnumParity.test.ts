/** The MCP tools' hand-listed vocabularies must match the runtime tables the ops refuse against
 *  (#1070 / #1072).
 *
 *  `modoki-mcp` imports nothing from the engine runtime, so a tool's `z.enum([...])` cannot be
 *  derived from `LIGHT_KINDS` & co. — it is a second copy. Drift has two failure shapes, and both are
 *  silent: a value the runtime gained but the tool lacks is UNREACHABLE through the tool (zod rejects
 *  it before any op runs), and a value the tool offers but the runtime lacks is a refusal the tool
 *  advertises as valid. This pins each copy to its table instead. */

import { describe, it, expect, afterEach } from 'vitest';
import { zodToJsonSchema } from '../../tools/modoki-mcp/node_modules/zod-to-json-schema';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';
import { CREATE_ENTITY_KINDS, LIGHT_KINDS, JOURNAL_LEVELS } from '../../packages/modoki/src/runtime/index';
import { UI_PRESET_NAMES } from '../../packages/modoki/src/runtime/ui/uiAuthoring';
import { PRIMITIVE_NAMES } from '../../packages/modoki/src/runtime/loaders/primitives';
import { PRIMITIVE_SPRITE_NAMES } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { createEntitySpecKeys, resolveCreateEntitySpec } from '../../packages/modoki/src/runtime/scene/createEntitySpec';
import * as V from '../../tools/shared/createEntityVocabulary';
import { EDITOR_JOURNAL_SOURCES } from '../../packages/modoki/src/editor/editorJournal';
import { DEVICE_KEY_MODIFIERS, EDITOR_INPUT_MODIFIERS, KEY_ARG_DESCRIPTION, MOUSE_BUTTONS, POINTER_ACTIONS } from '../../tools/shared/inputVocabulary';

let surface: Surface | undefined;
let device: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; device?.restore(); device = undefined; });

function enumOf(s: Surface, tool: string, param: string): string[] {
  const json = zodToJsonSchema(s.schemaFor(tool) as never) as { properties?: Record<string, { enum?: string[] }> };
  const values = json.properties?.[param]?.enum;
  if (!values) throw new Error(`${tool}.${param} is not an enum in the advertised schema`);
  return values;
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('editor MCP tool enums == the runtime tables', () => {
  it.each([
    { tool: 'modoki_create_entity', param: 'light', table: LIGHT_KINDS },
    { tool: 'modoki_create_entity', param: 'preset', table: UI_PRESET_NAMES },
    { tool: 'modoki_journal', param: 'level', table: JOURNAL_LEVELS },
    { tool: 'modoki_editor_journal', param: 'source', table: EDITOR_JOURNAL_SOURCES },
    { tool: 'modoki_wait_for_edit', param: 'source', table: EDITOR_JOURNAL_SOURCES },
  ])('$tool $param', ({ tool, param, table }) => {
    surface = loadSurface();
    expect(sorted(enumOf(surface, tool, param))).toEqual(sorted(table));
  });

  // #1076 — the input vocabularies the `/api/input/*` routes refuse against.
  it.each([
    ...['modoki_tap', 'modoki_drag', 'modoki_pointer', 'modoki_tap_handle', 'modoki_drag_handle']
      .map((tool) => ({ tool, param: 'button', table: MOUSE_BUTTONS as readonly string[] })),
    { tool: 'modoki_pointer', param: 'action', table: POINTER_ACTIONS as readonly string[] },
  ])('$tool $param', ({ tool, param, table }) => {
    surface = loadSurface();
    expect(sorted(enumOf(surface, tool, param))).toEqual(sorted(table));
  });

  it.each(['modoki_tap', 'modoki_drag', 'modoki_pointer', 'modoki_hover', 'modoki_scroll', 'modoki_press_key', 'modoki_tap_handle', 'modoki_drag_handle'])(
    '%s modifiers', (tool) => {
      surface = loadSurface();
      const json = zodToJsonSchema(surface.schemaFor(tool) as never) as { properties?: Record<string, { items?: { enum?: string[] } }> };
      const values = json.properties?.modifiers?.items?.enum;
      if (!values) throw new Error(`${tool}.modifiers is not a list of an enum in the advertised schema`);
      expect(sorted(values)).toEqual(sorted(EDITOR_INPUT_MODIFIERS));
    });

  // #1094 — `key` is the one input vocabulary that CANNOT be a z.enum: a single character is legal
  // and enumerating every character is not. So the advertised/enforced pin is carried by the
  // DESCRIPTION instead, derived from the same table the routes refuse against. This reads the
  // PUBLISHED schema, which the constant's own unit test cannot: it catches a description edited by
  // hand back into a literal.
  it.each([
    { tool: 'modoki_press_key', param: 'key' },
    { tool: 'modoki_type_text', param: 'submitKey' },
  ])('$tool $param advertises the derived key vocabulary', ({ tool, param }) => {
    surface = loadSurface();
    const json = zodToJsonSchema(surface.schemaFor(tool) as never) as { properties?: Record<string, { description?: string }> };
    const described = json.properties?.[param]?.description;
    if (!described) throw new Error(`${tool}.${param} has no description in the advertised schema`);
    expect(described).toContain(KEY_ARG_DESCRIPTION);
  });

  // ⚠️ The DEVICE half, and it needs saying why it is a separate block rather than more rows above:
  // `device_press_key`/`device_type_text` live in a DIFFERENT package with its own registry, and
  // they derive from the same `KEY_ARG_DESCRIPTION` — so a hand-edit there drifts from the table
  // exactly as one here would, with nothing to catch it. Raised by the #1094 close-out review and
  // initially left unpinned; the two tools enforce one vocabulary, so they get one guard.
  it.each([
    { tool: 'device_press_key', param: 'key' },
    { tool: 'device_type_text', param: 'submitKey' },
  ])('$tool $param advertises the derived key vocabulary', async ({ tool, param }) => {
    device = await loadDeviceSurface();
    const described = device.shapeFor(tool)[param]?.description;
    if (!described) throw new Error(`${tool}.${param} has no description in the registered shape`);
    expect(described).toContain(KEY_ARG_DESCRIPTION);
  });

  // #1216 C-3: it offered every kind but `environment`, which the device tool and the op both built —
  // an asymmetry nothing recorded a reason for.
  it('modoki_create_entity.kind offers every runtime kind', () => {
    surface = loadSurface();
    expect(sorted(enumOf(surface, 'modoki_create_entity', 'kind'))).toEqual(sorted(CREATE_ENTITY_KINDS));
  });
});

/** #1216 C-3 — both create_entity tools derive from `tools/shared/createEntityVocabulary.ts`, a copy
 *  of the runtime tables (neither MCP package imports the engine). This pins the copy. */
describe('the shared create-entity vocabulary == the runtime tables', () => {
  it.each([
    { list: 'CREATE_ENTITY_KINDS', copy: V.CREATE_ENTITY_KINDS, table: CREATE_ENTITY_KINDS },
    { list: 'PRIMITIVE_MESHES', copy: V.PRIMITIVE_MESHES, table: PRIMITIVE_NAMES },
    { list: 'SPRITE_SHAPES', copy: V.SPRITE_SHAPES, table: PRIMITIVE_SPRITE_NAMES },
    { list: 'LIGHT_KINDS', copy: V.LIGHT_KINDS, table: LIGHT_KINDS },
    { list: 'UI_PRESETS', copy: V.UI_PRESETS, table: UI_PRESET_NAMES },
  ])('$list', ({ copy, table }) => {
    expect(sorted(copy)).toEqual(sorted(table));
  });

  it.each([...CREATE_ENTITY_KINDS])('kind %s: the same field and default the op applies', (kind) => {
    const field = (V.CREATE_ENTITY_FIELDS as Record<string, { key: string; fallback: string } | undefined>)[kind];
    expect(createEntitySpecKeys(kind)).toEqual(field ? ['kind', field.key] : ['kind']);
    if (!field) return;
    const r = resolveCreateEntitySpec({ kind });
    expect(r.ok && (r.spec as unknown as Record<string, unknown>)[field.key]).toBe(field.fallback);
  });
});

describe('device_create_entity.spec is one strict object per kind (#1216 C-3)', () => {
  it('a typo\'d key, another kind\'s field and an unknown kind are refused by the schema', async () => {
    device = await loadDeviceSurface();
    const typo = device.validate('device_create_entity', { spec: { kind: 'primitive', mseh: 'cube' } });
    expect(typo.ok).toBe(false);
    expect(typo.error).toMatch(/a "primitive" spec accepts only: kind, mesh/);
    expect(device.validate('device_create_entity', { spec: { kind: 'primitive', shape: 'circle' } }).ok).toBe(false);
    expect(device.validate('device_create_entity', { spec: { kind: 'empty', name: 'X' } }).ok).toBe(false);
    // Review: the union's own miss said only "Invalid input"; the op this now pre-empts named the kinds.
    // Mutation: drop the `error` option from makeDeviceCreateEntitySpec's z.discriminatedUnion.
    expect(device.validate('device_create_entity', { spec: { kind: 'pyramid' } }).error).toMatch(/spec\.kind must be one of: empty, primitive/);
  });

  it('every kind, alone and with its own field, is accepted', async () => {
    device = await loadDeviceSurface();
    for (const kind of CREATE_ENTITY_KINDS) {
      expect(device.validate('device_create_entity', { spec: { kind } }).ok, kind).toBe(true);
      const field = (V.CREATE_ENTITY_FIELDS as Record<string, { key: string; values: readonly string[] } | undefined>)[kind];
      for (const value of field?.values ?? []) {
        expect(device.validate('device_create_entity', { spec: { kind, [field!.key]: value } }).ok, `${kind} ${value}`).toBe(true);
      }
    }
  });
});

describe('modoki_create_entity relays every field it was given, whatever the kind (#1216 C-3)', () => {
  // The tool copied only the kind's own field into `spec`, so `{kind:'primitive', shape:'circle'}`
  // dropped `shape` before the op could refuse it and built a sphere.
  it('a field of another kind reaches the op, which refuses it', async () => {
    surface = loadSurface();
    await surface.call('modoki_create_entity', { kind: 'primitive', shape: 'circle' });
    const body = surface.last()?.body as { spec?: Record<string, unknown>; params?: { spec?: Record<string, unknown> } };
    expect(body.spec ?? body.params?.spec).toEqual({ kind: 'primitive', shape: 'circle' });
  });
});

describe('modoki_create_entity leaves the light/preset DEFAULTS to the op (#1070 close-out review)', () => {
  // The tool used to send `light: light ?? 'point'` / `preset: preset ?? 'view'` — a second copy of the
  // defaults `resolveCreateEntitySpec` now owns. Changing the runtime default would then have made
  // curl and the tool build DIFFERENT entities, and nothing pinned the defaults, only the enums.
  const relayedSpec = (s: Surface): Record<string, unknown> => {
    const body = s.last()?.body as { spec?: Record<string, unknown>; params?: { spec?: Record<string, unknown> } } | undefined;
    const spec = body?.spec ?? body?.params?.spec;
    if (!spec) throw new Error(`no spec in the relayed body: ${JSON.stringify(body)}`);
    return spec;
  };

  it.each([
    { kind: 'light', key: 'light' },
    { kind: 'ui', key: 'preset' },
  ])('{kind:"$kind"} relays no `$key` — the op picks it', async ({ kind, key }) => {
    surface = loadSurface();
    await surface.call('modoki_create_entity', { kind });
    expect(surface.last()?.path).toBe('/api/editor-action');
    expect(relayedSpec(surface)).not.toHaveProperty(key);
  });

  it('an explicit light/preset is still relayed (the accept side)', async () => {
    surface = loadSurface();
    await surface.call('modoki_create_entity', { kind: 'light', light: 'spot' });
    expect(relayedSpec(surface).light).toBe('spot');
    await surface.call('modoki_create_entity', { kind: 'ui', preset: 'button' });
    expect(relayedSpec(surface).preset).toBe('button');
  });
});

describe('device input tools accept exactly the tables the relay refuses against (#1076)', () => {
  it.each([...MOUSE_BUTTONS])('device_pointer button %s', async (button) => {
    device = await loadDeviceSurface();
    expect(device.validate('device_pointer', { action: 'down', x: 1, y: 1, button }).ok).toBe(true);
  });

  it.each([...POINTER_ACTIONS])('device_pointer action %s', async (action) => {
    device = await loadDeviceSurface();
    expect(device.validate('device_pointer', { action, x: 1, y: 1 }).ok).toBe(true);
  });

  it.each([...DEVICE_KEY_MODIFIERS])('device_press_key modifier %s', async (modifier) => {
    device = await loadDeviceSurface();
    expect(device.validate('device_press_key', { key: 'z', modifiers: [modifier] }).ok).toBe(true);
  });

  // The other half: a value outside the table is refused by the schema too, not only by the relay.
  it('a value outside each table is refused', async () => {
    device = await loadDeviceSurface();
    expect(device.validate('device_pointer', { action: 'down', x: 1, y: 1, button: 'rigth' }).ok).toBe(false);
    expect(device.validate('device_pointer', { action: 'wiggle', x: 1, y: 1 }).ok).toBe(false);
    expect(device.validate('device_press_key', { key: 'z', modifiers: ['control'] }).ok).toBe(false);
  });
});

describe('device_journal accepts every runtime journal level', () => {
  it.each([...JOURNAL_LEVELS])('level %s', async (level) => {
    device = await loadDeviceSurface();
    expect(device.validate('device_journal', { level }).ok).toBe(true);
  });
});
