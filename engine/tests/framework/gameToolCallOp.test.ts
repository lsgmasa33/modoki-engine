/** The `game-tool-call` op enforces the tool's DECLARATION (#286).
 *
 *  Why this file exists rather than more coverage in the MCP tests: the declaration promised a
 *  strict schema and for a while exactly ONE caller kept that promise. The MCP server rebuilds a
 *  zod shape from `params`, so a typo'd key was refused there — and the `curl` API,
 *  `device_eval`'s `modoki.call`, and the device relays all reached `tool.handler(args)` with
 *  whatever they were given. That is a partially-wired authoring surface: the field exists, the
 *  docs describe it, and most of the ways in ignore it.
 *
 *  These drive the op through `runAgentOp` — the SAME entry point the bridge transport uses — so
 *  what is proved is the path every non-MCP caller actually takes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import {
  registerAgentTool, clearAgentTools, validateAgentToolArgs, type AgentToolDef,
} from '../../packages/modoki/src/runtime/debug/agentToolRegistry';
import { setDebugMenuEnabled, isDebugMenuEnabled } from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';

const wasEnabled = isDebugMenuEnabled();
const handler = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, saw: args }));

const TOOL: AgentToolDef = {
  name: 'court_load_level',
  description: 'load a level',
  mutates: true,
  params: {
    levelId: { type: 'string', description: 'guid' },
    track: { type: 'string', description: 'ladder', enum: ['easy', 'hard'] },
    index: { type: 'number', int: true, description: 'position' },
    settle: { type: 'boolean', description: 'wait' },
  },
  handler: (a) => handler(a),
};

beforeEach(() => {
  clearAgentTools();
  setDebugMenuEnabled(true);
  handler.mockClear();
  registerAgentTool(TOOL);
});
afterEach(() => { clearAgentTools(); setDebugMenuEnabled(wasEnabled); });

const call = (args: Record<string, unknown>) =>
  runAgentOp('game-tool-call', { name: 'court_load_level', args }) as Promise<Record<string, unknown>>;

describe('validateAgentToolArgs', () => {
  it('accepts a valid call and an empty one', () => {
    expect(validateAgentToolArgs(TOOL, { levelId: 'g-1', track: 'hard', index: 3, settle: true })).toBeNull();
    expect(validateAgentToolArgs(TOOL, {})).toBeNull();
  });

  it('names the real parameters when a key is unrecognized', () => {
    const why = validateAgentToolArgs(TOOL, { levelid: 'g-1' });
    // §5: a refusal that lists the options is what turns a dead end into the caller's next move.
    expect(why).toMatch(/levelid/);
    expect(why).toMatch(/levelId, track, index, settle/);
  });

  it('rejects wrong types, a bad enum, and a non-integer', () => {
    expect(validateAgentToolArgs(TOOL, { levelId: 7 })).toMatch(/must be a string/);
    expect(validateAgentToolArgs(TOOL, { track: 'brutal' })).toMatch(/one of: easy, hard/);
    expect(validateAgentToolArgs(TOOL, { index: 2.5 })).toMatch(/whole number/);
    expect(validateAgentToolArgs(TOOL, { settle: 'yes' })).toMatch(/true or false/);
    expect(validateAgentToolArgs(TOOL, { index: Number.NaN })).toMatch(/must be a number/);
  });

  it('requires a required param, and only a required one', () => {
    const req: AgentToolDef = { ...TOOL, params: { id: { type: 'string', description: 'x', required: true } } };
    expect(validateAgentToolArgs(req, {})).toMatch(/requires 'id'/);
    expect(validateAgentToolArgs(req, { id: 'a' })).toBeNull();
  });

  it('treats a tool with no params as accepting nothing', () => {
    const bare: AgentToolDef = { ...TOOL, params: undefined };
    expect(validateAgentToolArgs(bare, {})).toBeNull();
    expect(validateAgentToolArgs(bare, { x: 1 })).toMatch(/\(no parameters\)/);
  });
});

describe('the op enforces it', () => {
  it('passes valid args through to the handler', async () => {
    const r = await call({ track: 'hard' });
    expect(r.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ track: 'hard' });
  });

  it('REFUSES a typo instead of dropping it — the handler is never reached', async () => {
    // The measured failure this guards: for a tool whose params are all optional, a dropped key
    // turns a typo into a different operation that reports success.
    const r = await call({ trak: 'hard' });
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/trak/);
    expect(r.params).toEqual(['levelId', 'track', 'index', 'settle']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a bad enum value before the handler sees it', async () => {
    const r = await call({ track: 'brutal' });
    expect(r.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still refuses an unknown tool by name, listing what is registered', async () => {
    const r = await runAgentOp('game-tool-call', { name: 'court_nope', args: {} }) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.known).toEqual(['court_load_level']);
  });

  it('reports a throwing handler as a refusal, not a transport failure', async () => {
    handler.mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await call({});
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/threw: boom/);
  });
});

describe('game-tools declaration feed', () => {
  it('serializes exactly what the relays and the MCP server need', async () => {
    const r = await runAgentOp('game-tools', {}) as { tools: Record<string, unknown>[] };
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]).toMatchObject({ name: 'court_load_level', mutates: true, requiresPlaying: false });
    // The handler must NOT be serialized — it cannot cross the bridge, and shipping it would make
    // the payload unserializable rather than merely large.
    expect(r.tools[0]).not.toHaveProperty('handler');
  });
});
