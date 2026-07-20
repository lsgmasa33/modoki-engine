/** AtlasAssetView — the `.atlas.json` inspector: edit the member sprite list + pack
 *  options, Re-pack (POST /api/reimport), and preview the generated pages.
 *
 *  The authored fields (members / pageSize / padding / extrude / maxPages) live in the
 *  committed `.atlas.json`; this view reads + writes that file. The DERIVED bookkeeping
 *  (pages + frame map) lives in the atlas's `.meta.json` sidecar and is surfaced through
 *  the live manifest (`getAssetEntry(guid).atlas`) for the page preview + stats — it
 *  refreshes after a Re-pack via the watcher's manifest broadcast. */

import { useState, useEffect, useCallback } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { writeAssetFile } from '../assetOps';
import { useEditorStore } from '../../store/editorStore';
import { getAssetEntry, getGuidForPath, type AtlasCacheBlock } from '../../../runtime/loaders/assetManifest';
import { resolveAtlasPageUrl } from '../../../runtime/loaders/textureResolver';
import { markScene2DDirty } from '../../../runtime/rendering/Scene2D';
import { TEXTURE_MAX_SIZES } from '../../../runtime/loaders/textureSettings';
import { AssetRefField } from '../AssetRefField';
import { inputStyle } from '../fields';
import { reimportBtnStyle } from './widgets';

interface AtlasSourceDoc {
  id?: string;
  version?: number;
  members: string[];
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

const DEFAULT_DOC: AtlasSourceDoc = { members: [], pageSize: 1024, padding: 2, extrude: 1 };

export function AtlasAssetView({ path, name }: { path: string; name: string }) {
  const [doc, setDoc] = useState<AtlasSourceDoc>(DEFAULT_DOC);
  const [packing, setPacking] = useState(false);
  const [blockVersion, setBlockVersion] = useState(0); // bump to re-read the manifest block
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const guid = getGuidForPath(path) ?? doc.id;
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  const block = (guid ? getAssetEntry(guid)?.atlas : undefined) as AtlasCacheBlock | undefined;
  // `assetsVersion`/`blockVersion` are read so the preview recomputes after a re-pack
  // re-registers the atlas entry; reference them to satisfy the deps lint without effect.
  void assetsVersion; void blockVersion;

  // Load the authored `.atlas.json` (served as a normal project asset file).
  useEffect(() => {
    const ac = new AbortController();
    backendFetch(path, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<AtlasSourceDoc> | null) => {
        if (!d) return;
        setDoc({
          id: d.id, version: d.version,
          members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
          pageSize: typeof d.pageSize === 'number' ? d.pageSize : 1024,
          padding: typeof d.padding === 'number' ? d.padding : 2,
          extrude: typeof d.extrude === 'number' ? d.extrude : 1,
          ...(typeof d.maxPages === 'number' ? { maxPages: d.maxPages } : {}),
        });
      })
      .catch(() => { /* keep defaults */ });
    return () => ac.abort();
  }, [path]);

  // Persist a change to the `.atlas.json` (discrete controls — no debounce). Empty
  // member slots are kept while editing; the packer ignores blanks.
  const update = useCallback((patch: Partial<AtlasSourceDoc>) => {
    setDoc((prev) => {
      const next = { ...prev, ...patch, version: 1 as const };
      void writeAssetFile(path, JSON.stringify(next, null, 2));
      return next;
    });
  }, [path]);

  const setMember = (i: number, v: string) => update({ members: doc.members.map((m, j) => (j === i ? v : m)) });
  const addMember = () => update({ members: [...doc.members, ''] });
  const removeMember = (i: number) => update({ members: doc.members.filter((_, j) => j !== i) });

  const repack = useCallback(async () => {
    setPacking(true);
    setImportStatus(true, `Packing ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[AtlasAssetView] pack failed:', summary.errors ?? summary);
      }
      refreshAssets();          // re-scan panel; the watcher broadcast re-registers the block
      setBlockVersion((v) => v + 1);
      markScene2DDirty();       // refresh on-screen packed sprites to the new page
    } finally {
      setPacking(false);
      setImportStatus(false);
    }
  }, [path, name, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };
  const num = (v: number, on: (n: number) => void, min = 0) => (
    <input type="number" min={min} value={v} onChange={(e) => on(Math.max(min, Number(e.target.value) || 0))} style={{ ...inputStyle, width: 70 }} />
  );

  return (
    <>
      <div style={sectionStyle}>Members ({doc.members.length})</div>
      {doc.members.map((m, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: 1 }}>
            <AssetRefField label="" value={m} accept={['sprite']} onChange={(v) => setMember(i, v)} placeholder="drop / pick a sprite" />
          </div>
          <button onClick={() => removeMember(i)} title="Remove" style={{ ...reimportBtnStyle, width: 24, padding: 0 }}>✕</button>
        </div>
      ))}
      <button onClick={addMember} style={{ ...reimportBtnStyle, marginTop: 2 }}>+ Add member</button>

      <div style={sectionStyle}>Pack options</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Page size</span>
        <select value={String(doc.pageSize)} onChange={(e) => update({ pageSize: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {TEXTURE_MAX_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={rowStyle}><span style={labelStyle}>Padding</span>{num(doc.padding, (n) => update({ padding: n }))}</div>
      <div style={rowStyle}><span style={labelStyle}>Extrude (bleed)</span>{num(doc.extrude, (n) => update({ extrude: n }))}</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Max pages</span>
        {num(doc.maxPages ?? 0, (n) => update(n > 0 ? { maxPages: n } : { maxPages: undefined }))}
      </div>

      <button
        disabled={packing}
        onClick={repack}
        style={{ ...reimportBtnStyle, marginTop: 8, background: packing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${packing ? '#444' : '#27ae60'}`, cursor: packing ? 'wait' : 'pointer' }}
      >
        {packing ? 'Packing...' : block ? 'Re-pack' : 'Pack'}
      </button>

      {block && <AtlasPagePreview guid={guid!} block={block} />}
    </>
  );
}

/** Page-count + per-page thumbnails read from the built manifest block. */
function AtlasPagePreview({ guid, block }: { guid: string; block: AtlasCacheBlock }) {
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  const memberCount = Object.keys(block.frames).length;
  return (
    <>
      <div style={sectionStyle}>Pages ({block.pages.length}) · {memberCount} packed</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {block.pages.map((pg, p) => {
          const url = resolveAtlasPageUrl({ atlasGuid: guid, page: p, rect: { x: 0, y: 0, w: pg.w, h: pg.h }, pivot: { x: 0, y: 0 }, pageW: pg.w, pageH: pg.h, texture: block.texture, hash: pg.hash }, '2d');
          return (
            <div key={p} style={{ width: 132, fontSize: 10, color: '#888' }}>
              {url
                ? <img src={url} alt={`page ${p}`} style={{ width: 132, height: 132, objectFit: 'contain', background: '#1a1a1a', border: '1px solid #333', imageRendering: 'pixelated' }} />
                : <div style={{ width: 132, height: 132, background: '#1a1a1a', border: '1px solid #333' }} />}
              <div>page {p} — {pg.w}×{pg.h}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
