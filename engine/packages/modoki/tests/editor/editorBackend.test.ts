/** `jsonFileBody`/`writeAssetFile`/`postWriteFile` — the client-side JSON write seam (#835),
 *  the mirror of the server's `assetJsonBytes` (`editorBackendRouter.ts`,
 *  `assetJsonBytesAgree.test.ts`).
 *
 *  ⚠️ **Assert on the BYTES, not a parsed round-trip or a re-derivation of the function under
 *  test.** `JSON.parse` succeeds identically with or without the trailing newline — exactly how
 *  this defect survived in the corpus for so long — and a test that computes its own "expected"
 *  by calling `jsonFileBody` again can never fail when `jsonFileBody` itself regresses, since
 *  both sides mutate together. The literal string below is the independent check. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonFileBody, writeAssetFile, postWriteFile } from '../../src/editor/backend/editorBackend';

describe('jsonFileBody', () => {
  it('ends every document with a trailing newline — asserted on a LITERAL expected string', () => {
    const body = jsonFileBody({ a: 1 });
    // Not `jsonFileBody({a:1}) === jsonFileBody({a:1})` — that can never fail. A literal string is
    // the only version of this assertion that can catch a regression in the function itself.
    expect(body).toBe('{\n  "a": 1\n}\n');
    expect(body.endsWith('\n')).toBe(true);
    expect(body.codePointAt(body.length - 1)).toBe(0x0a);
  });

  it('matches JSON.stringify(data, null, 2) plus exactly one trailing newline, for a nested document', () => {
    const doc = { id: 'g1', nested: { a: [1, 2, 3] }, s: 'x' };
    expect(jsonFileBody(doc)).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});

describe('writeAssetFile / postWriteFile — the ONE client /api/write-file wrapper', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('POSTs { path, content, encoding } to /api/write-file, content passed through UNCHANGED', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true, status: 200 } as Response;
    }));

    const ok = await writeAssetFile('/assets/x.json', 'RAW CONTENT — not re-serialised here');
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { url: '/api/write-file', body: { path: '/assets/x.json', content: 'RAW CONTENT — not re-serialised here' } },
    ]);
  });

  it('a JSON write composed with jsonFileBody reaches the network with its newline intact', async () => {
    let posted: { path: string; content: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      posted = JSON.parse(init!.body as string);
      return { ok: true, status: 200 } as Response;
    }));

    await writeAssetFile('/assets/doc.json', jsonFileBody({ id: 'g1' }));
    expect(posted).not.toBeNull();
    expect(posted!.content.endsWith('\n')).toBe(true);
    expect(posted!.content).toBe('{\n  "id": "g1"\n}\n');
  });

  it('a base64 write passes encoding through and content is NEVER touched by jsonFileBody', async () => {
    let posted: { path: string; content: string; encoding?: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      posted = JSON.parse(init!.body as string);
      return { ok: true, status: 200 } as Response;
    }));

    const base64 = 'AAECAwQ='; // arbitrary binary bytes, base64-encoded — must survive byte-exact
    await writeAssetFile('/assets/x.glb', base64, 'base64');
    expect(posted).toEqual({ path: '/assets/x.glb', content: base64, encoding: 'base64' });
    // The defining property this guards: a binary write must not end up newline-terminated.
    expect(posted!.content.endsWith('\n')).toBe(false);
  });

  it('resolves false (never throws) when the network call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(writeAssetFile('/assets/x.json', 'content')).resolves.toBe(false);
  });

  it('resolves false when the server answers non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    await expect(writeAssetFile('/assets/x.json', 'content')).resolves.toBe(false);
  });

  it('postWriteFile returns the raw Response (status included) for a caller that needs it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409 }) as Response));
    const res = await postWriteFile('/assets/x.json', 'content');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });
});
