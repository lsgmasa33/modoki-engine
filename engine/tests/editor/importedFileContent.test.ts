/** #1713 — the Assets panel's OS-file drop writes what `importedFileContent` answers, never the dropped bytes of a
 *  JSON asset as they came: those carry the source's id, and a copy of an asset the project already has would claim
 *  its guid. The decision itself is the backend's (`importIdentity.test.ts`); this pins the client half.
 *
 *  Mutations, each checked red: fall back to the dropped bytes when the backend fails — the failure cases go red;
 *  skip the round trip for `.json` too — the prefab case goes red; stop adding the answered id to `claimed` — the batch
 *  case goes red. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { importedFileContent } from '../../packages/modoki/src/editor/backend/editorBackend';

const DROPPED = Buffer.from('{"id":"11111111-1111-4111-8111-111111111111"}').toString('base64');
const FRESH = Buffer.from('{"id":"22222222-2222-4222-8222-222222222222"}\n').toString('base64');

afterEach(() => { vi.restoreAllMocks(); });

describe('importedFileContent (#1713)', () => {
  it('a JSON asset is written as the backend answers it', async () => {
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, content: FRESH }), { status: 200 }));
    expect(await importedFileContent('/assets/imp/Box.prefab.json', DROPPED)).toBe(FRESH);
    expect(String(fetchStub.mock.calls[0][0])).toContain('/api/import-identity');
    expect(JSON.parse(String(fetchStub.mock.calls[0][1]?.body))).toEqual({ path: '/assets/imp/Box.prefab.json', content: DROPPED, claimed: [] });
  });

  it('one batch shares `claimed`: each call sends what the batch decided so far, and adds the id it was answered', async () => {
    const fetchStub = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: DROPPED, id: 'id-one' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: FRESH, id: 'id-two' }), { status: 200 }));
    const claimed = new Set<string>();
    await importedFileContent('/assets/imp/a.prefab.json', DROPPED, claimed);
    await importedFileContent('/assets/imp/b.prefab.json', DROPPED, claimed);
    const sent = fetchStub.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).claimed);
    expect(sent).toEqual([[], ['id-one']]);
    expect([...claimed]).toEqual(['id-one', 'id-two']);
  });

  it('a backend failure refuses the file (null) — it never falls back to the dropped bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    expect(await importedFileContent('/assets/imp/Box.prefab.json', DROPPED)).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await importedFileContent('/assets/imp/Box.prefab.json', DROPPED)).toBeNull();
  });

  it('OTHER SIDE: a binary is written as dropped, with no round trip', async () => {
    const fetchStub = vi.spyOn(globalThis, 'fetch');
    expect(await importedFileContent('/assets/imp/dot.png', DROPPED)).toBe(DROPPED);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
