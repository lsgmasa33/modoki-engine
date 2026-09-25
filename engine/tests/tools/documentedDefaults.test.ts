/** A default a param description STATES is read from the constant the code uses — conventions §11:
 *  "A documented default matches the code. A wrong default is worse than none."
 *
 *  The 2026-09-25 audit (C-10) wrote three numbers into descriptions that had said only "a default
 *  cap": the scene-state index cap and the watch-read series cap. `wait_for`'s timeout was already
 *  stated in its tool description, and is pinned here with them. Prose
 *  cannot import the constant (the MCP servers do not load `app/`), so this is what keeps the two
 *  from drifting apart when someone retunes a limit. */

import { describe, it, expect, afterEach } from 'vitest';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';
import { getTool } from '../../tools/modoki-mcp/src/registry';
import { DEFAULT_INDEX_LIMIT, DEFAULT_WATCH_SERIES_LIMIT } from '../../app/debug/agentBridge';
import { WAIT_FOR_DEFAULT_MS, WAIT_FOR_MIN_MS, WAIT_FOR_MAX_MS } from '../../app/debug/waitFor';

let surface: Surface | undefined;
let device: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; device?.restore(); device = undefined; });

const paramDoc = (shape: Record<string, unknown> | undefined, param: string): string =>
  ((shape?.[param] as { description?: string } | undefined)?.description) ?? '';

/** The number as a whole word, so `200` does not match inside `2000`. */
const states = (text: string, n: number) => new RegExp(`(?<![\\d.])${n}(?![\\d.])`).test(text);

describe('stated defaults match the constants', () => {
  it('get_scene_state index cap — both servers', async () => {
    surface = loadSurface();
    device = await loadDeviceSurface();
    expect(states(paramDoc(getTool('modoki_get_scene_state')?.shape, 'limit'), DEFAULT_INDEX_LIMIT)).toBe(true);
    expect(states(paramDoc(device.shapeFor('device_get_scene_state'), 'limit'), DEFAULT_INDEX_LIMIT)).toBe(true);
  });

  it('watch read series cap — both servers', async () => {
    surface = loadSurface();
    device = await loadDeviceSurface();
    expect(states(paramDoc(getTool('modoki_watch')?.shape, 'limit'), DEFAULT_WATCH_SERIES_LIMIT)).toBe(true);
    expect(states(paramDoc(device.shapeFor('device_watch'), 'limit'), DEFAULT_WATCH_SERIES_LIMIT)).toBe(true);
  });

  it('wait_for timeoutMs default and clamp (stated in the TOOL description — the param keeps the shared base)', () => {
    surface = loadSurface();
    const doc = surface.descriptionOf('modoki_wait_for');
    for (const n of [WAIT_FOR_DEFAULT_MS, WAIT_FOR_MIN_MS, WAIT_FOR_MAX_MS]) expect(states(doc, n), `${n} in: ${doc}`).toBe(true);
  });

  it('the matcher rejects a number that is only a substring (accept side of `states`)', () => {
    expect(states('capped at 2000', 200)).toBe(false);
    expect(states('capped at 200 by default', 200)).toBe(true);
  });
});

/** C-1 (2026-09-25 audit): the device input tools take SCREENSHOT px, the device reads report CSS
 *  px, and a point copied across lands at 1/DPR with an ok reply (a raw coordinate is exempt from
 *  the occlusion refusal). Both sides must say so — the population is every device tool with a raw
 *  `x`, so a new one cannot ship with the bare word "pixels". */
describe('device coordinate units are stated on both sides', () => {
  it('every device tool with a raw x/y names SCREENSHOT px on it', async () => {
    device = await loadDeviceSurface();
    const withXY = device.names.filter((n) => 'x' in device!.shapeFor(n) && 'y' in device!.shapeFor(n));
    expect(withXY.length).toBeGreaterThanOrEqual(4);
    const bare = withXY.filter((n) => !/SCREENSHOT px/.test(paramDoc(device!.shapeFor(n), 'x')));
    expect(bare, 'device x params that do not name their unit').toEqual([]);
  });

  it('the CSS-px reads point back at the screenshot-px inputs', async () => {
    device = await loadDeviceSurface();
    for (const n of ['device_layout_bounds', 'device_hit_regions', 'device_handles']) {
      expect(device.descriptionOf(n), n).toMatch(/SCREENSHOT px|screenshot px/);
    }
  });
});
