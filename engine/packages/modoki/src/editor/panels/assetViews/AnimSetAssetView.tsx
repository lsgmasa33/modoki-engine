/** AnimSetAssetView — editor for a `.animset.json`: per-clip skeletal playback
 *  params (speed / loop / fadeDuration). Extracted from Inspector.tsx
 *  (editor-inspector.md F2). Mirrors MaterialAssetView's load → write-file →
 *  invalidate flow, plus setAnimSet so the running scene picks up edits next
 *  frame without a reload. Editing applies live to any SkeletalAnimator whose
 *  `clip` leaves the matching field at its trait default (= inherit). */

import { useState, useEffect, useRef, useCallback } from 'react';
import { pushAction } from '../../undo/undoManager';
import type { AnimSetClipDef } from '../../../runtime/loaders/animSetCache';
import { NumberField } from './widgets';
import { persistAssetEdit, useAssetViewRefresher, invalidateAnimSetFile } from './persist';
import { pendingAssetDoc } from '../pendingAssetDoc';
import { parseAssetJson, isMissingAsset } from '../../../runtime/loaders/assetFetch';

export function AnimSetAssetView({ path }: { path: string }) {
  const [data, setData] = useState<{ source?: string; clips?: AnimSetClipDef[] } | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    // ⚠️ A parked (unsaved) edit is NOT on disk (#831), so fetching the file here would re-seed
    // the panel — and, through the refresher, the live cache — with the PRE-edit document while
    // the registry still holds the newer one. The panel then shows a document that disagrees with
    // what Cmd+S would write, which `pendingAssetDoc`'s docblock calls the worst of the three
    // states; it has been filed three times already (QA-CTX-0008 and two more). Ask the registry
    // first, exactly as the five asset EDITORS do, and fall back to the file when nothing pends.
    const parked = pendingAssetDoc(path, 'animset');
    if (parked) { setData(parked as { source?: string; clips?: AnimSetClipDef[] }); return; }
    const ac = new AbortController();
    fetch(path, { signal: ac.signal })
      .then(r => parseAssetJson(r, path))
      .catch(e => { if (isMissingAsset(e)) return null; throw e; })
      .then((data) => setData(data as { source?: string; clips?: AnimSetClipDef[] } | null))
      .catch(e => { if (e.name !== 'AbortError') setData(null); });
    return () => ac.abort();
  }, [path]);
  useAssetViewRefresher(path, setData);

  const writeData = useCallback((updated: typeof data, label: string) => {
    const old = dataRef.current;
    if (!old || !updated) return;
    persistAssetEdit(path, 'animset', updated, invalidateAnimSetFile);
    pushAction({
      _isFileDirect: true, // parked, not scene state (persistAssetEdit) — see MaterialAssetView for why
      label,
      undo: () => persistAssetEdit(path, 'animset', old, invalidateAnimSetFile),
      redo: () => persistAssetEdit(path, 'animset', updated, invalidateAnimSetFile),
    });
  }, [path]);

  const writeClipField = useCallback((index: number, field: keyof AnimSetClipDef, value: unknown) => {
    const cur = dataRef.current;
    if (!cur?.clips) return;
    const clips = cur.clips.map((c, i) => (i === index ? { ...c, [field]: value } : c));
    writeData({ ...cur, clips }, `Edit ${cur.clips[index]?.name} ${String(field)}`);
  }, [writeData]);

  if (!data) return <div style={{ color: '#555', fontSize: '11px', padding: 4 }}>Loading...</div>;

  const clips = data.clips ?? [];

  return (
    <>
      <div style={{ color: '#888', fontSize: '10px', marginBottom: 6 }}>
        Per-clip playback defaults. A SkeletalAnimator using this set inherits these
        unless its own speed/loop/fade are changed from their defaults (1 / on / 0).
      </div>
      {clips.length === 0 && (
        <div style={{ color: '#666', fontSize: '11px', padding: '4px 0' }}>This animset lists no clips.</div>
      )}
      {clips.map((clip, i) => (
        <div key={clip.name + i} style={{ borderTop: '1px solid #333', paddingTop: 6, marginTop: 6 }}>
          <div style={{ color: '#ddd', fontSize: '11px', fontWeight: 'bold', marginBottom: 2 }}>{clip.name}</div>
          <NumberField label="Speed" value={clip.speed ?? 1} step={0.1} wide
            onChange={v => writeClipField(i, 'speed', v)} dataUiId={`assetView.animSet.clip.${i}.speed`} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
            <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>Loop</span>
            <input type="checkbox" checked={clip.loop ?? true} onChange={e => writeClipField(i, 'loop', e.target.checked)} />
          </div>
          <NumberField label="Fade Duration" value={clip.fadeDuration ?? 0} step={0.05} wide
            onChange={v => writeClipField(i, 'fadeDuration', Math.max(0, v))} dataUiId={`assetView.animSet.clip.${i}.fadeDuration`} />
        </div>
      ))}
    </>
  );
}
