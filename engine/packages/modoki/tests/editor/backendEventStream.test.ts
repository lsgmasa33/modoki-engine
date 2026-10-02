/** #1967: the build-family routes are POSTs, so the editor streams them with `backendEventStream` (fetch + a reader)
 *  instead of `EventSource` (GET only), and the editor and the MCP parse the stream with ONE parser (`sseFrames.ts`). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSseParser, type SseFrame } from '../../src/editor/backend/sseFrames';
import { backendEventStream } from '../../src/editor/backend/editorBackend';

const frames = (chunks: string[], end = true): SseFrame[] => {
  const out: SseFrame[] = [];
  const p = createSseParser((f) => out.push(f));
  for (const c of chunks) p.push(c);
  if (end) p.end();
  return out;
};

describe('createSseParser', () => {
  it('a frame split across chunks — mid-field and mid-terminator — is delivered once, whole', () => {
    const whole = 'event: status\ndata: "DONE"\n\n';
    for (let i = 1; i < whole.length; i++) {
      expect(frames([whole.slice(0, i), whole.slice(i)], false), `split at ${i}`).toEqual([{ event: 'status', data: '"DONE"' }]);
    }
  });

  it('a frame with no event: is a message; several data: lines join with a newline; comments and id: are skipped', () => {
    expect(frames(['data: "a"\n\n: keep-alive\n\nid: 7\nevent: step\ndata: {"step":1,\ndata: "total":2}\n\n'])).toEqual([
      { event: 'message', data: '"a"' },
      { event: 'step', data: '{"step":1,\n"total":2}' },
    ]);
  });

  it('a CRLF terminator split across two chunks still ends the frame (normalised on the buffer, not the chunk)', () => {
    expect(frames(['data: "a"\r\n\r', '\ndata: "b"\r\n\r\n'], false)).toEqual([
      { event: 'message', data: '"a"' },
      { event: 'message', data: '"b"' },
    ]);
  });

  it('CRLF line endings parse the same, and a last frame with no blank line is delivered at end()', () => {
    expect(frames(['event: status\r\ndata: "x"\r\n\r\ndata: "tail"'])).toEqual([
      { event: 'status', data: '"x"' },
      { event: 'message', data: '"tail"' },
    ]);
  });
});

/** A `fetch` Response whose body yields `chunks`, one per read. */
const streamed = (chunks: string[], init: ResponseInit = { status: 200 }) => new Response(new ReadableStream({
  start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
}), init);

describe('backendEventStream', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs the path — never a GET — and hands each event to its listeners in order', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => streamed(['data: "line 1"\n\nevent: step\ndata: {"step":1,"total":2}\n', '\nevent: status\ndata: "DONE"\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const got: string[] = [];
    const s = backendEventStream('/api/build?platform=web');
    s.onmessage = (e) => got.push(`message ${e.data}`);
    s.addEventListener('step', (e) => got.push(`step ${e.data}`));
    await new Promise<void>((resolve) => {
      s.addEventListener('status', (e) => { got.push(`status ${e.data}`); s.close(); resolve(); });
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/build?platform=web');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(got).toEqual(['message "line 1"', 'step {"step":1,"total":2}', 'status "DONE"']);
  });

  it('a refusal before the stream opens reaches onerror with the server\'s own reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, switching: true, error: 'The editor is switching project' }), { status: 503 })));
    const failure = await new Promise((resolve) => { backendEventStream('/api/build?platform=web').onerror = resolve; });
    expect(failure).toEqual({ refused: true, reason: 'The editor is switching project' });
  });

  it('a stream that ends with no final status the caller closed on is an error; one the caller closed is not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamed(['data: "half a build"\n\n'])));
    await new Promise<void>((resolve) => { backendEventStream('/api/build').onerror = (r) => { expect(r).toBeUndefined(); resolve(); }; });

    vi.stubGlobal('fetch', vi.fn(async () => streamed(['event: status\ndata: "DONE"\n\n'])));
    const onerror = vi.fn();
    const closed = backendEventStream('/api/build');
    closed.onerror = onerror;
    await new Promise<void>((resolve) => { closed.addEventListener('status', () => { closed.close(); resolve(); }); });
    await new Promise((r) => setTimeout(r, 10));
    expect(onerror).not.toHaveBeenCalled();
  });
});

/** #1967's other caller sweep: `/api/rescan-assets` writes sidecars, so it is POST only, and the panels' rescans must
 *  say so (a GET gets a 405 and no assets). Assets.tsx's fetch is a `.tsx` panel (no unit test by convention); this is
 *  the `.ts` one. */
describe('backendEventStream — what the #1991 review found', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a listener that THROWS does not abort the request (the server would kill the job) and later events still arrive', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return streamed(['data: not json\n\n', 'event: status\ndata: "DONE"\n\n']);
    }));
    const s = backendEventStream('/api/build');
    const onerror = vi.fn();
    s.onerror = onerror;
    s.onmessage = (e) => { JSON.parse(e.data); }; // throws on the malformed frame, as setup.ts's would
    await new Promise<void>((resolve) => { s.addEventListener('status', () => resolve()); });
    expect(signal?.aborted).toBe(false);
    expect(onerror).not.toHaveBeenCalled();
    s.close();
  });

  it('a refusal (an error status) is told apart from a connection that failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const failed = await new Promise((resolve) => { backendEventStream('/api/build').onerror = resolve; });
    expect(failed).toEqual({ refused: false, reason: 'Failed to fetch' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })));
    const refused = await new Promise((resolve) => { backendEventStream('/api/build').onerror = resolve; });
    expect(refused).toEqual({ refused: true, reason: 'POST only' });
  });
});

describe('readWritableAssetRoot POSTs its rescan', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks /api/rescan-assets with POST', async () => {
    const { readWritableAssetRoot } = await import('../../src/editor/panels/assetOps');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ assets: [{ path: '/assets/a.png' }] }), { status: 200 })
      : new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readWritableAssetRoot()).toEqual({ ok: true, root: '/assets' });
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });
});
