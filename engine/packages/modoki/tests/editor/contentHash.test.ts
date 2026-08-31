/** contentHash's `sha256Hex` (#469) — the CLIENT half of the `ifMatch` precondition on
 *  `POST /api/write-file`. Both sides must agree on the SAME bytes for the same content: the
 *  server hashes the raw file buffer with Node's `crypto.createHash('sha256')`
 *  (`editorBackendRouter.ts`), this hashes the UTF-8 encoding of the same string with
 *  `crypto.subtle.digest`. A silent disagreement here would make every conditional write
 *  report a conflict — a worse failure than the race #469 fixes. */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { sha256Hex } from '../../src/editor/utils/contentHash';

describe('sha256Hex', () => {
  it('agrees with Node crypto over the UTF-8 bytes of a known string', async () => {
    const text = '{"members":["a","b"],"pageSize":512,"padding":1,"extrude":2}\n';
    const expected = crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
    expect(await sha256Hex(text)).toBe(expected);
  });

  it('agrees with Node crypto for an empty string', async () => {
    const expected = crypto.createHash('sha256').update(Buffer.from('', 'utf-8')).digest('hex');
    expect(await sha256Hex('')).toBe(expected);
  });

  it('agrees with Node crypto for non-ASCII content (multi-byte UTF-8)', async () => {
    const text = '{"name":"アトラス — 🎮"}\n';
    const expected = crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
    expect(await sha256Hex(text)).toBe(expected);
  });

  it('is lowercase hex', async () => {
    const hash = await sha256Hex('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content (sanity — not a constant)', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});
