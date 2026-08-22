/** The agent-tool registry (#270) — the seam a GAME uses to put its own tools on the `modoki`
 *  MCP surface.
 *
 *  What is worth guarding here is not the Map. It is the three ways this seam can fail SILENTLY,
 *  each of which produces a tool that looks correctly wired and simply never appears:
 *    - a malformed or reserved name accepted and then dropped downstream;
 *    - the debug gate hiding the LIST while leaving tools callable by name;
 *    - a change that does not move the version, so the MCP server never re-registers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerAgentTool,
  unregisterAgentTool,
  listAgentTools,
  getAgentTool,
  subscribeAgentTools,
  agentToolsVersion,
  clearAgentTools,
} from '../../packages/modoki/src/runtime/debug/agentToolRegistry';
import { setDebugMenuEnabled, isDebugMenuEnabled } from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';

const wasEnabled = isDebugMenuEnabled();

beforeEach(() => {
  clearAgentTools();
  setDebugMenuEnabled(true);
});
afterEach(() => {
  clearAgentTools();
  setDebugMenuEnabled(wasEnabled);
});

const def = (name: string) => ({
  name,
  description: 'does a thing',
  mutates: false,
  handler: async () => ({ ok: true }),
});

describe('registration', () => {
  it('registers and lists a tool', () => {
    registerAgentTool(def('court_load_level'));
    expect(listAgentTools().map((t) => t.name)).toEqual(['court_load_level']);
  });

  it('replaces by name rather than duplicating', () => {
    registerAgentTool({ ...def('court_x'), description: 'first' });
    registerAgentTool({ ...def('court_x'), description: 'second' });
    expect(listAgentTools()).toHaveLength(1);
    expect(listAgentTools()[0].description).toBe('second');
  });

  it('unregisters', () => {
    registerAgentTool(def('court_x'));
    unregisterAgentTool('court_x');
    expect(listAgentTools()).toEqual([]);
  });

  // The THROW is the point. A registry that quietly ignored a bad name would leave the game
  // looking correctly wired with no tool and no explanation anywhere — the exact silent-failure
  // shape this repo keeps getting bitten by.
  it.each([
    ['Court_Load', 'uppercase'],
    ['9court', 'leading digit'],
    ['court-load', 'hyphen'],
    ['court load', 'space'],
    ['', 'empty'],
  ])('throws on a malformed name: %s (%s)', (name) => {
    expect(() => registerAgentTool(def(name))).toThrow(/not a valid tool name/);
    expect(listAgentTools()).toEqual([]);
  });

  it('throws on the reserved modoki_ prefix, so a game cannot shadow an engine tool', () => {
    expect(() => registerAgentTool(def('modoki_tap'))).toThrow(/reserved/);
    // And not merely for a name the engine happens to use today — the whole namespace is reserved,
    // because the collision would otherwise appear only once the engine adds that tool.
    expect(() => registerAgentTool(def('modoki_not_a_real_tool'))).toThrow(/reserved/);
    expect(listAgentTools()).toEqual([]);
  });

  it('throws on the bare name `wait`, which carries no prefix but is still the engine\'s', () => {
    // `wait` is `modoki_batch`'s pseudo-step, and the batch matches it BEFORE consulting the
    // registry (it is the documented spelling and not a registry entry). So a game tool by that
    // name would register cleanly, appear over MCP, and then be unreachable from every batch —
    // the step would silently sleep instead. Registration is the only place to make that loud.
    expect(() => registerAgentTool(def('wait'))).toThrow(/reserved/);
    expect(listAgentTools()).toEqual([]);
    // Neighbouring names are NOT reserved — the guard is one exact name, not a prefix.
    registerAgentTool(def('court_wait'));
    registerAgentTool(def('waiting_room'));
    expect(listAgentTools().map((t) => t.name).sort()).toEqual(['court_wait', 'waiting_room']);
  });
});

describe('declared facts survive registration', () => {
  // These two are what the LIVE sweep reads to decide whether a tool is safe to call and whether a
  // stopped-editor refusal is a defect. A field silently dropped here would not fail anything
  // until the sweep either damaged a project or started crying wolf.
  it('carries mutates and requiresPlaying through to the listing', () => {
    registerAgentTool({ ...def('court_load_level'), mutates: true, requiresPlaying: true });
    registerAgentTool(def('court_list_levels'));
    const byName = Object.fromEntries(listAgentTools().map((t) => [t.name, t]));
    expect(byName.court_load_level.mutates).toBe(true);
    expect(byName.court_load_level.requiresPlaying).toBe(true);
    expect(byName.court_list_levels.mutates).toBe(false);
    expect(byName.court_list_levels.requiresPlaying).toBeUndefined();
  });
});

describe('the debug gate', () => {
  it('hides tools from BOTH list and lookup when the debug menu is off', () => {
    registerAgentTool(def('court_x'));
    setDebugMenuEnabled(false);
    expect(listAgentTools()).toEqual([]);
    // The half that matters: a gate that only emptied the list would leave every tool fully
    // drivable by anyone who already knew its name — hiding the surface, not closing it.
    expect(getAgentTool('court_x')).toBeUndefined();
  });

  it('restores them when re-enabled — the gate filters, it does not delete', () => {
    registerAgentTool(def('court_x'));
    setDebugMenuEnabled(false);
    setDebugMenuEnabled(true);
    expect(listAgentTools().map((t) => t.name)).toEqual(['court_x']);
  });
});

describe('change notification', () => {
  it('bumps the version and notifies on register and unregister', () => {
    const seen = vi.fn();
    const off = subscribeAgentTools(seen);
    const v0 = agentToolsVersion();
    registerAgentTool(def('court_x'));
    expect(agentToolsVersion()).toBeGreaterThan(v0);
    const v1 = agentToolsVersion();
    unregisterAgentTool('court_x');
    expect(agentToolsVersion()).toBeGreaterThan(v1);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not notify for an unregister that removed nothing', () => {
    const seen = vi.fn();
    const off = subscribeAgentTools(seen);
    unregisterAgentTool('never_registered');
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('stops notifying after unsubscribe', () => {
    const seen = vi.fn();
    subscribeAgentTools(seen)();
    registerAgentTool(def('court_x'));
    expect(seen).not.toHaveBeenCalled();
  });
});
