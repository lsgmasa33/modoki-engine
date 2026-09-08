/** #822 — `device_step`'s outbound `timeoutMs` must be DERIVED from the same rule the device uses
 *  internally (`simStepDefaultTimeout`, `engine/tools/shared/simStepTiming.ts`), not left undefined
 *  and falling back to the editor backend's flat 5s transport default. Before this fix,
 *  `device_step {frames: 600}` — the max the tool's own description advertises — always failed as
 *  a transport timeout while the device was still faithfully stepping (they diverge above 112
 *  frames: `simStepDefaultTimeout(112) = 112*40+500 = 4980ms`, just under the flat 5000ms default;
 *  above that the device's own budget exceeds it).
 *
 *  Uses the REAL device tool surface harness (`deviceSurface.ts`) — the tool is real, only the
 *  backend HTTP call is stubbed — so this asserts on the actual outbound request body, not a
 *  reimplementation of the tool's logic. */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';
import { simStepDefaultTimeout } from '../../tools/shared/simStepTiming';

let surface: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

function paramsOf(surface: DeviceSurface): Record<string, unknown> {
  const req = surface.last();
  const body = req?.body as { method?: string; params?: Record<string, unknown> } | undefined;
  expect(body?.method).toBe('sim-step');
  return body?.params ?? {};
}

describe('device_step timeoutMs derivation (#822)', () => {
  it('derives timeoutMs from frames when the caller supplies none — the divergence case (frames:600, the advertised max)', async () => {
    surface = await loadDeviceSurface(() => deviceReply({ ok: true, stepped: 600, advancedMs: 10000, timeScale: 1 }));
    await surface.call('device_step', { frames: 600 });
    const params = paramsOf(surface);
    expect(params.timeoutMs).toBe(simStepDefaultTimeout(600));
    // Pinned literally too: the whole bug was this landing at the flat 5000ms transport default.
    expect(params.timeoutMs).toBe(20000);
    expect(params.timeoutMs).not.toBe(5000);
  });

  it('derives timeoutMs even for a SMALL frame count — never omits the field', async () => {
    surface = await loadDeviceSurface(() => deviceReply({ ok: true, stepped: 1, advancedMs: 16, timeScale: 1 }));
    await surface.call('device_step', { frames: 1 });
    const params = paramsOf(surface);
    expect(params.timeoutMs).toBe(simStepDefaultTimeout(1));
    expect(params.timeoutMs).toBe(3000); // the formula's floor
  });

  it('a caller-supplied timeoutMs is passed through UNCHANGED, not overridden by the derivation', async () => {
    surface = await loadDeviceSurface(() => deviceReply({ ok: true, stepped: 600, advancedMs: 10000, timeScale: 1 }));
    await surface.call('device_step', { frames: 600, timeoutMs: 45000 });
    const params = paramsOf(surface);
    expect(params.timeoutMs).toBe(45000);
  });

  it('omitting frames still derives from the default frame count (1)', async () => {
    surface = await loadDeviceSurface(() => deviceReply({ ok: true, stepped: 1, advancedMs: 16, timeScale: 1 }));
    await surface.call('device_step', {});
    const params = paramsOf(surface);
    expect(params.timeoutMs).toBe(simStepDefaultTimeout(1));
  });
});
