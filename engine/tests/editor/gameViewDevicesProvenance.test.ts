/** #786 at the MCP SEAM — the device read-back an agent actually receives carries where each safe-area
 *  quartet came from.
 *
 *  `devicePresets.test.ts` pins the data. This pins the two ops that relay it, because the defect was
 *  reported at the seam: `modoki_set_game_view_device {device:'Galaxy Tab S9'}` answered a confident
 *  zero quartet labelled `'preset'` — by the codebase's own definition "this screen really has no
 *  notch" — and `modoki_game_view_devices` relayed each row's insets with no provenance field at all.
 *  An agent then attributes its layout measurement to a zero nobody measured. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

type Basis = 'measured' | 'published' | 'inferred' | 'no-device';
type Row = { name: string; safeAreaBasis?: { portrait: Basis; landscape: Basis } };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
});
afterEach(async () => {
  await runAgentOp('set-game-view-device', { device: 'Free', orientation: 'portrait' });
  game?.dispose(); game = undefined;
  vi.unstubAllGlobals();
});

describe('modoki_game_view_devices — every row says where its insets came from', () => {
  it('a reasoned Android-tablet zero and a measured iPhone SE zero are no longer the same answer', async () => {
    const r = await runAgentOp('game-view-devices', {}) as { presets: Row[] };
    const row = (name: string) => r.presets.find((p) => p.name === name);
    expect(row('Galaxy Tab S9')?.safeAreaBasis).toEqual({ portrait: 'inferred', landscape: 'inferred' });
    expect(row('iPhone SE')?.safeAreaBasis).toEqual({ portrait: 'measured', landscape: 'inferred' });
    expect(row('16:9 (720p)')?.safeAreaBasis).toEqual({ portrait: 'no-device', landscape: 'no-device' });
  });

  it('no row is relayed without a basis — for either orientation', async () => {
    const r = await runAgentOp('game-view-devices', {}) as { presets: Row[] };
    expect(r.presets.length).toBeGreaterThan(10);
    for (const p of r.presets) {
      expect(p.safeAreaBasis?.portrait, `${p.name} portrait`).toMatch(/^(measured|published|inferred|no-device)$/);
      expect(p.safeAreaBasis?.landscape, `${p.name} landscape`).toMatch(/^(measured|published|inferred|no-device)$/);
    }
  });
});

describe('modoki_set_game_view_device — the read-back for the screen just selected', () => {
  it("the issue's own scenario: previewing a Galaxy Tab S9 reports 'inferred', not a statement", async () => {
    const r = await runAgentOp('set-game-view-device', { device: 'Galaxy Tab S9' }) as { safeArea?: unknown; safeAreaBasis?: string };
    expect(r.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(r.safeAreaBasis).toBe('inferred');
  });

  it('follows the ORIENTATION — the Air is measured upright and inferred on its side', async () => {
    const up = await runAgentOp('set-game-view-device', { device: 'iPhone Air', orientation: 'portrait' }) as { safeAreaBasis?: string };
    const side = await runAgentOp('set-game-view-device', { device: 'iPhone Air', orientation: 'landscape' }) as { safeAreaBasis?: string };
    expect(up.safeAreaBasis).toBe('measured');
    expect(side.safeAreaBasis).toBe('inferred');
  });

  it("a custom size says 'no-device'", async () => {
    const r = await runAgentOp('set-game-view-device', { logicalWidth: 640, logicalHeight: 480 }) as { safeAreaBasis?: string };
    expect(r.safeAreaBasis).toBe('no-device');
  });
});
