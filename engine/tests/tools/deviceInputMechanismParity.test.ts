/** #32 Phase 0 shipped the input-fidelity fact in TWO places, and it has to stay one fact.
 *
 *  `INPUT_MECHANISM` lives in `engine/app/debug/bridge.ts` (the in-page device bridge — a bundled
 *  browser script shipped inside the game) and `DEVICE_INPUT_MECHANISM` lives in
 *  `engine/tools/game-debug-mcp/src/mcp-tools.ts` (a Node MCP server). They are separate runtimes
 *  with no shared module graph, so the duplication is forced — but a duplicated constant that has
 *  to be kept in sync BY HAND is precisely the shadow-value shape root CLAUDE.md warns goes stale,
 *  and here going stale means the surface LIES to an agent about input fidelity: `device_status`
 *  would keep announcing 'synthetic' after Phase 1 routed Android through trusted CDP input, or
 *  vice-versa. That is worse than having no field at all.
 *
 *  So: parity is asserted from SOURCE TEXT rather than by importing either module (bridge.ts pulls
 *  in `@capacitor/core` and the engine runtime; mcp-tools.ts is Node-side — neither imports cleanly
 *  into the other's environment, and a test that reached past that would be testing a mock).
 *
 *  When Phase 1/2 land and the mechanism stops being a single constant, this guard should be
 *  REPLACED by whatever asserts the per-platform detection agrees across the two surfaces — not
 *  deleted. The invariant is "both surfaces state the same mechanism", not "the constant is
 *  'synthetic'". */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const BRIDGE = path.join(REPO, 'engine/app/debug/bridge.ts');
const MCP_TOOLS = path.join(REPO, 'engine/tools/game-debug-mcp/src/mcp-tools.ts');

/** Pull `export const INPUT_MECHANISM = 'synthetic' as const;` → 'synthetic'. Returns undefined
 *  when the declaration is gone or was reshaped, which the tests below treat as a failure rather
 *  than silently passing — a guard that stops finding its subject must go red, not quiet. */
function readMechanism(file: string, name: string): string | undefined {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'\\s*as\\s+const`).exec(src);
  return m?.[1];
}

describe('device input mechanism — the two surfaces state one fact (#32 Phase 0)', () => {
  it('bridge.ts declares INPUT_MECHANISM', () => {
    expect(
      readMechanism(BRIDGE, 'INPUT_MECHANISM'),
      'INPUT_MECHANISM is gone or reshaped in engine/app/debug/bridge.ts — if Phase 1/2 replaced it '
      + 'with per-platform detection, replace this guard with the equivalent parity assertion (see the header).',
    ).toBeDefined();
  });

  it('mcp-tools.ts declares DEVICE_INPUT_MECHANISM', () => {
    expect(
      readMechanism(MCP_TOOLS, 'DEVICE_INPUT_MECHANISM'),
      'DEVICE_INPUT_MECHANISM is gone or reshaped in engine/tools/game-debug-mcp/src/mcp-tools.ts — see the header.',
    ).toBeDefined();
  });

  it('the two agree — a device_* reply and device_status cannot claim different fidelity', () => {
    const bridge = readMechanism(BRIDGE, 'INPUT_MECHANISM');
    const mcp = readMechanism(MCP_TOOLS, 'DEVICE_INPUT_MECHANISM');
    expect(
      mcp,
      `device_status would report '${mcp}' while the device bridge actually dispatches '${bridge}'. `
      + 'These are two copies of one fact (separate runtimes, no shared module graph) — update both.',
    ).toBe(bridge);
  });
});
