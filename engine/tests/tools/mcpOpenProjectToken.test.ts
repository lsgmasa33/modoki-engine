/** `modoki_open_project` keeps the MCP that asked for the switch working (#1587 close-out review).
 *
 *  The editor's instance token (C6) is per PROJECT, so a switch makes the editor expect a new one,
 *  and an MCP still sending the old one is refused as "WRONG EDITOR" on every later call — the
 *  switch back included. The route hands the new token back and the MCP adopts it. Driven through
 *  the real tool handler and the real context, with only `fetch` stubbed, because the property is
 *  what the NEXT request carries, which no reply-shape test can see. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createToolContext } from '../../tools/modoki-mcp/src/context';
import { registerAllTools } from '../../tools/modoki-mcp/src/registerAll';
import { clearRegistry, getTool } from '../../tools/modoki-mcp/src/registry';

const STUB = 'http://stub.modoki.test';

/** `status` is what the route really answers with — a TIMEOUT is a 504, and the failure path is
 *  the one a 200-only stub would never reach. */
function harness(openReply: Record<string, unknown>, configuredToken?: string, status = 200) {
  clearRegistry();
  const sent: { path: string; token: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).slice(STUB.length);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ path, token: headers['X-Modoki-Token'] ?? null });
    const body = path === '/api/identity'
      ? { repoRoot: process.cwd(), projectRoot: '/p/a', backendPort: 1, pid: 1, branch: 'x', packaged: false }
      : path === '/api/open-project' ? openReply : { ok: true };
    return new Response(JSON.stringify(body), { status: path === '/api/open-project' ? status : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const ctx = createToolContext({ backend: STUB, token: configuredToken });
  registerAllTools({ registerTool: () => ({ remove: () => {} }), validateToolInput: async (_t: unknown, a: unknown) => a } as never, ctx);
  const call = (name: string, args: Record<string, unknown>) => getTool(name)!.handler(args as never);
  return { sent, call };
}

const text = (r: unknown) => JSON.stringify(r);

afterEach(() => { vi.unstubAllGlobals(); clearRegistry(); });

describe('modoki_open_project — the token after a switch', () => {
  it('sends the OLD token on the switch, then the NEW one on every later call', async () => {
    const { sent, call } = harness({ ok: true, opened: true, projectRoot: '/p/b', previousRoot: '/p/a', token: 'tok-b' }, 'tok-a');
    const res = await call('modoki_open_project', { path: '/p/b' });
    expect(sent.find((s) => s.path === '/api/open-project')?.token).toBe('tok-a');
    await call('modoki_get_editor_state', {});
    expect(sent.at(-1)).toEqual({ path: '/api/editor-state', token: 'tok-b' });
    // Acted on, not printed: the agent is told it was adopted, never shown the value.
    expect(text(res)).toContain('tokenAdopted');
    expect(text(res)).not.toContain('tok-b');
  });

  it('a config with NO token keeps sending none', async () => {
    const { sent, call } = harness({ ok: true, opened: true, projectRoot: '/p/b', previousRoot: '/p/a', token: 'tok-b' });
    const res = await call('modoki_open_project', { path: '/p/b' });
    await call('modoki_get_editor_state', {});
    expect(sent.at(-1)).toEqual({ path: '/api/editor-state', token: null });
    expect(text(res)).not.toContain('tokenAdopted');
  });

  it('a refusal that names the SAME token changes nothing', async () => {
    const { sent, call } = harness({ ok: false, code: 'REQUIRES_SAVE', error: 'unsaved', token: 'tok-a' }, 'tok-a', 409);
    const res = await call('modoki_open_project', { path: '/p/b' });
    await call('modoki_get_editor_state', {});
    expect(sent.at(-1)).toEqual({ path: '/api/editor-state', token: 'tok-a' });
    expect(text(res)).not.toContain('tokenAdopted');
  });

  it('a TIMEOUT still adopts: the token switched when the open STARTED, so the next call must carry it', async () => {
    const { sent, call } = harness({ ok: false, code: 'TIMEOUT', error: 'still preparing', token: 'tok-b' }, 'tok-a', 504);
    const res = await call('modoki_open_project', { path: '/p/b' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    await call('modoki_get_editor_state', {});
    expect(sent.at(-1)).toEqual({ path: '/api/editor-state', token: 'tok-b' });
    expect(text(res)).not.toContain('tok-b');
  });
});
