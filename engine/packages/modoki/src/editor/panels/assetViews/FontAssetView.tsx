/** FontAssetView — MSDF font import settings editor + Apply (bake) action.
 *  Mirrors TextureAssetView: settings persist to the font's `.meta.json` `font`
 *  block on change; Apply runs msdf-atlas-gen (via /api/reimport) and reloads.
 *  The baked mtsdf atlas + Chlumsky metrics are served at `<src>~atlas.png` +
 *  `<src>~metrics.json`; the font is then GUID-referenceable by the Text traits. */

import { useState, useEffect, useCallback } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { useEditorStore } from '../../store/editorStore';
import {
  DEFAULT_FONT_SETTINGS, resolveFontSettings, FONT_ATLAS_SUFFIX,
  type FontImportSettings, type FontFieldType, type FontCharsetPreset, type FontMode, type FontCacheInfo,
} from '../../../runtime/loaders/fontSettings';
import { assetUrl } from '../../../runtime/loaders/assetUrl';
import { inputStyle } from '../fields';
import { DropdownField, formatBytes, reimportBtnStyle, writeMetaOrWarn } from './widgets';

const CHARSET_OPTIONS: { value: FontCharsetPreset; label: string }[] = [
  { value: 'ascii', label: 'ASCII (printable, 95 glyphs)' },
  { value: 'latin1', label: 'Latin-1 (ASCII + accents)' },
  { value: 'custom', label: 'Custom…' },
];

const MODE_OPTIONS: { value: FontMode; label: string }[] = [
  { value: 'baked', label: 'Baked (fixed atlas only)' },
  { value: 'dynamic', label: 'Dynamic (baked + runtime glyph gen)' },
];

const FIELD_TYPE_OPTIONS: { value: FontFieldType; label: string }[] = [
  { value: 'mtsdf', label: 'MTSDF (4-channel — outline / glow)' },
  { value: 'msdf', label: 'MSDF (3-channel — fill only, smaller)' },
];

const ATLAS_MAX_OPTIONS = [512, 1024, 2048, 4096];

export function FontAssetView({ path, name }: { path: string; name: string }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<FontImportSettings>(DEFAULT_FONT_SETTINGS);
  const [customChars, setCustomChars] = useState('');
  const [importing, setImporting] = useState(false);
  const [converted, setConverted] = useState(false);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  const loadMeta = useCallback((signal?: AbortSignal) => {
    return backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        const s = resolveFontSettings(m as { font?: Partial<FontImportSettings> });
        setSettings(s);
        setCustomChars(s.customChars ?? '');
        setConverted(!!m.fontCache);
      })
      .catch(() => { /* keep defaults */ });
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    loadMeta(ac.signal);
    return () => ac.abort();
  }, [loadMeta]);

  // Persist a settings change to the meta sidecar immediately (discrete controls).
  // Full meta preserved (id/fontCache).
  const update = useCallback((patch: Partial<FontImportSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      const updatedMeta = { ...(meta ?? {}), version: 2, font: next };
      setMeta(updatedMeta);
      writeMetaOrWarn(path, updatedMeta);
      return next;
    });
  }, [meta, path]);

  const apply = useCallback(async () => {
    setImporting(true);
    setImportStatus(true, `Baking ${name}...`);
    try {
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok || (summary.errors && summary.errors.length)) {
        console.error('[Inspector] Font bake failed:', summary.errors ?? summary);
      }
      await loadMeta();
      refreshAssets();
    } finally {
      setImporting(false);
      setImportStatus(false);
    }
  }, [path, name, loadMeta, refreshAssets, setImportStatus]);

  const labelStyle: React.CSSProperties = { flex: 1, color: '#888', fontSize: '11px' };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '8px 0 3px' };

  return (
    <>
      <div style={{ color: '#ccc', fontSize: 12, marginBottom: 6, wordBreak: 'break-all' }}>{name}</div>

      <div style={sectionStyle}>Atlas</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Field type</span>
        <select value={settings.fieldType} onChange={(e) => update({ fieldType: e.target.value as FontFieldType })} style={{ ...inputStyle, flex: 1 }}>
          {FIELD_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Glyph size (px/em)</span>
        <select value={String(settings.size)} onChange={(e) => update({ size: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {[32, 40, 48, 64, 96, 128].map((s) => <option key={s} value={s}>{s}{s >= 96 ? ' (sharp corners)' : ''}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Distance range (px)</span>
        <select value={String(settings.pxRange)} onChange={(e) => update({ pxRange: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
          {[2, 4, 6, 8].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={sectionStyle}>Charset</div>
      <DropdownField
        label="Preset"
        value={settings.charset}
        options={CHARSET_OPTIONS.map((o) => o.value)}
        onChange={(v) => update({ charset: v as FontCharsetPreset })}
      />
      {settings.charset === 'custom' && (
        <div style={rowStyle}>
          <span style={labelStyle}>Characters</span>
          <input
            value={customChars}
            onChange={(e) => setCustomChars(e.target.value)}
            onBlur={() => update({ customChars })}
            placeholder="e.g. 0123ABC…"
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
      )}

      <div style={sectionStyle}>Mode</div>
      <DropdownField
        label="Glyph source"
        value={settings.mode}
        options={MODE_OPTIONS.map((o) => o.value)}
        onChange={(v) => update({ mode: v as FontMode })}
      />
      <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
        {settings.mode === 'dynamic'
          ? 'Baked glyphs render instantly; unseen glyphs (accents, CJK) are generated at runtime.'
          : 'Only the baked charset renders; missing glyphs show a fallback box.'}
      </div>
      {/* atlasMax sizes the RUNTIME dynamic-page atlas only — the baked atlas
          auto-sizes (msdf-atlas-gen `-potr`), so this control is meaningless for a
          baked font and is shown only in dynamic mode. */}
      {settings.mode === 'dynamic' && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Runtime page size (px)</span>
            <select value={String(settings.atlasMax)} onChange={(e) => update({ atlasMax: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }}>
              {ATLAS_MAX_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
            Size of each runtime-generated glyph page. The baked atlas auto-sizes independently.
          </div>
        </>
      )}

      <button
        disabled={importing}
        onClick={apply}
        style={{ ...reimportBtnStyle, marginTop: 8, background: importing ? '#555' : '#2ecc71', color: '#fff', border: `1px solid ${importing ? '#444' : '#27ae60'}`, cursor: importing ? 'wait' : 'pointer' }}
      >
        {importing ? 'Baking...' : converted ? 'Re-bake' : 'Apply'}
      </button>
      {converted && <FontImportedStats cache={meta?.fontCache as FontCacheInfo | undefined} />}
      {converted && <FontAtlasPreview path={path} cache={meta?.fontCache as FontCacheInfo | undefined} />}
    </>
  );
}

/** The baked mtsdf atlas image (`~atlas.png`), on a dark backing so the alpha
 *  channel doesn't wash it out. It's a 4-channel MTSDF, so the RGB reads as
 *  colorful glyph edges (the multi-channel distance field) — that's expected, not a
 *  bug. Cache-busted by the content hash so a re-bake refreshes the preview. */
function FontAtlasPreview({ path, cache }: { path: string; cache: FontCacheInfo | undefined }) {
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  const url = assetUrl(path + FONT_ATLAS_SUFFIX) + (cache?.hash ? `?v=${cache.hash}` : '');
  return (
    <>
      <div style={sectionStyle}>Atlas preview</div>
      <div style={{
        background: '#0d0d16 url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="8" height="8" fill="%23161622"/><rect x="8" y="8" width="8" height="8" fill="%23161622"/></svg>\')',
        border: '1px solid #333', borderRadius: 3, padding: 4,
      }}>
        <img src={url} alt="MTSDF atlas" style={{ display: 'block', width: '100%', height: 'auto', imageRendering: 'pixelated' }} />
      </div>
      <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
        MTSDF — RGB is the multi-channel distance field (colorful edges are normal); alpha is the true SDF.
      </div>
    </>
  );
}

/** Post-bake stats read back from the meta sidecar: atlas dimensions, glyph count,
 *  and atlas PNG size. */
function FontImportedStats({ cache }: { cache: FontCacheInfo | undefined }) {
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '1px 0' };
  const labelStyle: React.CSSProperties = { color: '#888' };
  const valStyle: React.CSSProperties = { color: '#ccc' };
  const sectionStyle: React.CSSProperties = { color: '#f1c40f', fontSize: '10px', textTransform: 'uppercase', margin: '10px 0 3px' };
  if (!cache) return null;
  return (
    <>
      <div style={sectionStyle}>Imported</div>
      {cache.atlasWidth != null && (
        <div style={rowStyle}><span style={labelStyle}>Atlas</span><span style={valStyle}>{cache.atlasWidth} × {cache.atlasHeight}</span></div>
      )}
      {cache.glyphCount != null && (
        <div style={rowStyle}><span style={labelStyle}>Glyphs</span><span style={valStyle}>{cache.glyphCount}</span></div>
      )}
      {cache.bytes != null && (
        <div style={rowStyle}><span style={labelStyle}>Atlas size</span><span style={valStyle}>{formatBytes(cache.bytes)}</span></div>
      )}
    </>
  );
}
