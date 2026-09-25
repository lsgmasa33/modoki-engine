/** Schema PROSE an agent pays for, across BOTH MCP servers (#1555).
 *
 *  `DEFINITION_BYTES` (`mcpRegistry.test.ts`) prices the editor surface as a whole and stops it
 *  growing unnoticed. It cannot see HOW the bytes are spent, and the 2026-09-25 audit (T-4, T-5)
 *  measured two ways they were being wasted that a total cannot catch:
 *
 *  - **Repeated prose.** The §1 no-`$ref` rule makes every aimed input tool carry its own copy of
 *    the aim STRUCTURE, and the prose rode along: description strings over 80 B repeated three or
 *    more times came to 26.8 KB, `allowOccluded` alone in ten wordings. A loaded schema is paid for
 *    once and then re-read on every later turn, so each copy recurs.
 *  - **History.** "used to be called…", "this description used to claim…", a bare `(#32)` — true,
 *    and of no use to an agent choosing arguments now. It belongs in docs and code comments.
 *
 *  The device server is on zod 4 and the editor on zod 3, so each schema is converted with its own
 *  dialect's JSON-Schema emitter — the same JSON an MCP client receives. */
import { describe, it, expect, afterEach } from 'vitest';
import { zodToJsonSchema } from '../../tools/modoki-mcp/node_modules/zod-to-json-schema';
import { z as z4 } from '../../tools/game-debug-mcp/node_modules/zod';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { loadSurface } from './mcpSurface';
import { loadDeviceSurface } from './deviceSurface';
import { DESCRIPTION_HISTORY } from './firstSentence';
import { ALLOW_OCCLUDED_BASE, ALLOW_OCCLUDED_NESTED, ENTITY_AIM_BASE, SURFACE_AIM_BASE } from '../../tools/shared/aimVocabulary';

type Json = Record<string, unknown>;
/** One description as a client reads it. `path` is the dotted property path inside the tool's
 *  input schema (`from.entity.surface`); empty for the tool's own description. */
type Prose = { tool: string; path: string; text: string };

/** Walk a JSON Schema for every `description`, keeping the property path. Descends into the
 *  containers the live surface uses — an array's `items` and a union's branches keep their
 *  parent's path, since a client addresses them by the same name. */
function walk(node: unknown, tool: string, path: string, out: Prose[]): void {
  if (Array.isArray(node)) { for (const n of node) walk(n, tool, path, out); return; }
  if (!node || typeof node !== 'object') return;
  const n = node as Json;
  if (typeof n.description === 'string' && path) out.push({ tool, path, text: n.description });
  if (n.properties && typeof n.properties === 'object') {
    for (const [k, v] of Object.entries(n.properties as Json)) walk(v, tool, path ? `${path}.${k}` : k, out);
  }
  for (const k of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties'] as const) {
    if (n[k] && typeof n[k] === 'object') walk(n[k], tool, path, out);
  }
}

type Loaded = { prose: Prose[]; schemas: Map<string, Json>; restore: () => void };

async function loadBoth(): Promise<Loaded> {
  const s = loadSurface();
  const d = await loadDeviceSurface();
  const prose: Prose[] = [];
  const schemas = new Map<string, Json>();
  for (const name of s.names) {
    prose.push({ tool: name, path: '', text: s.descriptionOf(name) });
    const schema = s.schemaFor(name);
    if (!schema) continue;
    const json = zodToJsonSchema(schema as never) as Json;
    schemas.set(name, json);
    walk(json, name, '', prose);
  }
  for (const name of d.names) {
    prose.push({ tool: name, path: '', text: d.descriptionOf(name) });
    const json = z4.toJSONSchema(z4.object(d.shapeFor(name) as never), { unrepresentable: 'any' }) as Json;
    schemas.set(name, json);
    walk(json, name, '', prose);
  }
  return { prose, schemas, restore: () => { s.restore(); d.restore(); } };
}

/** Bytes spent on description strings over 80 B that appear three or more times. */
function repeatedProseBytes(prose: readonly Prose[]): { bytes: number; top: string[] } {
  const byText = new Map<string, number>();
  for (const p of prose) byText.set(p.text, (byText.get(p.text) ?? 0) + 1);
  const rows = [...byText].filter(([t, n]) => t.length > 80 && n >= 3).map(([t, n]) => ({ t, n, bytes: t.length * n }));
  rows.sort((a, b) => b.bytes - a.bytes);
  return {
    bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
    top: rows.slice(0, 5).map((r) => `${r.n}x ${r.t.length} B: ${r.t.slice(0, 70)}…`),
  };
}

/** History in a description (`firstSentence.ts`, shared with the game-tool guard). */
const HISTORY = DESCRIPTION_HISTORY;

/** Descriptions whose history explains CURRENT behaviour, so cutting it would lose a rule. */
const HISTORY_EXEMPT: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'modoki_set_transform', reason: '`space` has no default BECAUSE it was once documented as "world" while writing local fields — the history is the reason for the required param' },
];

/** `As \`from.entity\`.` — a pointer at a sibling field in the SAME tool. */
const POINTER = /^As `([\w.]+)`\.$/;

function resolvePath(schema: Json, path: string): Json | undefined {
  let node: Json | undefined = schema;
  for (const key of path.split('.')) {
    const props = node?.properties as Json | undefined;
    node = props?.[key] as Json | undefined;
    // An optional nested object may be emitted as a union; take the object branch.
    if (node && !node.properties && Array.isArray(node.anyOf)) {
      node = (node.anyOf as Json[]).find((b) => b && typeof b === 'object' && 'properties' in b) ?? node;
    }
  }
  return node;
}

describe('schema prose an agent re-reads every turn (#1555)', () => {
  let loaded: Loaded | undefined;
  afterEach(() => { loaded?.restore(); loaded = undefined; });

  it('prose repeated across tools stays under its ceiling', async () => {
    loaded = await loadBoth();
    // Measured 2026-09-25 (#1555): 26,847 B before (read off tools/list), 15,450 B after on this
    // walk (734 descriptions across both servers). A CEILING with headroom, never
    // a floor — a floor pinned at today's number is a frozen baseline that reddens on whoever
    // removes prose next, which is the direction this exists to encourage.
    const CEILING = 16_500;
    const { bytes, top } = repeatedProseBytes(loaded.prose);
    expect(bytes, `repeated description prose is ${bytes} B, past ${CEILING}. Largest:\n  ${top.join('\n  ')}\n`
      + 'A field that must repeat its STRUCTURE (§1, no $ref) need not repeat its prose: share one '
      + 'wording (tools/shared/aimVocabulary.ts) and point a nested copy at the statement in the same '
      + 'tool. If the spend is earned, raise CEILING and say why.').toBeLessThanOrEqual(CEILING);
    expect(loaded.prose.length, 'the walk found almost nothing — it has stopped descending').toBeGreaterThan(600);
  });

  it('a description states current behaviour, not its history', async () => {
    loaded = await loadBoth();
    assertExemptionLedger({
      label: 'HISTORY_EXEMPT in mcpDescriptionProse',
      population: loaded.prose.filter((p) => HISTORY.test(p.text)).map((p) => ({
        item: p.tool, site: `${p.tool}${p.path ? `.${p.path}` : ''}: "${p.text.match(new RegExp(`.{0,50}(?:${HISTORY.source}).{0,30}`))?.[0]}"`,
      })),
      exempt: HISTORY_EXEMPT,
      scanned: loaded.prose.length,
      floor: 600,
      fix: 'say what the tool does NOW; move the history and the issue number to a code comment or the feature doc.',
    });
  });

  it('…and THAT detector can fail', () => {
    expect(HISTORY.test('trusted input on iOS (#32) — else synthetic')).toBe(true);
    expect(HISTORY.test('This is the param that used to be called `force`')).toBe(true);
    expect(HISTORY.test('Since #845 a change is parked')).toBe(true);
    expect(HISTORY.test('refuses NOT_FOUND for an entity that no longer exists')).toBe(false);
    expect(HISTORY.test('#fff background')).toBe(false);
    // The two forms the first regex missed (#1555 review), and an entity it must not take.
    expect(HISTORY.test('not OS-level trusted input; see #32.')).toBe(true);
    expect(HISTORY.test('(#373 part 2; the toolbar button')).toBe(true);
    expect(HISTORY.test('a quote is &#39; here')).toBe(false);
    expect(HISTORY.test('tint:#000000; fill')).toBe(false);
    expect(HISTORY.test('Until now this was reachable only through modoki_eval')).toBe(true);
  });

  it('every aim states the rule in ONE wording on both servers, or points within its own tool', async () => {
    loaded = await loadBoth();
    const bad: string[] = [];
    let aims = 0;
    const fullAimsPerTool = new Map<string, string[]>();
    for (const p of loaded.prose) {
      const leaf = p.path.split('.').pop();
      const nested = p.path.includes('.');
      const pointer = POINTER.exec(p.text);
      if (pointer) {
        // A pointer must land on a field in the same tool that says something itself.
        const target = resolvePath(loaded.schemas.get(p.tool)!, pointer[1]);
        const said = target?.description as string | undefined;
        if (!said || POINTER.test(said)) bad.push(`${p.tool}.${p.path} points at \`${pointer[1]}\`, which ${said ? 'is itself a pointer' : 'does not exist or says nothing'}`);
        continue;
      }
      if (leaf === 'allowOccluded') {
        aims++;
        if (nested ? p.text !== ALLOW_OCCLUDED_NESTED : !p.text.includes(ALLOW_OCCLUDED_BASE)) {
          bad.push(`${p.tool}.${p.path}: ${nested ? 'a nested allowOccluded must be ALLOW_OCCLUDED_NESTED' : 'must extend ALLOW_OCCLUDED_BASE'}`);
        }
      } else if (leaf === 'surface' && p.path.endsWith('entity.surface')) {
        aims++;
        if (!p.text.includes(SURFACE_AIM_BASE)) bad.push(`${p.tool}.${p.path}: must extend SURFACE_AIM_BASE`);
      } else if (leaf === 'entity' && resolvePath(loaded.schemas.get(p.tool)!, `${p.path}.surface`)) {
        aims++;
        if (!p.text.includes(ENTITY_AIM_BASE)) bad.push(`${p.tool}.${p.path}: an entity aim must extend ENTITY_AIM_BASE`);
        fullAimsPerTool.set(p.tool, [...(fullAimsPerTool.get(p.tool) ?? []), p.path]);
      }
    }
    // One full aim statement per tool: a second one (drag's `to` beside `from`) must point at the
    // first. The ceiling below cannot hold this on its own — reverting the device drag's `sameAs`
    // stayed under it (#1555 review), and a full copy still extends ENTITY_AIM_BASE, so nothing
    // above would notice either.
    for (const [tool, paths] of fullAimsPerTool) {
      if (paths.length > 1) bad.push(`${tool}: ${paths.length} full entity-aim statements (${paths.join(', ')}) — build the later ones with sameAs`);
    }
    expect(bad, 'aim prose drifted from tools/shared/aimVocabulary.ts').toEqual([]);
    // tap/drag/pointer/hover/scroll/focus/handle tools on two servers: well over this.
    expect(aims, 'the aim walk found almost nothing — it has stopped matching').toBeGreaterThan(30);
  });
});
