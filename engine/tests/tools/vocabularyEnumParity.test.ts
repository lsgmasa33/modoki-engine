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
import { EDITOR_JOURNAL_SOURCES } from '../../packages/modoki/src/editor/editorJournal';

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

  it('modoki_create_entity.kind offers every runtime kind except `environment`', () => {
    surface = loadSurface();
    const offered = enumOf(surface, 'modoki_create_entity', 'kind');
    // Every kind the tool offers must be one the op builds.
    expect(offered.filter((k) => !(CREATE_ENTITY_KINDS as readonly string[]).includes(k))).toEqual([]);
    // And the one the op builds that the tool does not offer is named, so a NEW kind added to the
    // runtime without the tool fails here instead of being quietly unreachable.
    expect(CREATE_ENTITY_KINDS.filter((k) => !offered.includes(k))).toEqual(['environment']);
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

describe('device_journal accepts every runtime journal level', () => {
  it.each([...JOURNAL_LEVELS])('level %s', async (level) => {
    device = await loadDeviceSurface();
    expect(device.validate('device_journal', { level }).ok).toBe(true);
  });
});
