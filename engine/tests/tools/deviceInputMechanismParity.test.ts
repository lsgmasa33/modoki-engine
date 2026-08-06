/** #32 Phase 0 shipped the input-fidelity fact in TWO places (one mechanism, always 'synthetic')
 *  and this guard kept them in sync. Phase 1 (Android CDP) landed a SECOND mechanism
 *  ('trusted-cdp'), so the invariant this guard checks is now over THREE literal declarations,
 *  not two — but it is still the SAME invariant Phase 0's header called out in advance: **"both
 *  surfaces state the same mechanism", not "the constant is 'synthetic'"**. This file is that
 *  REPLACEMENT, not a deletion.
 *
 *  Phase 2 (iOS WebDriverAgent) added a THIRD mechanism ('trusted-wda'), so it is now four
 *  declarations across four surfaces. Phase 2 also proved why this guard earns its keep in a way
 *  the literals alone did not: the backend reported `trusted-wda` while `device_status` printed
 *  "synthetic", because mcp-tools.ts knew only two literals and fell through its else-branch. The
 *  literals were consistent; the REPORTING was not. Hence the last test here checks each literal is
 *  actually USED in the MCP's fidelity line, not merely declared.
 *
 *  The declarations, and why each is a separate copy rather than an import:
 *   - `INPUT_MECHANISM` in `engine/app/debug/bridge.ts` — the in-page device bridge (a bundled
 *     browser script shipped inside the game). This is what a device_* reply's fallback path
 *     ACTUALLY dispatches when no trusted route is available: still 'synthetic', unchanged by
 *     Phase 1 (CDP injection happens host-side, never inside this bundle).
 *   - `TRUSTED_CDP_MECHANISM` in `engine/plugins/backend/deviceCdp.ts` — the Node backend plugin
 *     that owns the Android CDP route. This is the NEW mechanism Phase 1 added: 'trusted-cdp'.
 *   - `TRUSTED_WDA_MECHANISM` in `engine/plugins/backend/deviceWda.ts` — the Node backend plugin
 *     that owns the iOS WebDriverAgent route: 'trusted-wda' (Phase 2). It covers a NARROWER set of
 *     ops than the CDP route (tap/drag only), which is why the status reply also carries
 *     `trustedOps`.
 *   - `SYNTHETIC_MECHANISM` + `TRUSTED_CDP_MECHANISM` + `TRUSTED_WDA_MECHANISM` in
 *     `engine/tools/game-debug-mcp/src/mcp-tools.ts` (a separate NPM package) — the literals
 *     `device_status` can report, read from the backend's LIVE probe rather than hardcoded. These
 *     must equal bridge.ts's, deviceCdp.ts's and deviceWda.ts's values respectively, or
 *     `device_status` could announce a mechanism no device_* reply actually uses (or vice-versa).
 *
 *  bridge.ts / deviceCdp.ts / deviceWda.ts / mcp-tools.ts span separate runtimes and packages with
 *  no shared module graph (a browser bundle, two Electron/Vite-plugin Node modules, and an
 *  independent MCP server package) — so parity is asserted from SOURCE TEXT, same as Phase 0's
 *  guard, not by importing across those boundaries. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const BRIDGE = path.join(REPO, 'engine/app/debug/bridge.ts');
const DEVICE_CDP = path.join(REPO, 'engine/plugins/backend/deviceCdp.ts');
const DEVICE_WDA = path.join(REPO, 'engine/plugins/backend/deviceWda.ts');
// #107 moved the literals + the line that renders them out of `mcp-tools.ts` into `reply.ts`
// (same package), so the reporter could be tested by RENDERING it — see `deviceInputFidelity.test.ts`.
// This guard follows the declarations; its subject is unchanged.
const MCP_TOOLS = path.join(REPO, 'engine/tools/game-debug-mcp/src/reply.ts');

/** Pull `const NAME = 'value' as const;` (optionally `export`ed) → 'value'. Returns undefined when
 *  the declaration is gone or was reshaped, which the tests below treat as a failure rather than
 *  silently passing — a guard that stops finding its subject must go red, not quiet. */
function readMechanism(file: string, name: string): string | undefined {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'\\s*as\\s+const`).exec(src);
  return m?.[1];
}

describe('device input mechanism — every surface states the SAME set of mechanisms (#32)', () => {
  it('bridge.ts declares INPUT_MECHANISM (the synthetic fallback every device_* op still has)', () => {
    expect(
      readMechanism(BRIDGE, 'INPUT_MECHANISM'),
      'INPUT_MECHANISM is gone or reshaped in engine/app/debug/bridge.ts — if a later phase replaced '
      + 'it with something else, replace this guard with the equivalent parity assertion (see the header).',
    ).toBe('synthetic');
  });

  it('deviceCdp.ts declares TRUSTED_CDP_MECHANISM (the Phase 1 Android route)', () => {
    expect(
      readMechanism(DEVICE_CDP, 'TRUSTED_CDP_MECHANISM'),
      'TRUSTED_CDP_MECHANISM is gone or reshaped in engine/plugins/backend/deviceCdp.ts — see the header.',
    ).toBe('trusted-cdp');
  });

  it('deviceWda.ts declares TRUSTED_WDA_MECHANISM (the Phase 2 iOS route)', () => {
    expect(
      readMechanism(DEVICE_WDA, 'TRUSTED_WDA_MECHANISM'),
      'TRUSTED_WDA_MECHANISM is gone or reshaped in engine/plugins/backend/deviceWda.ts — see the header.',
    ).toBe('trusted-wda');
  });

  it('mcp-tools.ts declares ALL THREE literals, matching each backend surface exactly', () => {
    const bridgeMechanism = readMechanism(BRIDGE, 'INPUT_MECHANISM');
    const cdpMechanism = readMechanism(DEVICE_CDP, 'TRUSTED_CDP_MECHANISM');
    const wdaMechanism = readMechanism(DEVICE_WDA, 'TRUSTED_WDA_MECHANISM');
    const mcpSynthetic = readMechanism(MCP_TOOLS, 'SYNTHETIC_MECHANISM');
    const mcpTrustedCdp = readMechanism(MCP_TOOLS, 'TRUSTED_CDP_MECHANISM');
    const mcpTrustedWda = readMechanism(MCP_TOOLS, 'TRUSTED_WDA_MECHANISM');

    expect(mcpSynthetic, 'SYNTHETIC_MECHANISM is gone or reshaped in mcp-tools.ts').toBeDefined();
    expect(mcpTrustedCdp, 'TRUSTED_CDP_MECHANISM is gone or reshaped in mcp-tools.ts').toBeDefined();
    expect(mcpTrustedWda, 'TRUSTED_WDA_MECHANISM is gone or reshaped in mcp-tools.ts').toBeDefined();

    expect(
      mcpSynthetic,
      `device_status could report synthetic as '${mcpSynthetic}' while the device bridge actually `
      + `dispatches '${bridgeMechanism}'. Update both — these are copies of one fact.`,
    ).toBe(bridgeMechanism);
    expect(
      mcpTrustedCdp,
      `device_status could report the trusted mechanism as '${mcpTrustedCdp}' while `
      + `engine/plugins/backend/deviceCdp.ts actually reports '${cdpMechanism}'. Update both.`,
    ).toBe(cdpMechanism);
    expect(
      mcpTrustedWda,
      `device_status could report the iOS mechanism as '${mcpTrustedWda}' while `
      + `engine/plugins/backend/deviceWda.ts actually reports '${wdaMechanism}'. Update both.`,
    ).toBe(wdaMechanism);
  });

  it('a mechanism the MCP cannot NAME is a mechanism device_status will mis-report', () => {
    // Found live, not by a test: the backend answered `trusted-wda` while device_status printed
    // "synthetic", because the MCP only knew two literals and fell through to its else-branch.
    // A literal declared on a backend surface but absent from the MCP's own `fidelity` reporting is
    // exactly that bug, so assert every known mechanism is actually mentioned there.
    //
    // Note what this can and cannot see, since #107 was reported against a green suite: it proves
    // the reporter MENTIONS each literal, never what it says about one. That is a source-text
    // check on the vocabulary; the sentence is `deviceInputFidelity.test.ts`'s job. Keep both.
    const mcpSrc = readFileSync(MCP_TOOLS, 'utf8');
    for (const name of ['SYNTHETIC_MECHANISM', 'TRUSTED_CDP_MECHANISM', 'TRUSTED_WDA_MECHANISM']) {
      const uses = mcpSrc.split(name).length - 1;
      expect(uses, `${name} is declared in mcp-tools.ts but barely used — device_status probably cannot report it`).toBeGreaterThan(1);
    }
  });
});
