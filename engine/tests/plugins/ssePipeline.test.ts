/**
 * #1259 — every SSE stream ends with a status. The helper's contract, on a fake response:
 * a rejection becomes exactly one `FAILED:` verdict and an `end()`, a response that is already
 * over is left alone, and the slot's `onEnd` runs exactly once whatever the body does. The route
 * wiring is covered by sseRouteRejection.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { catchMiddlewareRejection, failSseResponse, isSseResponse, runSsePipeline, type SseResponse } from '../../plugins/ssePipeline';

interface FakeRes extends SseResponse {
  writes: string[];
  ends: number;
  headers: Record<string, string>;
  statuses(): string[];
}

function fakeRes(opts: { sse?: boolean; ended?: boolean; destroyed?: boolean } = {}): FakeRes {
  const res = {
    writes: [] as string[],
    ends: 0,
    headers: (opts.sse ?? true) ? { 'content-type': 'text/event-stream' } : {} as Record<string, string>,
    writableEnded: opts.ended ?? false,
    destroyed: opts.destroyed ?? false,
    headersSent: false,
    getHeader(name: string) { return this.headers[name.toLowerCase()]; },
    write(chunk: string) { this.writes.push(chunk); return true; },
    end() { this.ends++; this.writableEnded = true; return this; },
    statuses() {
      return this.writes
        .filter((w) => w.startsWith('event: status\n'))
        .map((w) => JSON.parse(w.slice('event: status\ndata: '.length)) as string);
    },
  };
  return res as unknown as FakeRes;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('failSseResponse', () => {
  it('writes exactly one FAILED status carrying headline and message, then ends', () => {
    const res = fakeRes();
    expect(failSseResponse(res, 'android build', new Error('boom'))).toBe(true);
    // Nothing but the status: a separate log line printed the message twice in the Build Support dialog.
    expect(res.writes).toEqual([`event: status\ndata: ${JSON.stringify('FAILED:android build\nboom')}\n\n`]);
    expect(res.ends).toBe(1);
  });

  it('still fails the stream when the rejection value cannot be turned into text', () => {
    const res = fakeRes();
    const hostile = Object.create(null) as object; // String(hostile) throws: no toString
    expect(failSseResponse(res, 'h', hostile)).toBe(true);
    expect(res.statuses()[0]).toMatch(/^FAILED:h\nunknown error/);
    expect(res.ends).toBe(1);
  });

  it('writes nothing to a response the handler already ended', () => {
    const res = fakeRes({ ended: true });
    expect(failSseResponse(res, 'x', new Error('late'))).toBe(false);
    expect(res.writes).toEqual([]);
    expect(res.ends).toBe(0);
  });

  it('writes nothing to a response a client disconnect destroyed', () => {
    const res = fakeRes({ destroyed: true });
    expect(failSseResponse(res, 'x', new Error('gone'))).toBe(false);
    expect(res.writes).toEqual([]);
  });

  it('carries a non-Error rejection value as its string', () => {
    const res = fakeRes();
    failSseResponse(res, 'h', 'plain');
    expect(res.statuses()).toEqual(['FAILED:h\nplain']);
  });
});

describe('runSsePipeline', () => {
  it('turns a rejection into one FAILED status, ends the stream, and runs onEnd once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const onEnd = vi.fn();
    await runSsePipeline(res, 'OTA publish', async () => { await Promise.resolve(); throw new Error('ENOENT tmp'); }, onEnd);
    expect(res.statuses()).toEqual(['FAILED:OTA publish\nENOENT tmp']);
    expect(res.ends).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('adds nothing to a body that finished its own stream', async () => {
    const res = fakeRes();
    const onEnd = vi.fn();
    await runSsePipeline(res, 'build', async () => {
      res.write('event: status\ndata: "DONE"\n\n');
      res.end();
    }, onEnd);
    expect(res.statuses()).toEqual(['DONE']);
    expect(res.ends).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not append a second verdict when the body rejects AFTER ending the stream', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const onEnd = vi.fn();
    await runSsePipeline(res, 'build', async () => {
      res.write('event: status\ndata: "DONE"\n\n');
      res.end();
      throw new Error('after the fact');
    }, onEnd);
    expect(res.statuses()).toEqual(['DONE']);
    expect(res.ends).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the client disconnected before the rejection, and still runs onEnd', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const onEnd = vi.fn();
    await runSsePipeline(res, 'build', async () => {
      (res as { destroyed: boolean }).destroyed = true;
      throw new Error('mid-step');
    }, onEnd);
    expect(res.writes).toEqual([]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('writes the verdict even when logging the rejection throws (a value whose inspect hook throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('inspect boom'); });
    const res = fakeRes();
    const onEnd = vi.fn();
    await expect(runSsePipeline(res, 'build', async () => { throw new Error('real cause'); }, onEnd)).resolves.toBeUndefined();
    expect(res.statuses()).toEqual(['FAILED:build\nreal cause']);
    expect(res.ends).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('treats a body that throws SYNCHRONOUSLY (not an async literal) like a rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const onEnd = vi.fn();
    const syncThrower = (() => { throw new Error('before any await'); }) as unknown as () => Promise<void>;
    await runSsePipeline(res, 'build', syncThrower, onEnd);
    expect(res.statuses()).toEqual(['FAILED:build\nbefore any await']);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('starts the body synchronously — no tick between the call and its first statement', () => {
    const res = fakeRes();
    let started = false;
    void runSsePipeline(res, 'build', async () => { started = true; });
    expect(started).toBe(true);
  });
});

describe('catchMiddlewareRejection', () => {
  const req = { method: 'GET', url: '/api/build?platform=web' } as never;

  it('ends an open SSE response with a FAILED status and does not call next', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes({ sse: true });
    const next = vi.fn();
    catchMiddlewareRejection(async () => { throw new Error('plan threw'); })(req, res as never, next);
    await vi.waitFor(() => expect(res.ends).toBe(1));
    expect(res.statuses()).toEqual(['FAILED:Unexpected error\nplan threw']);
    expect(next).not.toHaveBeenCalled();
  });

  it('ends the SSE response and forwards non-SSE errors even when logging throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('inspect boom'); });
    const sse = fakeRes({ sse: true });
    catchMiddlewareRejection(async () => { throw new Error('plan threw'); })(req, sse as never, vi.fn());
    await vi.waitFor(() => expect(sse.ends).toBe(1));
    expect(sse.statuses()).toEqual(['FAILED:Unexpected error\nplan threw']);

    const plain = fakeRes({ sse: false });
    const next = vi.fn();
    const err = new Error('json route threw');
    catchMiddlewareRejection(async () => { throw err; })(req, plain as never, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(err));
  });

  it('forwards a non-SSE rejection to next(err) — what connect does for a synchronous throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes({ sse: false });
    const next = vi.fn();
    const err = new Error('json route threw');
    catchMiddlewareRejection(async () => { throw err; })(req, res as never, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(err));
    expect(res.writes).toEqual([]);
  });

  it('leaves a finished non-SSE response alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes({ sse: false, ended: true });
    const next = vi.fn();
    const settled = vi.fn();
    catchMiddlewareRejection(async () => { settled(); throw new Error('late'); })(req, res as never, next);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(settled).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a resolving handler through untouched', async () => {
    const res = fakeRes();
    const next = vi.fn();
    const handler = vi.fn(async (_q: unknown, _r: unknown, n: () => void) => { n(); });
    catchMiddlewareRejection(handler)(req, res as never, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith());
    expect(res.writes).toEqual([]);
  });

  it('recognises the SSE content type by prefix (a charset suffix still counts)', () => {
    const res = fakeRes({ sse: false });
    res.headers['content-type'] = 'text/event-stream; charset=utf-8';
    expect(isSseResponse(res)).toBe(true);
  });
});
