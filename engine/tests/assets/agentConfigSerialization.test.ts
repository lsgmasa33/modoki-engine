import { describe, it, expect } from 'vitest';
import TOML from 'smol-toml';
import type { TomlValue } from 'smol-toml';
import { tomlString, mcpServersToToml, expectedCursorMcpJson } from '../../scripts/sync-agent-configs.mjs';

/** The shape `mcpServersToToml`'s output parses back into: a `[mcp_servers.<name>]` table
 *  per server. Narrows the parser's generic `TomlValue` union once so callers below can
 *  index into it directly instead of casting at every access. */
interface McpServersTomlDoc {
  mcp_servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

function asMcpServersToml(value: TomlValue): McpServersTomlDoc {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('mcp_servers' in value)) {
    throw new Error('expected a parsed TOML document with an mcp_servers table');
  }
  return value as unknown as McpServersTomlDoc;
}

/**
 * Unit coverage for the hand-rolled TOML/JSON serializers in sync-agent-configs.mjs —
 * engine/tests/assets/agentConfigSync.test.ts only checks THIS repo's current .mcp.json
 * converts correctly; these tests exercise the serializer logic itself against inputs
 * that don't otherwise appear in .mcp.json (quotes, backslashes, multiple servers, no
 * env, no args), parsing the TOML output with a real parser rather than eyeballing it.
 */
describe('tomlString', () => {
  it('quotes a plain string', () => {
    expect(tomlString('npx')).toBe('"npx"');
  });

  it('escapes embedded double quotes', () => {
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('escapes backslashes (Windows-style paths)', () => {
    expect(tomlString('C:\\Users\\x\\modoki')).toBe('"C:\\\\Users\\\\x\\\\modoki"');
  });

  it('escapes backslash before quote in the right order (no double-escaping)', () => {
    // A naive quote-then-backslash-escape order would mangle this; backslashes must be
    // escaped FIRST so the quote-escaping doesn't re-touch the backslashes it just added.
    const parsed = TOML.parse(`v = ${tomlString('a\\"b')}`);
    expect(parsed.v).toBe('a\\"b');
  });
});

describe('mcpServersToToml', () => {
  it('round-trips a single server with args and env through a real TOML parser', () => {
    const toml = mcpServersToToml({
      modoki: {
        command: 'npx',
        args: ['tsx', 'engine/tools/modoki-mcp/src/index.ts'],
        env: { MODOKI_BACKEND: 'http://127.0.0.1:5179' },
      },
    });
    const parsed = asMcpServersToml(TOML.parse(toml));
    expect(parsed.mcp_servers.modoki).toEqual({
      command: 'npx',
      args: ['tsx', 'engine/tools/modoki-mcp/src/index.ts'],
      env: { MODOKI_BACKEND: 'http://127.0.0.1:5179' },
    });
  });

  it('round-trips multiple servers, each independently addressable', () => {
    const toml = mcpServersToToml({
      modoki: { command: 'npx', args: ['tsx', 'a.ts'], env: { X: '1' } },
      'game-debug': { command: 'npx', args: ['tsx', 'b.ts'], env: { X: '2' } },
    });
    const parsed = asMcpServersToml(TOML.parse(toml));
    expect(Object.keys(parsed.mcp_servers)).toEqual(['modoki', 'game-debug']);
    expect(parsed.mcp_servers.modoki.env?.X).toBe('1');
    expect(parsed.mcp_servers['game-debug'].env?.X).toBe('2');
  });

  it('omits the env table entirely when a server has no env (matches chrome-devtools in .mcp.json)', () => {
    const toml = mcpServersToToml({
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    });
    const parsed = asMcpServersToml(TOML.parse(toml));
    expect(parsed.mcp_servers['chrome-devtools'].env).toBeUndefined();
    expect(toml).not.toContain('chrome-devtools.env');
  });

  it('omits args when a server has none', () => {
    const toml = mcpServersToToml({ bare: { command: 'node' } });
    const parsed = asMcpServersToml(TOML.parse(toml));
    expect(parsed.mcp_servers.bare.args).toBeUndefined();
  });

  it('produces valid TOML for values containing quotes and backslashes together', () => {
    const toml = mcpServersToToml({
      windows: {
        command: 'C:\\Program Files\\node.exe',
        args: ['--flag="value"'],
        env: { PATH_HINT: 'C:\\Users\\"quoted"\\dir' },
      },
    });
    const parsed = asMcpServersToml(TOML.parse(toml));
    expect(parsed.mcp_servers.windows.command).toBe('C:\\Program Files\\node.exe');
    expect(parsed.mcp_servers.windows.args?.[0]).toBe('--flag="value"');
    expect(parsed.mcp_servers.windows.env?.PATH_HINT).toBe('C:\\Users\\"quoted"\\dir');
  });

  it('is idempotent — serializing twice produces identical output', () => {
    const servers = { a: { command: 'x', args: ['1', '2'], env: { K: 'v' } } };
    expect(mcpServersToToml(servers)).toBe(mcpServersToToml(servers));
  });
});

describe('expectedCursorMcpJson', () => {
  it('wraps servers under an mcpServers key and round-trips through JSON.parse', () => {
    const servers = { modoki: { command: 'npx', args: ['tsx', 'x.ts'], env: { A: '1' } } };
    const json = expectedCursorMcpJson(servers);
    expect(JSON.parse(json)).toEqual({ mcpServers: servers });
  });

  it('ends with a single trailing newline (stable diffs)', () => {
    const json = expectedCursorMcpJson({ modoki: { command: 'npx' } });
    expect(json.endsWith('}\n')).toBe(true);
    expect(json.endsWith('}\n\n')).toBe(false);
  });
});
