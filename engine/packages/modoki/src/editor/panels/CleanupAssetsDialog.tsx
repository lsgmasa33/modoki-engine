/** "Clean Up Unused Assets" dialog.
 *
 *  Runs the static asset tree-shaker over the open project (GET /api/unused-assets)
 *  and lists every orphan — a file on disk that no scene/prefab reaches, i.e. what
 *  the production build would tree-shake out. The user checks which to remove and
 *  hits Delete; each goes to the OS trash (recoverable) via /api/delete-asset,
 *  alongside its `.meta.json` sidecar when present.
 *
 *  Gated by editorStore.cleanupAssetsOpen (opened from the Assets menu). */

import { useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '../store/editorStore';
import { backendFetch, backendPostJson } from '../backend/editorBackend';

interface Orphan { path: string; type: string; bytes: number }
interface UnusedResponse {
  orphans?: Orphan[];
  totalBytes?: number;
  sceneCount?: number;
  warnings?: string[];
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer',
  fontFamily: 'monospace', fontSize: 11, ...extra,
});

export default function CleanupAssetsDialog() {
  const open = useEditorStore((s) => s.cleanupAssetsOpen);
  const close = useEditorStore((s) => s.closeCleanupAssets);

  const [data, setData] = useState<UnusedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await backendFetch('/api/unused-assets');
      const j = (await res.json()) as UnusedResponse;
      if (!res.ok || j.error) throw new Error(j.error || `scan failed (${res.status})`);
      setData(j);
      // Default every orphan selected — cleanup is the intent, and delete is
      // recoverable (OS trash). Select-all/none below flips it.
      setSelected(new Set((j.orphans ?? []).map((o) => o.path)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-scan each time the dialog opens (the project may have changed since last).
  useEffect(() => { if (open) scan(); }, [open, scan]);

  if (!open) return null;

  const orphans = data?.orphans ?? [];
  const toggle = (path: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const allSelected = orphans.length > 0 && selected.size === orphans.length;
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.path)));

  const selectedBytes = orphans.filter((o) => selected.has(o.path)).reduce((s, o) => s + o.bytes, 0);

  const deleteSelected = async () => {
    const paths = orphans.filter((o) => selected.has(o.path)).map((o) => o.path);
    if (paths.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      // Trash each orphan AND its .meta.json sidecar (missing ones are skipped
      // server-side, so binaries-with-sidecar and JSON-assets-without both work).
      const withSidecars = paths.flatMap((p) => [p, `${p}.meta.json`]);
      const res = await backendPostJson('/api/delete-asset', { paths: withSidecars });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || `delete failed (${res.status})`);
      // Re-scan to show what remains (the manifest refreshes via the file watcher).
      await scan();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        minWidth: 480, maxWidth: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Clean Up Unused Assets</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
          Files no scene or prefab references — what the production build would drop.
          Deleting moves them to the Trash (recoverable).
        </div>

        {loading ? (
          <div style={{ color: '#888', fontSize: 12, padding: '20px 0' }}>Scanning…</div>
        ) : error && !data ? (
          <div style={{ color: '#e74c3c', fontSize: 12, padding: '12px 0', whiteSpace: 'pre-wrap' }}>{error}</div>
        ) : orphans.length === 0 ? (
          <div style={{ color: '#2ecc71', fontSize: 12, padding: '20px 0' }}>
            No unused assets — every shippable file is referenced by a scene or prefab
            {data?.sceneCount != null ? ` (${data.sceneCount} scene${data.sceneCount === 1 ? '' : 's'} scanned).` : '.'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: '#aaa' }}>
              <button onClick={selectAll} style={btn({ padding: '3px 10px' })}>
                {allSelected ? 'Select none' : 'Select all'}
              </button>
              <span>{orphans.length} unused · {formatBytes(data?.totalBytes ?? 0)} total</span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, minHeight: 120 }}>
              {orphans.map((o) => {
                const slash = o.path.lastIndexOf('/');
                const name = slash >= 0 ? o.path.slice(slash + 1) : o.path;
                const dir = slash >= 0 ? o.path.slice(0, slash + 1) : '';
                const checked = selected.has(o.path);
                return (
                  <label key={o.path} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
                    borderBottom: '1px solid #2a2a3a', cursor: 'pointer', fontSize: 11,
                    background: checked ? '#26263c' : 'transparent',
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(o.path)} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#666' }}>{dir}</span>
                      <span style={{ color: '#ddd' }}>{name}</span>
                    </span>
                    <span style={{ color: '#7a7aa0', minWidth: 64, textAlign: 'right' }}>{o.type}</span>
                    <span style={{ color: '#999', minWidth: 64, textAlign: 'right' }}>{formatBytes(o.bytes)}</span>
                  </label>
                );
              })}
            </div>

            {(data?.warnings?.length ?? 0) > 0 && (
              <div style={{ marginTop: 8, color: '#e0a030', fontSize: 10, maxHeight: 72, overflowY: 'auto' }}>
                ⚠ {data!.warnings!.length} scan warning{data!.warnings!.length === 1 ? '' : 's'} — an asset reached only by an
                unresolved reference could be listed here in error. Review before deleting:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {data!.warnings!.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                  {data!.warnings!.length > 8 && <li>…and {data!.warnings!.length - 8} more</li>}
                </ul>
              </div>
            )}

            {error && <div style={{ marginTop: 8, color: '#e74c3c', fontSize: 11, whiteSpace: 'pre-wrap' }}>{error}</div>}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={close} style={btn()}>Close</button>
          {orphans.length > 0 && (
            <button
              onClick={deleteSelected}
              disabled={deleting || selected.size === 0}
              style={btn({
                background: selected.size === 0 ? '#3a2a2a' : '#5c2a2a',
                borderColor: '#7a3a3a',
                color: selected.size === 0 ? '#888' : '#fff',
                cursor: deleting || selected.size === 0 ? 'default' : 'pointer',
              })}
            >
              {deleting ? 'Deleting…' : `Delete ${selected.size} selected (${formatBytes(selectedBytes)})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
