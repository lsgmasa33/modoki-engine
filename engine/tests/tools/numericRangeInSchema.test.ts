/** A number outside a tool's range is REFUSED by the schema, not clamped downstream (#1560;
 *  docs/mcp-tool-conventions.md §5).
 *
 *  §5 already said "refused, not clamped" — two exceptions: a `timeoutMs` budget, and a clamp the
 *  reply reports (`clampedFrom`). The usage audit (2026-09-25 C-16) found the rule honoured on some
 *  tools and not others: `find_references`, `profiler`, `watch`, `input_watch` and
 *  `device_duplicate_entity` all ADVERTISED a max in the description while the schema let any
 *  number through, to be clamped (or refused with a different message) later.
 *
 *  The population is every top-level numeric param on BOTH surfaces whose description states
 *  "max N": the schema must publish that same maximum. Derived from the surfaces, so a param added
 *  later with a "max" in its prose is held to it without anyone listing it here. */

import { describe, it, expect } from 'vitest';
import { loadSurface } from './mcpSurface';
import { loadDeviceSurface } from './deviceSurface';
import { getTool } from '../../tools/modoki-mcp/src/registry';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { runAgentOp, PROFILER_BOOT_MAX } from '../../app/debug/agentBridge';
import { MAX_SAMPLES_CEIL, MAX_SERIES_CEIL } from '../../app/debug/watch';
import { MAX_CEIL as MAX_PRESSES_CEIL } from '../../packages/modoki/src/runtime/input/pointerRecorder';
import { FIND_REFERENCES_MAX_LIMIT, FIND_REFERENCES_MAX_DEPTH, RENDER_SEQUENCE_MAX_FRAMES, RENDER_SEQUENCE_MAX_FPS } from '../../plugins/backend/editorBackendRouter';
import { DUPLICATE_MAX_COUNT } from '../../app/debug/liveLifecycle';
import { CONSOLE_LOOKBACK_MAX_MS } from '../../app/debug/waitFor';
import { MAX_CAPTURE_SECONDS } from '../../plugins/backend/deviceSyslog';

/** Unwrap optional/default/nullable to the inner schema — the same accessor in zod 3 and zod 4. */
function inner(schema: unknown): unknown {
  let s = schema as { unwrap?: () => unknown; removeDefault?: () => unknown; _def?: { innerType?: unknown } };
  for (let i = 0; i < 8; i++) {
    const next = s.removeDefault?.() ?? s.unwrap?.() ?? s._def?.innerType;
    if (!next || next === s) break;
    s = next as typeof s;
  }
  return s;
}

/** A number schema's published maximum (zod 3 and zod 4 both expose `maxValue`), or undefined. */
function numberMax(schema: unknown): { isNumber: boolean; max: number | null } {
  const n = inner(schema) as { maxValue?: number | null; isInt?: boolean; _def?: { typeName?: string }; _zod?: { def?: { type?: string } } };
  const isNumber = n?._def?.typeName === 'ZodNumber' || n?._zod?.def?.type === 'number';
  const max = n?.maxValue;
  return { isNumber, max: max == null || !Number.isFinite(max) ? null : max };
}

function descriptionOf(schema: unknown): string {
  let s = schema as { description?: string; unwrap?: () => unknown; removeDefault?: () => unknown };
  for (let i = 0; i < 8 && s; i++) {
    if (s.description) return s.description;
    s = (s.removeDefault?.() ?? s.unwrap?.()) as typeof s;
  }
  return '';
}

/** The first "max N" in a description (commas and underscores in N allowed). */
function statedMax(description: string): number | null {
  const m = /(?:\b(?:max(?:imum)?|ceiling)\.?\s+|≤\s*)([\d][\d,_]*)\b/i.exec(description);
  return m ? Number(m[1].replace(/[,_]/g, '')) : null;
}

/** Params whose "max N" is deliberately NOT a schema maximum — each with why. Rows are SPENT per
 *  occurrence by the shared ledger, so a row whose param starts publishing its max (or disappears)
 *  goes red as over-blessed rather than lingering. */
const EXEMPT = [
  // Mode-dependent: the schema caps the LARGER (boot, 200) and the op refuses a capture-read over 20.
  { item: 'modoki_profiler.limit', reason: 'mode-dependent max — the schema holds boot\'s 200, the op refuses a capture-read over 20' },
  { item: 'device_profiler.limit', reason: 'mode-dependent max — the schema holds boot\'s 200, the op refuses a capture-read over 20' },
  // Source-dependent: 60 bounds an iOS SYSTEM capture (you wait for it); source:'app' is a look-back.
  { item: 'device_native_logs.seconds', reason: "source-dependent — the backend refuses a system capture over 60; an app look-back is capped at 30 days (2592000)" },
];

type Row = { item: string; site: string };

/** Every stated-max numeric param whose schema publishes a DIFFERENT maximum, plus how many stated
 *  maxima were examined. `timeoutMs` is §5's named exception on every tool — a budget, clamped. */
function mismatches(tools: Array<{ name: string; shape: Record<string, unknown> }>): { rows: Row[]; checked: number } {
  const rows: Row[] = [];
  let checked = 0;
  for (const { name, shape } of tools) {
    for (const [param, schema] of Object.entries(shape)) {
      const { isNumber, max } = numberMax(schema);
      if (!isNumber || param === 'timeoutMs') continue;
      const stated = statedMax(descriptionOf(schema));
      if (stated == null) continue;
      checked++;
      if (max !== stated) rows.push({ item: `${name}.${param}`, site: `${name}.${param}: says max ${stated}, publishes ${max ?? 'none'}` });
    }
  }
  return { rows, checked };
}

describe('a stated max is a published max (#1560)', () => {
  it('both surfaces', async () => {
    const editor = loadSurface();
    const device = await loadDeviceSurface();
    try {
      const e = mismatches(editor.names.map((name) => ({ name, shape: getTool(name)!.shape as Record<string, unknown> })));
      const d = mismatches(device.names.map((name) => ({ name, shape: device.shapeFor(name) as Record<string, unknown> })));
      assertExemptionLedger({
        label: 'EXEMPT in numericRangeInSchema',
        population: [...e.rows, ...d.rows],
        exempt: EXEMPT,
        scanned: e.checked + d.checked,
        floor: 10,
        fix: 'give the schema the max the description states (`.max(N)`), or refuse it op-side and add an EXEMPT row saying why the schema cannot hold it.',
      });
    } finally { editor.restore(); device.restore(); }
  });

  // The accessors, both sides, so the population above cannot be empty by accident.
  it('statedMax reads "max 1000", "maximum 4,096", "ceiling 500" and nothing from "maxDepth"', () => {
    expect(statedMax('default 50, max 1000).')).toBe(1000);
    expect(statedMax('(default 40, ceiling 500)')).toBe(500);
    expect(statedMax('Maximum 4,096 series')).toBe(4096);
    expect(statedMax('How many maxDepth hops')).toBeNull();
    expect(statedMax('Frame count (default 8, ≤120).')).toBe(120);
  });
});

/** The one mode-dependent max the schema cannot hold (EXEMPT above): the op refuses it instead. */
describe('profiler capture-read refuses a limit over its 20 (#1560)', () => {
  it('limit 21 is refused naming the max; 20 is read', async () => {
    // runAgentOp rethrows an OpRefusal; the route turns it into the coded §5 reply.
    await expect(runAgentOp('profiler', { action: 'capture-read', limit: 21 })).rejects.toThrow(/over the max of 20/);
    const at = await runAgentOp('profiler', { action: 'capture-read', limit: 20 }) as Record<string, unknown>;
    expect(JSON.stringify(at)).not.toMatch(/over the max/);
  });
});

/** The MCP packages bundle standalone, so each schema max is a hand COPY of an engine ceiling. The
 *  guard above ties description to schema; this ties schema to the ceiling the op actually enforces,
 *  so raising one without the other goes red (#1560 review). */
describe('each published max is the engine ceiling it mirrors', () => {
  it.each([
    ['modoki_watch', 'maxSamples', MAX_SAMPLES_CEIL], ['device_watch', 'maxSamples', MAX_SAMPLES_CEIL],
    ['modoki_watch', 'maxSeries', MAX_SERIES_CEIL], ['device_watch', 'maxSeries', MAX_SERIES_CEIL],
    ['modoki_input_watch', 'maxPresses', MAX_PRESSES_CEIL], ['device_input_watch', 'maxPresses', MAX_PRESSES_CEIL],
    ['modoki_profiler', 'limit', PROFILER_BOOT_MAX], ['device_profiler', 'limit', PROFILER_BOOT_MAX],
    ['modoki_find_references', 'limit', FIND_REFERENCES_MAX_LIMIT], ['modoki_find_references', 'maxDepth', FIND_REFERENCES_MAX_DEPTH],
    ['modoki_render_sequence', 'frames', RENDER_SEQUENCE_MAX_FRAMES], ['modoki_render_sequence', 'fps', RENDER_SEQUENCE_MAX_FPS],
    ['device_duplicate_entity', 'count', DUPLICATE_MAX_COUNT],
  ] as const)('%s.%s', async (tool, param, ceiling) => {
    let shape: Record<string, unknown>;
    if (tool.startsWith('device_')) {
      const d = await loadDeviceSurface();
      try { shape = d.shapeFor(tool) as Record<string, unknown>; } finally { d.restore(); }
    } else {
      const e = loadSurface();
      try { shape = getTool(tool)!.shape as Record<string, unknown>; } finally { e.restore(); }
    }
    expect(numberMax(shape[param]).max).toBe(ceiling);
  });

  it('modoki_wait_for console.lookbackMs (a NESTED param) publishes the waitFor ceiling', () => {
    const e = loadSurface();
    try {
      const consoleSchema = inner(getTool('modoki_wait_for')!.shape.console as unknown) as { shape: Record<string, unknown> };
      expect(numberMax(consoleSchema.shape.lookbackMs).max).toBe(CONSOLE_LOOKBACK_MAX_MS);
    } finally { e.restore(); }
  });

  it('device_native_logs states the syslog capture ceiling', async () => {
    const d = await loadDeviceSurface();
    try { expect(statedMax(descriptionOf(d.shapeFor('device_native_logs').seconds))).toBe(MAX_CAPTURE_SECONDS); } finally { d.restore(); }
  });
});
