/** Device ↔ editor TWIN PARAMETER parity (#1559, conventions §9).
 *
 *  Each MCP server declares its own zod shapes, so a param added on one twin is silently absent on the
 *  other — the 2026-09-25 audit found `device_console_logs` without `since`, `device_duplicate_entity`
 *  without the `entity` alias, `device_diagnose` without `video`, and a `drag.steps` default of 5 vs 10,
 *  none of them written down anywhere. Nothing compared the twins, so drift was invisible by
 *  construction. This walks BOTH live registries and fails on:
 *  - a param one twin has and the other lacks, unless {@link RECORDED} gives the reason;
 *  - a param both have whose descriptions state DIFFERENT defaults, unless {@link RECORDED_DEFAULTS} does;
 *  - a device tool with no editor twin, unless {@link DEVICE_ONLY} does;
 *  - any recorded entry that no longer holds (a stale reason is a lie with a citation).
 *  The reasons are the §9 ledger's; `docs/debug-tools-mcp.md` states the naming table they sit beside. */

import { describe, it, beforeAll } from 'vitest';
import { loadSurface } from './mcpSurface';
import { loadDeviceSurface } from './deviceSurface';
import { getTool } from '../../tools/modoki-mcp/src/registry';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

/** Twins whose names differ — historical, recorded in debug-tools-mcp.md's naming table. */
const RENAMED: Record<string, string> = {
  device_console_logs: 'modoki_get_console_logs',
  device_layout_bounds: 'modoki_get_layout_bounds',
  device_screenshot: 'modoki_capture_viewport',
  device_introspect: 'modoki_list_actions',
};

const CHROME_AIM = 'aims EDITOR chrome by its data-ui-id label; game UI stays out of that namespace on purpose (pressOrigin.ts), so on a device it would find nothing';
const MOUSE = 'mouse-only input (editor authoring: multi-select, snapping, context menus); a device is touch';

/** device tool → { param: reason } for params on ONE side only. */
const RECORDED: Record<string, { deviceOnly?: Record<string, string>; editorOnly?: Record<string, string> }> = {
  device_screenshot: {
    deviceOnly: {
      savePath: 'a device capture is a native screenshot written to a file; the reply carries its path, not the image',
      inline: 'opts back into the image in the reply, which the file-first device capture defaults away',
      source: 'which native capture path to use (the WebView vs the OS) — the editor has one renderer to grab',
    },
    editorOnly: {
      maxSide: 'the editor grab is a canvas encode it sizes itself; the device capture is the OS image',
      quality: 'same — the JPEG encode is the editor\'s own',
    },
  },
  device_tap: { editorOnly: { label: CHROME_AIM, within: CHROME_AIM, button: MOUSE, clickCount: MOUSE, modifiers: MOUSE } },
  device_pointer: { editorOnly: { label: CHROME_AIM, within: CHROME_AIM, modifiers: MOUSE } },
  device_hover: { editorOnly: { label: CHROME_AIM, within: CHROME_AIM, modifiers: MOUSE } },
  device_scroll: { editorOnly: { label: CHROME_AIM, within: CHROME_AIM, modifiers: MOUSE } },
  device_drag: {
    deviceOnly: {
      delayMs: 'the device paces each step with a real delay over the lease; the editor dispatches its steps back to back',
      dom: 'drags a DOM widget on the device (a debug slider) instead of the game canvas',
    },
    editorOnly: { button: MOUSE, modifiers: MOUSE },
  },
  device_mutate_scene: {
    deviceOnly: {
      where: 'the device write is a LIVE selector write (set-traits): select by where/guid/name/id, then set', guid: 'selector — see where',
      name: 'selector — see where', id: 'selector — see where', set: 'the field values the selector write applies',
      dryRun: 'preview what the selector matches before writing', limit: 'bound on how many entities the selector write may touch',
    },
    editorOnly: {
      path: 'the editor edits a scene FILE (or its live world) — a device has no project checkout',
      ops: 'the editor\'s structural op list (add/remove/reparent entities) — scene authoring, not a live write',
    },
  },
  device_create_entity: {
    deviceOnly: { spec: 'one strict object per kind (#1223 P4); both derive the vocabulary from tools/shared/createEntityVocabulary.ts' },
    editorOnly: {
      kind: 'the editor spells the same spec flat (#1223 P4)', mesh: 'flat spec — see kind', shape: 'flat spec — see kind',
      preset: 'flat spec — see kind', light: 'flat spec — see kind',
    },
  },
  device_duplicate_entity: {
    deviceOnly: { count: 'bulk spawn is the device load-test knob; the editor duplicate is one undoable authoring act (Cmd+D)' },
  },
  device_load_scene: { editorOnly: { discardUnsaved: 'a device holds no unsaved scene work to discard' } },
  device_press_key: { editorOnly: { panel: 'targets an editor panel\'s keyboard focus' } },
  device_wait_for: {
    editorOnly: {
      chrome: 'reads editor chrome — the runtime wait-for has no chrome reader (#1559 C-12)',
      editor: 'reads the editor state — the runtime wait-for has no editor (#1559 C-12)',
    },
  },
};

/** device tool → { param: reason } where both state a different default. */
const RECORDED_DEFAULTS: Record<string, Record<string, string>> = {
  device_eval: { timeoutMs: 'nested deadlines: the device body must finish inside the lease transport\'s own deadline (debug-tools-mcp.md § Nested deadlines)' },
  device_drag: { steps: 'different pacing models: 5 steps × delayMs 20 on the device vs 10 undelayed on the editor — aligning the count would change the gesture\'s speed, and so its fling velocity' },
};

/** Device tools with no editor twin, and why. */
const DEVICE_ONLY: Record<string, string> = {
  device_status: 'the lease itself — the editor has no lease',
  device_connect: 'takes the lease',
  device_disconnect: 'releases the lease',
  device_list: 'lists leasable devices',
  device_game_tools: 'a game\'s own tools appear as real tools in the editor; the device reaches them through this pair (agent-tools.md)',
  device_game_tool_call: 'see device_game_tools',
  device_step: 'the editor steps through modoki_play_control {action:"step"}',
  device_invalidate_assets: 'the editor evicts as the second half of modoki_reimport_asset (debug-tools-mcp.md, #1216 C-13)',
  device_crash_reports: 'native crash reports from the phone',
  device_native_logs: 'the phone\'s native/system log — the editor\'s process log is modoki_get_console_logs',
};

type Shape = Record<string, { description?: string }>;
const device = new Map<string, Shape>();
const editor = new Map<string, Shape>();

beforeAll(async () => {
  const d = await loadDeviceSurface(() => undefined);
  for (const n of d.names) device.set(n, d.shapeFor(n) as Shape);
  d.restore();
  const e = loadSurface();
  for (const n of e.names) editor.set(n, getTool(n)!.shape as Shape);
  e.restore();
});

const twinOf = (name: string) => RENAMED[name] ?? name.replace(/^device_/, 'modoki_');
/** The number a description states as its default ("default 50", "Default: 5"), or undefined. */
const statedDefault = (desc?: string) => desc?.match(/default[:\s]+(-?\d[\d_]*(?:\.\d+)?)/i)?.[1];

const ledger = (label: string, population: Array<{ item: string; site: string }>, exempt: Array<{ item: string; reason: string }>, scanned: number, fix: string) =>
  assertExemptionLedger({ label, population, exempt, floor: 1, scanned, fix });

describe('device ↔ editor twin parameter parity (#1559)', () => {
  it('every device tool has an editor twin, or a recorded reason it does not', () => {
    ledger('DEVICE_ONLY in twinParamParity',
      [...device.keys()].filter((n) => !editor.has(twinOf(n))).map((n) => ({ item: n, site: n })),
      Object.entries(DEVICE_ONLY).map(([item, reason]) => ({ item, reason })),
      device.size, 'give the device tool an editor twin, or record why it has none in DEVICE_ONLY');
  });

  it('a param on one twin only is recorded with its reason — and every record still holds', () => {
    const population: Array<{ item: string; site: string }> = [];
    let walked = 0;
    for (const [name, dShape] of device) {
      const eShape = editor.get(twinOf(name));
      if (!eShape) continue;
      walked += Object.keys(dShape).length + Object.keys(eShape).length;
      for (const k of Object.keys(dShape)) if (!eShape[k]) population.push({ item: `${name}:deviceOnly:${k}`, site: `${name}.${k}` });
      for (const k of Object.keys(eShape)) if (!dShape[k]) population.push({ item: `${name}:editorOnly:${k}`, site: `${twinOf(name)}.${k}` });
    }
    const exempt = Object.entries(RECORDED).flatMap(([name, rec]) => [
      ...Object.entries(rec.deviceOnly ?? {}).map(([k, reason]) => ({ item: `${name}:deviceOnly:${k}`, reason })),
      ...Object.entries(rec.editorOnly ?? {}).map(([k, reason]) => ({ item: `${name}:editorOnly:${k}`, reason })),
    ]);
    ledger('RECORDED in twinParamParity', population, exempt, walked,
      'add the param to the other twin, or record in RECORDED why only one side takes it');
  });

  it('a param both twins take states the same default, or the difference is recorded', () => {
    const population: Array<{ item: string; site: string }> = [];
    let shared = 0;
    for (const [name, dShape] of device) {
      const eShape = editor.get(twinOf(name));
      if (!eShape) continue;
      for (const k of Object.keys(dShape)) {
        if (!eShape[k]) continue;
        shared++;
        const a = statedDefault(dShape[k].description), b = statedDefault(eShape[k].description);
        if (a !== undefined && b !== undefined && a !== b) population.push({ item: `${name}.${k}`, site: `${name}.${k}=${a} vs ${twinOf(name)}.${k}=${b}` });
      }
    }
    const exempt = Object.entries(RECORDED_DEFAULTS).flatMap(([name, rec]) => Object.entries(rec).map(([k, reason]) => ({ item: `${name}.${k}`, reason })));
    ledger('RECORDED_DEFAULTS in twinParamParity', population, exempt, shared,
      'give both twins one default, or record in RECORDED_DEFAULTS why they differ');
  });
});
