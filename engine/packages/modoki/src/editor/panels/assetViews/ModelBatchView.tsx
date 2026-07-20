/** ModelBatchView — multi-select editor for N model (.glb) assets. Batch-sets the
 *  postprocessor across the selection (differing values show "Mixed") and offers a
 *  single "Re-import all (N)". Meta writes are fire-and-forget, matching the
 *  single-asset model view. */

import { useState, useEffect, useCallback } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import { getModelPostprocessorIds } from '../../../runtime/loaders/modelPostprocessorRegistry';
import { inputStyle, MIXED_PLACEHOLDER } from '../fields';
import { reimportBtnStyle } from './widgets';
import { reimportPaths } from './reimport';
import type { SelectedAsset } from '../../store/editorStore';

export function ModelBatchView({ assets }: { assets: SelectedAsset[] }) {
  const paths = assets.map((a) => a.path);
  const [postprocessors, setPostprocessors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const postprocessorIds = getModelPostprocessorIds();
  const setImportStatus = useEditorStore((s) => s.setImportStatus);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);

  const loadAll = useCallback(async () => {
    setLoaded(false);
    const entries = await Promise.all(paths.map(async (p) => {
      try {
        const r = await backendFetch(`/api/read-meta?path=${encodeURIComponent(p)}`);
        const m = r.ok ? await r.json() : {};
        return [p, (m.postprocessor as string) ?? 'none'] as const;
      } catch { return [p, 'none'] as const; }
    }));
    setPostprocessors(Object.fromEntries(entries));
    setLoaded(true);
  }, [paths]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const values = paths.map((p) => postprocessors[p] ?? 'none');
  const mixed = values.length > 0 && !values.every((v) => v === values[0]);
  const common = mixed ? '' : (values[0] ?? 'none');

  const applyPostprocessor = useCallback((next: string) => {
    setPostprocessors((prev) => {
      const updated: Record<string, string> = { ...prev };
      for (const p of paths) {
        updated[p] = next;
        backendFetch('/api/write-meta', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, meta: { version: 1, postprocessor: next } }),
        }).catch(() => {});
      }
      return updated;
    });
  }, [paths]);

  const reimportAll = useCallback(async () => {
    setImporting(true);
    try {
      await reimportPaths(paths.map((p) => ({ path: p, type: 'model' })), setImportStatus, `Re-importing ${paths.length} models…`);
      await loadAll();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [paths, setImportStatus, loadAll, refreshAssets]);

  if (!loaded) return <div style={{ color: '#666', fontSize: 11 }}>Loading {paths.length} models…</div>;

  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <div style={{ color: '#888', fontSize: '10px', marginBottom: 2 }}>Postprocessor</div>
        <select value={common} onChange={(e) => { if (e.target.value) applyPostprocessor(e.target.value); }} style={{ ...inputStyle, width: '100%' }}>
          {mixed && <option value="">{MIXED_PLACEHOLDER}</option>}
          {postprocessorIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      <button
        disabled={importing}
        onClick={reimportAll}
        style={{ ...reimportBtnStyle, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Converting…' : `Re-import all (${paths.length})`}
      </button>
    </>
  );
}
