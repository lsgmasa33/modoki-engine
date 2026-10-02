/** A fake asset backend for undo/redo tests that need a DISK, not a request log (#1679).
 *
 *  It holds the exact bytes each write sent (base64 decoded, as `/api/write-file` decodes it) and applies the
 *  preconditions the real routes apply, over those stored bytes:
 *  - `/api/write-file`: `ifMatch` → 409 `reason:'if-match'` unless sha256(stored bytes) equals it, or nothing is stored;
 *    `ifNoneMatch:'*'` → 409 `reason:'if-none-match'` when anything is stored.
 *  - `/api/delete-asset`: every `ifMatch` checked first, and one miss trashes NOTHING (409 `reason:'if-match'` with
 *    `conflicts`); otherwise each present path (a folder with everything under it) is removed, absent ones are
 *    `missing`. A lone absent `path` with no precondition is a 404. (`ifEmpty`/`ifSettings` went from the route with
 *    their only callers, #1868, so the fake models them no longer.)
 *  - `/api/duplicate-asset`: 409 on an occupied destination; a `.json` copy is RE-MINTED (a fresh `id`), a binary copy
 *    takes its `.meta.json` along (the source's, with a fresh `id` and no `generated`, as `duplicateAssetFile` does);
 *    answers the sha256 of the copy's stored bytes and, for a binary, the sidecar it wrote.
 *  - `/api/rescan-assets`: runs `onRescan` (a test's stand-in for the scanner's GUID heal), and answers `rescanBody()`
 *    (the manifest the real route returns; `{}` unless a test supplies one, #1844).
 *  - any other GET: serves the stored bytes.
 *
 *  So a precondition a test sees accepted was compared against the bytes the forward step really wrote, not against a
 *  recomputation of them. The ROUTE's own rule is pinned against the real router in
 *  `engine/tests/plugins/deleteAssetPreconditions.test.ts`; this fake only has to agree with it. */

import { createHash } from 'node:crypto';

export interface FakeAssetRoute {
  disk: Map<string, Buffer>;
  folders: Set<string>;
  calls: Array<{ url: string; body: Record<string, unknown> | undefined }>;
  /** URL substrings that answer 500 (a backend failure, not a refusal). */
  fail: Set<string>;
  /** `/api/write-file` target paths that answer 500 — one file's write failing while the rest land. */
  failWrites: Set<string>;
  onRescan: () => void;
  /** What `/api/rescan-assets` answers: the manifest the real route returns (`ctx.rebuildManifest()`). */
  rescanBody: () => unknown;
  put(path: string, content: string | Buffer): void;
  text(path: string): string | undefined;
  fetch: (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
}

/** The route's hash (`ifMatchRefusal`): the stored bytes with a leading UTF-8 BOM stripped. */
export const sha256 = (b: Buffer | string): string => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return createHash('sha256').update(buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf).digest('hex');
};

export function makeFakeAssetRoute(): FakeAssetRoute {
  const disk = new Map<string, Buffer>();
  const folders = new Set<string>();
  const calls: FakeAssetRoute['calls'] = [];
  let dups = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const under = (p: string) => [...disk.keys(), ...folders].filter((k) => k.startsWith(`${p}/`));

  const route: FakeAssetRoute = {
    disk, folders, calls, fail: new Set(), failWrites: new Set(), onRescan: () => {}, rescanBody: () => ({}),
    put(path, content) { disk.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content)); },
    text(path) { return disk.get(path)?.toString('utf8'); },
    async fetch(url, init) {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url: u, body });
      if ([...route.fail].some((f) => u.includes(f))) return reply(500, { error: 'backend failure' });

      if (u.endsWith('/api/write-file')) {
        const b = body as { path: string; content: string; encoding?: string; ifMatch?: string; ifNoneMatch?: string };
        if (route.failWrites.has(b.path)) return reply(500, { error: 'backend failure' });
        const cur = disk.get(b.path);
        if (b.ifMatch !== undefined && (cur === undefined || sha256(cur) !== b.ifMatch)) return reply(409, { ok: false, conflict: true, reason: 'if-match' });
        if (b.ifNoneMatch === '*' && cur !== undefined) return reply(409, { ok: false, conflict: true, reason: 'if-none-match', existingPath: b.path });
        disk.set(b.path, b.encoding === 'base64' ? Buffer.from(b.content, 'base64') : Buffer.from(b.content));
        return reply(200, { ok: true });
      }

      if (u.endsWith('/api/delete-asset')) {
        const b = body as { path?: string; paths?: string[]; ifMatch?: string | Record<string, string> };
        const batch = Array.isArray(b.paths);
        const inputs = batch ? b.paths! : [b.path!];
        const expectSha = new Map<string, string>(
          typeof b.ifMatch === 'string' ? [[inputs[0], b.ifMatch]] : Object.entries(b.ifMatch ?? {}),
        );
        const conflicts = inputs.filter((p) => {
          if (expectSha.has(p)) { const cur = disk.get(p); if (cur === undefined || sha256(cur) !== expectSha.get(p)) return true; }
          return false;
        });
        if (conflicts.length) return reply(409, { ok: false, conflict: true, reason: 'if-match', conflicts });
        const present = inputs.filter((p) => disk.has(p) || folders.has(p));
        const missing = inputs.filter((p) => !present.includes(p));
        if (!batch && present.length === 0 && expectSha.size === 0) return reply(404, { error: 'File not found' });
        for (const p of present) { disk.delete(p); folders.delete(p); for (const k of under(p)) { disk.delete(k); folders.delete(k); } }
        return reply(200, { ok: true, trashed: present.length, missing, failed: [] });
      }

      if (u.endsWith('/api/duplicate-asset')) {
        const b = body as { from: string; to: string };
        const src = disk.get(b.from);
        if (src === undefined) return reply(404, { error: 'Source not found' });
        if (disk.has(b.to)) return reply(409, { error: 'Destination exists' });
        let copy = src;
        let sidecar: Record<string, unknown> | undefined;
        if (b.to.endsWith('.json')) copy = Buffer.from(`${JSON.stringify({ ...JSON.parse(src.toString('utf8')), id: `dup-${++dups}` }, null, 2)}\n`);
        else if (disk.has(`${b.from}.meta.json`)) {
          const { generated: _generated, ...meta } = JSON.parse(disk.get(`${b.from}.meta.json`)!.toString('utf8')) as Record<string, unknown>;
          sidecar = { ...meta, id: `dup-meta-${++dups}` };
          disk.set(`${b.to}.meta.json`, Buffer.from(JSON.stringify(sidecar)));
        }
        disk.set(b.to, copy);
        return reply(200, { ok: true, saved: true, sha256: sha256(copy), ...(sidecar ? { sidecar } : {}) });
      }

      if (u.endsWith('/api/rescan-assets')) {
        // POST only, as the real route (#1967): a caller that GETs it gets the 405, not a rescan.
        if (init?.method !== 'POST') return reply(405, { error: 'POST /api/rescan-assets' });
        route.onRescan();
        return reply(200, route.rescanBody());
      }
      if (u.includes('/api/')) return reply(200, { ok: true });

      const path = u.replace(/^https?:\/\/[^/]+/, '');
      const cur = disk.get(path);
      return cur === undefined ? new Response('', { status: 404 }) : new Response(new Uint8Array(cur), { status: 200 });
    },
  };
  return route;
}
